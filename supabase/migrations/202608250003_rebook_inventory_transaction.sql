-- Open-month confirmed Inventory edits are append-only: reverse the original
-- economic/movement effect, cancel an untouched payable, and book a replacement.
create or replace function public.ledger_rebook_inventory_transaction_v1(
  p_original_transaction_id bigint,
  p_payment_mode text,
  p_category_id bigint,
  p_fund_account_id bigint,
  p_due_date date,
  p_amount numeric,
  p_memo text,
  p_reason text,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_original public.ledger_transactions%rowtype;
  v_candidate public.ledger_candidates%rowtype;
  v_old_payable public.ledger_payables%rowtype;
  v_old_allocated numeric(16,3) := 0;
  v_reversal_id bigint;
  v_rebook_id bigint;
  v_new_payable_id bigint;
  v_operation uuid := gen_random_uuid();
  v_before jsonb;
begin
  select lower(role::text) into v_role
  from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_payment_mode is null or p_payment_mode not in ('immediate', 'payable') then
    return jsonb_build_object('status', 'invalid_payment_mode');
  end if;
  if p_amount is null or p_amount <= 0 or scale(p_amount) > 3 then
    return jsonb_build_object('status', 'invalid_amount');
  end if;
  if nullif(btrim(p_reason), '') is null then
    return jsonb_build_object('status', 'reason_required');
  end if;

  perform pg_advisory_xact_lock(hashtext('ledger_inventory_rebook:' || p_original_transaction_id::text));
  select * into v_original
  from public.ledger_transactions
  where id = p_original_transaction_id
  for update;
  if v_original.id is null then return jsonb_build_object('status', 'not_found'); end if;
  if v_original.status <> 'confirmed'
     or v_original.type <> 'expense'
     or v_original.source_type not in ('inventory_purchase_candidate', 'inventory_purchase_rebook') then
    return jsonb_build_object('status', 'not_editable');
  end if;
  select * into v_candidate
  from public.ledger_candidates
  where candidate_type = 'inventory_purchase'
    and status = 'confirmed'
    and resolved_transaction_id = v_original.id
  order by id
  limit 1
  for update;
  if v_candidate.id is null then
    return jsonb_build_object('status', 'invalid_original_state');
  end if;
  perform pg_advisory_xact_lock(
    hashtext('ledger_month_close:' || to_char(date_trunc('month', v_original.business_date), 'YYYY-MM'))
  );
  if public.ledger_month_is_closed_v1(date_trunc('month', v_original.business_date)::date) then
    return jsonb_build_object('status', 'month_closed');
  end if;
  if exists (
    select 1 from public.ledger_transactions
    where correction_of_id = v_original.id
      and source_type in ('inventory_purchase_reversal', 'inventory_purchase_rebook')
  ) then
    return jsonb_build_object('status', 'already_rebooked');
  end if;
  if not exists (
    select 1 from public.ledger_categories
    where id = p_category_id and kind = 'expense' and is_active = true
  ) then
    return jsonb_build_object('status', 'invalid_category');
  end if;
  if p_payment_mode = 'immediate' and not exists (
    select 1 from public.ledger_fund_accounts
    where id = p_fund_account_id
      and is_active = true and is_business_fund = true and type <> 'card_clearing'
      and active_from <= v_original.business_date
      and (active_to is null or active_to >= v_original.business_date)
  ) then
    return jsonb_build_object('status', 'invalid_account');
  end if;
  if p_payment_mode = 'payable'
     and (v_original.party_id is null or not exists (
       select 1 from public.ledger_parties where id = v_original.party_id and is_active = true
     )) then
    return jsonb_build_object('status', 'party_required');
  end if;

  select * into v_old_payable
  from public.ledger_payables
  where expense_transaction_id = v_original.id
  for update;
  if v_old_payable.id is not null then
    select coalesce(sum(allocated_amount), 0) into v_old_allocated
    from public.ledger_payable_allocations
    where payable_id = v_old_payable.id;
    if v_old_allocated > 0 or v_old_payable.status in ('partially_paid', 'paid') then
      return jsonb_build_object('status', 'payable_already_paid');
    end if;
    if v_old_payable.status <> 'unpaid'
       or v_old_payable.party_id is distinct from v_original.party_id
       or v_old_payable.original_amount <> v_original.amount
       or exists (select 1 from public.ledger_movements where transaction_id = v_original.id) then
      return jsonb_build_object('status', 'invalid_original_state');
    end if;
  elsif (select count(*) from public.ledger_movements where transaction_id = v_original.id and amount < 0) <> 1
     or (select count(*) from public.ledger_movements where transaction_id = v_original.id) <> 1 then
    return jsonb_build_object('status', 'invalid_original_state');
  end if;

  v_before := jsonb_build_object(
    'transaction', to_jsonb(v_original),
    'movements', coalesce((select jsonb_agg(to_jsonb(m) order by m.id) from public.ledger_movements m where m.transaction_id = v_original.id), '[]'::jsonb),
    'payable', case when v_old_payable.id is null then null else to_jsonb(v_old_payable) end,
    'candidate', to_jsonb(v_candidate)
  );

  insert into public.ledger_transactions(
    operation_id, type, occurred_at, business_date, recognition_month, amount,
    category_id, party_id, status, source_type, source_key, source_snapshot,
    source_fingerprint, source_synced_at, correction_of_id, memo,
    created_by, confirmed_by, economic_effect_sign
  ) values (
    v_operation, 'expense', v_original.occurred_at, v_original.business_date,
    v_original.recognition_month, v_original.amount, v_original.category_id,
    v_original.party_id, 'confirmed', 'inventory_purchase_reversal',
    'inventory-reversal:' || v_original.id || ':' || v_operation::text,
    v_original.source_snapshot,
    v_original.source_fingerprint, now(), v_original.id,
    'Reversal: ' || btrim(p_reason), p_actor_user_id, p_actor_user_id, -1
  ) returning id into v_reversal_id;

  insert into public.ledger_movements(transaction_id, fund_account_id, amount)
  select v_reversal_id, fund_account_id, -amount
  from public.ledger_movements
  where transaction_id = v_original.id;

  if v_old_payable.id is not null then
    update public.ledger_payables
    set status = 'cancelled', updated_at = now()
    where id = v_old_payable.id;
  end if;

  insert into public.ledger_transactions(
    operation_id, type, occurred_at, business_date, recognition_month, amount,
    category_id, party_id, status, source_type, source_key, source_snapshot,
    source_fingerprint, source_synced_at, correction_of_id, memo,
    created_by, confirmed_by, economic_effect_sign
  ) values (
    v_operation, 'expense', v_original.occurred_at, v_original.business_date,
    v_original.recognition_month, p_amount, p_category_id, v_original.party_id,
    'confirmed', 'inventory_purchase_rebook',
    'inventory-rebook:' || v_original.id || ':' || v_operation::text,
    v_original.source_snapshot, v_original.source_fingerprint, now(), v_original.id,
    nullif(btrim(p_memo), ''), p_actor_user_id, p_actor_user_id, 1
  ) returning id into v_rebook_id;

  if p_payment_mode = 'immediate' then
    insert into public.ledger_movements(transaction_id, fund_account_id, amount)
    values(v_rebook_id, p_fund_account_id, -p_amount);
  else
    insert into public.ledger_payables(expense_transaction_id, party_id, original_amount, due_date)
    values(v_rebook_id, v_original.party_id, p_amount, p_due_date)
    returning id into v_new_payable_id;
  end if;

  update public.ledger_candidates
  set resolved_transaction_id = v_rebook_id, updated_at = now()
  where id = v_candidate.id;

  insert into public.ledger_audit_logs(
    actor_user_id, action, entity_type, entity_id,
    before_snapshot, after_snapshot, reason
  ) values (
    p_actor_user_id, 'inventory_transaction_rebooked', 'transaction', v_rebook_id,
    v_before,
    jsonb_build_object(
      'originalTransactionId', v_original.id,
      'reversalTransactionId', v_reversal_id,
      'rebookTransactionId', v_rebook_id,
      'operationId', v_operation,
      'paymentMode', p_payment_mode,
      'categoryId', p_category_id,
      'fundAccountId', case when p_payment_mode = 'immediate' then p_fund_account_id else null end,
      'payableId', v_new_payable_id,
      'dueDate', p_due_date,
      'amount', p_amount,
      'replacementTransaction', (select to_jsonb(t) from public.ledger_transactions t where t.id = v_rebook_id),
      'replacementMovements', coalesce((select jsonb_agg(to_jsonb(m) order by m.id) from public.ledger_movements m where m.transaction_id = v_rebook_id), '[]'::jsonb),
      'replacementPayable', (select to_jsonb(p) from public.ledger_payables p where p.id = v_new_payable_id),
      'candidate', (select to_jsonb(c) from public.ledger_candidates c where c.id = v_candidate.id)
    ), btrim(p_reason)
  );

  return jsonb_build_object(
    'status', 'rebooked', 'originalTransactionId', v_original.id,
    'reversalTransactionId', v_reversal_id,
    'transactionId', v_rebook_id, 'payableId', v_new_payable_id,
    'operationId', v_operation
  );
end;
$$;

alter function public.ledger_rebook_inventory_transaction_v1(bigint,text,bigint,bigint,date,numeric,text,text,bigint) owner to postgres;
revoke all on function public.ledger_rebook_inventory_transaction_v1(bigint,text,bigint,bigint,date,numeric,text,text,bigint)
  from public, anon, authenticated;
grant execute on function public.ledger_rebook_inventory_transaction_v1(bigint,text,bigint,bigint,date,numeric,text,text,bigint)
  to service_role;

comment on function public.ledger_rebook_inventory_transaction_v1(bigint,text,bigint,bigint,date,numeric,text,text,bigint) is
  'Atomically reverses and rebooks an open-month confirmed Inventory expense. Paid or partially-paid payables are immutable.';
