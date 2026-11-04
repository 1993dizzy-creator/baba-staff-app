-- =============================================================================
-- BABA 8/2 Dabaco 126,000₫ 단건 정정 — EXECUTION DRAFT (BLOCKED)
-- 승인 전 실행 금지. 승인값 두 개가 없으면 쓰기 전에 예외로 중단되고 전체 롤백된다.
-- Migration 아님. 운영 DB에서 별도 명시 승인 후, 같은 세션에서
--   1) aug02-dabaco126-20261104-preflight-READONLY.sql  → 21행 모두 ok=true
--   2) 이 파일(승인값 2줄 주석 해제·입력)
--   3) aug02-dabaco126-20261104-postflight-READONLY.sql → 모두 ok=true
-- 순서로 실행한다. 월마감은 실행하지 않는다.
--
-- 정본: Notion「2026년 8월 미해결 23칸 — 재조사 방지 원장」› Codex 단건 작업지시: Dabaco 126,000₫
--
-- 사실(2026-11-04 운영 읽기 전용 확인):
--   TX #30 8/2 Schweppes gừng 12×10,500=126,000₫, 재고로그 #8223·후보 #24 공급처 Dabaco,
--   그러나 party 15(Ok Mart)·후불 #15로 기표, 현금 이동 없음.
--   시트 G14 Dabaco 현금 421,000 = #27 65k + #28 204k + #29 26k(현금 처리) + #30 126k.
--   후불 #15 는 배분 #6 으로 8/21 Ok Mart 법인 지급 #1090(8,487,500₫, 시트 K288 일치)에 126k paid.
--
-- 변경(이것만):
--   a. 배분 #6(#15 ← #1090, 126,000) 삭제 → #1090 의 126,000₫은 Ok Mart 원지급의 미배정 정산분
--      (선례: okmart-payable-reallocation-20261103, #1978 2,670,000₫ 미배정). 다른 24개 배분 불변.
--   b. 후불 #15 status paid → cancelled (오귀속 채무; 취소 채무 76건 모두 배분 없음과 같은 형태).
--   c. TX #30 party_id 15 → 2(Dabaco) 한 컬럼만. 금액·분류·인식월·원천 스냅샷/지문·후보 #24·재고 불변.
--   d. 정정 전표 A (8/2, correction, 금액 0, correction_of #30): 매장현금 −126,000 (기인식 비용의 당일 현금 지급 복원;
--      선례 #4048/#4056/#4057).
--   e. 정정 전표 B (8/31, correction, 금액 0, correction_of #1057): 매장현금 +126,000 (역사 기말 기술재기준화,
--      실입금 아님; 선례 #4051/#4059/#4062).
--   f. 감사 로그 1행(before/after 전체 스냅샷).
--
-- 결과: 8/2 현금 일계 −606,600 → −732,600 (APP−시트 +126,000 → 0), 8/31 현금 일계 +126,000,
--   8~10월·11월 현재 4계좌 기말 변화 0, 8/21·8/24 실제 지급·이동 변화 0, 8월 경제비용·매출 변화 0,
--   재고·후보 변화 0, Ok Mart 미지급 14,653,500 불변(+ #1090 미배정 126,000).
-- 재실행: 완료 상태면 ALREADY_APPLIED 알림 후 변경 0, 부분 상태면 예외·전체 롤백.
-- =============================================================================

BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ▼ 운영 승인 후에만 주석 해제하고 값을 넣는다. 없으면 아래 DO 블록 첫 단계에서 BLOCKED 로 중단.
-- SET LOCAL baba.correction_actor_user_id = '1';
-- SET LOCAL baba.dabaco126_approval = 'APPROVED:aug02-dabaco126-20261104';

DO $dabaco126$
DECLARE
  c_approval constant text := 'APPROVED:aug02-dabaco126-20261104';
  c_key_a constant text := 'august:2026-08-02:cash:dabaco-schweppes126:v1';
  c_key_b constant text := 'august:2026-08-31:cash-day2-dabaco126-rebase:v1';
  c_action constant text := 'august_02_dabaco126_cash_and_okmart_allocation_fixed';
  c_eom constant jsonb := '{"2026-08:1":51502786,"2026-08:2":222917683,"2026-08:3":46343661,"2026-08:5":6774110,"2026-09:1":38479206,"2026-09:2":267861665,"2026-09:3":24040861,"2026-09:5":8463910,"2026-10:1":78005406,"2026-10:2":175285689,"2026-10:3":54391381,"2026-10:5":6512710}';
  v_actor bigint;
  v_tx30 public.ledger_transactions%rowtype; v_tx30_after public.ledger_transactions%rowtype;
  v_p15 public.ledger_payables%rowtype; v_p15_after public.ledger_payables%rowtype;
  v_a6 public.ledger_payable_allocations%rowtype;
  v_cash_id bigint; v_a bigint; v_b bigint; v_audit bigint;
  v_bal_before jsonb; v_bal_after jsonb; v_day_before jsonb; v_day_after jsonb;
  v_exp numeric; v_rev numeric; v_open numeric; v_unalloc numeric; v_f text; v_n integer;
BEGIN
  ---------------------------------------------------------------------------
  -- 0. 승인 게이트(쓰기 전).
  ---------------------------------------------------------------------------
  IF current_setting('baba.dabaco126_approval', true) IS DISTINCT FROM c_approval THEN
    RAISE EXCEPTION 'DABACO126_BLOCKED_APPROVAL_REQUIRED';
  END IF;
  v_actor := nullif(current_setting('baba.correction_actor_user_id', true), '')::bigint;
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.users WHERE id = v_actor) THEN
    RAISE EXCEPTION 'DABACO126_BLOCKED_ACTOR_REQUIRED';
  END IF;
  IF current_setting('transaction_isolation') <> 'serializable' THEN
    RAISE EXCEPTION 'DABACO126_SERIALIZABLE_REQUIRED';
  END IF;

  -- 수동 정정 RPC와 같은 월 잠금 + 대상 행 잠금.
  PERFORM pg_advisory_xact_lock(hashtext('ledger_month_close:2026-08'));
  PERFORM public.ledger_assert_month_open_v1(DATE '2026-08-01');
  SELECT * INTO v_tx30 FROM public.ledger_transactions WHERE id = 30 FOR UPDATE;
  SELECT * INTO v_p15 FROM public.ledger_payables WHERE id = 15 FOR UPDATE;
  PERFORM 1 FROM public.ledger_transactions WHERE id IN (1057, 1090, 1094) FOR UPDATE;
  PERFORM 1 FROM public.ledger_payable_allocations WHERE payment_transaction_id IN (1090, 1094) OR payable_id IN (15, 107) FOR UPDATE;
  SELECT id INTO v_cash_id FROM public.ledger_fund_accounts WHERE id = 1 AND code = 'store_cash' AND is_active;
  IF v_cash_id IS NULL THEN RAISE EXCEPTION 'DABACO126_STORE_CASH_ACCOUNT_CHANGED'; END IF;

  ---------------------------------------------------------------------------
  -- 1. 중복 방지: 완료 상태면 변경 0, 일부만 있으면 중단.
  ---------------------------------------------------------------------------
  SELECT count(*) INTO v_n FROM public.ledger_transactions
   WHERE source_key IN (c_key_a, c_key_b) OR correction_of_id = 30;
  IF v_n > 0 OR EXISTS (SELECT 1 FROM public.ledger_audit_logs WHERE action = c_action) THEN
    IF v_n = 2 AND v_tx30.party_id = 2 AND v_p15.status = 'cancelled'
       AND NOT EXISTS (SELECT 1 FROM public.ledger_payable_allocations WHERE payable_id = 15)
       AND (SELECT count(*) FROM public.ledger_audit_logs WHERE action = c_action) = 1 THEN
      RAISE NOTICE 'DABACO126_ALREADY_APPLIED: nothing changed';
      RETURN;
    END IF;
    RAISE EXCEPTION 'DABACO126_PARTIAL_OR_FOREIGN_STATE (% related rows)', v_n;
  END IF;

  ---------------------------------------------------------------------------
  -- 2. 사전 조건(PREFLIGHT 와 같은 고정값).
  ---------------------------------------------------------------------------
  IF NOT (v_tx30.type = 'expense' AND v_tx30.status = 'confirmed' AND v_tx30.source_type = 'inventory_purchase_candidate'
      AND v_tx30.source_key = 'candidate:24' AND v_tx30.business_date = DATE '2026-08-02' AND v_tx30.recognition_month = DATE '2026-08-01'
      AND v_tx30.amount = 126000 AND v_tx30.category_id = 66 AND v_tx30.party_id = 15 AND v_tx30.correction_of_id IS NULL
      AND md5(to_jsonb(v_tx30)::text) = '78903f9b0d0410e3d69af351ff448090') THEN
    RAISE EXCEPTION 'DABACO126_TX30_CHANGED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ledger_movements WHERE transaction_id = 30) THEN RAISE EXCEPTION 'DABACO126_TX30_HAS_MOVEMENT'; END IF;
  IF (SELECT md5(to_jsonb(c)::text) FROM public.ledger_candidates c WHERE c.id = 24) IS DISTINCT FROM '10b258d3065e5b702139a19090f03525' THEN
    RAISE EXCEPTION 'DABACO126_CANDIDATE24_CHANGED';
  END IF;
  IF (SELECT md5(to_jsonb(l)::text) FROM public.inventory_logs l WHERE l.id = 8223) IS DISTINCT FROM '690cd1e480434ec2116ab582462055fb' THEN
    RAISE EXCEPTION 'DABACO126_INVENTORY_LOG_CHANGED';
  END IF;
  IF NOT (v_p15.party_id = 15 AND v_p15.original_amount = 126000 AND v_p15.status = 'paid' AND v_p15.expense_transaction_id = 30) THEN
    RAISE EXCEPTION 'DABACO126_PAYABLE15_CHANGED';
  END IF;
  SELECT * INTO v_a6 FROM public.ledger_payable_allocations WHERE id = 6;
  IF v_a6.id IS NULL OR v_a6.payable_id <> 15 OR v_a6.payment_transaction_id <> 1090 OR v_a6.allocated_amount <> 126000
     OR (SELECT count(*) FROM public.ledger_payable_allocations WHERE payable_id = 15) <> 1 THEN
    RAISE EXCEPTION 'DABACO126_ALLOCATION6_CHANGED';
  END IF;
  SELECT md5(string_agg(a.id||':'||a.payable_id||':'||a.allocated_amount::text, '|' ORDER BY a.id)), count(*)
    INTO v_f, v_n FROM public.ledger_payable_allocations a WHERE a.payment_transaction_id = 1090;
  IF v_f <> '05554f37553d64541fa994ddc470677c' OR v_n <> 25 THEN RAISE EXCEPTION 'DABACO126_PAYMENT1090_ALLOCATIONS_CHANGED'; END IF;
  SELECT md5(string_agg(a.id||':'||a.payable_id||':'||a.payment_transaction_id||':'||a.allocated_amount::text, '|' ORDER BY a.id))
    INTO v_f FROM public.ledger_payable_allocations a WHERE a.payment_transaction_id = 1094;
  IF v_f <> 'f3e5a8547af2f70e914c9ee90e07df23' THEN RAISE EXCEPTION 'DABACO126_PAYMENT1094_ALLOCATIONS_CHANGED'; END IF;
  SELECT md5(string_agg(t.id||':'||t.type||':'||t.status||':'||t.business_date||':'||t.amount::text||':'||coalesce(t.party_id::text,'')||':'||
           coalesce((SELECT string_agg(m.id||'/'||m.fund_account_id||'/'||m.amount::text, ',' ORDER BY m.id) FROM public.ledger_movements m WHERE m.transaction_id = t.id), ''), '|' ORDER BY t.id))
    INTO v_f FROM public.ledger_transactions t WHERE t.id IN (1090, 1094);
  IF v_f <> 'f7eaa49778ae805f46ee8c89c96e4f2b' THEN RAISE EXCEPTION 'DABACO126_PAYMENT_TX_CHANGED'; END IF;
  IF (SELECT md5(p.id||':'||p.party_id||':'||p.original_amount::text||':'||p.status||':'||p.expense_transaction_id) FROM public.ledger_payables p WHERE p.id = 107) <> '80b9843b5c9abcab0874c6b98b2ea43a' THEN
    RAISE EXCEPTION 'DABACO126_PAYABLE107_CHANGED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ledger_payable_payment_requests WHERE payment_transaction_id IN (1090, 1094)) THEN
    RAISE EXCEPTION 'DABACO126_PAYMENT_REQUEST_PRESENT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ledger_parties WHERE id = 2 AND name = 'Dabaco' AND is_active) THEN RAISE EXCEPTION 'DABACO126_PARTY2_CHANGED'; END IF;
  IF (SELECT md5(to_jsonb(t)::text) FROM public.ledger_transactions t WHERE t.id = 1057) IS DISTINCT FROM '762862a88e086cf6a6315824ad2200dc' THEN
    RAISE EXCEPTION 'DABACO126_TX1057_CHANGED';
  END IF;
  IF (SELECT count(*) FROM public.ledger_month_closures WHERE month IN (DATE '2026-08-01', DATE '2026-09-01') AND status = 'reopened' AND revision = 4) <> 2
     OR EXISTS (SELECT 1 FROM public.ledger_month_closures WHERE month IN (DATE '2026-08-01', DATE '2026-09-01', DATE '2026-10-01') AND status = 'closed') THEN
    RAISE EXCEPTION 'DABACO126_CLOSURE_STATE_CHANGED';
  END IF;

  -- 금액 기준(전·후 비교용). 11월은 현재값을 그대로 비교한다.
  SELECT jsonb_object_agg(k, v) INTO v_bal_before FROM (
    SELECT to_char(e.d, 'YYYY-MM')||':'||m.fund_account_id k, sum(m.amount) v
      FROM public.ledger_movements m JOIN public.ledger_transactions t ON t.id = m.transaction_id AND t.status = 'confirmed'
     CROSS JOIN (VALUES (DATE '2026-08-31'), (DATE '2026-09-30'), (DATE '2026-10-31'), (DATE '2026-11-30')) e(d)
     WHERE m.fund_account_id IN (1, 2, 3, 5) AND t.business_date <= e.d GROUP BY 1) x;
  IF (SELECT jsonb_object_agg(key, value) FROM jsonb_each(v_bal_before) WHERE key < '2026-11') <> c_eom THEN
    RAISE EXCEPTION 'DABACO126_MONTH_END_BALANCES_CHANGED %', v_bal_before;
  END IF;
  SELECT jsonb_object_agg(d, net) INTO v_day_before FROM (
    SELECT t.business_date d, sum(m.amount) net FROM public.ledger_movements m JOIN public.ledger_transactions t ON t.id = m.transaction_id AND t.status = 'confirmed'
     WHERE m.fund_account_id = 1 AND t.business_date IN (DATE '2026-08-02', DATE '2026-08-31') GROUP BY 1) x;
  IF (v_day_before->>'2026-08-02')::numeric <> -606600 OR (v_day_before->>'2026-08-31')::numeric <> 7859990 THEN
    RAISE EXCEPTION 'DABACO126_DAY_CASH_CHANGED %', v_day_before;
  END IF;
  SELECT sum(amount * economic_effect_sign) INTO v_exp FROM public.ledger_transactions WHERE status = 'confirmed' AND type IN ('expense', 'expense_recognition') AND recognition_month = DATE '2026-08-01';
  SELECT sum(amount * economic_effect_sign) INTO v_rev FROM public.ledger_transactions WHERE status = 'confirmed' AND type IN ('income', 'sales') AND recognition_month = DATE '2026-08-01';
  IF v_exp <> 465830399 OR v_rev <> 734736553 THEN RAISE EXCEPTION 'DABACO126_AUG_PNL_CHANGED (% / %)', v_exp, v_rev; END IF;
  SELECT sum(p.original_amount - coalesce((SELECT sum(a.allocated_amount) FROM public.ledger_payable_allocations a
           JOIN public.ledger_transactions pt ON pt.id = a.payment_transaction_id AND pt.status = 'confirmed' WHERE a.payable_id = p.id), 0))
    INTO v_open FROM public.ledger_payables p WHERE p.party_id = 15 AND p.status <> 'cancelled';
  IF v_open <> 14653500 THEN RAISE EXCEPTION 'DABACO126_OKMART_OPEN_CHANGED %', v_open; END IF;

  ---------------------------------------------------------------------------
  -- 3. 정정(단일 트랜잭션).
  ---------------------------------------------------------------------------
  DELETE FROM public.ledger_payable_allocations WHERE id = 6 AND payable_id = 15 AND payment_transaction_id = 1090 AND allocated_amount = 126000;
  GET DIAGNOSTICS v_n = ROW_COUNT; IF v_n <> 1 THEN RAISE EXCEPTION 'DABACO126_ALLOCATION_DELETE_COUNT %', v_n; END IF;

  UPDATE public.ledger_payables SET status = 'cancelled', updated_at = now() WHERE id = 15 AND status = 'paid' RETURNING * INTO v_p15_after;
  IF v_p15_after.id IS NULL THEN RAISE EXCEPTION 'DABACO126_PAYABLE15_UPDATE_FAILED'; END IF;

  UPDATE public.ledger_transactions SET party_id = 2, updated_at = now() WHERE id = 30 AND party_id = 15 RETURNING * INTO v_tx30_after;
  IF v_tx30_after.id IS NULL
     OR (to_jsonb(v_tx30_after) - 'party_id' - 'updated_at') <> (to_jsonb(v_tx30) - 'party_id' - 'updated_at') THEN
    RAISE EXCEPTION 'DABACO126_TX30_UPDATE_UNEXPECTED';
  END IF;

  INSERT INTO public.ledger_transactions (operation_id, type, status, source_type, source_key, business_date, occurred_at, recognition_month,
      amount, category_id, party_id, correction_of_id, memo, source_snapshot, display_snapshot, created_by, confirmed_by, economic_effect_sign)
  VALUES (gen_random_uuid(), 'correction', 'confirmed', 'manual', c_key_a, DATE '2026-08-02', TIMESTAMPTZ '2026-08-02 05:00:00+00', NULL,
      0, NULL, NULL, 30, '8/2 Dabaco Schweppes gừng 126,000₫ 기인식 비용의 당일 현금 지급 복원(시트 G14). 새 비용 아님',
      jsonb_build_object('sheet', '8월!G14', 'cashAmount', -126000, 'newExpense', 0, 'expenseAlreadyRecognized', 30,
        'candidateId', 24, 'inventoryLogId', 8223, 'supplier', 'Dabaco', 'partyFrom', 15, 'partyTo', 2,
        'releasedAllocation', jsonb_build_object('id', 6, 'payableId', 15, 'paymentTransactionId', 1090, 'amount', 126000)),
      '{}'::jsonb, v_actor, v_actor, 1)
  RETURNING id INTO v_a;
  INSERT INTO public.ledger_movements (transaction_id, fund_account_id, amount) VALUES (v_a, v_cash_id, -126000);

  INSERT INTO public.ledger_transactions (operation_id, type, status, source_type, source_key, business_date, occurred_at, recognition_month,
      amount, category_id, party_id, correction_of_id, memo, source_snapshot, display_snapshot, created_by, confirmed_by, economic_effect_sign)
  VALUES (gen_random_uuid(), 'correction', 'confirmed', 'manual', c_key_b, DATE '2026-08-31', TIMESTAMPTZ '2026-08-31 05:00:00+00', NULL,
      0, NULL, NULL, 1057, '8/31 기존 역사기말 기술보정 재기준화: 8/2 Dabaco 126,000₫ 현금 지급 복원 상쇄(실입금 아님)',
      jsonb_build_object('linkedCorrectionId', v_a, 'cashAmount', 126000, 'technicalRebase', true, 'realCashReceipt', false),
      '{}'::jsonb, v_actor, v_actor, 1)
  RETURNING id INTO v_b;
  INSERT INTO public.ledger_movements (transaction_id, fund_account_id, amount) VALUES (v_b, v_cash_id, 126000);

  ---------------------------------------------------------------------------
  -- 4. 사후 조건.
  ---------------------------------------------------------------------------
  SELECT jsonb_object_agg(k, v) INTO v_bal_after FROM (
    SELECT to_char(e.d, 'YYYY-MM')||':'||m.fund_account_id k, sum(m.amount) v
      FROM public.ledger_movements m JOIN public.ledger_transactions t ON t.id = m.transaction_id AND t.status = 'confirmed'
     CROSS JOIN (VALUES (DATE '2026-08-31'), (DATE '2026-09-30'), (DATE '2026-10-31'), (DATE '2026-11-30')) e(d)
     WHERE m.fund_account_id IN (1, 2, 3, 5) AND t.business_date <= e.d GROUP BY 1) x;
  IF v_bal_after <> v_bal_before THEN RAISE EXCEPTION 'DABACO126_POST_MONTH_END_BALANCES_CHANGED %', v_bal_after; END IF;
  SELECT jsonb_object_agg(d, net) INTO v_day_after FROM (
    SELECT t.business_date d, sum(m.amount) net FROM public.ledger_movements m JOIN public.ledger_transactions t ON t.id = m.transaction_id AND t.status = 'confirmed'
     WHERE m.fund_account_id = 1 AND t.business_date IN (DATE '2026-08-02', DATE '2026-08-31') GROUP BY 1) x;
  IF (v_day_after->>'2026-08-02')::numeric <> -732600 OR (v_day_after->>'2026-08-31')::numeric <> 7985990 THEN
    RAISE EXCEPTION 'DABACO126_POST_DAY_CASH_UNEXPECTED %', v_day_after;
  END IF;
  IF (SELECT sum(amount * economic_effect_sign) FROM public.ledger_transactions WHERE status = 'confirmed' AND type IN ('expense', 'expense_recognition') AND recognition_month = DATE '2026-08-01') <> v_exp
     OR (SELECT sum(amount * economic_effect_sign) FROM public.ledger_transactions WHERE status = 'confirmed' AND type IN ('income', 'sales') AND recognition_month = DATE '2026-08-01') <> v_rev THEN
    RAISE EXCEPTION 'DABACO126_POST_AUG_PNL_CHANGED';
  END IF;
  SELECT md5(string_agg(a.id||':'||a.payable_id||':'||a.payment_transaction_id||':'||a.allocated_amount::text, '|' ORDER BY a.id)), count(*)
    INTO v_f, v_n FROM public.ledger_payable_allocations a WHERE a.payment_transaction_id = 1090;
  IF v_f <> '226c611e51fa6c2ba5dd688af23aa761' OR v_n <> 24 THEN RAISE EXCEPTION 'DABACO126_POST_OTHER24_CHANGED'; END IF;
  SELECT md5(string_agg(a.id||':'||a.payable_id||':'||a.payment_transaction_id||':'||a.allocated_amount::text, '|' ORDER BY a.id))
    INTO v_f FROM public.ledger_payable_allocations a WHERE a.payment_transaction_id = 1094;
  IF v_f <> 'f3e5a8547af2f70e914c9ee90e07df23' THEN RAISE EXCEPTION 'DABACO126_POST_1094_CHANGED'; END IF;
  SELECT md5(string_agg(t.id||':'||t.type||':'||t.status||':'||t.business_date||':'||t.amount::text||':'||coalesce(t.party_id::text,'')||':'||
           coalesce((SELECT string_agg(m.id||'/'||m.fund_account_id||'/'||m.amount::text, ',' ORDER BY m.id) FROM public.ledger_movements m WHERE m.transaction_id = t.id), ''), '|' ORDER BY t.id))
    INTO v_f FROM public.ledger_transactions t WHERE t.id IN (1090, 1094);
  IF v_f <> 'f7eaa49778ae805f46ee8c89c96e4f2b' THEN RAISE EXCEPTION 'DABACO126_POST_PAYMENT_TX_CHANGED'; END IF;
  IF (SELECT md5(p.id||':'||p.party_id||':'||p.original_amount::text||':'||p.status||':'||p.expense_transaction_id) FROM public.ledger_payables p WHERE p.id = 107) <> '80b9843b5c9abcab0874c6b98b2ea43a' THEN
    RAISE EXCEPTION 'DABACO126_POST_PAYABLE107_CHANGED';
  END IF;
  SELECT sum(p.original_amount - coalesce((SELECT sum(a.allocated_amount) FROM public.ledger_payable_allocations a
           JOIN public.ledger_transactions pt ON pt.id = a.payment_transaction_id AND pt.status = 'confirmed' WHERE a.payable_id = p.id), 0))
    INTO v_f FROM public.ledger_payables p WHERE p.party_id = 15 AND p.status <> 'cancelled';
  IF v_f::numeric <> v_open THEN RAISE EXCEPTION 'DABACO126_POST_OKMART_OPEN_CHANGED %', v_f; END IF;
  SELECT t.amount - coalesce(sum(a.allocated_amount), 0) INTO v_unalloc
    FROM public.ledger_transactions t LEFT JOIN public.ledger_payable_allocations a ON a.payment_transaction_id = t.id WHERE t.id = 1090 GROUP BY t.amount;
  IF v_unalloc <> 126000 THEN RAISE EXCEPTION 'DABACO126_POST_1090_UNALLOCATED_UNEXPECTED %', v_unalloc; END IF;
  IF EXISTS (SELECT 1 FROM public.ledger_payables p WHERE p.party_id = 15
              AND (SELECT coalesce(sum(a.allocated_amount), 0) FROM public.ledger_payable_allocations a WHERE a.payable_id = p.id) > p.original_amount) THEN
    RAISE EXCEPTION 'DABACO126_POST_OVERALLOCATED';
  END IF;
  IF (SELECT md5(to_jsonb(c)::text) FROM public.ledger_candidates c WHERE c.id = 24) <> '10b258d3065e5b702139a19090f03525'
     OR (SELECT md5(to_jsonb(l)::text) FROM public.inventory_logs l WHERE l.id = 8223) <> '690cd1e480434ec2116ab582462055fb'
     OR (SELECT md5(to_jsonb(t)::text) FROM public.ledger_transactions t WHERE t.id = 1057) <> '762862a88e086cf6a6315824ad2200dc' THEN
    RAISE EXCEPTION 'DABACO126_POST_SOURCE_ROWS_CHANGED';
  END IF;

  ---------------------------------------------------------------------------
  -- 5. 감사(되돌리기에 필요한 전체 before/after).
  ---------------------------------------------------------------------------
  INSERT INTO public.ledger_audit_logs (actor_user_id, action, entity_type, entity_id, before_snapshot, after_snapshot, reason)
  VALUES (v_actor, c_action, 'transaction', 30,
    jsonb_build_object('transaction', to_jsonb(v_tx30), 'payable', to_jsonb(v_p15), 'allocation', to_jsonb(v_a6),
      'fundBalances', v_bal_before, 'cashDay', v_day_before, 'augExpense', v_exp, 'augRevenue', v_rev, 'okMartOpen', v_open, 'payment1090Unallocated', 0),
    jsonb_build_object('transaction', to_jsonb(v_tx30_after), 'payable', to_jsonb(v_p15_after), 'allocation', NULL,
      'caseIds', jsonb_build_array(v_a, v_b), 'technicalRebaseId', v_b,
      'fundBalances', v_bal_after, 'cashDay', v_day_after, 'augExpense', v_exp, 'augRevenue', v_rev, 'okMartOpen', v_open, 'payment1090Unallocated', v_unalloc,
      'changedFields', jsonb_build_array('ledger_transactions#30.party_id', 'ledger_payables#15.status', 'ledger_payable_allocations#6(deleted)')),
    'aug02-dabaco126-20261104: 시트 G14 Dabaco 현금 421,000₫ 중 #30 126,000₫이 Ok Mart 후불 #15/배분 #6(→#1090)으로 오귀속. '
    || '#1090·#1094 실제 지급과 다른 24개 배분 보존, 126,000₫은 #1090 미배정 정산분. 8/2 현금 지급 복원 + 8/31 기술재기준화(실입금 아님). 재고·원가·후보 무변경.')
  RETURNING id INTO v_audit;

  RAISE NOTICE 'DABACO126_OK correction A #%, rebase B #%, audit #%', v_a, v_b, v_audit;
END
$dabaco126$;

COMMIT;
