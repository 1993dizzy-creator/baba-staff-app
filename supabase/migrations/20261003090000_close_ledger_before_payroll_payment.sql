-- Ledger month close no longer waits for payroll payment.
--
-- BABA pays a month's salaries around the 10th of the next month, after that
-- month's ledger is closed. Until the payroll batch completes, ledger P&L shows a
-- predicted payroll cost (display layer only, never a ledger transaction). When the
-- batch completes, the existing payroll_completed_batch expense_recognition is
-- booked to the payroll month, even if that month is already closed; the salary
-- cash movements stay on their payment dates.
--
-- 1. ledger_close_preflight_v1: drop only the PAYROLL_NOT_COMPLETED blocker
--    (patched in place like 20260921170100 / 20260927173019 / 20261001193526, so
--    every other blocker, warning and the preflight hash stay exactly as deployed).
-- 2. ledger_payroll_finalization_allowed_v1 + ledger_transaction_month_guard_v1:
--    a closed recognition month accepts exactly one row — the first completed-batch
--    company-cost recognition, flagged by the payroll sync in this transaction and
--    matching the completed batch's month and actual_company_cost_total. Any other
--    write to a closed month is still rejected.
-- 3. ledger_sync_payroll_company_cost_v2: when the payroll month is closed and no
--    recognition exists yet, book it through v1 (it used to return "unchanged" and
--    silently skip the cost). An existing recognition keeps the drift path.
-- 4. ledger_sync_payroll_company_cost_v1: the recognition's business_date is the
--    Vietnam (Asia/Ho_Chi_Minh) calendar date of completed_at, not its UTC date
--    (a batch completed 2026-10-01 01:00 ICT = 2026-09-30 18:00 UTC belongs to
--    2026-10-01). recognition_month stays the payroll month. Payroll cash movements
--    (payment_date) are untouched.
-- No data is changed by this migration.

do $preflight_payroll$
declare
  v_definition text;
  v_check text := $check$ if exists(select 1 from public.payroll_payment_batches where payroll_month=p_month and status<>'completed')or((select min(payroll_month)from public.payroll_payment_batches)<=p_month and not exists(select 1 from public.payroll_payment_batches where payroll_month=p_month and status='completed')) then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','PAYROLL_NOT_COMPLETED'));end if;$check$;
begin
  v_definition := pg_get_functiondef('public.ledger_close_preflight_v1(date,bigint)'::regprocedure);
  -- Already applied: nothing to do.
  if position('PAYROLL_NOT_COMPLETED' in v_definition) = 0 then
    return;
  end if;
  if (length(v_definition) - length(replace(v_definition, v_check, ''))) / length(v_check) <> 1 then
    raise exception 'PAYROLL_PREFLIGHT_CONTRACT_MISMATCH';
  end if;
  v_definition := replace(v_definition, v_check, '');
  if position('PAYROLL_NOT_COMPLETED' in v_definition) > 0 then
    raise exception 'PAYROLL_PREFLIGHT_CONTRACT_MISMATCH';
  end if;
  execute v_definition;
end;
$preflight_payroll$;

do $payroll_business_date$
declare
  v_definition text;
  v_utc_date text := $utc$coalesce((v_snapshot->>'completed_at')::timestamptz::date,$utc$;
  v_local_date text := $local$coalesce(((v_snapshot->>'completed_at')::timestamptz at time zone 'Asia/Ho_Chi_Minh')::date,$local$;
begin
  v_definition := pg_get_functiondef('public.ledger_sync_payroll_company_cost_v1(jsonb,bigint)'::regprocedure);
  -- Already applied: nothing to do.
  if position(v_local_date in v_definition) > 0 and position(v_utc_date in v_definition) = 0 then
    return;
  end if;
  if (length(v_definition) - length(replace(v_definition, v_utc_date, ''))) / length(v_utc_date) <> 1 then
    raise exception 'PAYROLL_COMPANY_COST_CONTRACT_MISMATCH';
  end if;
  execute replace(v_definition, v_utc_date, v_local_date);
end;
$payroll_business_date$;

create or replace function public.ledger_payroll_finalization_allowed_v1(p_tx public.ledger_transactions)
returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select p_tx.type = 'expense_recognition'
    and p_tx.status = 'confirmed'
    and p_tx.source_type = 'payroll_completed_batch'
    and coalesce(p_tx.economic_effect_sign, 1) = 1
    and p_tx.recognition_month is not null
    and p_tx.source_key = 'payroll-batch:' || split_part(p_tx.source_key, ':', 2) || ':company-cost'
    and coalesce(current_setting('ledger.payroll_finalization_batch', true), '') = split_part(p_tx.source_key, ':', 2)
    and exists(
      select 1 from public.payroll_payment_batches b
      where b.id::text = split_part(p_tx.source_key, ':', 2)
        and b.status = 'completed'
        and b.payroll_month = p_tx.recognition_month
        and b.actual_company_cost_total = p_tx.amount
        -- Same contract as v1: the Vietnam calendar date of the batch completion.
        and b.completed_at is not null
        and p_tx.business_date = (b.completed_at at time zone 'Asia/Ho_Chi_Minh')::date
    )
    and not exists(
      select 1 from public.ledger_transactions t
      where t.source_type = 'payroll_completed_batch' and t.source_key = p_tx.source_key
    )
    and public.ledger_month_is_closed_v1(p_tx.recognition_month)
    and date_trunc('month', p_tx.business_date)::date > p_tx.recognition_month
$$;

do $month_guard_payroll$
declare
  v_definition text;
  v_anchor text := $anchor$ if tg_op<>'INSERT' then v_old_month:=old.recognition_month;$anchor$;
  v_branch text := $branch$ if tg_op='INSERT' and public.ledger_payroll_finalization_allowed_v1(new) then
  perform public.ledger_assert_month_open_v1(date_trunc('month',new.business_date)::date);
  return new;
 end if;
$branch$;
begin
  v_definition := pg_get_functiondef('public.ledger_transaction_month_guard_v1()'::regprocedure);
  if position('ledger_payroll_finalization_allowed_v1' in v_definition) > 0 then
    return;
  end if;
  if (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception 'LEDGER_MONTH_GUARD_CONTRACT_MISMATCH';
  end if;
  v_definition := replace(v_definition, v_anchor, v_branch || v_anchor);
  execute v_definition;
end;
$month_guard_payroll$;

create or replace function public.ledger_sync_payroll_company_cost_v2(p_row jsonb, p_actor_user_id bigint)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_role text;
  v_month date;
  v_tx public.ledger_transactions%rowtype;
  v_result jsonb;
begin
  select lower(role::text) into v_role from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then return jsonb_build_object('status', 'forbidden'); end if;
  v_month := (p_row->>'payrollMonth')::date;
  if not public.ledger_month_is_closed_v1(v_month) then
    return public.ledger_sync_payroll_company_cost_v1(p_row, p_actor_user_id);
  end if;
  select * into v_tx from public.ledger_transactions
  where source_type = 'payroll_completed_batch' and source_key = 'payroll-batch:' || (p_row->>'batchId') || ':company-cost';
  if v_tx.id is null then
    -- Close-first policy: the payroll month was closed before its payment completed.
    -- Book the first completed-batch recognition to that month (guard exception above).
    if coalesce((p_row->>'completed')::boolean, false) and coalesce((p_row->>'amount')::numeric, 0) > 0 then
      perform set_config('ledger.payroll_finalization_batch', p_row->>'batchId', true);
      v_result := public.ledger_sync_payroll_company_cost_v1(p_row, p_actor_user_id);
      perform set_config('ledger.payroll_finalization_batch', '', true);
      return v_result || jsonb_build_object('closedMonth', true, 'finalizedAfterClose', true);
    end if;
    return jsonb_build_object('status', 'unchanged', 'unchangedCount', 1, 'driftCount', 0, 'closedMonth', true);
  end if;
  if v_tx.source_fingerprint = p_row->>'fingerprint' then
    return jsonb_build_object('status', 'unchanged', 'unchangedCount', 1, 'driftCount', 0, 'closedMonth', true);
  end if;
  v_result := public.ledger_record_source_drift_v1(v_tx.id, p_row->>'fingerprint', (p_row->>'amount')::numeric, p_row->'snapshot', p_actor_user_id);
  return jsonb_build_object('status', 'drift', 'unchangedCount', 0,
    'driftCount', case when v_result->>'status' = 'created' then 1 else 0 end, 'closedMonth', true);
end
$$;

alter function public.ledger_payroll_finalization_allowed_v1(public.ledger_transactions) owner to postgres;
revoke all on function public.ledger_payroll_finalization_allowed_v1(public.ledger_transactions) from public, anon, authenticated, service_role;
revoke all on function public.ledger_sync_payroll_company_cost_v2(jsonb, bigint) from public, anon, authenticated;
grant execute on function public.ledger_sync_payroll_company_cost_v2(jsonb, bigint) to service_role;
