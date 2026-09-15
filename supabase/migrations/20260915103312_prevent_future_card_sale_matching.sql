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

alter function public.ledger_match_card_reconciliation_v1(bigint, jsonb, boolean, bigint) owner to postgres;

revoke all on function public.ledger_match_card_reconciliation_v1(bigint, jsonb, boolean, bigint) from public, anon, authenticated;
grant execute on function public.ledger_match_card_reconciliation_v1(bigint, jsonb, boolean, bigint) to service_role;

comment on function public.ledger_match_card_reconciliation_v1(bigint, jsonb, boolean, bigint) is
  'Matches only POS card sales on or before the deposit business date; preserves month-close and clearing lock contracts.';
