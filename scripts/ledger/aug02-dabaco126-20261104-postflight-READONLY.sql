-- =============================================================================
-- BABA 8/2 Dabaco 126,000₫ 단건 정정 — POSTFLIGHT (READ ONLY)
-- EXECUTION 커밋 직후 실행. 쓰기 없음. 모든 행 ok=true 여야 PASS.
-- 하나라도 false 면 추가 정정 금지·즉시 보고(감사 행 before 스냅샷으로 복구 범위 확인).
-- =============================================================================
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

WITH
bal AS (
  SELECT jsonb_object_agg(k, v) AS j FROM (
    SELECT to_char(e.d, 'YYYY-MM') || ':' || m.fund_account_id AS k, sum(m.amount) AS v
      FROM public.ledger_movements m
      JOIN public.ledger_transactions t ON t.id = m.transaction_id AND t.status = 'confirmed'
     CROSS JOIN (VALUES (DATE '2026-08-31'), (DATE '2026-09-30'), (DATE '2026-10-31')) e(d)
     WHERE m.fund_account_id IN (1, 2, 3, 5) AND t.business_date <= e.d
     GROUP BY 1) x),
day_cash AS (
  SELECT t.business_date d, sum(m.amount) net FROM public.ledger_movements m
    JOIN public.ledger_transactions t ON t.id = m.transaction_id AND t.status = 'confirmed'
   WHERE m.fund_account_id = 1 AND t.business_date IN (DATE '2026-08-02', DATE '2026-08-31') GROUP BY 1),
ca AS (SELECT * FROM public.ledger_transactions WHERE source_key = 'august:2026-08-02:cash:dabaco-schweppes126:v1'),
cb AS (SELECT * FROM public.ledger_transactions WHERE source_key = 'august:2026-08-31:cash-day2-dabaco126-rebase:v1'),
au AS (SELECT * FROM public.ledger_audit_logs WHERE action = 'august_02_dabaco126_cash_and_okmart_allocation_fixed'),
checks(n, name, ok, actual) AS (
  SELECT 1, 'tx30_party_dabaco_only_change', (t.party_id = 2 AND md5((to_jsonb(t) - 'party_id' - 'updated_at')::text) = 'd86090e0c7dd718c9c512a15a78ec10f'),
      jsonb_build_object('party', t.party_id, 'amount', t.amount) FROM public.ledger_transactions t WHERE t.id = 30
  UNION ALL SELECT 2, 'tx30_still_no_own_movement', count(*) = 0, to_jsonb(count(*)) FROM public.ledger_movements WHERE transaction_id = 30
  UNION ALL SELECT 3, 'source_rows_unchanged(candidate24,invlog8223,tx1057)',
      (SELECT md5(to_jsonb(c)::text) FROM public.ledger_candidates c WHERE c.id = 24) = '10b258d3065e5b702139a19090f03525'
      AND (SELECT md5(to_jsonb(l)::text) FROM public.inventory_logs l WHERE l.id = 8223) = '690cd1e480434ec2116ab582462055fb'
      AND (SELECT md5(to_jsonb(t)::text) FROM public.ledger_transactions t WHERE t.id = 1057) = '762862a88e086cf6a6315824ad2200dc', NULL::jsonb
  UNION ALL SELECT 4, 'payable15_cancelled_unallocated', (p.status = 'cancelled' AND p.original_amount = 126000 AND p.party_id = 15
      AND NOT EXISTS (SELECT 1 FROM public.ledger_payable_allocations a WHERE a.payable_id = 15)), to_jsonb(p.status)
    FROM public.ledger_payables p WHERE p.id = 15
  UNION ALL SELECT 5, 'payment1090_other24_preserved_126k_unallocated',
      NOT EXISTS (SELECT 1 FROM public.ledger_payable_allocations WHERE id = 6)
      AND (SELECT md5(string_agg(a.id||':'||a.payable_id||':'||a.payment_transaction_id||':'||a.allocated_amount::text, '|' ORDER BY a.id))
             FROM public.ledger_payable_allocations a WHERE a.payment_transaction_id = 1090) = '226c611e51fa6c2ba5dd688af23aa761'
      AND (SELECT t.amount - sum(a.allocated_amount) FROM public.ledger_transactions t JOIN public.ledger_payable_allocations a ON a.payment_transaction_id = t.id WHERE t.id = 1090 GROUP BY t.amount) = 126000,
      (SELECT jsonb_build_object('n', count(*), 'sum', sum(allocated_amount)) FROM public.ledger_payable_allocations WHERE payment_transaction_id = 1090)
  UNION ALL SELECT 6, 'payments1090_1094_and_payable107_unchanged',
      (SELECT md5(string_agg(a.id||':'||a.payable_id||':'||a.payment_transaction_id||':'||a.allocated_amount::text, '|' ORDER BY a.id))
         FROM public.ledger_payable_allocations a WHERE a.payment_transaction_id = 1094) = 'f3e5a8547af2f70e914c9ee90e07df23'
      AND (SELECT md5(string_agg(t.id||':'||t.type||':'||t.status||':'||t.business_date||':'||t.amount::text||':'||coalesce(t.party_id::text,'')||':'||
             coalesce((SELECT string_agg(m.id||'/'||m.fund_account_id||'/'||m.amount::text, ',' ORDER BY m.id) FROM public.ledger_movements m WHERE m.transaction_id = t.id), ''), '|' ORDER BY t.id))
             FROM public.ledger_transactions t WHERE t.id IN (1090, 1094)) = 'f7eaa49778ae805f46ee8c89c96e4f2b'
      AND (SELECT md5(p.id||':'||p.party_id||':'||p.original_amount::text||':'||p.status||':'||p.expense_transaction_id) FROM public.ledger_payables p WHERE p.id = 107) = '80b9843b5c9abcab0874c6b98b2ea43a',
      NULL
  UNION ALL SELECT 7, 'correction_a_0802_cash_minus126k',
      (SELECT count(*) = 1 FROM ca) AND (SELECT bool_and(type = 'correction' AND status = 'confirmed' AND amount = 0 AND business_date = DATE '2026-08-02' AND correction_of_id = 30) FROM ca)
      AND (SELECT string_agg(m.fund_account_id||'='||m.amount::text, ',') FROM public.ledger_movements m WHERE m.transaction_id IN (SELECT id FROM ca)) = '1=-126000.000',
      (SELECT jsonb_agg(id) FROM ca)
  UNION ALL SELECT 8, 'correction_b_0831_rebase_plus126k',
      (SELECT count(*) = 1 FROM cb) AND (SELECT bool_and(type = 'correction' AND status = 'confirmed' AND amount = 0 AND business_date = DATE '2026-08-31' AND correction_of_id = 1057) FROM cb)
      AND (SELECT string_agg(m.fund_account_id||'='||m.amount::text, ',') FROM public.ledger_movements m WHERE m.transaction_id IN (SELECT id FROM cb)) = '1=126000.000',
      (SELECT jsonb_agg(id) FROM cb)
  UNION ALL SELECT 9, 'no_other_correction_of_tx30', (SELECT count(*) = 1 FROM public.ledger_transactions WHERE correction_of_id = 30), NULL
  UNION ALL SELECT 10, 'single_audit_row_with_same_balances',
      (SELECT count(*) = 1 FROM au) AND (SELECT bool_and(entity_type = 'transaction' AND entity_id = 30
        AND after_snapshot->'fundBalances' = before_snapshot->'fundBalances'
        AND (after_snapshot->>'payment1090Unallocated')::numeric = 126000) FROM au),
      (SELECT jsonb_agg(id) FROM au)
  UNION ALL SELECT 11, 'month_end_balances_aug_oct_unchanged',
      bal.j = '{"2026-08:1":51502786,"2026-08:2":222917683,"2026-08:3":46343661,"2026-08:5":6774110,"2026-09:1":38479206,"2026-09:2":267861665,"2026-09:3":24040861,"2026-09:5":8463910,"2026-10:1":78005406,"2026-10:2":175285689,"2026-10:3":54391381,"2026-10:5":6512710}'::jsonb,
      bal.j FROM bal
  UNION ALL SELECT 12, 'cash_day_0802_matches_sheet_0831_rebased',
      (SELECT net FROM day_cash WHERE d = DATE '2026-08-02') = -732600 AND (SELECT net FROM day_cash WHERE d = DATE '2026-08-31') = 7985990,
      (SELECT jsonb_object_agg(d, net) FROM day_cash)
  UNION ALL SELECT 13, 'aug_economic_expense_revenue_unchanged',
      (SELECT sum(amount * economic_effect_sign) FROM public.ledger_transactions WHERE status = 'confirmed' AND type IN ('expense', 'expense_recognition') AND recognition_month = DATE '2026-08-01') = 465830399
      AND (SELECT sum(amount * economic_effect_sign) FROM public.ledger_transactions WHERE status = 'confirmed' AND type IN ('income', 'sales') AND recognition_month = DATE '2026-08-01') = 734736553,
      NULL
  UNION ALL SELECT 14, 'okmart_open_payables_unchanged',
      (SELECT sum(p.original_amount - coalesce((SELECT sum(a.allocated_amount) FROM public.ledger_payable_allocations a
          JOIN public.ledger_transactions pt ON pt.id = a.payment_transaction_id AND pt.status = 'confirmed' WHERE a.payable_id = p.id), 0))
         FROM public.ledger_payables p WHERE p.party_id = 15 AND p.status <> 'cancelled') = 14653500,
      NULL
  UNION ALL SELECT 15, 'no_overallocated_payable', NOT EXISTS (SELECT 1 FROM public.ledger_payables p
      WHERE (SELECT coalesce(sum(a.allocated_amount), 0) FROM public.ledger_payable_allocations a WHERE a.payable_id = p.id) > p.original_amount), NULL
  UNION ALL SELECT 16, 'closures_unchanged_no_month_close',
      (SELECT count(*) = 2 AND bool_and(c.status = 'reopened' AND c.revision = 4) FROM public.ledger_month_closures c WHERE c.month IN (DATE '2026-08-01', DATE '2026-09-01'))
      AND NOT EXISTS (SELECT 1 FROM public.ledger_month_closures c WHERE c.month IN (DATE '2026-08-01', DATE '2026-09-01', DATE '2026-10-01') AND c.status = 'closed'),
      NULL
)
SELECT n, name, ok, actual FROM checks ORDER BY n;

ROLLBACK;
