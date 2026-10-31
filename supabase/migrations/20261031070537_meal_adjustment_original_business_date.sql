-- Future meal corrections use original business dates; no historical data changes.
begin;

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
  v_original_source_amount numeric;
  v_latest_source_amount numeric;
  v_drift_fingerprint text;
  v_review_required boolean := false;
  v_review_recorded boolean := false;
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

  select
    v_original.amount * v_original.economic_effect_sign
    + coalesce(sum(linked.amount * linked.economic_effect_sign), 0)
  into v_previous_amount
  from public.ledger_transactions linked
  where linked.correction_of_id = v_original.id
    and linked.status = 'confirmed'
    and linked.source_type = 'ledger_correction';

  v_delta := p_final_amount - v_previous_amount;
  v_original_source_amount := coalesce(
    (v_original.source_snapshot ->> 'total_amount')::numeric,
    (v_candidate.source_snapshot ->> 'total_amount')::numeric,
    v_original.amount * v_original.economic_effect_sign
  );
  v_latest_source_amount := coalesce(
    (v_candidate.source_drift_snapshot ->> 'total_amount')::numeric,
    v_original_source_amount
  );
  v_drift_fingerprint := nullif(v_candidate.source_drift_fingerprint, '');
  v_review_required := v_candidate.source_drift_snapshot is not null
    and v_drift_fingerprint is not null
    and v_latest_source_amount <> v_original_source_amount
    and v_latest_source_amount <> v_previous_amount
    and (v_original.display_snapshot ->> 'mealSourceDriftReviewedFingerprint')
      is distinct from v_drift_fingerprint;

  -- Only a financial delta requires an open adjustment business month and cash account.
  -- Run every prerequisite before recording a review, so failures leave no metadata/audit.
  if v_delta <> 0 then
    v_business_date := v_original.business_date;
    perform pg_advisory_xact_lock(
      hashtext('ledger_month_close:' || to_char(v_business_date, 'YYYY-MM'))
    );
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
  end if;

  -- The candidate is locked: review the exact fingerprint used for this decision.
  -- A new fingerprint invalidates this review, even when its total is unchanged.
  if v_candidate.source_drift_snapshot is not null
     and v_drift_fingerprint is not null
     and (v_delta <> 0 or v_review_required) then
    update public.ledger_transactions
    set display_snapshot = coalesce(display_snapshot, '{}'::jsonb) || jsonb_build_object(
      'mealSourceDriftReviewedFingerprint', v_drift_fingerprint,
      'mealSourceDriftReviewedAt', v_adjusted_at
    )
    where id = v_original.id;
    insert into public.ledger_audit_logs(
      actor_user_id, action, entity_type, entity_id,
      before_snapshot, after_snapshot, reason
    ) values (
      p_actor_user_id, 'meal_source_drift_reviewed', 'transaction', v_original.id,
      jsonb_build_object('displaySnapshot', v_original.display_snapshot,
        'previousEffectiveAmount', v_previous_amount),
      jsonb_build_object('currentDriftFingerprint', v_drift_fingerprint,
        'finalAmount', p_final_amount, 'reviewedAt', v_adjusted_at,
        'economicDelta', v_delta),
      btrim(p_reason)
    );
    v_review_recorded := true;
  end if;

  if v_delta = 0 then
    return jsonb_build_object(
      'status', case when v_review_recorded then 'reviewed' else 'unchanged' end,
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
    'reviewedSourceDriftFingerprint', v_drift_fingerprint,
    'adjustedAt', v_adjusted_at,
    'attributionPolicy', 'original_meal_business_date',
    'businessDate', v_business_date
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
      'currentDriftFingerprint', v_drift_fingerprint,
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
  'Open-month meal delta on original business date; occurred_at/adjustedAt retain execution time. Immutable provenance, linked corrections, drift review and service-only authorization preserved.';

-- Existing manual creation RPC: preserve signature, validation and grants.
create or replace function public.ledger_create_manual_transaction_v1(
  p_type text,p_occurred_at timestamptz,p_recognition_month date,p_amount numeric,
  p_category_id bigint,p_party_id bigint,p_from_account_id bigint,p_to_account_id bigint,
  p_memo text,p_reason text,p_actor_user_id bigint,p_source_key text default null
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_role text; v_id bigint; v_operation_id uuid := gen_random_uuid(); v_business_date date;
  v_category_kind text; v_transaction public.ledger_transactions%rowtype;
begin
  select lower(role::text) into v_role from public.users where id=p_actor_user_id and is_active=true and app_login_enabled=true;
  if coalesce(v_role,'') not in ('owner','master') then return jsonb_build_object('status','forbidden'); end if;
  if p_type not in ('expense','income','transfer','balance_adjustment') then return jsonb_build_object('status','invalid_type'); end if;
  if p_amount is null or p_amount <= 0 or p_amount <> trunc(p_amount) then return jsonb_build_object('status','invalid_amount'); end if;
  if p_occurred_at is null then return jsonb_build_object('status','invalid_date'); end if;
  v_business_date := ((p_occurred_at at time zone 'Asia/Ho_Chi_Minh') - interval '3 hours')::date;
  if p_type in ('expense','income') then
    if p_recognition_month is null or p_recognition_month <> date_trunc('month',p_recognition_month)::date then return jsonb_build_object('status','invalid_recognition_month'); end if;
    select kind into v_category_kind from public.ledger_categories where id=p_category_id and is_active=true;
    if v_category_kind is distinct from p_type then return jsonb_build_object('status','invalid_category'); end if;
  elsif p_recognition_month is not null or p_category_id is not null then return jsonb_build_object('status','invalid_profit_fields');
  end if;
  if p_type='expense' and (p_from_account_id is null or p_to_account_id is not null) then return jsonb_build_object('status','invalid_accounts'); end if;
  if p_type='income' and (p_to_account_id is null or p_from_account_id is not null) then return jsonb_build_object('status','invalid_accounts'); end if;
  if p_type='transfer' and (p_from_account_id is null or p_to_account_id is null or p_from_account_id=p_to_account_id) then return jsonb_build_object('status','invalid_accounts'); end if;
  if p_type='balance_adjustment' and ((p_from_account_id is null) = (p_to_account_id is null)) then return jsonb_build_object('status','invalid_accounts'); end if;
  if p_type='balance_adjustment' and nullif(btrim(p_reason),'') is null then return jsonb_build_object('status','reason_required'); end if;
  if exists(select 1 from (values(p_from_account_id),(p_to_account_id)) a(id) where id is not null and not exists(select 1 from public.ledger_fund_accounts f where f.id=a.id and f.is_active=true)) then return jsonb_build_object('status','invalid_accounts'); end if;

  -- Reuse the existing meal adjustment instead of adding a second meal.
  if p_type = 'expense' and exists (
    select 1 from public.ledger_categories where id = p_category_id and name = '직원 식대'
  ) and exists (
    select 1 from public.ledger_transactions
    where business_date = v_business_date and status = 'confirmed'
      and source_type = 'attendance_meal_daily_candidate' and correction_of_id is null
  ) then
    return jsonb_build_object('status', 'automatic_meal_requires_adjustment');
  end if;

  insert into public.ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,party_id,status,source_type,source_key,memo,created_by,confirmed_by)
  values(v_operation_id,p_type,p_occurred_at,v_business_date,case when p_type in ('income','expense') then p_recognition_month end,p_amount,case when p_type in ('income','expense') then p_category_id end,p_party_id,'confirmed','manual',nullif(btrim(p_source_key),''),nullif(btrim(p_memo),''),p_actor_user_id,p_actor_user_id)
  returning * into v_transaction; v_id:=v_transaction.id;
  if p_from_account_id is not null then insert into public.ledger_movements(transaction_id,fund_account_id,amount) values(v_id,p_from_account_id,-p_amount); end if;
  if p_to_account_id is not null then insert into public.ledger_movements(transaction_id,fund_account_id,amount) values(v_id,p_to_account_id,p_amount); end if;
  if p_type='transfer' and (select coalesce(sum(amount),0) from public.ledger_movements where transaction_id=v_id) <> 0 then raise check_violation using message='transfer movements must net to zero'; end if;
  insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,after_snapshot,reason)
  values(p_actor_user_id,'created','transaction',v_id,to_jsonb(v_transaction),coalesce(nullif(btrim(p_reason),''),nullif(btrim(p_memo),'')));
  return jsonb_build_object('status','created','transactionId',v_id,'operationId',v_operation_id,'businessDate',v_business_date);
exception when unique_violation then return jsonb_build_object('status','duplicate_source');
when check_violation or foreign_key_violation or not_null_violation or invalid_text_representation then return jsonb_build_object('status','invalid_input');
end $$;
revoke all on function public.ledger_create_manual_transaction_v1(text,timestamptz,date,numeric,bigint,bigint,bigint,bigint,text,text,bigint,text) from public,anon,authenticated;
grant execute on function public.ledger_create_manual_transaction_v1(text,timestamptz,date,numeric,bigint,bigint,bigint,bigint,text,text,bigint,text) to service_role;
commit;
