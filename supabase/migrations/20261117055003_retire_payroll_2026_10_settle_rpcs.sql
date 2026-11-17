-- LEGACY-CLEANUP-P1: retire the one-off 2026-10 special settlement RPCs.
--
-- 2026-10 payroll was settled once (batch 4, 17/17) through
-- payroll_settle_2026_10_v1 (migration 20261116163616). The app path that called
-- it was removed; nothing in the database references either function (no
-- callers, views, triggers, policies or cron jobs).
--
-- Drops ONLY these two functions, each by exact signature with RESTRICT (no
-- CASCADE). Not touched: every table and row (payroll, allocations, residuals,
-- settlement requests, audit logs, ledger), and the shared objects from
-- 20261116163616 that other months keep using (ledger_project_payroll_payment_group_v1,
-- payroll_cancel_employee_payment_v3, payroll_refresh_payment_tax_totals_v1).
--
-- Guard: if a 2026-10 payroll batch exists it must be the completed 17/17
-- special settlement with exactly one request and one applied audit row;
-- otherwise abort and drop nothing. A database without a 2026-10 batch (fresh
-- replay) has nothing to protect and the drop proceeds.
--
-- Recovery: re-run the two "create or replace function" blocks and their
-- revoke/grant lines from 20261116163616_payroll_2026_10_special_settlement.sql
-- (production bodies were verified byte-identical to that file before retirement).
begin;
set local lock_timeout = '5s';

do $$
declare
  v_run public.payroll_payment_batches%rowtype;
begin
  select * into v_run from public.payroll_payment_batches where payroll_month = date '2026-10-01';
  if v_run.id is not null and (
       v_run.status <> 'completed'
       or v_run.paid_employee_count <> 17
       or v_run.target_employee_count <> 17
       or (select count(*) from public.payroll_special_settlement_requests where payroll_month = date '2026-10-01') <> 1
       or (select count(*) from public.payroll_payment_audit_logs
           where payroll_batch_id = v_run.id and action = 'special_settlement_applied') <> 1) then
    raise exception 'PAYROLL_2026_10_SETTLEMENT_RETIRE_PRECONDITION' using errcode = '55000';
  end if;
end;
$$;

drop function public.payroll_settle_2026_10_v1(date,jsonb,jsonb,jsonb,jsonb,text,text,text,bigint,text,jsonb,bigint) restrict;
drop function public.payroll_settle_2026_10_final_state_v1(date,jsonb,bigint,bigint,bigint) restrict;

do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname like 'payroll\_settle\_2026\_10\_%') then
    raise exception 'PAYROLL_2026_10_SETTLE_RPC_STILL_PRESENT' using errcode = '55000';
  end if;
  if to_regprocedure('public.ledger_project_payroll_payment_group_v1(date,date,bigint,bigint)') is null
     or to_regprocedure('public.payroll_cancel_employee_payment_v3(bigint,bigint,text,bigint)') is null
     or to_regprocedure('public.payroll_refresh_payment_tax_totals_v1(bigint)') is null then
    raise exception 'PAYROLL_SHARED_SPLIT_FUNCTION_MISSING' using errcode = '55000';
  end if;
end;
$$;

commit;
