-- =============================================================================
-- BABA 8/2 Dabaco 126,000₫ 단건 정정 — PREFLIGHT (READ ONLY)
-- 정본: Notion「2026년 8월 미해결 23칸 — 재조사 방지 원장」› Codex 단건 작업지시: Dabaco 126,000₫
-- 쓰기 없음. 모든 행의 ok=true 일 때만 EXECUTION 초안을 승인 검토할 수 있다.
-- 기준값: 2026-11-04 운영 DB 읽기 전용 조회(audit max #7306).
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
checks(n, name, ok, actual) AS (
  -- 1. 원매입 TX #30: Dabaco 재고입고(후보 #24, 로그 #8223)인데 Ok Mart(15)로 기표, 이동 없음.
  SELECT 1, 'tx30_state', (t.type = 'expense' AND t.status = 'confirmed' AND t.source_type = 'inventory_purchase_candidate'
      AND t.source_key = 'candidate:24' AND t.business_date = DATE '2026-08-02' AND t.recognition_month = DATE '2026-08-01'
      AND t.amount = 126000 AND t.category_id = 66 AND t.party_id = 15 AND t.correction_of_id IS NULL
      AND t.source_snapshot->>'supplier' = 'Dabaco' AND (t.source_snapshot->>'inventory_log_id')::bigint = 8223
      AND md5(to_jsonb(t)::text) = '78903f9b0d0410e3d69af351ff448090'),
    jsonb_build_object('party', t.party_id, 'amount', t.amount, 'md5', md5(to_jsonb(t)::text))
    FROM public.ledger_transactions t WHERE t.id = 30
  UNION ALL SELECT 2, 'tx30_no_movement', count(*) = 0, to_jsonb(count(*)) FROM public.ledger_movements WHERE transaction_id = 30
  UNION ALL SELECT 3, 'candidate24_unchanged', md5(to_jsonb(c)::text) = '10b258d3065e5b702139a19090f03525'
      AND c.status = 'confirmed' AND c.resolved_transaction_id = 30, jsonb_build_object('status', c.status, 'proposedParty', c.proposed_party_id)
    FROM public.ledger_candidates c WHERE c.id = 24
  UNION ALL SELECT 4, 'inventory_log8223_unchanged', md5(to_jsonb(l)::text) = '690cd1e480434ec2116ab582462055fb',
      jsonb_build_object('qty', l.change_quantity, 'price', l.new_purchase_price, 'supplier', l.new_supplier)
    FROM public.inventory_logs l WHERE l.id = 8223
  -- 2. 오귀속 채무 #15 와 잘못된 배분 #6 (→ 8/21 #1090).
  UNION ALL SELECT 5, 'payable15_paid', (p.party_id = 15 AND p.original_amount = 126000 AND p.status = 'paid' AND p.expense_transaction_id = 30),
      jsonb_build_object('status', p.status) FROM public.ledger_payables p WHERE p.id = 15
  UNION ALL SELECT 6, 'allocation6_only_link_of_payable15',
      (SELECT count(*) = 1 AND bool_and(a.id = 6 AND a.payment_transaction_id = 1090 AND a.allocated_amount = 126000)
         FROM public.ledger_payable_allocations a WHERE a.payable_id = 15),
      (SELECT jsonb_agg(jsonb_build_object('id', a.id, 'pay', a.payment_transaction_id, 'amt', a.allocated_amount)) FROM public.ledger_payable_allocations a WHERE a.payable_id = 15)
  -- 3. 실제 지급 #1090/#1094 와 다른 배분 보존 기준.
  UNION ALL SELECT 7, 'payment1090_allocations_25', (count(*) = 25 AND sum(a.allocated_amount) = 8487500
      AND md5(string_agg(a.id||':'||a.payable_id||':'||a.allocated_amount::text, '|' ORDER BY a.id)) = '05554f37553d64541fa994ddc470677c'),
      jsonb_build_object('n', count(*), 'sum', sum(a.allocated_amount)) FROM public.ledger_payable_allocations a WHERE a.payment_transaction_id = 1090
  UNION ALL SELECT 8, 'payment1090_other24_fingerprint',
      md5(string_agg(a.id||':'||a.payable_id||':'||a.payment_transaction_id||':'||a.allocated_amount::text, '|' ORDER BY a.id)) = '226c611e51fa6c2ba5dd688af23aa761',
      jsonb_build_object('n', count(*), 'sum', sum(a.allocated_amount)) FROM public.ledger_payable_allocations a WHERE a.payment_transaction_id = 1090 AND a.id <> 6
  UNION ALL SELECT 9, 'payment1094_allocations', md5(string_agg(a.id||':'||a.payable_id||':'||a.payment_transaction_id||':'||a.allocated_amount::text, '|' ORDER BY a.id)) = 'f3e5a8547af2f70e914c9ee90e07df23',
      jsonb_build_object('n', count(*), 'sum', sum(a.allocated_amount)) FROM public.ledger_payable_allocations a WHERE a.payment_transaction_id = 1094
  UNION ALL SELECT 10, 'payments1090_1094_tx_and_movements',
      md5(string_agg(t.id||':'||t.type||':'||t.status||':'||t.business_date||':'||t.amount::text||':'||coalesce(t.party_id::text,'')||':'||
        coalesce((SELECT string_agg(m.id||'/'||m.fund_account_id||'/'||m.amount::text, ',' ORDER BY m.id) FROM public.ledger_movements m WHERE m.transaction_id = t.id), ''), '|' ORDER BY t.id)) = 'f7eaa49778ae805f46ee8c89c96e4f2b',
      NULL::jsonb FROM public.ledger_transactions t WHERE t.id IN (1090, 1094)
  UNION ALL SELECT 11, 'payable107_paid_unchanged', md5(string_agg(p.id||':'||p.party_id||':'||p.original_amount::text||':'||p.status||':'||p.expense_transaction_id, '|')) = '80b9843b5c9abcab0874c6b98b2ea43a'
      AND (SELECT string_agg(a.payment_transaction_id||'='||a.allocated_amount::text, ',' ORDER BY a.id) FROM public.ledger_payable_allocations a WHERE a.payable_id = 107) = '1090=636000.000,1094=514000.000',
      NULL FROM public.ledger_payables p WHERE p.id = 107
  UNION ALL SELECT 12, 'payment_requests_1090_1094_none', count(*) = 0, to_jsonb(count(*)) FROM public.ledger_payable_payment_requests r WHERE r.payment_transaction_id IN (1090, 1094)
  -- 4. 대상 거래처·마감·중복.
  UNION ALL SELECT 13, 'party2_dabaco_active', (p.name = 'Dabaco' AND p.is_active), to_jsonb(p.name) FROM public.ledger_parties p WHERE p.id = 2
  UNION ALL SELECT 14, 'store_cash_account1', (a.code = 'store_cash' AND a.is_active), to_jsonb(a.code) FROM public.ledger_fund_accounts a WHERE a.id = 1
  UNION ALL SELECT 15, 'closures_aug_sep_reopened_rev4_oct_open',
      (SELECT count(*) = 2 AND bool_and(c.status = 'reopened' AND c.revision = 4) FROM public.ledger_month_closures c WHERE c.month IN (DATE '2026-08-01', DATE '2026-09-01'))
      AND NOT EXISTS (SELECT 1 FROM public.ledger_month_closures c WHERE c.month IN (DATE '2026-08-01', DATE '2026-09-01', DATE '2026-10-01') AND c.status = 'closed'),
      (SELECT jsonb_agg(jsonb_build_object('m', c.month, 's', c.status, 'r', c.revision) ORDER BY c.month) FROM public.ledger_month_closures c WHERE c.month >= DATE '2026-08-01')
  UNION ALL SELECT 16, 'no_prior_same_case_correction',
      NOT EXISTS (SELECT 1 FROM public.ledger_transactions t WHERE t.correction_of_id = 30
                     OR t.source_key IN ('august:2026-08-02:cash:dabaco-schweppes126:v1', 'august:2026-08-31:cash-day2-dabaco126-rebase:v1'))
      AND NOT EXISTS (SELECT 1 FROM public.ledger_audit_logs a WHERE a.action = 'august_02_dabaco126_cash_and_okmart_allocation_fixed'),
      NULL
  UNION ALL SELECT 17, 'tx1057_legacy_balance_anchor_unchanged', md5(to_jsonb(t)::text) = '762862a88e086cf6a6315824ad2200dc', NULL FROM public.ledger_transactions t WHERE t.id = 1057
  -- 5. 금액 불변 기준(8~10월 4계좌 기말, 8/2·8/31 현금 일계, 8월 경제비용·매출, Ok Mart 미지급).
  UNION ALL SELECT 18, 'month_end_balances_aug_oct',
      bal.j = '{"2026-08:1":51502786,"2026-08:2":222917683,"2026-08:3":46343661,"2026-08:5":6774110,"2026-09:1":38479206,"2026-09:2":267861665,"2026-09:3":24040861,"2026-09:5":8463910,"2026-10:1":78005406,"2026-10:2":175285689,"2026-10:3":54391381,"2026-10:5":6512710}'::jsonb,
      bal.j FROM bal
  UNION ALL SELECT 19, 'cash_day_net_0802_0831',
      (SELECT net FROM day_cash WHERE d = DATE '2026-08-02') = -606600 AND (SELECT net FROM day_cash WHERE d = DATE '2026-08-31') = 7859990,
      (SELECT jsonb_object_agg(d, net) FROM day_cash)
  UNION ALL SELECT 20, 'aug_economic_expense_revenue',
      (SELECT sum(amount * economic_effect_sign) FROM public.ledger_transactions WHERE status = 'confirmed' AND type IN ('expense', 'expense_recognition') AND recognition_month = DATE '2026-08-01') = 465830399
      AND (SELECT sum(amount * economic_effect_sign) FROM public.ledger_transactions WHERE status = 'confirmed' AND type IN ('income', 'sales') AND recognition_month = DATE '2026-08-01') = 734736553,
      NULL
  UNION ALL SELECT 21, 'okmart_open_payables',
      (SELECT sum(p.original_amount - coalesce((SELECT sum(a.allocated_amount) FROM public.ledger_payable_allocations a
          JOIN public.ledger_transactions pt ON pt.id = a.payment_transaction_id AND pt.status = 'confirmed' WHERE a.payable_id = p.id), 0))
         FROM public.ledger_payables p WHERE p.party_id = 15 AND p.status <> 'cancelled') = 14653500,
      NULL
)
SELECT n, name, ok, actual FROM checks ORDER BY n;

-- 요약: 전부 true 여야 함(21행).
ROLLBACK;
