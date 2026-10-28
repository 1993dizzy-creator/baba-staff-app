-- Rent integration (A plan) — one-off production data seed. RUN ONLY WITH EXPLICIT APPROVAL,
-- after 20261028140000_add_rent_contracts.sql and 20261028140100_reserve_allocation_kinds_v2.sql
-- are installed and scripts/ledger/rent-a-verify.sql (section A) has been captured.
--
-- Writes (through the validated RPCs, one transaction):
--   ledger_rent_contracts          +2  (current 2026-07~2027-06 active/provisional; next 2027-07~2028-06 planned/provisional)
--   ledger_rent_contract_payments  +2  (#1304 ledger link; 2026-07-03 pre-ledger Sheet evidence)
--   ledger_audit_logs              +4
-- Never writes ledger_transactions, ledger_movements, reserve entries/plans/schedules,
-- recurring plans or month closures. No July ledger row is created.
-- Actor: user #1 (active master). Rollback: scripts/ledger/rent-a-rollback.sql section 1.

begin;
set local lock_timeout = '5s';

do $$
declare
  v_result jsonb;
  v_current bigint;
  v_next bigint;
begin
  if exists (select 1 from public.ledger_rent_contracts) then
    raise exception 'RENT_SEED_ALREADY_APPLIED';
  end if;
  -- Preconditions: the rows this seed points at must be exactly what was reviewed.
  if not exists (select 1 from public.ledger_recurring_expense_plans
    where id = 3 and is_active and amount = 50000000 and source_key_prefix = 'store-rent' and effective_from = date '2026-08-01') then
    raise exception 'RENT_SEED_PRECONDITION: recurring plan #3';
  end if;
  if not exists (select 1 from public.ledger_reserve_plans
    where id = 1 and is_active and target_amount = 720000000 and target_date = date '2027-07-01'
      and recurring_monthly_amount = 60000000 and recurring_start_month = date '2026-09-01') then
    raise exception 'RENT_SEED_PRECONDITION: reserve plan #1';
  end if;
  if not exists (select 1 from public.ledger_transactions
    where id = 1304 and type = 'prepaid_expense_payment' and status = 'confirmed' and amount = 300000000 and business_date = date '2026-08-11') then
    raise exception 'RENT_SEED_PRECONDITION: transaction #1304';
  end if;
  if public.ledger_rent_ledger_start_v1() is distinct from date '2026-08-01' then
    raise exception 'RENT_SEED_PRECONDITION: ledger start';
  end if;

  v_result := public.ledger_save_rent_contract_v1(null, jsonb_build_object(
    'name', '매장 임대 (현 계약)',
    'periodStart', '2026-07-01', 'periodEnd', '2027-06-30',
    'annualAmount', 600000000, 'monthlyExpenseAmount', 50000000,
    'status', 'active', 'termsStatus', 'provisional',
    'recurringPlanId', 3,
    'memo', '기간·납부기한 잠정(계약서 확인 전). 7/3 300M(원장 이전) + 8/11 300M(#1304) 지급.'), 1);
  if v_result->>'status' <> 'saved' then raise exception 'RENT_SEED_FAILED: current contract %', v_result; end if;
  v_current := (v_result->>'contractId')::bigint;

  v_result := public.ledger_save_rent_contract_v1(null, jsonb_build_object(
    'name', '매장 임대 (차기 계약)',
    'periodStart', '2027-07-01', 'periodEnd', '2028-06-30',
    'annualAmount', 720000000,
    'status', 'planned', 'termsStatus', 'provisional',
    'reservePlanId', 1,
    'memo', '예상 연 720M. 납부 방식·기한 미확정.'), 1);
  if v_result->>'status' <> 'saved' then raise exception 'RENT_SEED_FAILED: next contract %', v_result; end if;
  v_next := (v_result->>'contractId')::bigint;

  v_result := public.ledger_record_pre_ledger_rent_payment_v1(v_current, 'sheet:2026-07:row:33',
    date '2026-07-03', 300000000, 2, '7월 시트 33행 tien nha · 법인계좌. 8/1 개시잔액에 이미 반영(신규 현금 지출 아님).', 1);
  if v_result->>'status' <> 'recorded' then raise exception 'RENT_SEED_FAILED: pre-ledger payment %', v_result; end if;

  v_result := public.ledger_link_rent_payment_v1(v_current, 1304, null, '8월 시트 132행 · 원장 #1304', 1);
  if v_result->>'status' <> 'linked' then raise exception 'RENT_SEED_FAILED: link #1304 %', v_result; end if;
end
$$;

-- Must show exactly 2 contracts and 2 payments totalling 600,000,000.
select c.id, c.name, c.status, c.terms_status, c.period_start, c.period_end, c.annual_amount,
  coalesce(sum(p.amount), 0) as paid, count(p.id) as payments
from public.ledger_rent_contracts c
left join public.ledger_rent_contract_payments p on p.contract_id = c.id
group by c.id order by c.id;

commit;
