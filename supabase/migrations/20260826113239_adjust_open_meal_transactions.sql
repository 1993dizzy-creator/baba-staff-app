-- Open-month manual adjustments for confirmed attendance-based employee meals.
-- The confirmed source transaction and candidate provenance remain immutable.

create or replace function public.ledger_adjust_open_meal_transaction_v1(
  p_original_transaction_id bigint,
  p_final_amount numeric,
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
  v_candidate_id bigint;
  v_source_month date;
  v_adjusted_at timestamptz := now();
  v_business_date date;
  v_store_cash_id bigint;
  v_previous_amount numeric;
  v_delta numeric;
  v_adjustment_id bigint;
  v_operation_id uuid := gen_random_uuid();
  v_adjustment_snapshot jsonb;
  v_adjustment_fingerprint text;
begin
  select lower(role::text)
  into v_role
  from public.users
  where id = p_actor_user_id
    and is_active = true
    and app_login_enabled = true;

  if coalesce(v_role, '') not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_final_amount is null or p_final_amount < 0 or scale(p_final_amount) > 3 then
    return jsonb_build_object('status', 'invalid_amount');
  end if;
  if nullif(btrim(p_reason), '') is null then
    return jsonb_build_object('status', 'reason_required');
  end if;

  -- All adjustments for one source transaction serialize before current amount
  -- is recalculated, so concurrent requests cannot apply the same delta twice.
  perform pg_advisory_xact_lock(
    hashtext('ledger_meal_adjustment:' || p_original_transaction_id::text)
  );

  select *
  into v_original
  from public.ledger_transactions
  where id = p_original_transaction_id
  for update;

  if v_original.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_original.status <> 'confirmed'
     or v_original.type <> 'expense'
     or v_original.source_type <> 'attendance_meal_daily_candidate'
     or v_original.correction_of_id is not null then
    return jsonb_build_object('status', 'not_meal_transaction');
  end if;
  if v_original.source_key is null
     or v_original.source_key !~ '^candidate:[0-9]+$' then
    return jsonb_build_object('status', 'invalid_meal_candidate_link');
  end if;
  if not exists (
    select 1
    from public.ledger_categories category
    where category.id = v_original.category_id
      and category.kind = 'expense'
      and category.name = '직원 식대'
  ) then
    return jsonb_build_object('status', 'not_meal_transaction');
  end if;

  v_candidate_id := substring(v_original.source_key from '^candidate:([0-9]+)$')::bigint;
  select *
  into v_candidate
  from public.ledger_candidates
  where id = v_candidate_id
  for update;

  if v_candidate.id is null
     or v_candidate.candidate_type <> 'employee_meal'
     or v_candidate.source_type <> 'attendance_meal_daily'
     or v_candidate.status <> 'confirmed'
     or v_candidate.resolved_transaction_id is distinct from v_original.id then
    return jsonb_build_object('status', 'invalid_meal_candidate_link');
  end if;

  v_source_month := coalesce(
    v_original.recognition_month,
    date_trunc('month', v_original.business_date)::date
  );
  perform pg_advisory_xact_lock(
    hashtext('ledger_month_close:' || to_char(v_source_month, 'YYYY-MM'))
  );
  if public.ledger_month_is_closed_v1(v_source_month) then
    return jsonb_build_object('status', 'original_month_closed');
  end if;

  v_business_date := (
    (v_adjusted_at at time zone 'Asia/Ho_Chi_Minh') - interval '3 hours'
  )::date;
  if public.ledger_month_is_closed_v1(date_trunc('month', v_business_date)::date) then
    return jsonb_build_object('status', 'adjustment_business_month_closed');
  end if;

  select account.id
  into v_store_cash_id
  from public.ledger_fund_accounts account
  where account.code = 'store_cash'
    and account.is_active = true
    and account.is_business_fund = true
    and account.active_from <= v_business_date
    and (account.active_to is null or account.active_to >= v_business_date);

  if v_store_cash_id is null then
    return jsonb_build_object('status', 'store_cash_unavailable');
  end if;

  select
    v_original.amount * v_original.economic_effect_sign
    + coalesce(sum(linked.amount * linked.economic_effect_sign), 0)
  into v_previous_amount
  from public.ledger_transactions linked
  where linked.correction_of_id = v_original.id
    and linked.status = 'confirmed'
    and linked.source_type = 'ledger_correction'
    and linked.source_snapshot->>'adjustmentType' = 'employee_meal';

  v_delta := p_final_amount - v_previous_amount;
  if v_delta = 0 then
    return jsonb_build_object(
      'status', 'unchanged',
      'originalTransactionId', v_original.id,
      'previousEffectiveAmount', v_previous_amount,
      'finalAmount', p_final_amount,
      'economicDelta', 0
    );
  end if;

  v_adjustment_snapshot := jsonb_build_object(
    'originalTransactionId', v_original.id,
    'adjustmentType', 'employee_meal',
    'previousEffectiveAmount', v_previous_amount,
    'finalAmount', p_final_amount,
    'economicDelta', v_delta,
    'originalSourceType', v_original.source_type,
    'originalSourceKey', v_original.source_key,
    'adjustedAt', v_adjusted_at
  );
  v_adjustment_fingerprint :=
    md5(v_adjustment_snapshot::text || ':1')
    || md5(v_adjustment_snapshot::text || ':2');

  insert into public.ledger_transactions(
    operation_id, type, occurred_at, business_date, recognition_month, amount,
    category_id, party_id, status, source_type, source_key, source_snapshot,
    source_fingerprint, source_synced_at, correction_of_id, memo, created_by,
    confirmed_by, economic_effect_sign
  ) values (
    v_operation_id, 'expense', v_adjusted_at, v_business_date,
    v_original.recognition_month, abs(v_delta), v_original.category_id,
    v_original.party_id, 'confirmed', 'ledger_correction', null,
    v_adjustment_snapshot, v_adjustment_fingerprint, v_adjusted_at,
    v_original.id, btrim(p_reason), p_actor_user_id, p_actor_user_id,
    case when v_delta > 0 then 1 else -1 end
  ) returning id into v_adjustment_id;

  insert into public.ledger_movements(transaction_id, fund_account_id, amount)
  values (v_adjustment_id, v_store_cash_id, -v_delta);

  insert into public.ledger_audit_logs(
    actor_user_id, action, entity_type, entity_id,
    before_snapshot, after_snapshot, reason
  ) values (
    p_actor_user_id, 'meal_adjustment_created', 'transaction', v_adjustment_id,
    jsonb_build_object(
      'originalTransactionId', v_original.id,
      'originalAmount', v_original.amount,
      'previousEffectiveAmount', v_previous_amount,
      'originalSourceType', v_original.source_type,
      'originalSourceKey', v_original.source_key,
      'originalSourceFingerprint', v_original.source_fingerprint
    ),
    jsonb_build_object(
      'adjustmentTransactionId', v_adjustment_id,
      'previousEffectiveAmount', v_previous_amount,
      'finalAmount', p_final_amount,
      'economicDelta', v_delta,
      'storeCashMovement', -v_delta,
      'originalTransactionId', v_original.id,
      'operationId', v_operation_id
    ),
    btrim(p_reason)
  );

  return jsonb_build_object(
    'status', 'created',
    'originalTransactionId', v_original.id,
    'adjustmentTransactionId', v_adjustment_id,
    'previousEffectiveAmount', v_previous_amount,
    'finalAmount', p_final_amount,
    'economicDelta', v_delta,
    'storeCashMovement', -v_delta,
    'operationId', v_operation_id
  );
end;
$$;

alter function public.ledger_adjust_open_meal_transaction_v1(bigint,numeric,text,bigint)
  owner to postgres;
revoke all on function public.ledger_adjust_open_meal_transaction_v1(bigint,numeric,text,bigint)
  from public, anon, authenticated;
grant execute on function public.ledger_adjust_open_meal_transaction_v1(bigint,numeric,text,bigint)
  to service_role;

comment on function public.ledger_adjust_open_meal_transaction_v1(bigint,numeric,text,bigint) is
  'Adds a serialized delta correction for a confirmed attendance meal in an open recognition month; preserves the original transaction and candidate provenance.';
