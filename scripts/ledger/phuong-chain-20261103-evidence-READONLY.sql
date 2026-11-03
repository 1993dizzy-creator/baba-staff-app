-- Evidence export only; candidates are NOT invoice approval. No execution by Codex.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
WITH candidates(payment_id,payable_id) AS (
 SELECT 1641,unnest(ARRAY[679,680,681,690,699,406,407,408,409,410,486,540,548]) UNION ALL
 SELECT 2399,unnest(ARRAY[584,585,586,732,733,734,780,781,820,845,893,894,896,910,930,931]) UNION ALL
 SELECT 3336,unnest(ARRAY[964,965,1047,1048,1057,1105,1106,1150,1151,1152,1197,1198,1199,1272,1273]) UNION ALL
 SELECT 3582,unnest(ARRAY[1278,1279,1379,1380,1381,1400,1467,1513,1573,1574,1575,1576,1647])
)
SELECT c.*,to_jsonb(p) payable,to_jsonb(e) original_expense,to_jsonb(i) inventory_source,
 (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.ledger_payable_allocations a WHERE a.payable_id=p.id) allocations_from_all_payments
FROM candidates c LEFT JOIN public.ledger_payables p ON p.id=c.payable_id
LEFT JOIN public.ledger_transactions e ON e.id=p.expense_transaction_id
LEFT JOIN public.inventory_logs i ON i.id=CASE WHEN coalesce(e.source_snapshot->>'inventory_log_id','') ~ '^[0-9]+$'
 THEN (e.source_snapshot->>'inventory_log_id')::bigint END ORDER BY c.payment_id,c.payable_id;

-- Original allocation IDs / timestamps / amounts, including released #388.
SELECT to_jsonb(a) original_allocation,to_jsonb(p) payable,to_jsonb(e) expense
FROM public.ledger_payable_allocations a JOIN public.ledger_payables p ON p.id=a.payable_id
JOIN public.ledger_transactions e ON e.id=p.expense_transaction_id
WHERE a.payment_transaction_id IN(1641,2399,3336,3582) OR p.id=388
ORDER BY a.payment_transaction_id,a.id;

-- Inspect neighboring receipt dates/items against HD015517 and HD015523.
-- No new purchase is inferred from a daily amount gap.
SELECT e.business_date,to_jsonb(e) expense,to_jsonb(p) payable,to_jsonb(i) inventory_source
FROM public.ledger_transactions e JOIN public.ledger_parties lp ON lp.id=e.party_id
LEFT JOIN public.ledger_payables p ON p.expense_transaction_id=e.id
LEFT JOIN public.inventory_logs i ON i.id=CASE WHEN coalesce(e.source_snapshot->>'inventory_log_id','') ~ '^[0-9]+$'
 THEN (e.source_snapshot->>'inventory_log_id')::bigint END
WHERE lp.name='Phương' AND e.status='confirmed' AND e.type IN('expense','expense_recognition')
AND e.business_date BETWEEN DATE '2026-10-23' AND DATE '2026-10-28'
ORDER BY e.business_date,e.id;
ROLLBACK;
