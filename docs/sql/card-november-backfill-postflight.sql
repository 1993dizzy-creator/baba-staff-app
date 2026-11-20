-- Read-only postflight for 20261120134158_backfill_november_18_19_card_deposits.sql.
-- Expected: two new auto_allocated deposits (11/18 10,087,054 / 11/19 14,545,476), lines in deposit-date FIFO:
--   11/18: 4985 226,971 + 5022 1,717,600 + 5050 8,142,483
--   11/19: 5050 2,145,417 + 5109 12,400,059
--   #88 (11/20): 5109 6,837,115
-- card clearing 4,792,926 (if no new card sale was synced in between) = outstanding 5109 930,526 + 5173 3,862,400;
-- #88 row, tx #5200 and its movements unchanged; no fee closure; preflight 6 unchanged.

-- 1. Late deposits and their lines.
select r.id, r.deposit_transaction_id, r.deposit_date, r.deposit_amount, r.status, r.matched_gross_amount,
  l.pos_card_transaction_id as sale, s.business_date as sale_date, l.allocated_gross_amount
from ledger_card_reconciliations r
join ledger_card_reconciliation_lines l on l.reconciliation_id = r.id
join ledger_transactions s on s.id = l.pos_card_transaction_id
where r.deposit_date >= '2026-11-18' and r.status <> 'cancelled'
order by r.deposit_date, r.id, s.business_date;

-- 2. New deposit transactions and movements.
select t.id, t.business_date, t.amount, t.status, t.memo, f.code, m.amount
from ledger_transactions t join ledger_movements m on m.transaction_id = t.id join ledger_fund_accounts f on f.id = m.fund_account_id
where t.type = 'card_settlement_deposit' and t.amount in (10087054, 14545476) order by t.id, m.id;

-- 3. Audits added by the migration (2 auto_allocated, 3 resequenced, 1 summary).
select id, action, entity_id, created_at from ledger_audit_logs
where action in ('november_card_deposits_backfilled', 'card_deposit_allocation_resequenced')
   or (action = 'card_deposit_auto_allocated' and (after_snapshot->>'depositAmount')::numeric in (10087054, 14545476))
order by id;

-- 4. Over-consumed sales (must be empty) and the outstanding late-November sales.
select t.id from ledger_transactions t where t.source_type = 'pos_sales_daily_payment' and t.status = 'confirmed'
  and ledger_card_sale_consumed_v1(t.id) > t.amount;
select t.id, t.business_date, t.amount - ledger_card_sale_consumed_v1(t.id) as outstanding
from ledger_transactions t
where t.status = 'confirmed' and t.source_type = 'pos_sales_daily_payment' and t.source_key like 'pos:%:card' and t.business_date >= '2026-11-15'
order by t.business_date;

-- 5. Re-run preflight 5 and 6.
