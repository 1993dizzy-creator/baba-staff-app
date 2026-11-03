-- REVIEW-ONLY, NOT a migration. No production execution authorized.
-- Phase A ONLY: #1641 belongs to Phương; release its 12 incorrect August
-- Carlsberg allocations (19,992,000). Leave the payment UNALLOCATED.
-- No new payment, movement, expense, inventory cost or request JSON is created.
-- Phase B invoice allocation is BLOCKED pending exact payable-level evidence.
-- #1638/#1796/#1797/#2399/#3336/#3337/#3582 and payable #388 stay unchanged.
-- Run BEFORE August rebuild, then obtain a NEW approved rebuild manifest.
-- Never edit/bypass the rebuild fingerprint or reverse checks.
-- Defaults deliberately fail closed. Even a populated review rolls back.
-- A separately approved execution copy needs independently reviewed baseline,
-- actor and COMMIT; filling these from live data inside the DO is forbidden.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Read-only candidate evidence. Full rows preserve original allocation IDs,
-- timestamps, source snapshots and payment-request results for later review.
CREATE TEMP VIEW pc_review_baseline AS
WITH aug AS (
 SELECT a.*, p.expense_transaction_id
 FROM public.ledger_payable_allocations a
 JOIN public.ledger_payables p ON p.id=a.payable_id
 JOIN public.ledger_transactions e ON e.id=p.expense_transaction_id
 JOIN public.ledger_transactions t ON t.id=a.payment_transaction_id
 WHERE e.business_date BETWEEN DATE '2026-08-01' AND DATE '2026-08-31'
   AND e.status='confirmed' AND t.status='confirmed'
   AND t.business_date BETWEEN DATE '2026-09-01' AND DATE '2026-10-31'
)
SELECT jsonb_build_object(
 'payments',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.ledger_transactions t
   WHERE t.id IN(1638,1641,1796,1797,2399,3336,3337,3582)),
 'augustRows',(SELECT count(*) FROM aug),
 'augustAmount',(SELECT sum(allocated_amount) FROM aug),
 'augustFingerprint',(SELECT md5(coalesce(string_agg(id::text||':'||payable_id::text||':'||
   payment_transaction_id::text||':'||allocated_amount::text,'|' ORDER BY id),'')) FROM aug),
 'augustAllocations',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM aug a),
 'allocations',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM public.ledger_payable_allocations a
   WHERE a.payment_transaction_id IN(1638,1641,1796,1797,2399,3336,3337,3582)),
 'payables',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.ledger_payables p
   WHERE p.id=388 OR p.id IN(SELECT a.payable_id FROM public.ledger_payable_allocations a
     WHERE a.payment_transaction_id IN(1638,1641,1796,1797,2399,3336,3337,3582))),
 'parties',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.ledger_parties p
   WHERE p.name IN('Phương','Carlsberg'))
) AS snapshot;
SELECT snapshot AS independently_review_before_populating_expected_baseline FROM pc_review_baseline;

DO $correction$
DECLARE
 expected_baseline constant jsonb := NULL; -- REQUIRED: independent full-row review
 actor_user_id constant bigint := NULL; -- REQUIRED: separately approved owner/master
 old_party bigint; new_party bigint; n integer; v_paid numeric; r record;
 before_tx jsonb; after_tx jsonb; before_alloc jsonb; audit_max bigint;
 h text; old_h text; relation_name text; applied boolean;
BEGIN
 IF expected_baseline IS NULL OR actor_user_id IS NULL THEN
   RAISE EXCEPTION 'PC_REVIEW_BLOCKED: approved full-row baseline and actor missing';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.users WHERE id=actor_user_id
   AND lower(role::text) IN('owner','master') AND is_active AND app_login_enabled) THEN
   RAISE EXCEPTION 'PC_ACTOR_REQUIRED';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ledger_month_close_serial'));
 PERFORM pg_advisory_xact_lock(hashtext('ledger_month_close:2026-08'));
 PERFORM pg_advisory_xact_lock(hashtext('ledger_month_close:2026-09'));
 PERFORM pg_advisory_xact_lock(hashtext('ledger_month_close:2026-10'));
 LOCK TABLE public.ledger_month_closures, public.ledger_month_closure_history,
   public.ledger_parties, public.ledger_fund_accounts, public.ledger_movements,
   public.inventory_logs, public.ledger_payable_payment_requests IN SHARE MODE;
 LOCK TABLE public.ledger_transactions, public.ledger_payables,
   public.ledger_payable_allocations, public.ledger_audit_logs IN SHARE ROW EXCLUSIVE MODE;
 IF to_regclass('baba_august_rebuild_private.runs') IS NOT NULL THEN
   EXECUTE 'SELECT EXISTS(SELECT 1 FROM baba_august_rebuild_private.runs WHERE status IN(''applying'',''applied''))' INTO applied;
   IF applied THEN RAISE EXCEPTION 'PC_REBUILD_ALREADY_ACTIVE'; END IF;
 END IF;
 IF (SELECT count(*) FROM public.ledger_month_closures
   WHERE month IN(DATE '2026-08-01',DATE '2026-09-01') AND status='reopened' AND revision=4)<>2 THEN
   RAISE EXCEPTION 'PC_MONTH_REVISION_DRIFT';
 END IF;
 PERFORM public.ledger_assert_month_open_v1(DATE '2026-08-01');
 PERFORM public.ledger_assert_month_open_v1(DATE '2026-09-01');
 PERFORM public.ledger_assert_month_open_v1(DATE '2026-10-01');
 IF (SELECT snapshot FROM pc_review_baseline) IS DISTINCT FROM expected_baseline THEN
   RAISE EXCEPTION 'PC_APPROVED_BASELINE_STALE';
 END IF;
 IF (expected_baseline->>'augustRows')::integer IS DISTINCT FROM 302
   OR (expected_baseline->>'augustAmount')::numeric IS DISTINCT FROM 69215076 THEN
   RAISE EXCEPTION 'PC_AUGUST_SCOPE_DRIFT';
 END IF;
 SELECT count(*),min(id) INTO n,old_party FROM public.ledger_parties WHERE name='Carlsberg' AND type='supplier';
 IF n<>1 THEN RAISE EXCEPTION 'PC_CARLSBERG_PARTY_AMBIGUOUS'; END IF;
 SELECT count(*),min(id) INTO n,new_party FROM public.ledger_parties WHERE name='Phương' AND type='supplier' AND is_active;
 IF n<>1 THEN RAISE EXCEPTION 'PC_PHUONG_PARTY_AMBIGUOUS'; END IF;
 SELECT to_jsonb(t) INTO before_tx FROM public.ledger_transactions t WHERE id=1641;
 IF NOT EXISTS(SELECT 1 FROM public.ledger_transactions WHERE id=1641 AND party_id=old_party
   AND business_date=DATE '2026-09-17' AND amount=19992000 AND status='confirmed' AND type='payable_payment') THEN
   RAISE EXCEPTION 'PC_PAYMENT_1641_DRIFT';
 END IF;
 SELECT count(*),sum(allocated_amount),jsonb_agg(to_jsonb(a) ORDER BY id)
   INTO n,v_paid,before_alloc FROM public.ledger_payable_allocations a WHERE payment_transaction_id=1641;
 IF n<>12 OR v_paid IS DISTINCT FROM 19992000 THEN RAISE EXCEPTION 'PC_1641_ALLOCATION_DRIFT'; END IF;
 IF EXISTS(SELECT 1 FROM public.ledger_payable_allocations a
   JOIN public.ledger_payables p ON p.id=a.payable_id
   JOIN public.ledger_transactions e ON e.id=p.expense_transaction_id
   WHERE a.payment_transaction_id=1641 AND (p.party_id<>old_party OR e.party_id IS DISTINCT FROM old_party
     OR p.status='cancelled' OR e.status<>'confirmed'
     OR e.business_date NOT BETWEEN DATE '2026-08-01' AND DATE '2026-08-31')) THEN
   RAISE EXCEPTION 'PC_1641_TARGET_DRIFT';
 END IF;

 CREATE TEMP TABLE pc_touched ON COMMIT DROP AS
   SELECT p.* FROM public.ledger_payables p WHERE p.id IN(
     SELECT payable_id FROM public.ledger_payable_allocations WHERE payment_transaction_id=1641);
 SELECT coalesce(max(id),0) INTO audit_max FROM public.ledger_audit_logs;
 -- Fixed list of full-row preservation assertions, not an installed tool/RPC.
 CREATE TEMP TABLE pc_protected(relation_name text PRIMARY KEY, fingerprint text) ON COMMIT DROP;
 FOREACH relation_name IN ARRAY ARRAY['ledger_transactions','ledger_movements','ledger_payables',
   'ledger_payable_allocations','inventory_logs','ledger_payable_payment_requests',
   'ledger_month_closures','ledger_month_closure_history','ledger_audit_logs','ledger_fund_accounts'] LOOP
   EXECUTE format($q$SELECT md5(coalesce(string_agg(j::text,'|' ORDER BY j::text),'')) FROM (
     SELECT CASE WHEN %L='ledger_transactions' AND to_jsonb(x)->>'id'='1641' THEN to_jsonb(x)-'party_id'
       WHEN %L='ledger_payables' AND (to_jsonb(x)->>'id')::bigint IN(SELECT id FROM pc_touched)
         THEN to_jsonb(x)-'status'-'updated_at' ELSE to_jsonb(x) END j
     FROM public.%I x WHERE (%L<>'ledger_payable_allocations' OR to_jsonb(x)->>'payment_transaction_id'<>'1641')
       AND (%L<>'ledger_audit_logs' OR (to_jsonb(x)->>'id')::bigint<=%s)) s$q$,
     relation_name,relation_name,relation_name,relation_name,relation_name,audit_max) INTO h;
   INSERT INTO pc_protected VALUES(relation_name,h);
 END LOOP;

 DELETE FROM public.ledger_payable_allocations WHERE payment_transaction_id=1641;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>12 THEN RAISE EXCEPTION 'PC_DELETE_COUNT_DRIFT'; END IF;
 -- Only party changes. Source snapshot and request JSON retain historical error.
 UPDATE public.ledger_transactions SET party_id=new_party WHERE id=1641;
 FOR r IN SELECT id,original_amount FROM pc_touched LOOP
   SELECT coalesce(sum(a.allocated_amount),0) INTO v_paid FROM public.ledger_payable_allocations a
     JOIN public.ledger_transactions t ON t.id=a.payment_transaction_id AND t.status='confirmed'
     WHERE a.payable_id=r.id;
   IF v_paid>r.original_amount THEN RAISE EXCEPTION 'PC_OVERALLOCATED:%',r.id; END IF;
   UPDATE public.ledger_payables SET status=CASE WHEN v_paid=original_amount THEN 'paid'
     WHEN v_paid>0 THEN 'partially_paid' ELSE 'unpaid' END,updated_at=now() WHERE id=r.id;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.ledger_payable_allocations WHERE payment_transaction_id=1641) THEN
   RAISE EXCEPTION 'PC_1641_MUST_REMAIN_UNALLOCATED';
 END IF;
 SELECT to_jsonb(t) INTO after_tx FROM public.ledger_transactions t WHERE id=1641;
 IF after_tx IS DISTINCT FROM jsonb_set(before_tx,'{party_id}',to_jsonb(new_party)) THEN
   RAISE EXCEPTION 'PC_UNEXPECTED_PAYMENT_MUTATION';
 END IF;
 -- Repeat preservation hashes before appending ONE audit entry.
 FOR r IN SELECT * FROM pc_protected LOOP
   relation_name:=r.relation_name; old_h:=r.fingerprint;
   EXECUTE format($q$SELECT md5(coalesce(string_agg(j::text,'|' ORDER BY j::text),'')) FROM (
     SELECT CASE WHEN %L='ledger_transactions' AND to_jsonb(x)->>'id'='1641' THEN to_jsonb(x)-'party_id'
       WHEN %L='ledger_payables' AND (to_jsonb(x)->>'id')::bigint IN(SELECT id FROM pc_touched)
         THEN to_jsonb(x)-'status'-'updated_at' ELSE to_jsonb(x) END j
     FROM public.%I x WHERE (%L<>'ledger_payable_allocations' OR to_jsonb(x)->>'payment_transaction_id'<>'1641')
       AND (%L<>'ledger_audit_logs' OR (to_jsonb(x)->>'id')::bigint<=%s)) s$q$,
     relation_name,relation_name,relation_name,relation_name,relation_name,audit_max) INTO h;
   IF h IS DISTINCT FROM old_h THEN RAISE EXCEPTION 'PC_PROTECTED_ROWS_CHANGED:%',relation_name; END IF;
 END LOOP;
 INSERT INTO public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
 VALUES(actor_user_id,'payable_allocation_corrected','transaction',1641,
   jsonb_build_object('transaction',before_tx,'allocations',before_alloc,
     'payables',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM pc_touched p),
     'approvedBaseline',expected_baseline),
   jsonb_build_object('transaction',after_tx,'allocations','[]'::jsonb,'unallocated',19992000,
     'payables',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.ledger_payables p JOIN pc_touched b USING(id)),
     'requestPayloadPreserved',true,'invoiceAllocation','BLOCKED'),
   'Phuong-Carlsberg 20261103 phase A: user-transcribed Notion/Zalo 9/17 recipient evidence. '
   '936000 already deducted; no second deduction. No FIFO reassignment. '
   'Original request/result and source snapshot remain historical. New August manifest approval required.');
 RAISE NOTICE 'PC_PHASE_A_REVIEW_OK: 1641 unallocated 19992000; no invoice allocations created';
END
$correction$;
-- Inspect a successful isolated review before the mandatory rollback.
SELECT snapshot AS proposed_after FROM pc_review_baseline;
DROP VIEW pc_review_baseline;
ROLLBACK;
