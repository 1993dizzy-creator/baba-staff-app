begin;

-- Salary advance paid from the ledger's manual entry sheet (지출 → 👥 가불).
-- This is the only write path for new advances; /api/admin/payroll/adjustments
-- rejects kind='advance'.
--
-- Reuses the contract of the existing production advance rows:
--   * payroll_monthly_adjustments(kind='advance', category='advance') — the
--     source of payroll advanceAmount, deducted from the month's net payout;
--   * ledger_transactions(type='payroll_payment', source_type='manual',
--     source_key starting 'payroll-advance-payment:<business_date>:user:<user_id>',
--     no category, no recognition_month) — a cash outflow, never a P&L expense
--     (labor cost is recognized once by the payroll batch expense_recognition);
--   * one negative ledger_movements row on the paying fund account;
--   * ledger_audit_logs action 'payroll_advance_payment_created'.
-- All four writes happen in this function's transaction: any failure rolls
-- back every row, so an advance is never deducted without its cash movement.
--
-- Idempotency: p_request_id is a client-generated UUID per submission.
--   adjustment source_key  = 'ledger-payroll-advance:<request_id>'
--   transaction source_key = 'payroll-advance-payment:<date>:user:<id>:<request_id>'
-- Both are covered by the existing (source_type, source_key) unique indexes.
-- Replaying a request returns the rows it already created ('duplicate');
-- reusing a request id for a different advance returns 'request_conflict'.
-- A different request id for the same employee and day is a separate advance.
-- Historical keys (payroll-advance-payment:<date>:user:<id>) are untouched.
create or replace function public.ledger_create_payroll_advance_payment_v1(
  p_request_id text,
  p_user_id bigint,
  p_amount numeric,
  p_occurred_at timestamptz,
  p_from_account_id bigint,
  p_memo text,
  p_actor_user_id bigint
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
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
  -- Same business-date cutoff as ledger_create_manual_transaction_v1.
  v_business_date := ((p_occurred_at at time zone 'Asia/Ho_Chi_Minh') - interval '3 hours')::date;
  v_payroll_month := date_trunc('month', v_business_date)::date;
  v_adjustment_key := 'ledger-payroll-advance:' || v_request_id;
  v_transaction_key := format('payroll-advance-payment:%s:user:%s:%s', v_business_date, p_user_id, v_request_id);

  -- Serialize retries of the same request, then answer a replay from its rows.
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
    where f.id = p_from_account_id and f.is_active = true and f.is_business_fund = true and f.type <> 'card_clearing'
  ) then return jsonb_build_object('status', 'invalid_accounts'); end if;
  select * into v_user from public.users
    where id = p_user_id and is_active = true and is_system_account = false;
  if not found then return jsonb_build_object('status', 'employee_not_found'); end if;
  -- Same rule as lib/payroll/eligibility.ts isPayrollEligible().
  if not coalesce(v_user.payroll_eligible_override, lower(coalesce(v_user.role::text, '')) not in ('owner', 'master')) then
    return jsonb_build_object('status', 'employee_not_payroll_eligible');
  end if;
  -- Same month-close lock as ledger month close and card fee cancel.
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
  -- Each branch returns after PL/pgSQL has rolled back every write in this block.
  when unique_violation then return jsonb_build_object('status', 'request_conflict');
  when object_not_in_prerequisite_state then
    -- payroll_lock_paid_month_adjustments_v1: the employee is already paid for this month.
    if sqlerrm like '%PAYROLL_ADJUSTMENT_LOCKED_FOR_PAID_EMPLOYEE%' then return jsonb_build_object('status', 'payroll_locked'); end if;
    raise;
  when check_violation or foreign_key_violation or not_null_violation or invalid_text_representation then
    return jsonb_build_object('status', 'invalid_input');
end $$;

revoke all on function public.ledger_create_payroll_advance_payment_v1(text, bigint, numeric, timestamptz, bigint, text, bigint) from public, anon, authenticated;
grant execute on function public.ledger_create_payroll_advance_payment_v1(text, bigint, numeric, timestamptz, bigint, text, bigint) to service_role;

-- Cancels an advance created by ledger_create_payroll_advance_payment_v1 — the
-- only way to cancel one (/api/admin/payroll/adjustments refuses ledger-origin
-- advances). Append-only, like ledger_cancel_card_fee_month_v1: the original
-- payroll_payment and its movement are kept; a reversal transaction
-- (economic_effect_sign -1, correction_of_id = original) carries the opposite
-- movement on the same fund account, and the payroll advance adjustment is
-- cancelled so it leaves advanceAmount. The reversal sits on the original
-- business date so the month's cash outflow nets to zero; P&L is untouched
-- because neither row is an expense. Historical advances (keys without a
-- request id) are not eligible.
create or replace function public.ledger_cancel_payroll_advance_payment_v1(
  p_transaction_id bigint,
  p_reason text,
  p_actor_user_id bigint
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_role text;
  v_reason text := nullif(btrim(p_reason), '');
  v_business_date date;
  v_month date;
  v_request_id text;
  v_adjustment_key text;
  v_reversal_key text;
  v_original public.ledger_transactions%rowtype;
  v_adjustment public.payroll_monthly_adjustments%rowtype;
  v_movement public.ledger_movements%rowtype;
  v_reversal public.ledger_transactions%rowtype;
begin
  select lower(role::text) into v_role from public.users
    where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then return jsonb_build_object('status', 'forbidden'); end if;
  if v_reason is null then return jsonb_build_object('status', 'reason_required'); end if;

  select business_date into v_business_date from public.ledger_transactions where id = p_transaction_id;
  if v_business_date is null then return jsonb_build_object('status', 'not_found'); end if;
  v_month := date_trunc('month', v_business_date)::date;
  perform pg_advisory_xact_lock(hashtext('ledger_month_close:' || to_char(v_month, 'YYYY-MM')));

  select * into v_original from public.ledger_transactions where id = p_transaction_id for update;
  v_request_id := substring(v_original.source_key from '^payroll-advance-payment:\d{4}-\d{2}-\d{2}:user:\d+:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');
  if v_original.type <> 'payroll_payment' or v_original.source_type <> 'manual' or v_request_id is null
     or v_original.source_snapshot->>'paymentKind' is distinct from 'advance'
     or v_original.source_snapshot->>'requestId' is distinct from v_request_id then
    return jsonb_build_object('status', 'not_ledger_payroll_advance');
  end if;
  v_adjustment_key := 'ledger-payroll-advance:' || v_request_id;
  v_reversal_key := v_adjustment_key || ':reversal';

  select * into v_adjustment from public.payroll_monthly_adjustments
    where source_type = 'manual' and source_key = v_adjustment_key for update;
  if not found or v_adjustment.kind <> 'advance' or v_adjustment.amount <> v_original.amount
     or v_adjustment.user_id::text is distinct from v_original.source_snapshot->>'userId' then
    return jsonb_build_object('status', 'invalid_state');
  end if;

  -- Idempotent: a second cancel returns the reversal already written.
  select * into v_reversal from public.ledger_transactions
    where source_type = 'payroll_advance_payment_reversal' and source_key = v_reversal_key;
  if found then
    return jsonb_build_object('status', 'already_cancelled', 'transactionId', v_original.id,
      'reversalTransactionId', v_reversal.id, 'payrollAdjustmentId', v_adjustment.id, 'cancelledAt', v_adjustment.cancelled_at);
  end if;
  if v_adjustment.cancelled_at is not null then return jsonb_build_object('status', 'invalid_state'); end if;
  if public.ledger_month_is_closed_v1(v_month) then return jsonb_build_object('status', 'month_closed'); end if;

  select * into v_movement from public.ledger_movements where transaction_id = v_original.id;
  if (select count(*) from public.ledger_movements where transaction_id = v_original.id) <> 1
     or v_movement.amount <> -v_original.amount then
    return jsonb_build_object('status', 'invalid_state');
  end if;

  -- payroll_lock_paid_month_adjustments_v1 fires here when the employee's
  -- month is already paid; the handler below turns it into payroll_locked.
  update public.payroll_monthly_adjustments
    set cancelled_at = now(), cancelled_by = p_actor_user_id, cancellation_reason = v_reason
    where id = v_adjustment.id;

  insert into public.ledger_transactions(
    operation_id, type, occurred_at, business_date, recognition_month, amount, category_id, party_id,
    status, source_type, source_key, source_snapshot, source_fingerprint, source_synced_at,
    correction_of_id, memo, created_by, confirmed_by, economic_effect_sign
  ) values (
    gen_random_uuid(), 'payroll_payment', v_original.occurred_at, v_original.business_date, null, v_original.amount, null, null,
    'confirmed', 'payroll_advance_payment_reversal', v_reversal_key,
    jsonb_build_object(
      'originalTransactionId', v_original.id, 'payrollAdjustmentId', v_adjustment.id, 'requestId', v_request_id,
      'userId', v_adjustment.user_id, 'paymentKind', 'advance_cancellation', 'cancelReason', v_reason
    ),
    md5(v_reversal_key), now(), v_original.id, '가불 취소 역분개: ' || v_reason,
    p_actor_user_id, p_actor_user_id, -1
  ) returning * into v_reversal;

  insert into public.ledger_movements(transaction_id, fund_account_id, amount)
    values (v_reversal.id, v_movement.fund_account_id, -v_movement.amount);

  insert into public.ledger_audit_logs(actor_user_id, action, entity_type, entity_id, before_snapshot, after_snapshot, reason)
    values (p_actor_user_id, 'payroll_advance_payment_cancelled', 'transaction', v_original.id,
      jsonb_build_object('transaction', to_jsonb(v_original), 'payrollAdjustment', to_jsonb(v_adjustment)),
      jsonb_build_object(
        'reversalTransactionId', v_reversal.id,
        'payrollAdjustment', (select to_jsonb(a) from public.payroll_monthly_adjustments a where a.id = v_adjustment.id),
        'restoredFundAccountId', v_movement.fund_account_id, 'restoredAmount', -v_movement.amount
      ),
      v_reason);

  return jsonb_build_object('status', 'cancelled', 'transactionId', v_original.id,
    'reversalTransactionId', v_reversal.id, 'payrollAdjustmentId', v_adjustment.id);
exception
  -- Each branch returns after PL/pgSQL has rolled back every write in this block.
  when unique_violation then return jsonb_build_object('status', 'already_cancelled', 'transactionId', p_transaction_id);
  when object_not_in_prerequisite_state then
    if sqlerrm like '%PAYROLL_ADJUSTMENT_LOCKED_FOR_PAID_EMPLOYEE%' then return jsonb_build_object('status', 'payroll_locked'); end if;
    raise;
  when raise_exception then
    if sqlerrm = 'LEDGER_MONTH_CLOSED' then return jsonb_build_object('status', 'month_closed'); end if;
    raise;
end $$;

revoke all on function public.ledger_cancel_payroll_advance_payment_v1(bigint, text, bigint) from public, anon, authenticated;
grant execute on function public.ledger_cancel_payroll_advance_payment_v1(bigint, text, bigint) to service_role;

commit;
