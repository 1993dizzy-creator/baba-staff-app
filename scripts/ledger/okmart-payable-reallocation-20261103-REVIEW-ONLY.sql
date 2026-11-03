-- =============================================================================
-- BABA one-time correction: Ok Mart (ledger_parties.id=15) payable allocations
-- REVIEW-ONLY. Do not run against production until reviewed and separately
-- approved. Not a migration; run once, as a single transaction, from psql.
--
-- Source of truth: Notion "거래처 지급·미지급 P1" (2026-11-03 user redefinition).
-- Zalo weekly claims == APP weekly purchases == payment amount for each row:
--
--   payment  date        amount        target purchase window (expense date)
--   #2396    2026-10-01   8,215,016₫    2026-09-21 .. 2026-09-27  (22 payables)
--   #2800    2026-10-10   6,409,500₫    2026-09-28 .. 2026-10-04  (18 payables)
--   #3281    2026-10-19   8,296,000₫    2026-10-05 .. 2026-10-11  (26 payables)
--   #3583    2026-10-31  21,953,000₫    2026-10-12 .. 2026-10-25  (58 payables)
--
-- The previous oldest-first allocation shifted every link by 2,670,000₫:
-- #1978 (9/23 bridge payment) occupies the 9/21-23 purchases (exactly
-- 2,670,000₫) and #3583 spills 2,670,000₫ into the 10/26 week.
--
-- What this script changes (and nothing else):
--   * ledger_payable_allocations of #2396/#2800/#3281/#3583 are rebuilt to
--     cover exactly their target window, each payable in full.
--   * #1978 loses only its allocations on the 9/21-23 purchases; its
--     2,670,000₫ stays UNALLOCATED (Notion: 9월 교량금 — no arbitrary target).
--     #1978's 9/18-20 allocations (4,208,958₫) are untouched.
--   * ledger_payables.status/updated_at recomputed for touched payables.
--   * one ledger_audit_logs row per changed payment + one summary row.
--
-- Expected result: Ok Mart open payables 6,313,500₫ -> 8,983,500₫
--   (= 10/26..11/01 week 5,083,500₫, matching the Zalo claim, + Nov 3,900,000₫
--    which stays unpaid). No transaction, movement, fund account, amount,
--   business date, inventory cost, sheet value or payment request changes.
--
-- Out of scope (blocked, see report): Phương and Carlsberg (9/17 #1641/#1797
-- recipient + invoice evidence, Phương 1,296,000₫, and their August payables
-- are protected by the August rebuild payable fingerprint), Ok Mart 9/10
-- #1793/#1794 and 9/23 #1979 bridge items.
--
-- Guards: exact pre-state fingerprints recorded 2026-11-03 (read-only),
-- month-open assertion, August-rebuild payable fingerprint unchanged,
-- transaction/movement/request fingerprints unchanged, exact post-state sums.
-- Any mismatch raises and the whole transaction rolls back.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- Approver recorded in ledger_audit_logs. Reviewer: confirm before running.
SET LOCAL baba.correction_actor_user_id = '1';

LOCK TABLE public.ledger_payable_allocations IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.ledger_payables IN SHARE ROW EXCLUSIVE MODE;

DO $okmart$
DECLARE
  c_party constant bigint := 15;
  c_bridge constant bigint := 1978;
  c_payments constant bigint[] := array[1978, 2396, 2800, 3281, 3583];
  c_bridge_released constant numeric := 2670000;
  -- Pre-state recorded 2026-11-03 from production (read-only queries).
  c_f_alloc constant text := '9e72ece59d8f91e3876fd8cc52fe001c';
  c_n_alloc constant integer := 145;
  c_f_tx constant text := 'b4085fbac040f252ac9fa882fcb330e5';
  c_f_payables constant text := '4a5b3844e9a6fe9752ccfa6e64980dcf';
  c_n_affected constant integer := 145;
  c_f_req constant text := '3fb7195e6456f741891d6c5eeda0613d';
  c_open_before constant numeric := 6313500;
  v_actor bigint := nullif(current_setting('baba.correction_actor_user_id', true), '')::bigint;
  v_f text; v_n integer; v_open_after numeric; v_aug_before text; v_aug_after text;
  v_f_tx_after text; v_f_req_after text; v_bad integer;
  v_before jsonb; v_after jsonb; v_pay record;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.users WHERE id = v_actor) THEN
    RAISE EXCEPTION 'OKMART_REALLOC_ACTOR_REQUIRED';
  END IF;

  CREATE TEMP TABLE okmart_window(payment_id bigint PRIMARY KEY, d1 date NOT NULL, d2 date NOT NULL) ON COMMIT DROP;
  INSERT INTO okmart_window VALUES
    (2396, DATE '2026-09-21', DATE '2026-09-27'),
    (2800, DATE '2026-09-28', DATE '2026-10-04'),
    (3281, DATE '2026-10-05', DATE '2026-10-11'),
    (3583, DATE '2026-10-12', DATE '2026-10-25');

  -- Payables in the 9/21..10/25 windows or currently allocated by the five payments.
  CREATE TEMP TABLE okmart_affected ON COMMIT DROP AS
    SELECT p.id FROM public.ledger_payables p
      JOIN public.ledger_transactions e ON e.id = p.expense_transaction_id
     WHERE p.party_id = c_party AND e.business_date BETWEEN DATE '2026-09-21' AND DATE '2026-10-25'
    UNION
    SELECT a.payable_id FROM public.ledger_payable_allocations a WHERE a.payment_transaction_id = ANY (c_payments);

  ---------------------------------------------------------------------------
  -- 1. Preflight: exact pre-state.
  ---------------------------------------------------------------------------
  PERFORM public.ledger_assert_month_open_v1(DATE '2026-09-01');
  PERFORM public.ledger_assert_month_open_v1(DATE '2026-10-01');

  SELECT md5(coalesce(string_agg(a.id||':'||a.payable_id||':'||a.payment_transaction_id||':'||a.allocated_amount::text, '|' ORDER BY a.id), '')), count(*)
    INTO v_f, v_n FROM public.ledger_payable_allocations a WHERE a.payment_transaction_id = ANY (c_payments);
  IF v_f <> c_f_alloc OR v_n <> c_n_alloc THEN RAISE EXCEPTION 'OKMART_REALLOC_ALLOCATION_FINGERPRINT_CHANGED (% rows)', v_n; END IF;

  SELECT md5(string_agg(t.id||':'||t.type||':'||t.status||':'||t.business_date||':'||t.amount::text||':'||coalesce(t.party_id::text, '')||':'||
           coalesce((SELECT sum(m.amount)::text||'/'||count(*) FROM public.ledger_movements m WHERE m.transaction_id = t.id), ''), '|' ORDER BY t.id))
    INTO v_f FROM public.ledger_transactions t WHERE t.id = ANY (c_payments);
  IF v_f IS DISTINCT FROM c_f_tx THEN RAISE EXCEPTION 'OKMART_REALLOC_TRANSACTION_FINGERPRINT_CHANGED'; END IF;

  SELECT md5(string_agg(p.id||':'||p.party_id||':'||p.original_amount::text||':'||p.status||':'||p.expense_transaction_id, '|' ORDER BY p.id)), count(*)
    INTO v_f, v_n FROM public.ledger_payables p WHERE p.id IN (SELECT id FROM okmart_affected);
  IF v_f IS DISTINCT FROM c_f_payables OR v_n <> c_n_affected THEN RAISE EXCEPTION 'OKMART_REALLOC_PAYABLE_FINGERPRINT_CHANGED (% rows)', v_n; END IF;

  SELECT md5(coalesce(string_agg(r.request_id||':'||r.payment_transaction_id||':'||md5(r.request_payload::text)||':'||md5(coalesce(r.result::text, '')), '|' ORDER BY r.request_id::text), ''))
    INTO v_f FROM public.ledger_payable_payment_requests r WHERE r.payment_transaction_id = ANY (c_payments);
  IF v_f IS DISTINCT FROM c_f_req THEN RAISE EXCEPTION 'OKMART_REALLOC_PAYMENT_REQUEST_FINGERPRINT_CHANGED'; END IF;

  IF (SELECT sum(p.original_amount - coalesce((SELECT sum(a.allocated_amount) FROM public.ledger_payable_allocations a
          JOIN public.ledger_transactions pt ON pt.id = a.payment_transaction_id AND pt.status = 'confirmed' WHERE a.payable_id = p.id), 0))
        FROM public.ledger_payables p WHERE p.party_id = c_party AND p.status <> 'cancelled') <> c_open_before THEN
    RAISE EXCEPTION 'OKMART_REALLOC_OPEN_BALANCE_CHANGED';
  END IF;

  -- Each target window must equal its payment amount exactly, with no other payment inside it.
  IF EXISTS (
    SELECT 1 FROM okmart_window w JOIN public.ledger_transactions t ON t.id = w.payment_id
     WHERE t.amount <> (SELECT coalesce(sum(p.original_amount), 0) FROM public.ledger_payables p
                          JOIN public.ledger_transactions e ON e.id = p.expense_transaction_id AND e.status = 'confirmed'
                         WHERE p.party_id = c_party AND p.status <> 'cancelled' AND e.business_date BETWEEN w.d1 AND w.d2)
  ) THEN RAISE EXCEPTION 'OKMART_REALLOC_WINDOW_TOTAL_MISMATCH'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.ledger_payable_allocations a
      JOIN public.ledger_payables p ON p.id = a.payable_id
      JOIN public.ledger_transactions e ON e.id = p.expense_transaction_id
     WHERE p.party_id = c_party AND e.business_date BETWEEN DATE '2026-09-21' AND DATE '2026-10-25'
       AND a.payment_transaction_id <> ALL (c_payments)
  ) THEN RAISE EXCEPTION 'OKMART_REALLOC_FOREIGN_ALLOCATION_IN_WINDOW'; END IF;

  -- August rebuild protection: same definition as baba_august_rebuild_private.payable_fingerprint().
  SELECT md5(coalesce(string_agg(x.id::text||':'||x.payable_id::text||':'||x.payment_transaction_id::text||':'||x.allocated_amount::text, '|' ORDER BY x.id), ''))
    INTO v_aug_before
    FROM public.ledger_payable_allocations x
    JOIN public.ledger_payables p ON p.id = x.payable_id
    JOIN public.ledger_transactions src ON src.id = p.expense_transaction_id
    JOIN public.ledger_transactions payment ON payment.id = x.payment_transaction_id
   WHERE src.business_date BETWEEN DATE '2026-08-01' AND DATE '2026-08-31'
     AND src.status = 'confirmed' AND payment.status = 'confirmed'
     AND payment.business_date BETWEEN DATE '2026-09-01' AND DATE '2026-10-31';

  CREATE TEMP TABLE okmart_before ON COMMIT DROP AS
    SELECT a.payment_transaction_id, a.payable_id, a.allocated_amount FROM public.ledger_payable_allocations a
     WHERE a.payment_transaction_id = ANY (c_payments);

  ---------------------------------------------------------------------------
  -- 2. Reallocate.
  ---------------------------------------------------------------------------
  DELETE FROM public.ledger_payable_allocations a
   WHERE a.payment_transaction_id IN (SELECT payment_id FROM okmart_window)
      OR (a.payment_transaction_id = c_bridge AND a.payable_id IN (
            SELECT p.id FROM public.ledger_payables p JOIN public.ledger_transactions e ON e.id = p.expense_transaction_id
             WHERE p.party_id = c_party AND e.business_date BETWEEN DATE '2026-09-21' AND DATE '2026-09-27'));

  INSERT INTO public.ledger_payable_allocations (payable_id, payment_transaction_id, allocated_amount)
  SELECT p.id, w.payment_id, p.original_amount
    FROM okmart_window w
    JOIN public.ledger_payables p ON p.party_id = c_party AND p.status <> 'cancelled'
    JOIN public.ledger_transactions e ON e.id = p.expense_transaction_id AND e.status = 'confirmed'
   WHERE e.business_date BETWEEN w.d1 AND w.d2
   ORDER BY w.payment_id, e.business_date, p.id;

  -- Same status rule as ledger_pay_payables_v1: fully covered -> paid, some -> partially_paid, none -> unpaid.
  UPDATE public.ledger_payables p
     SET status = s.next_status, updated_at = now()
    FROM (
      SELECT p2.id,
             CASE WHEN coalesce(x.alloc, 0) >= p2.original_amount THEN 'paid'
                  WHEN coalesce(x.alloc, 0) > 0 THEN 'partially_paid'
                  ELSE 'unpaid' END AS next_status
        FROM public.ledger_payables p2
        LEFT JOIN (SELECT a.payable_id, sum(a.allocated_amount) alloc FROM public.ledger_payable_allocations a
                     JOIN public.ledger_transactions pt ON pt.id = a.payment_transaction_id AND pt.status = 'confirmed'
                    GROUP BY a.payable_id) x ON x.payable_id = p2.id
       WHERE p2.id IN (SELECT id FROM okmart_affected) AND p2.status <> 'cancelled'
    ) s
   WHERE p.id = s.id AND p.status <> s.next_status;

  ---------------------------------------------------------------------------
  -- 3. Post-state assertions.
  ---------------------------------------------------------------------------
  IF EXISTS (
    SELECT 1 FROM (VALUES (1978, 4208958::numeric), (2396, 8215016), (2800, 6409500), (3281, 8296000), (3583, 21953000)) e(pay, expected)
     WHERE e.expected <> (SELECT coalesce(sum(a.allocated_amount), 0) FROM public.ledger_payable_allocations a WHERE a.payment_transaction_id = e.pay)
  ) THEN RAISE EXCEPTION 'OKMART_REALLOC_PAYMENT_ALLOCATION_TOTAL_MISMATCH'; END IF;

  SELECT count(*) INTO v_bad
    FROM okmart_window w
    JOIN public.ledger_payables p ON p.party_id = c_party AND p.status <> 'cancelled'
    JOIN public.ledger_transactions e ON e.id = p.expense_transaction_id AND e.business_date BETWEEN w.d1 AND w.d2
   WHERE p.status <> 'paid'
      OR (SELECT count(*) FROM public.ledger_payable_allocations a WHERE a.payable_id = p.id) <> 1
      OR NOT EXISTS (SELECT 1 FROM public.ledger_payable_allocations a WHERE a.payable_id = p.id
                        AND a.payment_transaction_id = w.payment_id AND a.allocated_amount = p.original_amount);
  IF v_bad > 0 THEN RAISE EXCEPTION 'OKMART_REALLOC_WINDOW_NOT_EXACT (% payables)', v_bad; END IF;

  IF EXISTS (
    SELECT 1 FROM public.ledger_payables p
     WHERE p.party_id = c_party AND p.original_amount < (SELECT coalesce(sum(a.allocated_amount), 0) FROM public.ledger_payable_allocations a WHERE a.payable_id = p.id)
  ) THEN RAISE EXCEPTION 'OKMART_REALLOC_OVER_ALLOCATED'; END IF;

  SELECT sum(p.original_amount - coalesce((SELECT sum(a.allocated_amount) FROM public.ledger_payable_allocations a
           JOIN public.ledger_transactions pt ON pt.id = a.payment_transaction_id AND pt.status = 'confirmed' WHERE a.payable_id = p.id), 0))
    INTO v_open_after FROM public.ledger_payables p WHERE p.party_id = c_party AND p.status <> 'cancelled';
  IF v_open_after <> c_open_before + c_bridge_released THEN
    RAISE EXCEPTION 'OKMART_REALLOC_OPEN_BALANCE_UNEXPECTED (% -> %)', c_open_before, v_open_after;
  END IF;

  SELECT md5(string_agg(t.id||':'||t.type||':'||t.status||':'||t.business_date||':'||t.amount::text||':'||coalesce(t.party_id::text, '')||':'||
           coalesce((SELECT sum(m.amount)::text||'/'||count(*) FROM public.ledger_movements m WHERE m.transaction_id = t.id), ''), '|' ORDER BY t.id))
    INTO v_f_tx_after FROM public.ledger_transactions t WHERE t.id = ANY (c_payments);
  SELECT md5(coalesce(string_agg(r.request_id||':'||r.payment_transaction_id||':'||md5(r.request_payload::text)||':'||md5(coalesce(r.result::text, '')), '|' ORDER BY r.request_id::text), ''))
    INTO v_f_req_after FROM public.ledger_payable_payment_requests r WHERE r.payment_transaction_id = ANY (c_payments);
  SELECT md5(coalesce(string_agg(x.id::text||':'||x.payable_id::text||':'||x.payment_transaction_id::text||':'||x.allocated_amount::text, '|' ORDER BY x.id), ''))
    INTO v_aug_after
    FROM public.ledger_payable_allocations x
    JOIN public.ledger_payables p ON p.id = x.payable_id
    JOIN public.ledger_transactions src ON src.id = p.expense_transaction_id
    JOIN public.ledger_transactions payment ON payment.id = x.payment_transaction_id
   WHERE src.business_date BETWEEN DATE '2026-08-01' AND DATE '2026-08-31'
     AND src.status = 'confirmed' AND payment.status = 'confirmed'
     AND payment.business_date BETWEEN DATE '2026-09-01' AND DATE '2026-10-31';
  IF v_f_tx_after <> c_f_tx THEN RAISE EXCEPTION 'OKMART_REALLOC_TRANSACTION_CHANGED'; END IF;
  IF v_f_req_after <> c_f_req THEN RAISE EXCEPTION 'OKMART_REALLOC_PAYMENT_REQUEST_CHANGED'; END IF;
  IF v_aug_after IS DISTINCT FROM v_aug_before THEN RAISE EXCEPTION 'OKMART_REALLOC_AUGUST_REBUILD_FINGERPRINT_CHANGED'; END IF;

  ---------------------------------------------------------------------------
  -- 4. Audit (before/after allocation snapshots per payment, reversible).
  ---------------------------------------------------------------------------
  FOR v_pay IN SELECT unnest(c_payments) AS id LOOP
    SELECT coalesce(jsonb_agg(jsonb_build_object('payableId', b.payable_id, 'amount', b.allocated_amount) ORDER BY b.payable_id), '[]'::jsonb)
      INTO v_before FROM okmart_before b WHERE b.payment_transaction_id = v_pay.id;
    SELECT coalesce(jsonb_agg(jsonb_build_object('payableId', a.payable_id, 'amount', a.allocated_amount) ORDER BY a.payable_id), '[]'::jsonb)
      INTO v_after FROM public.ledger_payable_allocations a WHERE a.payment_transaction_id = v_pay.id;
    INSERT INTO public.ledger_audit_logs (actor_user_id, action, entity_type, entity_id, before_snapshot, after_snapshot, reason)
    VALUES (v_actor, 'payable_allocation_corrected', 'transaction', v_pay.id,
            jsonb_build_object('allocations', v_before), jsonb_build_object('allocations', v_after),
            'okmart-payable-reallocation-20261103: Zalo weekly claim matched payment; oldest-first allocation replaced. Original payment request rows preserved unchanged.');
  END LOOP;

  INSERT INTO public.ledger_audit_logs (actor_user_id, action, entity_type, entity_id, before_snapshot, after_snapshot, reason)
  VALUES (v_actor, 'payable_allocation_correction_summary', 'ledger_party', c_party,
          jsonb_build_object('openPayables', c_open_before, 'allocationFingerprint', c_f_alloc, 'allocationRows', c_n_alloc),
          jsonb_build_object('openPayables', v_open_after, 'bridgeUnallocated', jsonb_build_object('paymentId', c_bridge, 'amount', c_bridge_released),
                             'windows', (SELECT jsonb_agg(jsonb_build_object('paymentId', payment_id, 'from', d1, 'to', d2) ORDER BY payment_id) FROM okmart_window)),
          'okmart-payable-reallocation-20261103 (REVIEW-ONLY script). Phương/Carlsberg and 9/10, 9/23 bridge items intentionally untouched.');

  RAISE NOTICE 'OKMART_REALLOC_OK open % -> %', c_open_before, v_open_after;
END
$okmart$;

COMMIT;
