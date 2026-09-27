-- Card deposit registration with atomic FIFO principal allocation.
--
-- New status 'auto_allocated': the deposit amount is allocated to the oldest
-- unsettled POS card sale principal on or before the deposit business date.
-- It settles gross but does NOT confirm a card fee:
--   * matched_gross_amount = deposit_amount (principal allocated), difference_amount = 0
--   * confirmed_at / confirmed_by stay null (no fee confirmation happened)
--   * no card_settlement_difference expense is created
-- 'matched' keeps its historical meaning (gross vs deposit compared, difference booked),
-- so fee metrics that filter on 'matched' are not diluted by 0% auto rows.
-- Month-close preflight blocks only 'unmatched'/'partial', so auto rows never block closing;
-- CARD_OVERALLOCATED and POS card-day locks already count every non-cancelled line.
-- No existing rows are updated by this migration.

alter table public.ledger_card_reconciliations
  drop constraint ledger_card_reconciliations_status_check,
  add constraint ledger_card_reconciliations_status_check
    check (status in ('unmatched', 'partial', 'matched', 'auto_allocated', 'cancelled'));

alter table public.ledger_card_reconciliations
  drop constraint ledger_card_reconciliation_confirmation,
  add constraint ledger_card_reconciliation_confirmation check (
    (
      status = 'matched'
      and confirmed_at is not null
      and confirmed_by is not null
      and matched_gross_amount >= deposit_amount
      and difference_amount = matched_gross_amount - deposit_amount
    )
    or (
      status in ('unmatched', 'partial')
      and confirmed_at is null
      and confirmed_by is null
      and difference_amount = 0
    )
    or (
      status = 'auto_allocated'
      and confirmed_at is null
      and confirmed_by is null
      and difference_amount = 0
      and matched_gross_amount = deposit_amount
    )
    or (
      status = 'cancelled'
      and (
        (confirmed_at is null and confirmed_by is null and difference_amount = 0)
        or (
          confirmed_at is not null
          and confirmed_by is not null
          and matched_gross_amount >= deposit_amount
          and difference_amount = matched_gross_amount - deposit_amount
        )
      )
    )
  );

create function public.ledger_create_card_deposit_auto_allocate_v1(
  p_deposit_at timestamptz,
  p_amount numeric,
  p_destination_account_id bigint,
  p_memo text,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_clearing bigint;
  v_bank bigint;
  v_balance numeric;
  v_available numeric;
  v_remaining numeric;
  v_allocated numeric;
  v_transaction bigint;
  v_reconciliation bigint;
  v_operation uuid := gen_random_uuid();
  v_date date;
  v_month date;
  v_sale record;
  v_allocations jsonb := '[]'::jsonb;
begin
  select lower(role::text) into v_role
  from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_deposit_at is null or p_amount is null or p_amount <= 0 or scale(p_amount) > 3 then
    return jsonb_build_object('status', 'invalid_amount');
  end if;

  v_date := ((p_deposit_at at time zone 'Asia/Ho_Chi_Minh') - interval '3 hours')::date;
  v_month := date_trunc('month', v_date)::date;
  -- Same lock order as create/match/cancel: month close, then card clearing balance.
  perform pg_advisory_xact_lock(hashtext('ledger_month_close:' || to_char(v_month, 'YYYY-MM')));
  if public.ledger_month_is_closed_v1(v_month) then
    return jsonb_build_object('status', 'month_closed');
  end if;
  perform pg_advisory_xact_lock(hashtext('ledger_card_clearing_balance'));

  select id into v_clearing
  from public.ledger_fund_accounts
  where code = 'card_clearing' and is_active = true
  for update;
  if v_clearing is null then return jsonb_build_object('status', 'card_clearing_missing'); end if;

  -- Card deposits always land in the BABA corporate bank account.
  select id into v_bank
  from public.ledger_fund_accounts
  where code = 'baba_corporate_bank' and is_active = true and type <> 'card_clearing';
  if v_bank is null then return jsonb_build_object('status', 'corporate_bank_missing'); end if;
  if p_destination_account_id is distinct from v_bank then
    return jsonb_build_object('status', 'invalid_destination');
  end if;

  select coalesce(sum(m.amount), 0) into v_balance
  from public.ledger_movements m
  join public.ledger_transactions t on t.id = m.transaction_id
  where m.fund_account_id = v_clearing and t.status = 'confirmed';
  if v_balance < p_amount then
    return jsonb_build_object('status', 'insufficient_card_pending', 'pendingBalance', v_balance);
  end if;

  -- Lock candidate sales in id order (the match RPC's order) before reading balances.
  perform 1
  from public.ledger_transactions
  where status = 'confirmed'
    and source_type = 'pos_sales_daily_payment'
    and source_key like 'pos:%:card'
    and business_date <= v_date
  order by id
  for update;

  -- Outstanding = sale gross minus every non-cancelled allocation (legacy partial lines included).
  select coalesce(sum(outstanding), 0) into v_available
  from (
    select c.id, c.business_date, c.outstanding
    from (
      select t.id, t.business_date,
        t.amount - coalesce((
          select sum(l.allocated_gross_amount)
          from public.ledger_card_reconciliation_lines l
          join public.ledger_card_reconciliations r on r.id = l.reconciliation_id
          where l.pos_card_transaction_id = t.id and r.status <> 'cancelled'
        ), 0) as outstanding
      from public.ledger_transactions t
      where t.status = 'confirmed'
        and t.source_type = 'pos_sales_daily_payment'
        and t.source_key like 'pos:%:card'
        and t.business_date <= v_date
    ) c
    where c.outstanding > 0
  ) eligible;
  if v_available < p_amount then
    return jsonb_build_object(
      'status', 'insufficient_unsettled_card_sales',
      'availableOutstanding', v_available,
      'depositAmount', p_amount
    );
  end if;

  insert into public.ledger_transactions(
    operation_id, type, occurred_at, business_date, amount, status, source_type,
    source_snapshot, source_fingerprint, source_synced_at, memo, created_by, confirmed_by
  ) values (
    v_operation, 'card_settlement_deposit', p_deposit_at, v_date, p_amount, 'confirmed',
    'card_settlement_deposit',
    jsonb_build_object(
      'depositAmount', p_amount,
      'destinationFundAccountId', v_bank,
      'allocationMode', 'fifo_auto'
    ),
    md5(v_operation::text || ':' || p_amount::text), now(), nullif(btrim(p_memo), ''),
    p_actor_user_id, p_actor_user_id
  ) returning id into v_transaction;

  insert into public.ledger_movements(transaction_id, fund_account_id, amount)
  values
    (v_transaction, v_clearing, -p_amount),
    (v_transaction, v_bank, p_amount);

  insert into public.ledger_card_reconciliations(
    deposit_transaction_id, deposit_date, destination_fund_account_id, deposit_amount,
    matched_gross_amount, difference_amount, status, memo
  ) values (
    v_transaction, v_date, v_bank, p_amount, p_amount, 0, 'auto_allocated', nullif(btrim(p_memo), '')
  ) returning id into v_reconciliation;

  -- FIFO: oldest business_date first, then id; each sale takes min(remaining, outstanding).
  v_remaining := p_amount;
  for v_sale in
    select eligible.id, eligible.business_date, eligible.outstanding
    from (
      select c.id, c.business_date, c.outstanding
      from (
        select t.id, t.business_date,
          t.amount - coalesce((
            select sum(l.allocated_gross_amount)
            from public.ledger_card_reconciliation_lines l
            join public.ledger_card_reconciliations r on r.id = l.reconciliation_id
            where l.pos_card_transaction_id = t.id and r.status <> 'cancelled'
          ), 0) as outstanding
        from public.ledger_transactions t
        where t.status = 'confirmed'
          and t.source_type = 'pos_sales_daily_payment'
          and t.source_key like 'pos:%:card'
          and t.business_date <= v_date
      ) c
      where c.outstanding > 0
    ) eligible
    order by eligible.business_date, eligible.id
  loop
    exit when v_remaining <= 0;
    v_allocated := least(v_remaining, v_sale.outstanding);
    insert into public.ledger_card_reconciliation_lines(reconciliation_id, pos_card_transaction_id, allocated_gross_amount)
    values (v_reconciliation, v_sale.id, v_allocated);
    v_allocations := v_allocations || jsonb_build_array(jsonb_build_object(
      'transactionId', v_sale.id,
      'businessDate', v_sale.business_date,
      'outstandingBefore', v_sale.outstanding,
      'allocatedAmount', v_allocated,
      'outstandingAfter', v_sale.outstanding - v_allocated
    ));
    v_remaining := v_remaining - v_allocated;
  end loop;
  if v_remaining <> 0 then
    -- Unreachable after the availability check; abort so nothing above is kept.
    raise exception 'card auto allocation left % unallocated', v_remaining;
  end if;

  insert into public.ledger_audit_logs(
    actor_user_id, action, entity_type, entity_id, after_snapshot, reason
  ) values (
    p_actor_user_id, 'card_deposit_auto_allocated', 'card_reconciliation', v_reconciliation,
    jsonb_build_object(
      'depositTransactionId', v_transaction,
      'bankAccountId', v_bank,
      'depositAmount', p_amount,
      'beforePendingBalance', v_balance,
      'afterPendingBalance', v_balance - p_amount,
      'allocations', v_allocations,
      'matchedGrossAmount', p_amount,
      'differenceAmount', 0,
      'status', 'auto_allocated'
    ),
    nullif(btrim(p_memo), '')
  );
  return jsonb_build_object(
    'status', 'created',
    'reconciliationId', v_reconciliation,
    'transactionId', v_transaction,
    'totalAllocated', p_amount,
    'allocations', v_allocations
  );
exception
  when check_violation or foreign_key_violation or not_null_violation then
    return jsonb_build_object('status', 'invalid_input');
end;
$$;

-- Legacy manual matching: unchanged from 20260915103312 except auto_allocated is immutable.
create or replace function public.ledger_match_card_reconciliation_v1(
  p_reconciliation_id bigint,
  p_allocations jsonb,
  p_confirm boolean,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_rec public.ledger_card_reconciliations%rowtype;
  v_item jsonb;
  v_id bigint;
  v_amount numeric;
  v_gross numeric := 0;
  v_other numeric;
  v_sale public.ledger_transactions%rowtype;
  v_clearing bigint;
  v_balance numeric;
  v_diff numeric;
  v_category bigint;
  v_diff_tx bigint;
  v_before jsonb;
  v_ids bigint[] := array[]::bigint[];
  v_deposit_date date;
  v_month date;
begin
  select lower(role::text) into v_role
  from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then
    return jsonb_build_object('status', 'invalid_allocations');
  end if;

  select deposit_date into v_deposit_date
  from public.ledger_card_reconciliations
  where id = p_reconciliation_id;
  if v_deposit_date is null then return jsonb_build_object('status', 'not_found'); end if;
  v_month := date_trunc('month', v_deposit_date)::date;
  perform pg_advisory_xact_lock(hashtext('ledger_month_close:' || to_char(v_month, 'YYYY-MM')));
  if public.ledger_month_is_closed_v1(v_month) then
    return jsonb_build_object('status', 'month_closed');
  end if;
  perform pg_advisory_xact_lock(hashtext('ledger_card_clearing_balance'));

  select * into v_rec
  from public.ledger_card_reconciliations
  where id = p_reconciliation_id
  for update;
  if v_rec.id is null then return jsonb_build_object('status', 'not_found'); end if;
  if v_rec.deposit_date is distinct from v_deposit_date then return jsonb_build_object('status', 'invalid_state'); end if;
  -- auto_allocated rows own FIFO lines written at registration; they are never re-matched.
  if v_rec.status in ('matched', 'auto_allocated', 'cancelled') then return jsonb_build_object('status', 'immutable'); end if;

  v_before := to_jsonb(v_rec);
  select array_agg(distinct (x->>'transactionId')::bigint order by (x->>'transactionId')::bigint)
    into v_ids
  from jsonb_array_elements(p_allocations) x;
  if cardinality(v_ids) <> jsonb_array_length(p_allocations) then
    return jsonb_build_object('status', 'duplicate_card_sale');
  end if;
  perform 1 from public.ledger_transactions where id = any(v_ids) order by id for update;

  for v_item in select value from jsonb_array_elements(p_allocations) loop
    begin
      v_id := (v_item->>'transactionId')::bigint;
      v_amount := (v_item->>'allocatedGrossAmount')::numeric;
    exception when others then
      return jsonb_build_object('status', 'invalid_allocations');
    end;
    if v_amount <= 0 or scale(v_amount) > 3 then
      return jsonb_build_object('status', 'invalid_allocations');
    end if;
    select * into v_sale
    from public.ledger_transactions
    where id = v_id
      and status = 'confirmed'
      and source_type = 'pos_sales_daily_payment'
      and source_key like 'pos:%:card';
    if v_sale.id is null then return jsonb_build_object('status', 'invalid_card_sale'); end if;
    if v_sale.business_date > v_rec.deposit_date then
      return jsonb_build_object(
        'status', 'future_card_sale',
        'transactionId', v_id,
        'saleBusinessDate', v_sale.business_date,
        'depositDate', v_rec.deposit_date
      );
    end if;
    select coalesce(sum(l.allocated_gross_amount), 0) into v_other
    from public.ledger_card_reconciliation_lines l
    join public.ledger_card_reconciliations r on r.id = l.reconciliation_id
    where l.pos_card_transaction_id = v_id
      and r.status <> 'cancelled'
      and r.id <> v_rec.id;
    if v_other + v_amount > v_sale.amount then
      return jsonb_build_object('status', 'gross_overallocated', 'transactionId', v_id);
    end if;
    v_gross := v_gross + v_amount;
  end loop;

  if p_confirm and v_gross < v_rec.deposit_amount then
    return jsonb_build_object('status', 'gross_below_deposit', 'matchedGrossAmount', v_gross);
  end if;
  if p_confirm then
    v_diff := v_gross - v_rec.deposit_amount;
    select id into v_clearing
    from public.ledger_fund_accounts
    where code = 'card_clearing' and is_active = true
    for update;
    select coalesce(sum(m.amount), 0) into v_balance
    from public.ledger_movements m
    join public.ledger_transactions t on t.id = m.transaction_id
    where m.fund_account_id = v_clearing and t.status = 'confirmed';
    if v_balance < v_diff then
      return jsonb_build_object('status', 'insufficient_card_pending', 'pendingBalance', v_balance);
    end if;
    if v_diff > 0 then
      select id into v_category
      from public.ledger_categories
      where kind = 'expense' and name = '카드 정산 차액' and is_active = true;
      if v_category is null then return jsonb_build_object('status', 'category_missing'); end if;
    end if;
  end if;

  delete from public.ledger_card_reconciliation_lines where reconciliation_id = v_rec.id;
  insert into public.ledger_card_reconciliation_lines(
    reconciliation_id, pos_card_transaction_id, allocated_gross_amount
  )
  select v_rec.id, (x->>'transactionId')::bigint, (x->>'allocatedGrossAmount')::numeric
  from jsonb_array_elements(p_allocations) x;

  if not p_confirm then
    update public.ledger_card_reconciliations
    set matched_gross_amount = v_gross,
        status = case when v_gross = 0 then 'unmatched' else 'partial' end,
        updated_at = now()
    where id = v_rec.id;
    insert into public.ledger_audit_logs(
      actor_user_id, action, entity_type, entity_id, before_snapshot, after_snapshot, reason
    ) values (
      p_actor_user_id, 'card_reconciliation_partial', 'card_reconciliation', v_rec.id, v_before,
      jsonb_build_object(
        'depositTransactionId', v_rec.deposit_transaction_id,
        'bankAccountId', v_rec.destination_fund_account_id,
        'depositAmount', v_rec.deposit_amount,
        'allocations', p_allocations,
        'matchedGrossAmount', v_gross,
        'differenceAmount', 0,
        'status', 'partial'
      ),
      'Card settlement partial match'
    );
    return jsonb_build_object('status', 'partial', 'matchedGrossAmount', v_gross);
  end if;

  if v_diff > 0 then
    insert into public.ledger_transactions(
      operation_id, type, occurred_at, business_date, recognition_month, amount,
      category_id, status, source_type, source_key, source_snapshot,
      source_fingerprint, source_synced_at, memo, created_by, confirmed_by
    )
    select
      d.operation_id, 'expense_recognition', d.occurred_at, v_rec.deposit_date,
      date_trunc('month', v_rec.deposit_date)::date, v_diff, v_category, 'confirmed',
      'card_settlement_difference', 'card-reconciliation:' || v_rec.id || ':difference',
      jsonb_build_object(
        'reconciliationId', v_rec.id,
        'depositAmount', v_rec.deposit_amount,
        'matchedGrossAmount', v_gross,
        'differenceAmount', v_diff,
        'sales', (
          select jsonb_agg(jsonb_build_object(
            'transactionId', l.pos_card_transaction_id,
            'businessDate', t.business_date,
            'allocatedGrossAmount', l.allocated_gross_amount
          ))
          from public.ledger_card_reconciliation_lines l
          join public.ledger_transactions t on t.id = l.pos_card_transaction_id
          where l.reconciliation_id = v_rec.id
        )
      ),
      md5(v_rec.id::text || ':' || v_gross::text || ':' || v_rec.deposit_amount::text),
      now(), '카드 정산 차액', p_actor_user_id, p_actor_user_id
    from public.ledger_transactions d
    where d.id = v_rec.deposit_transaction_id
    returning id into v_diff_tx;
    insert into public.ledger_movements(transaction_id, fund_account_id, amount)
    values (v_diff_tx, v_clearing, -v_diff);
  end if;

  update public.ledger_card_reconciliations
  set matched_gross_amount = v_gross,
      difference_amount = v_diff,
      status = 'matched',
      confirmed_at = now(),
      confirmed_by = p_actor_user_id,
      updated_at = now()
  where id = v_rec.id;
  insert into public.ledger_audit_logs(
    actor_user_id, action, entity_type, entity_id, before_snapshot, after_snapshot, reason
  ) values (
    p_actor_user_id, 'card_reconciliation_matched', 'card_reconciliation', v_rec.id, v_before,
    jsonb_build_object(
      'depositTransactionId', v_rec.deposit_transaction_id,
      'bankAccountId', v_rec.destination_fund_account_id,
      'depositAmount', v_rec.deposit_amount,
      'allocations', p_allocations,
      'matchedGrossAmount', v_gross,
      'differenceAmount', v_diff,
      'beforePendingBalance', v_balance,
      'afterPendingBalance', v_balance - v_diff,
      'status', 'matched'
    ),
    'Card settlement confirmed'
  );
  return jsonb_build_object(
    'status', 'matched',
    'matchedGrossAmount', v_gross,
    'differenceAmount', v_diff,
    'differenceTransactionId', v_diff_tx
  );
end;
$$;

-- Cancellation: unchanged from 20260915095952 except auto_allocated is accepted.
create or replace function public.ledger_cancel_card_reconciliation_v1(
  p_reconciliation_id bigint,
  p_reason text,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_rec public.ledger_card_reconciliations%rowtype;
  v_original public.ledger_transactions%rowtype;
  v_difference public.ledger_transactions%rowtype;
  v_clearing bigint;
  v_deposit_date date;
  v_month date;
  v_deposit_movement_count bigint;
  v_difference_count bigint;
  v_deposit_reversal_id bigint;
  v_difference_reversal_id bigint;
  v_operation uuid := gen_random_uuid();
  v_before jsonb;
  v_after jsonb;
begin
  select lower(role::text) into v_role
  from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if nullif(btrim(p_reason), '') is null then
    return jsonb_build_object('status', 'reason_required');
  end if;

  select deposit_date into v_deposit_date
  from public.ledger_card_reconciliations
  where id = p_reconciliation_id;
  if v_deposit_date is null then return jsonb_build_object('status', 'not_found'); end if;
  v_month := date_trunc('month', v_deposit_date)::date;
  perform pg_advisory_xact_lock(hashtext('ledger_month_close:' || to_char(v_month, 'YYYY-MM')));
  if public.ledger_month_is_closed_v1(v_month) then
    return jsonb_build_object('status', 'month_closed');
  end if;
  perform pg_advisory_xact_lock(hashtext('ledger_card_clearing_balance'));

  select * into v_rec
  from public.ledger_card_reconciliations
  where id = p_reconciliation_id
  for update;
  if v_rec.id is null then return jsonb_build_object('status', 'not_found'); end if;
  if v_rec.deposit_date is distinct from v_deposit_date then return jsonb_build_object('status', 'invalid_state'); end if;
  if v_rec.status = 'cancelled' then
    return jsonb_build_object(
      'status', 'already_cancelled',
      'cancelledAt', v_rec.cancelled_at,
      'cancelledBy', v_rec.cancelled_by
    );
  end if;
  -- auto_allocated has no difference transaction, so it follows the unmatched/partial reversal path:
  -- the deposit is reversed and its FIFO lines are preserved under the cancelled reconciliation.
  if v_rec.status not in ('unmatched', 'partial', 'matched', 'auto_allocated') then
    return jsonb_build_object('status', 'invalid_state');
  end if;

  select id into v_clearing
  from public.ledger_fund_accounts
  where code = 'card_clearing'
  for update;
  if v_clearing is null then return jsonb_build_object('status', 'invalid_state'); end if;

  select * into v_original
  from public.ledger_transactions
  where id = v_rec.deposit_transaction_id
  for update;
  if v_original.id is null
     or v_original.status <> 'confirmed'
     or v_original.type <> 'card_settlement_deposit'
     or v_original.source_type <> 'card_settlement_deposit'
     or v_original.amount <> v_rec.deposit_amount
     or v_original.business_date <> v_rec.deposit_date then
    return jsonb_build_object('status', 'invalid_state');
  end if;

  select count(*) into v_deposit_movement_count
  from public.ledger_movements
  where transaction_id = v_original.id;
  if v_deposit_movement_count <> 2
     or coalesce((select sum(amount) from public.ledger_movements where transaction_id = v_original.id), 0) <> 0
     or coalesce((select sum(amount) from public.ledger_movements where transaction_id = v_original.id and fund_account_id = v_clearing), 0) <> -v_rec.deposit_amount
     or coalesce((select sum(amount) from public.ledger_movements where transaction_id = v_original.id and fund_account_id = v_rec.destination_fund_account_id), 0) <> v_rec.deposit_amount then
    return jsonb_build_object('status', 'invalid_state');
  end if;
  if exists (
    select 1 from public.ledger_transactions
    where source_key = 'card-reconciliation:' || v_rec.id || ':deposit-reversal'
       or (correction_of_id = v_original.id and source_type = 'card_settlement_deposit_reversal')
  ) then
    return jsonb_build_object('status', 'already_cancelled');
  end if;

  select count(*) into v_difference_count
  from public.ledger_transactions
  where source_type = 'card_settlement_difference'
    and source_key = 'card-reconciliation:' || v_rec.id || ':difference';
  if v_rec.status = 'matched' and v_rec.difference_amount > 0 then
    if v_difference_count <> 1 then return jsonb_build_object('status', 'invalid_state'); end if;
    select * into v_difference
    from public.ledger_transactions
    where source_type = 'card_settlement_difference'
      and source_key = 'card-reconciliation:' || v_rec.id || ':difference'
    for update;
    if v_difference.status <> 'confirmed'
       or v_difference.type <> 'expense_recognition'
       or v_difference.amount <> v_rec.difference_amount
       or v_difference.business_date <> v_original.business_date
       or v_difference.recognition_month <> date_trunc('month', v_original.business_date)::date
       or v_difference.category_id is null
       or (select count(*) from public.ledger_movements where transaction_id = v_difference.id) <> 1
       or coalesce((select sum(amount) from public.ledger_movements where transaction_id = v_difference.id and fund_account_id = v_clearing), 0) <> -v_rec.difference_amount then
      return jsonb_build_object('status', 'invalid_state');
    end if;
    if exists (
      select 1 from public.ledger_transactions
      where source_key = 'card-reconciliation:' || v_rec.id || ':difference-reversal'
         or (correction_of_id = v_difference.id and source_type = 'card_settlement_difference_reversal')
    ) then
      return jsonb_build_object('status', 'already_cancelled');
    end if;
  elsif v_difference_count <> 0 then
    return jsonb_build_object('status', 'invalid_state');
  end if;

  v_before := jsonb_build_object(
    'reconciliation', to_jsonb(v_rec),
    'lines', coalesce((
      select jsonb_agg(to_jsonb(l) order by l.id)
      from public.ledger_card_reconciliation_lines l
      where l.reconciliation_id = v_rec.id
    ), '[]'::jsonb),
    'depositTransaction', to_jsonb(v_original),
    'differenceTransaction', case when v_difference.id is null then null else to_jsonb(v_difference) end
  );

  insert into public.ledger_transactions(
    operation_id, type, occurred_at, business_date, recognition_month, amount,
    category_id, party_id, status, source_type, source_key, source_snapshot,
    source_fingerprint, source_synced_at, correction_of_id, memo,
    created_by, confirmed_by, economic_effect_sign
  ) values (
    v_operation, v_original.type, v_original.occurred_at, v_original.business_date,
    v_original.recognition_month, v_original.amount, v_original.category_id,
    v_original.party_id, 'confirmed', 'card_settlement_deposit_reversal',
    'card-reconciliation:' || v_rec.id || ':deposit-reversal',
    jsonb_build_object(
      'reconciliationId', v_rec.id,
      'originalTransactionId', v_original.id,
      'cancelReason', btrim(p_reason)
    ),
    md5('card-reconciliation:' || v_rec.id || ':deposit-reversal'), now(),
    v_original.id, '카드 입금 취소 역분개: ' || btrim(p_reason),
    p_actor_user_id, p_actor_user_id, -1
  ) returning id into v_deposit_reversal_id;

  insert into public.ledger_movements(transaction_id, fund_account_id, amount)
  select v_deposit_reversal_id, fund_account_id, -amount
  from public.ledger_movements
  where transaction_id = v_original.id
  order by id;

  if v_difference.id is not null then
    insert into public.ledger_transactions(
      operation_id, type, occurred_at, business_date, recognition_month, amount,
      category_id, party_id, status, source_type, source_key, source_snapshot,
      source_fingerprint, source_synced_at, correction_of_id, memo,
      created_by, confirmed_by, economic_effect_sign
    ) values (
      v_operation, v_difference.type, v_difference.occurred_at, v_difference.business_date,
      v_difference.recognition_month, v_difference.amount, v_difference.category_id,
      v_difference.party_id, 'confirmed', 'card_settlement_difference_reversal',
      'card-reconciliation:' || v_rec.id || ':difference-reversal',
      jsonb_build_object(
        'reconciliationId', v_rec.id,
        'originalTransactionId', v_difference.id,
        'cancelReason', btrim(p_reason)
      ),
      md5('card-reconciliation:' || v_rec.id || ':difference-reversal'), now(),
      v_difference.id, '카드 정산 차액 취소 역분개: ' || btrim(p_reason),
      p_actor_user_id, p_actor_user_id, -1
    ) returning id into v_difference_reversal_id;

    insert into public.ledger_movements(transaction_id, fund_account_id, amount)
    select v_difference_reversal_id, fund_account_id, -amount
    from public.ledger_movements
    where transaction_id = v_difference.id
    order by id;
  end if;

  update public.ledger_card_reconciliations
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_by = p_actor_user_id,
      cancel_reason = btrim(p_reason),
      updated_at = now()
  where id = v_rec.id;

  select jsonb_build_object(
    'reconciliation', to_jsonb(r),
    'depositReversalTransactionId', v_deposit_reversal_id,
    'differenceReversalTransactionId', v_difference_reversal_id,
    'preservedLineCount', (select count(*) from public.ledger_card_reconciliation_lines where reconciliation_id = r.id)
  ) into v_after
  from public.ledger_card_reconciliations r
  where r.id = v_rec.id;

  insert into public.ledger_audit_logs(
    actor_user_id, action, entity_type, entity_id, before_snapshot, after_snapshot, reason
  ) values (
    p_actor_user_id, 'card_reconciliation_cancelled', 'card_reconciliation', v_rec.id,
    v_before, v_after, btrim(p_reason)
  );

  return jsonb_build_object(
    'status', 'cancelled',
    'reconciliationId', v_rec.id,
    'depositReversalTransactionId', v_deposit_reversal_id,
    'differenceReversalTransactionId', v_difference_reversal_id
  );
end;
$$;

alter function public.ledger_create_card_deposit_auto_allocate_v1(timestamptz, numeric, bigint, text, bigint) owner to postgres;
alter function public.ledger_match_card_reconciliation_v1(bigint, jsonb, boolean, bigint) owner to postgres;
alter function public.ledger_cancel_card_reconciliation_v1(bigint, text, bigint) owner to postgres;

revoke all on function public.ledger_create_card_deposit_auto_allocate_v1(timestamptz, numeric, bigint, text, bigint) from public, anon, authenticated;
revoke all on function public.ledger_match_card_reconciliation_v1(bigint, jsonb, boolean, bigint) from public, anon, authenticated;
revoke all on function public.ledger_cancel_card_reconciliation_v1(bigint, text, bigint) from public, anon, authenticated;

grant execute on function public.ledger_create_card_deposit_auto_allocate_v1(timestamptz, numeric, bigint, text, bigint) to service_role;
grant execute on function public.ledger_match_card_reconciliation_v1(bigint, jsonb, boolean, bigint) to service_role;
grant execute on function public.ledger_cancel_card_reconciliation_v1(bigint, text, bigint) to service_role;

comment on function public.ledger_create_card_deposit_auto_allocate_v1(timestamptz, numeric, bigint, text, bigint) is
  'Atomically registers a card deposit into baba_corporate_bank and allocates exactly the deposit amount to unsettled POS card sale principal FIFO (business_date, id; sales on or before the deposit date). Never estimates or books a card fee.';
comment on function public.ledger_match_card_reconciliation_v1(bigint, jsonb, boolean, bigint) is
  'Matches only POS card sales on or before the deposit business date; preserves month-close and clearing lock contracts. auto_allocated reconciliations are immutable.';
comment on function public.ledger_cancel_card_reconciliation_v1(bigint, text, bigint) is
  'Append-only card reconciliation cancellation: preserves originals and lines, reverses deposit and matched difference, and records cancellation metadata/audit. Also cancels auto_allocated deposits, releasing their FIFO allocations.';
