-- SELECT-only handoff; NOT executed against production by this task.
-- Use an independently approved consistent snapshot when collecting these sets.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

-- Full old allocation -> expense mapping, including allocation IDs for recovery.
SELECT a.id AS allocation_id,a.payment_transaction_id,a.payable_id,a.allocated_amount,
       p.party_id,lp.name,p.original_amount,p.status,e.id AS expense_id,e.business_date,
       to_jsonb(e) AS original_expense,to_jsonb(a) AS original_allocation
FROM public.ledger_payable_allocations a
JOIN public.ledger_payables p ON p.id=a.payable_id
JOIN public.ledger_parties lp ON lp.id=p.party_id
JOIN public.ledger_transactions e ON e.id=p.expense_transaction_id
WHERE a.payment_transaction_id IN(1638,1641,1796,1797,2399,3336,3337,3582)
   OR p.id=388
ORDER BY a.payment_transaction_id,e.business_date,p.id,a.id;

-- Actual claim windows, NOT an instruction to allocate by date or FIFO.
-- Review invoice/credit-note identity, duplicates and foreign payment links.
WITH claims(payment_id,d1,d2,paid,decision) AS (VALUES
 (1641,DATE '2026-09-01',DATE '2026-09-15',19992000::numeric,'ROW_MATCH_REQUIRED;936000_ALREADY_DEDUCTED'),
 (2399,DATE '2026-09-16',DATE '2026-09-30',18504000,'ROW_MATCH_REQUIRED'),
 (3336,DATE '2026-10-01',DATE '2026-10-15',21900000,'ROW_MATCH_REQUIRED'),
 (3582,DATE '2026-10-16',DATE '2026-10-28',20724000,'BLOCKED_1296000_UNEXPLAINED')
)
SELECT c.*,p.id AS candidate_payable,p.original_amount,p.status,e.id AS expense_id,e.business_date,
       to_jsonb(e) AS original_expense,
       (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM public.ledger_payable_allocations a
        WHERE a.payable_id=p.id) AS existing_allocations
FROM claims c
LEFT JOIN public.ledger_parties lp ON lp.name='Phương' AND lp.type='supplier'
LEFT JOIN public.ledger_payables p ON p.party_id=lp.id
LEFT JOIN public.ledger_transactions e ON e.id=p.expense_transaction_id
WHERE (e.business_date BETWEEN c.d1 AND c.d2 AND e.status='confirmed' AND p.status<>'cancelled')
   OR p.id IS NULL
ORDER BY c.payment_id,e.business_date,p.id;

-- Do NOT infer an invoice window for either Carlsberg September payment.
-- Check #1802/#3721 with the supplier's 10/31 document; never merge by amount alone.
SELECT to_jsonb(p) AS payable,to_jsonb(e) AS expense,
 (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM public.ledger_payable_allocations a
  WHERE a.payable_id=p.id) AS allocations
FROM public.ledger_payables p JOIN public.ledger_transactions e ON e.id=p.expense_transaction_id
WHERE p.id IN(388,1802) OR e.id=3721 ORDER BY p.id;
SELECT * FROM public.ledger_month_closures WHERE month BETWEEN DATE '2026-08-01' AND DATE '2026-10-01' ORDER BY month;
SELECT * FROM public.ledger_month_closure_history WHERE month IN(DATE '2026-08-01',DATE '2026-09-01') ORDER BY month,revision;
ROLLBACK;
