-- Read-only preflight for 20261120134158_backfill_november_18_19_card_deposits.sql.
-- Expected (Production 2026-11-20): 20261120121505 applied; #88 = tx #5200, 11/20, 6,837,115, lines
-- 4985:226,971 / 5022:1,717,600 / 5050:4,892,544; no deposit with 10,087,054 or 14,545,476; no other deposit dated
-- on/after 11/18; outstanding 5050:5,395,356 / 5109:20,167,700 / 5173:3,862,400; card clearing 29,425,456.

-- 1. #88 and its lines.
select r.id, r.deposit_transaction_id, r.deposit_date, r.deposit_amount, r.status, r.matched_gross_amount,
  (select json_agg(json_build_object('sale', l.pos_card_transaction_id, 'amount', l.allocated_gross_amount) order by l.pos_card_transaction_id)
     from ledger_card_reconciliation_lines l where l.reconciliation_id = r.id) as lines
from ledger_card_reconciliations r where r.id = 88;

-- 2. Duplicates and out-of-scope late deposits (both must be empty).
select 'reconciliation' as kind, id, deposit_date::text, deposit_amount, status from ledger_card_reconciliations where deposit_amount in (10087054, 14545476)
union all select 'transaction', id, business_date::text, amount, status from ledger_transactions where type = 'card_settlement_deposit' and amount in (10087054, 14545476);
select id, deposit_date, deposit_amount, status from ledger_card_reconciliations where status <> 'cancelled' and deposit_date >= '2026-11-18' and id <> 88;

-- 3. Outstanding November card sales (only 5050, 5109, 5173 may be non-zero before 11/20).
select t.id, t.business_date, t.amount, t.amount - ledger_card_sale_consumed_v1(t.id) as outstanding
from ledger_transactions t
where t.status = 'confirmed' and t.source_type = 'pos_sales_daily_payment' and t.source_key like 'pos:%:card' and t.business_date >= '2026-11-12'
order by t.business_date, t.id;

-- 4. Prerequisites: restore applied, nothing unresolved, November open, no November fee closure.
select (select count(*) from ledger_audit_logs where action = 'november_card_deposit_allocations_restored') as restore_summary,
  (select count(*) from ledger_card_reconciliations where status in ('unmatched', 'partial')) as unresolved,
  (select string_agg(status, ',') from ledger_month_closures where month = '2026-11-01') as november_closure,
  (select count(*) from ledger_card_fee_closures where fee_month >= '2026-11-01' and status = 'confirmed') as november_fee,
  (select count(*) from ledger_audit_logs where action = 'november_card_deposits_backfilled') as already_backfilled;

-- 5. Balances (re-run in the postflight: clearing -24,632,530, bank +24,632,530).
select f.code, sum(m.amount) as balance
from ledger_movements m join ledger_transactions t on t.id = m.transaction_id and t.status = 'confirmed'
join ledger_fund_accounts f on f.id = m.fund_account_id
where f.code in ('card_clearing', 'baba_corporate_bank') group by f.code;

-- 6. Protected fee evidence: Sept closure #1, October manual fee #4119, audit #8257.
select id, fee_month, fee_amount, status from ledger_card_fee_closures order by id;
select id, type, status, recognition_month, amount from ledger_transactions where id = 4119;
select id, action, entity_id from ledger_audit_logs where id = 8257;
