alter table public.ledger_card_reconciliations
  add column cancelled_at timestamptz null,
  add column cancelled_by bigint null references public.users(id) on delete restrict,
  add column cancel_reason text null;

create index ledger_card_reconciliations_cancelled_by_idx
  on public.ledger_card_reconciliations(cancelled_by);

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
  ),
  add constraint ledger_card_reconciliation_cancellation check (
    (
      status = 'cancelled'
      and cancelled_at is not null
      and cancelled_by is not null
      and nullif(btrim(cancel_reason), '') is not null
    )
    or (
      status <> 'cancelled'
      and cancelled_at is null
      and cancelled_by is null
      and cancel_reason is null
    )
  );

create or replace function public.ledger_create_card_deposit_v1(
  p_deposit_at timestamptz,
  p_amount numeric,
  p_destination_account_id bigint,
  p_reference text,
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
  v_balance numeric;
  v_transaction bigint;
  v_reconciliation bigint;
  v_operation uuid := gen_random_uuid();
  v_date date;
  v_month date;
  v_tx public.ledger_transactions%rowtype;
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
  if p_destination_account_id = v_clearing or not exists (
    select 1 from public.ledger_fund_accounts
    where id = p_destination_account_id and is_active = true
  ) then
    return jsonb_build_object('status', 'invalid_destination');
  end if;

  select coalesce(sum(m.amount), 0) into v_balance
  from public.ledger_movements m
  join public.ledger_transactions t on t.id = m.transaction_id
  where m.fund_account_id = v_clearing and t.status = 'confirmed';
  if v_balance < p_amount then
    return jsonb_build_object('status', 'insufficient_card_pending', 'pendingBalance', v_balance);
  end if;

  insert into public.ledger_transactions(
    operation_id, type, occurred_at, business_date, amount, status, source_type,
    source_snapshot, source_fingerprint, source_synced_at, memo, created_by, confirmed_by
  ) values (
    v_operation, 'card_settlement_deposit', p_deposit_at, v_date, p_amount, 'confirmed',
    'card_settlement_deposit',
    jsonb_build_object(
      'reference', nullif(btrim(p_reference), ''),
      'depositAmount', p_amount,
      'destinationFundAccountId', p_destination_account_id
    ),
    md5(v_operation::text || ':' || p_amount::text), now(), nullif(btrim(p_memo), ''),
    p_actor_user_id, p_actor_user_id
  ) returning * into v_tx;
  v_transaction := v_tx.id;

  insert into public.ledger_movements(transaction_id, fund_account_id, amount)
  values
    (v_transaction, v_clearing, -p_amount),
    (v_transaction, p_destination_account_id, p_amount);

  insert into public.ledger_card_reconciliations(
    deposit_transaction_id, deposit_date, destination_fund_account_id, deposit_amount, memo
  ) values (
    v_transaction, v_date, p_destination_account_id, p_amount, nullif(btrim(p_memo), '')
  ) returning id into v_reconciliation;

  insert into public.ledger_audit_logs(
    actor_user_id, action, entity_type, entity_id, after_snapshot, reason
  ) values (
    p_actor_user_id, 'card_deposit_created', 'card_reconciliation', v_reconciliation,
    jsonb_build_object(
      'depositTransactionId', v_transaction,
      'bankAccountId', p_destination_account_id,
      'depositAmount', p_amount,
      'beforePendingBalance', v_balance,
      'afterPendingBalance', v_balance - p_amount,
      'status', 'unmatched'
    ),
    coalesce(nullif(btrim(p_reference), ''), nullif(btrim(p_memo), ''))
  );
  return jsonb_build_object('status', 'created', 'reconciliationId', v_reconciliation, 'transactionId', v_transaction);
exception
  when check_violation or foreign_key_violation or not_null_violation then
    return jsonb_build_object('status', 'invalid_input');
end;
$$;

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
  if v_rec.status in ('matched', 'cancelled') then return jsonb_build_object('status', 'immutable'); end if;

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

create function public.ledger_cancel_card_reconciliation_v1(
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
  if v_rec.status not in ('unmatched', 'partial', 'matched') then
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

create or replace function public.ledger_close_preflight_v1(
  p_month date,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_blockers jsonb := '[]';
  v_warnings jsonb := '[]';
  v_token text;
  v_count bigint;
  v_amount numeric;
begin
  select lower(role::text) into v_role from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then return jsonb_build_object('status', 'forbidden'); end if;
  if p_month is null or p_month <> date_trunc('month', p_month)::date then return jsonb_build_object('status', 'invalid_month'); end if;
  if p_month >= date_trunc('month', now() at time zone 'Asia/Ho_Chi_Minh')::date then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', case when p_month = date_trunc('month', now() at time zone 'Asia/Ho_Chi_Minh')::date then 'CURRENT_MONTH' else 'FUTURE_MONTH' end));
  end if;
  if public.ledger_month_is_closed_v1(p_month) then v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'ALREADY_CLOSED')); end if;
  select count(*) into v_count from public.ledger_candidates where proposed_recognition_month = p_month and status = 'pending' and candidate_type in ('inventory_purchase', 'employee_meal');
  if v_count > 0 then v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'PENDING_CANDIDATES', 'count', v_count)); end if;
  if exists(select 1 from public.payroll_payment_batches where payroll_month = p_month and status <> 'completed') or ((select min(payroll_month) from public.payroll_payment_batches) <= p_month and not exists(select 1 from public.payroll_payment_batches where payroll_month = p_month and status = 'completed')) then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'PAYROLL_NOT_COMPLETED'));
  end if;
  select count(*) into v_count from public.ledger_recurring_expense_plans p where p.effective_from <= p_month and (p.effective_to is null or p.effective_to >= p_month) and not exists(select 1 from public.ledger_transactions t where t.source_type = 'recurring_expense' and t.source_key = 'recurring:' || p.id || ':' || to_char(p_month, 'YYYY-MM') and t.status = 'confirmed');
  if v_count > 0 then v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'RECURRING_NOT_SYNCED', 'count', v_count)); end if;
  select count(*) into v_count from public.ledger_candidates where proposed_recognition_month = p_month and status = 'confirmed' and resolved_transaction_id is null;
  if v_count > 0 then v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'CANDIDATE_LINK_BROKEN', 'count', v_count)); end if;
  if exists(select 1 from public.ledger_transactions t where t.type = 'transfer' and (t.recognition_month = p_month or date_trunc('month', t.business_date)::date = p_month) and coalesce((select sum(m.amount) from public.ledger_movements m where m.transaction_id = t.id), 0) <> 0) then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'TRANSFER_UNBALANCED'));
  end if;
  if exists(select 1 from public.ledger_transactions t where ((t.source_type = 'manual' and t.type in ('expense', 'income')) or t.type in ('payroll_payment', 'payable_payment', 'prepaid_expense_payment', 'card_settlement_deposit')) and (t.recognition_month = p_month or date_trunc('month', t.business_date)::date = p_month) and not exists(select 1 from public.ledger_movements m where m.transaction_id = t.id)) then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'REQUIRED_MOVEMENT_MISSING'));
  end if;
  if exists(select 1 from public.ledger_payables p where (select coalesce(sum(a.allocated_amount), 0) from public.ledger_payable_allocations a where a.payable_id = p.id) > p.original_amount) then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'PAYABLE_OVERALLOCATED'));
  end if;
  if exists(
    select 1
    from public.ledger_transactions t
    join public.ledger_card_reconciliation_lines l on l.pos_card_transaction_id = t.id
    join public.ledger_card_reconciliations r on r.id = l.reconciliation_id and r.status <> 'cancelled'
    group by t.id, t.amount
    having sum(l.allocated_gross_amount) > t.amount
  ) then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'CARD_OVERALLOCATED'));
  end if;
  if exists(select source_type, source_key from public.ledger_transactions where source_key is not null and status = 'confirmed' group by source_type, source_key having count(*) > 1) then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'DUPLICATE_ACTIVE_SOURCE'));
  end if;
  select count(*), coalesce(sum(r.deposit_amount), 0) into v_count, v_amount
  from public.ledger_card_reconciliations r
  where r.status in ('unmatched', 'partial')
    and date_trunc('month', r.deposit_date)::date = p_month;
  if v_count > 0 then
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'CARD_UNMATCHED', 'count', v_count, 'amount', v_amount));
  end if;
  select coalesce(sum(p.original_amount) - sum(coalesce((select sum(a.allocated_amount) from public.ledger_payable_allocations a join public.ledger_transactions pt on pt.id = a.payment_transaction_id where a.payable_id = p.id and pt.business_date < (p_month + interval '1 month')::date), 0)), 0) into v_amount from public.ledger_payables p join public.ledger_transactions t on t.id = p.expense_transaction_id where t.business_date < (p_month + interval '1 month')::date and p.status <> 'cancelled';
  if v_amount > 0 then v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('code', 'PAYABLE_OUTSTANDING', 'amount', v_amount)); end if;
  select count(*) into v_count from public.ledger_transactions where type = 'balance_adjustment' and date_trunc('month', business_date)::date = p_month;
  if v_count > 0 then v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('code', 'BALANCE_ADJUSTMENT', 'count', v_count)); end if;
  select count(*) into v_count from public.ledger_reserve_plans p where p.is_active and coalesce((select sum(case e.entry_type when 'allocate' then e.amount when 'release' then -e.amount when 'consume' then -e.amount else e.amount end) from public.ledger_reserve_entries e where e.reserve_plan_id = p.id and e.occurred_at < ((p_month + interval '1 month')::date + time '03:00') at time zone 'Asia/Ho_Chi_Minh'), 0) < p.target_amount;
  if v_count > 0 then v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('code', 'RESERVE_SHORTFALL', 'count', v_count)); end if;
  select count(*) into v_count from public.ledger_candidates where candidate_type = 'source_drift' and status = 'pending' and (source_snapshot->>'affectedClosedMonth')::date = p_month;
  if v_count > 0 then v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'CONFIRMED_SOURCE_DRIFT', 'count', v_count)); end if;

  v_token := md5((jsonb_build_object(
    'month', p_month,
    'blockers', v_blockers,
    'warnings', v_warnings,
    'transactionState', (select coalesce(jsonb_agg(jsonb_build_array(id, updated_at, amount, status, source_fingerprint) order by id), '[]') from public.ledger_transactions where recognition_month = p_month or date_trunc('month', business_date)::date = p_month),
    'candidateState', (select coalesce(jsonb_agg(jsonb_build_array(id, updated_at, status, source_fingerprint) order by id), '[]') from public.ledger_candidates where proposed_recognition_month = p_month),
    'cardState', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id,
        'updatedAt', r.updated_at,
        'status', r.status,
        'matchedGrossAmount', r.matched_gross_amount,
        'differenceAmount', r.difference_amount,
        'lines', coalesce((select jsonb_agg(jsonb_build_array(l.pos_card_transaction_id, l.allocated_gross_amount) order by l.pos_card_transaction_id) from public.ledger_card_reconciliation_lines l where l.reconciliation_id = r.id), '[]'::jsonb)
      ) order by r.id), '[]'::jsonb)
      from public.ledger_card_reconciliations r
      where date_trunc('month', r.deposit_date)::date = p_month
    )
  )::text) || md5('ledger-close-v1:' || jsonb_build_object('month', p_month, 'blockers', v_blockers, 'warnings', v_warnings)::text));
  return jsonb_build_object('status', 'ok', 'month', p_month, 'canClose', jsonb_array_length(v_blockers) = 0, 'blockers', v_blockers, 'warnings', v_warnings, 'preflightHash', v_token);
end;
$$;

alter function public.ledger_create_card_deposit_v1(timestamptz, numeric, bigint, text, text, bigint) owner to postgres;
alter function public.ledger_match_card_reconciliation_v1(bigint, jsonb, boolean, bigint) owner to postgres;
alter function public.ledger_cancel_card_reconciliation_v1(bigint, text, bigint) owner to postgres;
alter function public.ledger_close_preflight_v1(date, bigint) owner to postgres;

revoke all on function public.ledger_create_card_deposit_v1(timestamptz, numeric, bigint, text, text, bigint) from public, anon, authenticated;
revoke all on function public.ledger_match_card_reconciliation_v1(bigint, jsonb, boolean, bigint) from public, anon, authenticated;
revoke all on function public.ledger_cancel_card_reconciliation_v1(bigint, text, bigint) from public, anon, authenticated;
revoke all on function public.ledger_close_preflight_v1(date, bigint) from public, anon, authenticated;

grant execute on function public.ledger_create_card_deposit_v1(timestamptz, numeric, bigint, text, text, bigint) to service_role;
grant execute on function public.ledger_match_card_reconciliation_v1(bigint, jsonb, boolean, bigint) to service_role;
grant execute on function public.ledger_cancel_card_reconciliation_v1(bigint, text, bigint) to service_role;
grant execute on function public.ledger_close_preflight_v1(date, bigint) to service_role;

comment on function public.ledger_cancel_card_reconciliation_v1(bigint, text, bigint) is
  'Append-only card reconciliation cancellation: preserves originals and lines, reverses deposit and matched difference, and records cancellation metadata/audit.';
