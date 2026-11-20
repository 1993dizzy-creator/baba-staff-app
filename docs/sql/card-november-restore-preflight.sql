-- Read-only preflight for 20261120121505_restore_november_card_deposit_allocations.sql.
-- Expected (Production 2026-11-20): 8 rows #80-#87, all 'unmatched', 0 lines, 123,671,891 total;
-- no other unmatched/partial reconciliation; November open; October outstanding = provisional fee 5,699,112.

-- 1. Targets exactly as verified.
select r.id, r.deposit_transaction_id, r.deposit_date, r.deposit_amount, r.status, r.matched_gross_amount,
  (select count(*) from ledger_card_reconciliation_lines l where l.reconciliation_id = r.id) as lines,
  d.status as deposit_status, d.amount as deposit_tx_amount,
  (select json_agg(json_build_object('account', f.code, 'amount', m.amount) order by m.id)
     from ledger_movements m join ledger_fund_accounts f on f.id = m.fund_account_id where m.transaction_id = d.id) as movements
from ledger_card_reconciliations r join ledger_transactions d on d.id = r.deposit_transaction_id
where r.id between 80 and 87 order by r.id;

-- 2. Any other unresolved legacy deposit (must be empty).
select id, deposit_date, deposit_amount, status from ledger_card_reconciliations
where status in ('unmatched', 'partial') and id not between 80 and 87;

-- 3. Card sales by month (gross / consumed / outstanding) and month close state.
with s as (
  select t.business_date, t.amount,
    coalesce((select sum(l.allocated_gross_amount) from ledger_card_reconciliation_lines l join ledger_card_reconciliations r on r.id = l.reconciliation_id
              where l.pos_card_transaction_id = t.id and r.status <> 'cancelled'), 0)
    + coalesce((select sum(f.allocated_fee_amount) from ledger_card_fee_allocation_lines f join ledger_card_fee_closures c on c.id = f.closure_id
              where f.pos_card_transaction_id = t.id and c.status <> 'cancelled'), 0) as consumed
  from ledger_transactions t
  where t.status = 'confirmed' and t.source_type = 'pos_sales_daily_payment' and t.source_key like 'pos:%:card'),
g as (select date_trunc('month', business_date)::date as month, sum(amount) as gross, sum(consumed) as consumed, sum(amount - consumed) as outstanding,
        count(*) filter (where consumed > amount) as over_consumed from s group by 1)
select g.*, (select string_agg(status, ',') from ledger_month_closures mc where mc.month = g.month) as closure
from g order by month;

-- 4. Card clearing / corporate bank balances (must be identical in the postflight).
select f.code, sum(m.amount) as balance
from ledger_movements m join ledger_transactions t on t.id = m.transaction_id and t.status = 'confirmed'
join ledger_fund_accounts f on f.id = m.fund_account_id
where f.code in ('card_clearing', 'baba_corporate_bank') group by f.code;

-- 5. Protected fee evidence: Sept closure #1, October manual fee #4119, audit #8257.
select id, fee_month, fee_amount, status from ledger_card_fee_closures order by id;
select id, type, source_type, status, recognition_month, amount from ledger_transactions where id = 4119;
select id, action, entity_id, created_at from ledger_audit_logs where id = 8257;
