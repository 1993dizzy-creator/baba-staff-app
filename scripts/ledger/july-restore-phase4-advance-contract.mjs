// Owner-supplied READ-ONLY production prosrc snapshot, observed 2026-11-07.
// Data for contract comparison and isolated tests only; never a migration/DB runner.
import {sha} from './july-restore-phase2.mjs';
export const advanceProductionHash='fb74a29c46a1ac9bb1739fa7f32842a5fc6ac16a9f11596d9875a1ff331eee98';
export const advanceProductionBody=String.raw`
declare
  v_role text;
  v_request_id text;
  v_user public.users%rowtype;
  v_employee_name text;
  v_business_date date;
  v_payroll_month date;
  v_adjustment_key text;
  v_transaction_key text;
  v_memo text;
  v_operation_id uuid := gen_random_uuid();
  v_adjustment public.payroll_monthly_adjustments%rowtype;
  v_transaction public.ledger_transactions%rowtype;
  v_existing_account bigint;
begin
  select lower(role::text) into v_role from public.users
    where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then return jsonb_build_object('status', 'forbidden'); end if;
  if p_request_id is null or p_request_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return jsonb_build_object('status', 'invalid_request_id');
  end if;
  v_request_id := lower(p_request_id);
  if p_amount is null or p_amount <= 0 or p_amount <> trunc(p_amount) then return jsonb_build_object('status', 'invalid_amount'); end if;
  if p_occurred_at is null then return jsonb_build_object('status', 'invalid_date'); end if;
  v_business_date := ((p_occurred_at at time zone 'Asia/Ho_Chi_Minh') - interval '3 hours')::date;
  v_payroll_month := date_trunc('month', v_business_date)::date;
  v_adjustment_key := 'ledger-payroll-advance:' || v_request_id;
  v_transaction_key := format('payroll-advance-payment:%s:user:%s:%s', v_business_date, p_user_id, v_request_id);
  perform pg_advisory_xact_lock(hashtextextended(v_adjustment_key, 0));
  select * into v_adjustment from public.payroll_monthly_adjustments
    where source_type = 'manual' and source_key = v_adjustment_key;
  if found then
    select * into v_transaction from public.ledger_transactions
      where source_type = 'manual'
        and source_key = format('payroll-advance-payment:%s:user:%s:%s', v_adjustment.business_date, v_adjustment.user_id, v_request_id);
    select m.fund_account_id into v_existing_account from public.ledger_movements m where m.transaction_id = v_transaction.id limit 1;
    if v_adjustment.user_id <> p_user_id or v_adjustment.amount <> p_amount or v_adjustment.business_date <> v_business_date
      or v_existing_account is distinct from p_from_account_id then
      return jsonb_build_object('status', 'request_conflict');
    end if;
    return jsonb_build_object(
      'status', 'duplicate', 'transactionId', v_transaction.id, 'payrollAdjustmentId', v_adjustment.id,
      'operationId', v_transaction.operation_id, 'businessDate', v_business_date, 'sourceKey', v_transaction.source_key
    );
  end if;
  if p_from_account_id is null or not exists(
    select 1 from public.ledger_fund_accounts f
    where f.id = p_from_account_id
      and f.is_active = true
      and f.is_business_fund = true
      and f.type <> 'card_clearing'
  ) then return jsonb_build_object('status', 'invalid_accounts'); end if;
  select * into v_user from public.users
    where id = p_user_id and is_active = true and is_system_account = false;
  if not found then return jsonb_build_object('status', 'employee_not_found'); end if;
  if not coalesce(v_user.payroll_eligible_override, lower(coalesce(v_user.role::text, '')) not in ('owner', 'master')) then
    return jsonb_build_object('status', 'employee_not_payroll_eligible');
  end if;
  perform pg_advisory_xact_lock(hashtext('ledger_month_close:' || to_char(v_payroll_month, 'YYYY-MM')));
  if public.ledger_month_is_closed_v1(v_payroll_month) then return jsonb_build_object('status', 'month_closed'); end if;
  v_employee_name := coalesce(nullif(btrim(v_user.name), ''), nullif(btrim(v_user.full_name), ''), v_user.username);
  v_memo := coalesce(nullif(btrim(p_memo), ''), v_employee_name || ' 급여 가불');
  insert into public.payroll_monthly_adjustments(
    user_id, payroll_month, kind, category, amount, business_date, reason, note, source_type, source_key, created_by
  ) values (
    p_user_id, v_payroll_month, 'advance', 'advance', p_amount, v_business_date, v_memo,
    '장부 내역 추가 · 가불 지급', 'manual', v_adjustment_key, p_actor_user_id
  ) returning * into v_adjustment;
  insert into public.ledger_transactions(
    operation_id, type, occurred_at, business_date, recognition_month, amount, category_id, party_id,
    status, source_type, source_key, source_snapshot, memo, created_by, confirmed_by
  ) values (
    v_operation_id, 'payroll_payment', p_occurred_at, v_business_date, null, p_amount, null, null,
    'confirmed', 'manual', v_transaction_key,
    jsonb_build_object(
      'userId', p_user_id, 'employee', v_employee_name, 'paymentKind', 'advance',
      'payrollMonth', v_payroll_month, 'payrollAdjustmentId', v_adjustment.id, 'requestId', v_request_id
    ),
    v_memo, p_actor_user_id, p_actor_user_id
  ) returning * into v_transaction;
  insert into public.ledger_movements(transaction_id, fund_account_id, amount)
    values (v_transaction.id, p_from_account_id, -p_amount);
  insert into public.ledger_audit_logs(actor_user_id, action, entity_type, entity_id, after_snapshot, reason)
    values (p_actor_user_id, 'payroll_advance_payment_created', 'transaction', v_transaction.id,
      to_jsonb(v_transaction) || jsonb_build_object('payrollAdjustment', to_jsonb(v_adjustment)), v_memo);
  return jsonb_build_object(
    'status', 'created', 'transactionId', v_transaction.id, 'payrollAdjustmentId', v_adjustment.id,
    'operationId', v_operation_id, 'businessDate', v_business_date, 'sourceKey', v_transaction_key
  );
exception
  when unique_violation then return jsonb_build_object('status', 'request_conflict');
  when object_not_in_prerequisite_state then
    if sqlerrm like '%PAYROLL_ADJUSTMENT_LOCKED_FOR_PAID_EMPLOYEE%' then return jsonb_build_object('status', 'payroll_locked'); end if;
    raise;
  when check_violation or foreign_key_violation or not_null_violation or invalid_text_representation then
    return jsonb_build_object('status', 'invalid_input');
end `;

// Keep quoted SQL strings exact; ignore only line comments and unquoted whitespace.
export function advanceContractTokens(body){
 return (body.match(/'(?:''|[^'])*'|--[^\n]*|\s+|[a-zA-Z_][a-zA-Z_0-9$]*|[0-9]+|::|:=|<>|!=|[^\s']/g)||[]).filter(t=>!/^\s+$/.test(t)&&!t.startsWith('--'));
}
export function productionAdvanceContract(original){
 if(sha(advanceProductionBody)!==advanceProductionHash)throw Error('ADVANCE_PRODUCTION_SNAPSHOT_SHA');
 if(JSON.stringify(advanceContractTokens(original.body))!==JSON.stringify(advanceContractTokens(advanceProductionBody)))throw Error('ADVANCE_EXECUTABLE_CONTRACT_CHANGED');
 return {...original,body:advanceProductionBody,hash:advanceProductionHash,sql:original.sql.replace(original.body,()=>advanceProductionBody)};
}
