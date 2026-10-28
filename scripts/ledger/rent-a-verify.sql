-- Rent integration (A plan) — READ-ONLY verification. SELECT only.
-- Section A: run BEFORE installing the migrations and save the output.
-- Run all sections again AFTER install / seed and compare: every value in A must be identical.

-- A1. Closed months: status, revision, hash, operating result (expect 2026-08 and 2026-09 closed/rev4,
--     hashes ddfee6c7… / 5262cad6…, profit 267236765.578 / 70507820.4).
select month, status, revision, snapshot_hash,
  summary_snapshot->'operatingResult' as operating_result,
  summary_snapshot->'reserve'->>'totalProtectedReserve' as protected_reserve
from public.ledger_month_closures order by month;

-- A2. Fund account balances and the opening seed (expect opening 300,353,642 on 2026-08-01).
select m.fund_account_id, sum(m.amount) as balance
from public.ledger_movements m join public.ledger_transactions t on t.id = m.transaction_id
where t.status = 'confirmed' group by 1 order by 1;
select business_date, count(*), sum(amount) from public.ledger_transactions
where type = 'opening' and status = 'confirmed' group by 1;

-- A3. Ledger row fingerprints: nothing in the ledger may change.
select count(*) as tx_count, max(id) as tx_max_id,
  md5(string_agg(id || ':' || status || ':' || amount || ':' || coalesce(updated_at::text, ''), ',' order by id)) as tx_hash
from public.ledger_transactions;
select count(*) as movement_count, max(id) as movement_max_id,
  md5(string_agg(id || ':' || transaction_id || ':' || fund_account_id || ':' || amount, ',' order by id)) as movement_hash
from public.ledger_movements;

-- A4. Reserve history (expect entries #1 +60M, #2 +60M, #3 release 100M; balance 20M) and schedules.
select id, reserve_plan_id, entry_type, amount, occurred_at, memo from public.ledger_reserve_entries order by id;
select md5(string_agg(id || ':' || entry_type || ':' || amount || ':' || occurred_at, ',' order by id)) as reserve_entry_hash
from public.ledger_reserve_entries;
select id, scheduled_month, planned_amount, status, reserve_entry_id from public.ledger_reserve_scheduled_allocations order by id;
select id, target_amount, target_date, recurring_monthly_amount, recurring_start_month, fund_account_id
from public.ledger_reserve_plans order by id;

-- A5. Monthly rent recognitions stay as they are (#3302/#3305/#3306, 50M each, no movement).
select id, recognition_month, amount, status, source_key,
  (select count(*) from public.ledger_movements m where m.transaction_id = t.id) as movements
from public.ledger_transactions t where source_key like 'recurring:%' order by id;
select count(*) as july_rent_rows from public.ledger_transactions
where recognition_month = date '2026-07-01' and category_id = 3;

-- B. After install: objects, grants and security settings.
select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef, p.proconfig,
  has_function_privilege('anon', p.oid, 'execute') as anon_exec,
  has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
  has_function_privilege('service_role', p.oid, 'execute') as service_exec
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in (
  'ledger_rent_actor_can_write_v1', 'ledger_rent_ledger_start_v1', 'ledger_save_rent_contract_v1',
  'ledger_link_rent_payment_v1', 'ledger_record_pre_ledger_rent_payment_v1', 'ledger_reserve_insert_entry_v2',
  'ledger_create_reserve_entry_v2', 'ledger_generate_reserve_schedule_v2', 'ledger_confirm_reserve_schedule_v2')
order by 1;
select c.relname, c.relrowsecurity,
  has_table_privilege('anon', c.oid, 'select') as anon_select,
  has_table_privilege('authenticated', c.oid, 'select') as auth_select,
  has_table_privilege('service_role', c.oid, 'select') as service_select,
  has_table_privilege('service_role', c.oid, 'insert') as service_insert
from pg_class c where c.relname in ('ledger_rent_contracts', 'ledger_rent_contract_payments');
select column_name, data_type, is_nullable from information_schema.columns
where table_schema = 'public' and table_name = 'ledger_reserve_entries'
  and column_name in ('allocation_kind', 'restores_entry_id', 'attribution_month', 'request_key');
-- Existing reserve rows must keep NULL in every new column.
select count(*) filter (where allocation_kind is not null or restores_entry_id is not null
  or attribution_month is not null or request_key is not null) as legacy_rows_touched
from public.ledger_reserve_entries where id <= 3;

-- C. After seed: exactly 2 contracts, 2 payments, 600M paid on the current contract, no duplicate link.
select c.id, c.name, c.status, c.terms_status, c.period_start, c.period_end, c.annual_amount,
  c.recurring_plan_id, c.reserve_plan_id, coalesce(sum(p.amount), 0) as paid, count(p.id) as payments
from public.ledger_rent_contracts c left join public.ledger_rent_contract_payments p on p.contract_id = c.id
group by c.id order by c.id;
select id, contract_id, source, payment_transaction_id, pre_ledger_reference, paid_on, amount, fund_account_id
from public.ledger_rent_contract_payments order by id;
select action, entity_type, count(*) from public.ledger_audit_logs
where entity_type in ('rent_contract', 'rent_contract_payment') group by 1, 2 order by 1, 2;
