-- Read-only postflight for 20261120121505 (and 20261120121506 when applied).
-- Expected: #80-#87 'auto_allocated', lines = deposit (total 123,671,891), only November sales dated on/before
-- each deposit; balances identical to the preflight; November outstanding 36,262,571 if no sale/deposit changed
-- in between; 8 'card_deposit_allocation_restored' + 1 'november_card_deposit_allocations_restored' audits;
-- no unmatched/partial reconciliation; no new transaction, movement or fee closure.

-- 1. Restored targets.
select r.id, r.status, r.deposit_amount, r.matched_gross_amount, r.difference_amount,
  coalesce(sum(l.allocated_gross_amount), 0) as allocated, count(l.id) as lines,
  min(s.business_date) as first_sale, max(s.business_date) as last_sale, r.deposit_date,
  bool_and(s.business_date <= r.deposit_date and date_trunc('month', s.business_date) = date '2026-11-01') as dates_ok
from ledger_card_reconciliations r
left join ledger_card_reconciliation_lines l on l.reconciliation_id = r.id
left join ledger_transactions s on s.id = l.pos_card_transaction_id
where r.id between 80 and 87 group by r.id order by r.id;

-- 2. Restoration audits.
select id, action, entity_id, created_at, after_snapshot->>'status' as status, after_snapshot->>'depositAmount' as deposit
from ledger_audit_logs where action in ('card_deposit_allocation_restored', 'november_card_deposit_allocations_restored') order by id;

-- 3. Over-consumed sales (must be empty) and remaining legacy deposits (must be empty).
select t.id, t.business_date, t.amount from ledger_transactions t
where t.source_type = 'pos_sales_daily_payment' and t.source_key like 'pos:%:card' and t.status = 'confirmed'
  and t.amount < coalesce((select sum(l.allocated_gross_amount) from ledger_card_reconciliation_lines l join ledger_card_reconciliations r on r.id = l.reconciliation_id
        where l.pos_card_transaction_id = t.id and r.status <> 'cancelled'), 0)
      + coalesce((select sum(f.allocated_fee_amount) from ledger_card_fee_allocation_lines f join ledger_card_fee_closures c on c.id = f.closure_id
        where f.pos_card_transaction_id = t.id and c.status <> 'cancelled'), 0);
select id, status from ledger_card_reconciliations where status in ('unmatched', 'partial');

-- 4. Re-run preflight queries 3-5: balances, #76-#79, closure #1, #4119 and audit #8257 must be unchanged.

-- 5. After 20261120121506 only: the legacy creator is gone, the deposit path remains.
select to_regprocedure('public.ledger_create_card_deposit_v1(timestamptz,numeric,bigint,text,text,bigint)') as legacy_creator,
  to_regprocedure('public.ledger_create_card_deposit_auto_allocate_v1(timestamptz,numeric,bigint,text,bigint)') as auto_deposit;
