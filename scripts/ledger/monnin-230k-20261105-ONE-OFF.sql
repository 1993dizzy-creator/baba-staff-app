-- =============================================================================
-- BABA 11/5 Monin 리치 시럽 230,000₫ 단건 정정 — ONE-OFF (Migration 아님, Claude 미실행)
-- 승인값 2줄이 없으면 쓰기 전에 BLOCKED 예외로 전체 롤백된다. 파일 전체를 한 번에 실행한다.
--
-- 사실(2026-11-06 운영 읽기 전용 확인):
--   입고 #14994 (1 Chai × 230,000, 거래처 #19 Shop đồ khô chợ nhớn, business_date 11/6, created 11/6 15:23 VN)
--   → 후보 #2359 confirmed → 입고비용 TX #4168 (expense 230,000, 11/6, 11월 인식) → 미지급 #1909 unpaid, 배분 0.
--   시트 정본 11월!G75: 11/5 현금 지출 230,000₫. 직원이 하루 늦게 등록.
--
-- inventory_logs #14994 는 바꾸지 않는다:
--   inventory_writer_audit_guard 가 커밋된 행의 모든 UPDATE 를 INVENTORY_SOURCE_AUDIT_IMMUTABLE 로 거부하고,
--   기존 입고 수정 RPC 는 원본 날짜를 바꾸지 못한 채 정정 로그 + 재기표(신규 비용)를 만든다(#4168 단독 사용 위반).
--   또 11/6 15:23:09 재고확인 #14993(0.6→0)이 이 입고(15:23:20)보다 먼저라, 입고를 11/5 로 옮기면 그 재고확인
--   스냅샷의 전후 관계가 깨진다. 따라서 재고 원본·재고확인은 등록일(11/6) 그대로 두고 장부 영업일만 정정한다.
--
-- 변경(이것만, 순서대로):
--   1. TX #4168 business_date 11/6→11/5, occurred_at 11/6 03:00 VN→11/5 03:00 VN (두 컬럼 + updated_at).
--      금액·분류·거래처·인식월(11월)·원천 스냅샷/지문·후보 #2359·미지급 #1909 원금 불변. 감사 로그 1행.
--   2. 기존 RPC ledger_pay_payables_v2(고정 request_id → 정확히 1회)로 11/5 매장현금 230,000₫ 지급,
--      #1909 에 230,000 지정 배분. 지급 TX·이동·배분·지급 감사는 RPC 가 만든다.
-- 결과: 11/5 매장현금 일계 −388,200 → −618,200, #1909 paid, 거래처 #19 미지급 0, 11/6 현금 변화 0,
--   11월 비용 합계 변화 0, 재고·재고로그·후보 변화 0, 카드입금 #4177·băng dính #4163 무변경.
-- 재실행: 완료 상태면 ALREADY_APPLIED 알림 후 변경 0, 일부만 있으면 예외·전체 롤백.
-- =============================================================================

BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ▼ 운영 승인 후에만 주석 해제하고 값을 넣는다(actor = 활성 owner/master users.id).
-- SET LOCAL baba.correction_actor_user_id = '__ACTOR_USER_ID__';
-- SET LOCAL baba.monnin230_approval = 'APPROVED:monnin-230k-20261105';

DO $monnin230$
DECLARE
  c_approval constant text := 'APPROVED:monnin-230k-20261105';
  c_action constant text := 'monnin_230k_20261105_business_date_and_cash_payment';
  c_request constant uuid := 'b7a1c5e2-5d0f-4c3e-9a51-202611050230';
  c_memo constant text := '11/5 현금 지급 Monin 리치 시럽 230,000₫ (시트 11월!G75, 입고 #14994 지연 등록)';
  c_paid_at constant timestamptz := TIMESTAMPTZ '2026-11-05 05:00:00+00'; -- 11/5 12:00 VN → 영업일 11/5
  v_actor bigint;
  v_tx public.ledger_transactions%rowtype; v_tx_after public.ledger_transactions%rowtype;
  v_pay public.ledger_payables%rowtype;
  v_result jsonb; v_payment_id bigint; v_audit bigint; v_n integer;
  v_cash_1105 numeric; v_cash_1106 numeric; v_nov_exp numeric;
  v_item jsonb; v_item_logs text; v_guard text;
BEGIN
  -- 0. 승인 게이트(쓰기 전).
  IF current_setting('baba.monnin230_approval', true) IS DISTINCT FROM c_approval THEN
    RAISE EXCEPTION 'MONNIN230_BLOCKED_APPROVAL_REQUIRED';
  END IF;
  IF coalesce(current_setting('baba.correction_actor_user_id', true), '') !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'MONNIN230_BLOCKED_ACTOR_REQUIRED';
  END IF;
  v_actor := current_setting('baba.correction_actor_user_id')::bigint;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = v_actor AND is_active AND app_login_enabled
                 AND lower(role::text) IN ('owner', 'master')) THEN
    RAISE EXCEPTION 'MONNIN230_ACTIVE_OWNER_OR_MASTER_REQUIRED';
  END IF;
  IF current_setting('transaction_isolation') <> 'serializable' THEN RAISE EXCEPTION 'MONNIN230_SERIALIZABLE_REQUIRED'; END IF;

  -- 월 잠금 → 대상 행 잠금 (RPC 와 같은 순서). 가드는 끄지 않는다.
  PERFORM pg_advisory_xact_lock(hashtext('ledger_month_close:2026-11'));
  PERFORM public.ledger_assert_month_open_v1(DATE '2026-11-01');
  SELECT * INTO STRICT v_tx FROM public.ledger_transactions WHERE id = 4168 FOR UPDATE;
  SELECT * INTO STRICT v_pay FROM public.ledger_payables WHERE id = 1909 FOR UPDATE;
  PERFORM 1 FROM public.inventory_logs WHERE id = 14994 FOR SHARE;

  -- 1. 중복 방지.
  IF EXISTS (SELECT 1 FROM public.ledger_audit_logs WHERE action = c_action)
     OR EXISTS (SELECT 1 FROM public.ledger_payable_payment_requests WHERE request_id = c_request)
     OR EXISTS (SELECT 1 FROM public.ledger_payable_allocations WHERE payable_id = 1909) THEN
    IF (SELECT count(*) FROM public.ledger_audit_logs WHERE action = c_action) = 1
       AND v_tx.business_date = DATE '2026-11-05' AND v_pay.status = 'paid'
       AND (SELECT count(*) FROM public.ledger_payable_allocations a
             JOIN public.ledger_payable_payment_requests r ON r.payment_transaction_id = a.payment_transaction_id
            WHERE a.payable_id = 1909 AND a.allocated_amount = 230000 AND r.request_id = c_request) = 1
       AND (SELECT count(*) FROM public.ledger_payable_allocations WHERE payable_id = 1909) = 1 THEN
      RAISE NOTICE 'MONNIN230_ALREADY_APPLIED: nothing changed';
      RETURN;
    END IF;
    RAISE EXCEPTION 'MONNIN230_PARTIAL_OR_FOREIGN_STATE';
  END IF;

  -- 2. 사전 조건(2026-11-06 읽기 전용 확인값).
  IF md5(to_jsonb(v_tx)::text) <> '0211bcebabed0ae53f4e1373e5b81ba9'
     OR NOT (v_tx.type = 'expense' AND v_tx.status = 'confirmed' AND v_tx.amount = 230000 AND v_tx.party_id = 19
       AND v_tx.business_date = DATE '2026-11-06' AND v_tx.recognition_month = DATE '2026-11-01'
       AND v_tx.source_key = 'candidate:2359' AND v_tx.correction_of_id IS NULL) THEN
    RAISE EXCEPTION 'MONNIN230_TX4168_CHANGED';
  END IF;
  IF md5(to_jsonb(v_pay)::text) <> '7641188923a37a8e705bdfe15f37337a'
     OR NOT (v_pay.status = 'unpaid' AND v_pay.original_amount = 230000 AND v_pay.party_id = 19 AND v_pay.expense_transaction_id = 4168) THEN
    RAISE EXCEPTION 'MONNIN230_PAYABLE1909_CHANGED';
  END IF;
  IF (SELECT md5(to_jsonb(l)::text) FROM public.inventory_logs l WHERE id = 14994) <> '6cca5984d20f344b81273f6529eeacf3' THEN
    RAISE EXCEPTION 'MONNIN230_LOG14994_CHANGED';
  END IF;
  IF (SELECT md5(to_jsonb(c)::text) FROM public.ledger_candidates c WHERE id = 2359) <> 'a02d785476aadd53f68206ad759313d4' THEN
    RAISE EXCEPTION 'MONNIN230_CANDIDATE2359_CHANGED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ledger_movements WHERE transaction_id = 4168) THEN RAISE EXCEPTION 'MONNIN230_TX4168_HAS_MOVEMENT'; END IF;
  IF (SELECT count(*) FROM public.ledger_payables p WHERE p.party_id = 19 AND p.status NOT IN ('paid', 'cancelled')) <> 1 THEN
    RAISE EXCEPTION 'MONNIN230_PARTY19_OPEN_PAYABLES_CHANGED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ledger_fund_accounts WHERE id = 1 AND code = 'store_cash' AND is_active AND is_business_fund) THEN
    RAISE EXCEPTION 'MONNIN230_STORE_CASH_ACCOUNT_CHANGED';
  END IF;

  SELECT coalesce(sum(m.amount), 0) INTO v_cash_1105 FROM public.ledger_movements m JOIN public.ledger_transactions t
    ON t.id = m.transaction_id AND t.status = 'confirmed' WHERE m.fund_account_id = 1 AND t.business_date = DATE '2026-11-05';
  SELECT coalesce(sum(m.amount), 0) INTO v_cash_1106 FROM public.ledger_movements m JOIN public.ledger_transactions t
    ON t.id = m.transaction_id AND t.status = 'confirmed' WHERE m.fund_account_id = 1 AND t.business_date = DATE '2026-11-06';
  IF v_cash_1105 <> -388200 THEN RAISE EXCEPTION 'MONNIN230_CASH_1105_CHANGED %', v_cash_1105; END IF;
  SELECT sum(amount * economic_effect_sign) INTO v_nov_exp FROM public.ledger_transactions
   WHERE status = 'confirmed' AND type IN ('expense', 'expense_recognition') AND recognition_month = DATE '2026-11-01';
  -- 재고·재고로그(재고확인 포함)·완료 거래 #4177/#4163 은 실행 중 그대로여야 한다.
  SELECT to_jsonb(i) INTO v_item FROM public.inventory i WHERE id = 278;
  SELECT md5(string_agg(to_jsonb(l)::text, '|' ORDER BY l.id)) INTO v_item_logs FROM public.inventory_logs l WHERE l.item_id = 278;
  SELECT md5(string_agg(to_jsonb(t)::text, '|' ORDER BY t.id)) INTO v_guard FROM public.ledger_transactions t WHERE t.id IN (4163, 4177);

  -- 3. 장부 영업일 정정(#4168 두 컬럼만).
  UPDATE public.ledger_transactions
     SET business_date = DATE '2026-11-05', occurred_at = TIMESTAMPTZ '2026-11-04 20:00:00+00', updated_at = now()
   WHERE id = 4168 AND business_date = DATE '2026-11-06'
   RETURNING * INTO v_tx_after;
  IF v_tx_after.id IS NULL
     OR (to_jsonb(v_tx_after) - 'business_date' - 'occurred_at' - 'updated_at') <> (to_jsonb(v_tx) - 'business_date' - 'occurred_at' - 'updated_at') THEN
    RAISE EXCEPTION 'MONNIN230_TX4168_UPDATE_UNEXPECTED';
  END IF;
  INSERT INTO public.ledger_audit_logs (actor_user_id, action, entity_type, entity_id, before_snapshot, after_snapshot, reason)
  VALUES (v_actor, c_action, 'transaction', 4168,
    jsonb_build_object('transaction', to_jsonb(v_tx), 'payable', to_jsonb(v_pay), 'allocations', '[]'::jsonb, 'cash20261105', v_cash_1105),
    jsonb_build_object('transaction', to_jsonb(v_tx_after), 'paymentRequestId', c_request,
      'changedFields', jsonb_build_array('ledger_transactions#4168.business_date', 'ledger_transactions#4168.occurred_at'),
      'inventoryLogUnchanged', 14994, 'candidateUnchanged', 2359),
    'monnin-230k-20261105: 입고 #14994 는 11/6 지연 등록, 시트 11월!G75 11/5 현금 지출 230,000₫. '
    || '장부 영업일만 11/5 로 정정(재고 원본·재고확인 #14993·후보 #2359 불변, 신규 비용 없음). 이어서 #1909 에 11/5 현금 지급 1회.')
  RETURNING id INTO v_audit;

  -- 4. 지급 연결: 기존 RPC, 고정 request_id, #1909 지정 배분.
  v_result := public.ledger_pay_payables_v2(c_request, 19, 1, c_paid_at, 230000,
    '[{"payableId":1909,"allocatedAmount":230000}]'::jsonb, c_memo, v_actor);
  IF v_result->>'status' IS DISTINCT FROM 'paid' THEN RAISE EXCEPTION 'MONNIN230_PAYMENT_FAILED %', v_result; END IF;
  v_payment_id := (v_result->>'paymentTransactionId')::bigint;

  -- 5. 사후 조건.
  IF NOT EXISTS (SELECT 1 FROM public.ledger_transactions WHERE id = v_payment_id AND type = 'payable_payment' AND status = 'confirmed'
                 AND business_date = DATE '2026-11-05' AND amount = 230000 AND party_id = 19)
     OR (SELECT count(*) FROM public.ledger_movements WHERE transaction_id = v_payment_id) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.ledger_movements WHERE transaction_id = v_payment_id AND fund_account_id = 1 AND amount = -230000) THEN
    RAISE EXCEPTION 'MONNIN230_POST_PAYMENT_TX_UNEXPECTED';
  END IF;
  SELECT count(*) INTO v_n FROM public.ledger_payable_allocations WHERE payable_id = 1909;
  IF v_n <> 1 OR NOT EXISTS (SELECT 1 FROM public.ledger_payable_allocations WHERE payable_id = 1909
                             AND payment_transaction_id = v_payment_id AND allocated_amount = 230000)
     OR (SELECT status FROM public.ledger_payables WHERE id = 1909) <> 'paid'
     OR (SELECT to_jsonb(p) - 'status' - 'updated_at' FROM public.ledger_payables p WHERE id = 1909) <> (to_jsonb(v_pay) - 'status' - 'updated_at') THEN
    RAISE EXCEPTION 'MONNIN230_POST_PAYABLE_UNEXPECTED';
  END IF;
  IF (SELECT coalesce(sum(m.amount), 0) FROM public.ledger_movements m JOIN public.ledger_transactions t ON t.id = m.transaction_id AND t.status = 'confirmed'
       WHERE m.fund_account_id = 1 AND t.business_date = DATE '2026-11-05') <> -618200
     OR (SELECT coalesce(sum(m.amount), 0) FROM public.ledger_movements m JOIN public.ledger_transactions t ON t.id = m.transaction_id AND t.status = 'confirmed'
       WHERE m.fund_account_id = 1 AND t.business_date = DATE '2026-11-06') <> v_cash_1106 THEN
    RAISE EXCEPTION 'MONNIN230_POST_CASH_UNEXPECTED';
  END IF;
  IF (SELECT sum(amount * economic_effect_sign) FROM public.ledger_transactions
       WHERE status = 'confirmed' AND type IN ('expense', 'expense_recognition') AND recognition_month = DATE '2026-11-01') <> v_nov_exp
     OR EXISTS (SELECT 1 FROM public.ledger_payables p WHERE p.party_id = 19 AND p.status NOT IN ('paid', 'cancelled'))
     OR (SELECT to_jsonb(i) FROM public.inventory i WHERE id = 278) <> v_item
     OR (SELECT md5(string_agg(to_jsonb(l)::text, '|' ORDER BY l.id)) FROM public.inventory_logs l WHERE l.item_id = 278) <> v_item_logs
     OR (SELECT md5(to_jsonb(c)::text) FROM public.ledger_candidates c WHERE id = 2359) <> 'a02d785476aadd53f68206ad759313d4'
     OR (SELECT md5(string_agg(to_jsonb(t)::text, '|' ORDER BY t.id)) FROM public.ledger_transactions t WHERE t.id IN (4163, 4177)) <> v_guard
     OR (SELECT count(*) FROM public.ledger_transactions WHERE source_key = 'candidate:2359') <> 1 THEN
    RAISE EXCEPTION 'MONNIN230_POST_PROTECTED_STATE_CHANGED';
  END IF;

  RAISE NOTICE 'MONNIN230_OK tx #4168 → 2026-11-05, payment #% (11/5 cash -230,000), payable #1909 paid, audit #%', v_payment_id, v_audit;
END
$monnin230$;

-- 읽기 전용 결과 확인.
SELECT t.id, t.type, t.business_date, t.amount, p.id AS payable_id, p.status AS payable_status,
       (SELECT jsonb_agg(jsonb_build_object('payment', a.payment_transaction_id, 'amount', a.allocated_amount))
          FROM public.ledger_payable_allocations a WHERE a.payable_id = p.id) AS allocations,
       (SELECT sum(m.amount) FROM public.ledger_movements m JOIN public.ledger_transactions x ON x.id = m.transaction_id AND x.status = 'confirmed'
         WHERE m.fund_account_id = 1 AND x.business_date = DATE '2026-11-05') AS store_cash_20261105
  FROM public.ledger_transactions t JOIN public.ledger_payables p ON p.expense_transaction_id = t.id
 WHERE t.id = 4168;
COMMIT;
