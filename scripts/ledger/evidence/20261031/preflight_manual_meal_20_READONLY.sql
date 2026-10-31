-- BABA October 2026 — Manual employee-meal rows and auto-meal correspondence.
-- READ ONLY. No transaction changes; do not run any write operation on the basis of this snapshot alone.
WITH expected_ids(id) AS (SELECT unnest(ARRAY[2419,2420,2421,2422,2825,2826,2827,2828,2829,3338,3339,3340,3341,3342,3343,3344,3345,3346,3347,3348]::bigint[])),
targets AS (
 SELECT t.id,t.business_date,t.amount,t.category_id,t.status,t.source_type,t.source_key,t.memo,t.updated_at,
        t.created_by,t.confirmed_by,
        public.ledger_manual_transaction_blocker_v1(t) AS cancellation_blocker
 FROM public.ledger_transactions t JOIN expected_ids x ON x.id=t.id
)
SELECT t.id AS manual_tx_id,t.business_date,t.amount AS manual_amount,t.status,t.source_type,
 t.source_key,t.updated_at,t.cancellation_blocker,
 a.id AS auto_tx_id,a.amount AS auto_amount,a.source_snapshot->>'employee_count' AS auto_employee_count,
 (SELECT COUNT(*) FROM public.ledger_transactions x WHERE x.business_date=t.business_date
    AND x.status='confirmed' AND x.category_id=6 AND x.source_type='attendance_meal_daily_candidate') AS same_day_auto_count,
 (SELECT count(*) FROM public.ledger_movements m WHERE m.transaction_id=t.id) AS movement_rows,
 (SELECT sum(m.amount) FROM public.ledger_movements m WHERE m.transaction_id=t.id
    AND m.fund_account_id=1) AS store_cash_delta
FROM targets t
LEFT JOIN LATERAL (SELECT id,amount,source_snapshot FROM public.ledger_transactions a
 WHERE a.business_date=t.business_date AND a.category_id=6 AND a.status='confirmed'
   AND a.source_type='attendance_meal_daily_candidate' ORDER BY id LIMIT 1) a ON true
ORDER BY t.business_date,t.id;

-- Distinct source cross-month boundary: do not touch Sep 29 confirmed automatic meal or its Oct 1 adjustment.
SELECT id,business_date,recognition_month,status,source_type,amount,
 correction_of_id,source_snapshot->>'originalTransactionId' AS original_transaction_id
FROM public.ledger_transactions WHERE id IN (2112,2163,3385) ORDER BY id;
SELECT public.ledger_month_is_closed_v1(DATE '2026-09-01') AS sep_closed,
 public.ledger_month_is_closed_v1(DATE '2026-10-01') AS oct_closed;
