-- REVIEW-ONLY atomic alternative to Phase A, NOT a follow-up to it.
-- Phase A file stays unchanged. No production execution authorized.
-- User-approved evidence policy: FOUR period-level cross-check approvals.
-- No invented individual invoice evidence. Independent full-row baseline,
-- actor and separate DB execution authorization remain prerequisites.
-- #2399 lacks the 9/30 supplier original: explicit exception approval required.
-- NULL inputs fail closed; even populated reviews end with ROLLBACK.
-- #388 keeps original 3,300,000 and allocation #119/#1638/130,000;
-- delete #928 only: partially_paid, remaining unpaid 3,170,000.
-- #3582 retains unallocated 1,296,000.
-- No new payment; only #1641 party changes on payment transactions.
-- Movement, inventory, expense and request JSON are preserved.
-- Correct BEFORE rebuild, then independently approve a NEW rebuild manifest.
-- User-reported production read-only simulation PASS (not rerun locally):
-- Phuong open 13,870,000; Carlsberg open 46,219,992; overallocations 0.
-- Target payable IDs below retain the last explicitly supplied 57-ID list.
-- Notion's latest list still requires independent baseline/period approval.

BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

-- Exact existing allocation ID/payment pairs confirmed by production preflight.
-- An extra, missing or reassigned ID blocks ALL four payments before mutation.
CREATE TEMP TABLE pc_chain_original_ids ON COMMIT DROP AS
SELECT payment_id,generate_series(first_id,last_id)::bigint allocation_id
FROM (VALUES(1641::bigint,122,133),(2399,928,939),(3336,1269,1286),(3582,1346,1360))
 c(payment_id,first_id,last_id);
ALTER TABLE pc_chain_original_ids ADD PRIMARY KEY(allocation_id);

CREATE TEMP TABLE pc_chain_targets ON COMMIT DROP AS
SELECT payment_id,unnest(ids)::bigint payable_id,d1,d2,paid::numeric,allocated::numeric
FROM (VALUES
 (1641::bigint,ARRAY[679,680,681,690,699,406,407,408,409,410,486,540,548],DATE '2026-09-01',DATE '2026-09-15',19992000,19992000),
 (2399,ARRAY[584,585,586,732,733,734,780,781,820,845,893,894,896,910,930,931],DATE '2026-09-16',DATE '2026-09-30',18504000,18504000),
 (3336,ARRAY[964,965,1047,1048,1057,1105,1106,1150,1151,1152,1197,1198,1199,1272,1273],DATE '2026-10-01',DATE '2026-10-15',21900000,21900000),
 (3582,ARRAY[1278,1279,1379,1380,1381,1400,1467,1513,1573,1574,1575,1576,1647],DATE '2026-10-16',DATE '2026-10-28',20724000,19428000)
) c(payment_id,ids,d1,d2,paid,allocated);
ALTER TABLE pc_chain_targets ADD PRIMARY KEY(payable_id);
CREATE TEMP TABLE pc_chain_affected ON COMMIT DROP AS
 SELECT payable_id id FROM pc_chain_targets UNION SELECT 388
 UNION SELECT payable_id FROM public.ledger_payable_allocations
 WHERE payment_transaction_id IN(1641,2399,3336,3582);
ALTER TABLE pc_chain_affected ADD PRIMARY KEY(id);
-- Freeze the observation scope before mutation, including protected payments.
CREATE TEMP TABLE pc_chain_observed ON COMMIT DROP AS
 SELECT id FROM pc_chain_affected UNION SELECT payable_id FROM public.ledger_payable_allocations
 WHERE payment_transaction_id IN(1638,1796,1797,3337);
CREATE TEMP TABLE pc_chain_transactions ON COMMIT DROP AS
 SELECT expense_transaction_id id FROM public.ledger_payables WHERE id IN(SELECT id FROM pc_chain_observed)
 UNION SELECT unnest(ARRAY[1638,1641,1796,1797,2399,3336,3337,3582]::bigint[])
 UNION SELECT payment_transaction_id FROM public.ledger_payable_allocations
 WHERE payable_id IN(SELECT id FROM pc_chain_observed);
CREATE TEMP TABLE pc_chain_inventory ON COMMIT DROP AS
 SELECT DISTINCT (source_snapshot->>'inventory_log_id')::bigint id
 FROM public.ledger_transactions WHERE id IN(SELECT id FROM pc_chain_transactions)
 AND coalesce(source_snapshot->>'inventory_log_id','') ~ '^[0-9]+$';

CREATE TEMP VIEW pc_chain_snapshot AS
WITH aug AS (
 SELECT a.* FROM public.ledger_payable_allocations a
 JOIN public.ledger_payables p ON p.id=a.payable_id
 JOIN public.ledger_transactions e ON e.id=p.expense_transaction_id
 JOIN public.ledger_transactions t ON t.id=a.payment_transaction_id
 WHERE e.status='confirmed' AND t.status='confirmed'
 AND e.business_date BETWEEN DATE '2026-08-01' AND DATE '2026-08-31'
 AND t.business_date BETWEEN DATE '2026-09-01' AND DATE '2026-10-31'
)
SELECT jsonb_build_object(
 'transactions',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM public.ledger_transactions t WHERE id IN(SELECT id FROM pc_chain_transactions)),
 'payables',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') FROM public.ledger_payables p WHERE id IN(SELECT id FROM pc_chain_observed)),
 'allocations',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]') FROM public.ledger_payable_allocations a
   WHERE payable_id IN(SELECT id FROM pc_chain_observed) OR payment_transaction_id IN(1638,1641,1796,1797,2399,3336,3337,3582)),
 'movements',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY id),'[]') FROM public.ledger_movements m WHERE transaction_id IN(SELECT id FROM pc_chain_transactions)),
 'inventory',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY id),'[]') FROM public.inventory_logs i WHERE id IN(SELECT id FROM pc_chain_inventory)),
 'requests',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY request_id),'[]') FROM public.ledger_payable_payment_requests r WHERE payment_transaction_id IN(SELECT id FROM pc_chain_transactions)),
 'fundAccounts',(SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY id),'[]') FROM public.ledger_fund_accounts f WHERE id IN(SELECT fund_account_id FROM public.ledger_movements WHERE transaction_id IN(SELECT id FROM pc_chain_transactions))),
 'parties',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') FROM public.ledger_parties p WHERE name IN('Phương','Carlsberg')),
 'closures',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY month),'[]') FROM public.ledger_month_closures c WHERE month BETWEEN DATE '2026-08-01' AND DATE '2026-10-01'),
 'history',(SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY id),'[]') FROM public.ledger_month_closure_history h WHERE month IN(DATE '2026-08-01',DATE '2026-09-01')),
 'audits',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY id),'[]') FROM public.ledger_audit_logs l WHERE
   (entity_type='transaction' AND entity_id IN(SELECT id FROM pc_chain_transactions)) OR
   (entity_type='payable' AND entity_id IN(SELECT id FROM pc_chain_observed))),
 'writeTriggers',(SELECT coalesce(jsonb_agg(jsonb_build_object('table',tgrelid::regclass::text,'name',tgname,
   'enabled',tgenabled,'definition',pg_get_triggerdef(oid),'function',pg_get_functiondef(tgfoid)) ORDER BY tgrelid,tgname),'[]')
   FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN('public.ledger_transactions'::regclass,'public.ledger_payables'::regclass,'public.ledger_payable_allocations'::regclass,'public.ledger_audit_logs'::regclass)),
 'augustAllocations',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]') FROM aug a),
 'augustSummary',(SELECT jsonb_build_object('count',count(*),'amount',sum(allocated_amount),
   'fingerprint',md5(coalesce(string_agg(id::text||':'||payable_id::text||':'||payment_transaction_id::text||':'||allocated_amount::text,'|' ORDER BY id),''))) FROM aug)
) snapshot;

-- Capture this prefix in an independent consistent snapshot; inspect original
-- source_snapshot and period-level supplier/payment/APP evidence and exceptions.
SELECT snapshot AS baseline_for_independent_review FROM pc_chain_snapshot;
SELECT c.*,p.original_amount,e.id AS expense_id,to_jsonb(e) AS original_expense,
 (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.ledger_payable_allocations a WHERE a.payable_id=c.payable_id) existing_allocations
FROM pc_chain_targets c LEFT JOIN public.ledger_payables p ON p.id=c.payable_id
LEFT JOIN public.ledger_transactions e ON e.id=p.expense_transaction_id ORDER BY payment_id,payable_id;

DO $chain$
DECLARE
 approved_baseline constant jsonb := NULL;
 -- Four objects: paymentId, from, to, supplierStatus, supplierEvidence,
 -- supplierAmount (null if unverified), paymentEvidence, paymentAmount,
 -- appAmount, unallocatedAmount, exceptions.
 -- #1641: alreadyDeductedAmount=936000. #3336: supplierDocumentCount=7.
 -- #2399: missingOriginalApproved=true AND exceptionApprovalReference required;
 -- this is a separate evidence-exception approval, not DB execution permission.
 -- Status: matched (#1641/#3336), missing_original (#2399), partial_unresolved (#3582).
 approved_periods constant jsonb := NULL;
 actor_user_id constant bigint := NULL;
 before_state jsonb; after_state jsonb; expected_json jsonb; r record;
 phuong bigint; carlsberg bigint; n integer; paid_amount numeric; applied boolean;
BEGIN
 IF approved_baseline IS NULL OR approved_periods IS NULL OR actor_user_id IS NULL THEN
   RAISE EXCEPTION 'CHAIN_REVIEW_BLOCKED: independent baseline, period approvals and actor required';
 END IF;
 IF jsonb_typeof(approved_periods) IS DISTINCT FROM 'array' OR jsonb_array_length(approved_periods)<>4 THEN
   RAISE EXCEPTION 'CHAIN_PERIOD_REVIEW_INCOMPLETE';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.users WHERE id=actor_user_id AND lower(role::text) IN('owner','master') AND is_active AND app_login_enabled) THEN
   RAISE EXCEPTION 'CHAIN_ACTOR_REQUIRED';
 END IF;
 -- Match rebuild/month close and V2 party lock namespaces. V1 uses payable rows.
 PERFORM pg_advisory_xact_lock(hashtext('ledger_month_close_serial'));
 SELECT count(*),min(id) INTO n,phuong FROM public.ledger_parties WHERE name='Phương' AND type='supplier' AND is_active;
 IF n<>1 THEN RAISE EXCEPTION 'CHAIN_PHUONG_AMBIGUOUS'; END IF;
 SELECT count(*),min(id) INTO n,carlsberg FROM public.ledger_parties WHERE name='Carlsberg' AND type='supplier';
 IF n<>1 THEN RAISE EXCEPTION 'CHAIN_CARLSBERG_AMBIGUOUS'; END IF;
 FOR r IN SELECT id FROM public.ledger_parties WHERE id IN(phuong,carlsberg) ORDER BY id LOOP
   PERFORM pg_advisory_xact_lock(hashtextextended('ledger-payable-party:'||r.id::text,0));
 END LOOP;
 -- No explicit whole-table write-blocking locks. SERIALIZABLE + FK parent row
 -- locks protect against concurrent allocation inserts/deletes and scope drift.
 PERFORM 1 FROM public.ledger_month_closures WHERE month BETWEEN DATE '2026-08-01' AND DATE '2026-10-01' ORDER BY month FOR SHARE;
 PERFORM 1 FROM public.ledger_parties WHERE id IN(phuong,carlsberg) ORDER BY id FOR SHARE;
 PERFORM 1 FROM public.ledger_transactions WHERE id IN(SELECT id FROM pc_chain_transactions) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.ledger_payables WHERE id IN(SELECT id FROM pc_chain_observed) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.ledger_payable_allocations WHERE payable_id IN(SELECT id FROM pc_chain_observed)
   OR payment_transaction_id IN(1638,1641,1796,1797,2399,3336,3337,3582) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.ledger_movements WHERE transaction_id IN(SELECT id FROM pc_chain_transactions) ORDER BY id FOR SHARE;
 PERFORM 1 FROM public.inventory_logs WHERE id IN(SELECT id FROM pc_chain_inventory) ORDER BY id FOR SHARE;
 PERFORM 1 FROM public.ledger_fund_accounts WHERE id IN(SELECT fund_account_id FROM public.ledger_movements WHERE transaction_id IN(SELECT id FROM pc_chain_transactions)) ORDER BY id FOR SHARE;
 PERFORM 1 FROM public.ledger_month_closure_history WHERE month IN(DATE '2026-08-01',DATE '2026-09-01') ORDER BY id FOR SHARE;
 PERFORM 1 FROM public.ledger_payable_payment_requests WHERE payment_transaction_id IN(SELECT id FROM pc_chain_transactions) ORDER BY request_id FOR SHARE;
 IF to_regclass('baba_august_rebuild_private.runs') IS NOT NULL THEN
   EXECUTE 'SELECT EXISTS(SELECT 1 FROM baba_august_rebuild_private.runs WHERE status IN(''applying'',''applied''))' INTO applied;
   IF applied THEN RAISE EXCEPTION 'CHAIN_REBUILD_ALREADY_ACTIVE'; END IF;
 END IF;
 IF (SELECT count(*) FROM public.ledger_month_closures WHERE month IN(DATE '2026-08-01',DATE '2026-09-01') AND status='reopened' AND revision=4)<>2 THEN
   RAISE EXCEPTION 'CHAIN_MONTH_STATE_DRIFT';
 END IF;
 PERFORM public.ledger_assert_month_open_v1(DATE '2026-08-01');
 PERFORM public.ledger_assert_month_open_v1(DATE '2026-09-01');
 PERFORM public.ledger_assert_month_open_v1(DATE '2026-10-01');
 SELECT snapshot INTO before_state FROM pc_chain_snapshot;
 IF before_state IS DISTINCT FROM approved_baseline THEN RAISE EXCEPTION 'CHAIN_BASELINE_STALE'; END IF;
 IF EXISTS(
   (SELECT payment_id,allocation_id FROM pc_chain_original_ids
    EXCEPT SELECT payment_transaction_id,id FROM public.ledger_payable_allocations WHERE payment_transaction_id IN(1641,2399,3336,3582))
   UNION ALL
   (SELECT payment_transaction_id,id FROM public.ledger_payable_allocations WHERE payment_transaction_id IN(1641,2399,3336,3582)
    EXCEPT SELECT payment_id,allocation_id FROM pc_chain_original_ids)
 ) THEN RAISE EXCEPTION 'CHAIN_ORIGINAL_ALLOCATION_IDS_DRIFT'; END IF;
 IF before_state->'augustSummary'->>'count' IS DISTINCT FROM '302'
   OR (before_state->'augustSummary'->>'amount')::numeric IS DISTINCT FROM 69215076 THEN RAISE EXCEPTION 'CHAIN_AUGUST_BASELINE_DRIFT'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(before_state->'augustAllocations') j WHERE j->>'payment_transaction_id'='3337')<>6
   OR (SELECT sum((j->>'allocated_amount')::numeric) FROM jsonb_array_elements(before_state->'augustAllocations') j WHERE j->>'payment_transaction_id'='3337') IS DISTINCT FROM 9587992
   OR (SELECT sum((j->>'allocated_amount')::numeric) FROM jsonb_array_elements(before_state->'augustAllocations') j WHERE j->>'payment_transaction_id'='1638') IS DISTINCT FROM 10362000 THEN
   RAISE EXCEPTION 'CHAIN_PROTECTED_AUGUST_PAYMENTS_DRIFT'; END IF;
 IF EXISTS(SELECT 1 FROM public.ledger_transactions t WHERE id IN(SELECT id FROM pc_chain_transactions)
   AND to_jsonb(t)->>'source_type'='inventory_purchase_log'
   AND (coalesce(source_snapshot->>'inventory_log_id','') !~ '^[0-9]+$'
     OR NOT EXISTS(SELECT 1 FROM public.inventory_logs i WHERE i.id::text=t.source_snapshot->>'inventory_log_id'))) THEN
   RAISE EXCEPTION 'CHAIN_INVENTORY_SOURCE_UNRESOLVED'; END IF;
 IF EXISTS(SELECT 1 FROM public.ledger_payables p WHERE p.id IN(SELECT id FROM pc_chain_affected)
   AND p.original_amount<(SELECT coalesce(sum(a.allocated_amount),0) FROM public.ledger_payable_allocations a
     JOIN public.ledger_transactions t ON t.id=a.payment_transaction_id AND t.status='confirmed' WHERE a.payable_id=p.id)) THEN
   RAISE EXCEPTION 'CHAIN_EXISTING_OVERALLOCATION'; END IF;
 IF (SELECT count(*) FROM pc_chain_targets c JOIN public.ledger_payables p ON p.id=c.payable_id
   JOIN public.ledger_transactions e ON e.id=p.expense_transaction_id
   WHERE p.party_id=phuong AND e.party_id=phuong AND p.status<>'cancelled' AND e.status='confirmed'
   AND e.business_date BETWEEN c.d1 AND c.d2)<>57 THEN RAISE EXCEPTION 'CHAIN_CANDIDATE_DRIFT'; END IF;
 IF EXISTS(SELECT 1 FROM pc_chain_targets c JOIN public.ledger_payables p ON p.id=c.payable_id
   GROUP BY c.payment_id,c.allocated HAVING sum(p.original_amount)<>c.allocated) THEN RAISE EXCEPTION 'CHAIN_PERIOD_TOTAL_DRIFT'; END IF;
 -- Exact four periods; the 57 target IDs/amount and allocation guards above stay.
 IF (SELECT count(DISTINCT (j->>'paymentId')::bigint) FROM jsonb_array_elements(approved_periods) j)<>4
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(approved_periods) j
     LEFT JOIN (SELECT DISTINCT payment_id,d1,d2,paid,allocated FROM pc_chain_targets) c ON c.payment_id=(j->>'paymentId')::bigint
     WHERE c.payment_id IS NULL OR (j->>'from')::date IS DISTINCT FROM c.d1 OR (j->>'to')::date IS DISTINCT FROM c.d2
       OR (j->>'paymentAmount')::numeric IS DISTINCT FROM c.paid OR (j->>'appAmount')::numeric IS DISTINCT FROM c.allocated
       OR (j->>'unallocatedAmount')::numeric IS DISTINCT FROM c.paid-c.allocated
       OR nullif(btrim(j->>'supplierEvidence'),'') IS NULL OR nullif(btrim(j->>'paymentEvidence'),'') IS NULL
       OR nullif(btrim(j->>'exceptions'),'') IS NULL
       OR j->>'supplierStatus' IS DISTINCT FROM CASE c.payment_id WHEN 2399 THEN 'missing_original' WHEN 3582 THEN 'partial_unresolved' ELSE 'matched' END
       OR (c.payment_id IN(1641,3336) AND (j->>'supplierAmount')::numeric IS DISTINCT FROM c.allocated)
       OR (c.payment_id=2399 AND (j->'supplierAmount') IS DISTINCT FROM 'null'::jsonb)
       OR (c.payment_id=1641 AND (j->>'alreadyDeductedAmount')::numeric IS DISTINCT FROM 936000)
       OR (c.payment_id=3336 AND (j->>'supplierDocumentCount')::integer IS DISTINCT FROM 7)) THEN
   RAISE EXCEPTION 'CHAIN_PERIOD_REVIEW_MISMATCH'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(approved_periods) j WHERE j->>'paymentId'='2399'
   AND ((j->'missingOriginalApproved') IS DISTINCT FROM 'true'::jsonb
     OR nullif(btrim(j->>'exceptionApprovalReference'),'') IS NULL)) THEN
   RAISE EXCEPTION 'CHAIN_2399_MISSING_ORIGINAL_EXCEPTION_APPROVAL_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM (VALUES(1641,DATE '2026-09-17',19992000::numeric),(2399,DATE '2026-10-03',18504000),
   (3336,DATE '2026-10-20',21900000),(3582,DATE '2026-10-31',20724000)) v(id,d,amount)
   LEFT JOIN public.ledger_transactions t ON t.id=v.id
   WHERE t.id IS NULL OR t.business_date IS DISTINCT FROM v.d OR t.amount IS DISTINCT FROM v.amount
     OR t.status IS DISTINCT FROM 'confirmed' OR t.type IS DISTINCT FROM 'payable_payment'
     OR t.party_id IS DISTINCT FROM CASE WHEN v.id=1641 THEN carlsberg ELSE phuong END
     OR (SELECT coalesce(sum(allocated_amount),0) FROM public.ledger_payable_allocations WHERE payment_transaction_id=v.id)<>v.amount) THEN
   RAISE EXCEPTION 'CHAIN_PAYMENT_BASELINE_DRIFT'; END IF;
 IF (SELECT count(*) FROM public.ledger_payable_allocations WHERE payment_transaction_id=1641)<>12 THEN RAISE EXCEPTION 'CHAIN_1641_ROWS_DRIFT'; END IF;
 IF EXISTS(SELECT 1 FROM public.ledger_payable_allocations a JOIN public.ledger_payables p ON p.id=a.payable_id
   JOIN public.ledger_transactions e ON e.id=p.expense_transaction_id WHERE a.payment_transaction_id IN(2399,3336,3582)
   AND (p.party_id<>phuong OR e.party_id IS DISTINCT FROM phuong OR e.status<>'confirmed' OR p.status='cancelled')) THEN
   RAISE EXCEPTION 'CHAIN_OLD_PHUONG_SCOPE_DRIFT'; END IF;
 IF EXISTS(SELECT 1 FROM public.ledger_payable_allocations a JOIN public.ledger_payables p ON p.id=a.payable_id
   JOIN public.ledger_transactions e ON e.id=p.expense_transaction_id WHERE a.payment_transaction_id=1641
   AND (p.party_id<>carlsberg OR e.party_id IS DISTINCT FROM carlsberg OR e.status<>'confirmed' OR p.status='cancelled'
     OR e.business_date NOT BETWEEN DATE '2026-08-01' AND DATE '2026-08-31')) THEN RAISE EXCEPTION 'CHAIN_1641_TARGET_DRIFT'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.ledger_payables p JOIN public.ledger_transactions e ON e.id=p.expense_transaction_id
   WHERE p.id=388 AND p.party_id=phuong AND p.original_amount=3300000 AND p.status='paid'
   AND e.party_id=phuong AND e.status='confirmed' AND e.business_date=DATE '2026-08-31')
   OR (SELECT count(*) FROM public.ledger_payable_allocations WHERE payable_id=388)<>2
   OR NOT EXISTS(SELECT 1 FROM public.ledger_payable_allocations WHERE id=119 AND payable_id=388 AND payment_transaction_id=1638 AND allocated_amount=130000)
   OR NOT EXISTS(SELECT 1 FROM public.ledger_payable_allocations WHERE id=928 AND payable_id=388 AND payment_transaction_id=2399 AND allocated_amount=3170000) THEN
   RAISE EXCEPTION 'CHAIN_388_PROTECTION_DRIFT'; END IF;
 IF EXISTS(SELECT 1 FROM public.ledger_payable_allocations a WHERE a.payable_id IN(SELECT payable_id FROM pc_chain_targets)
   AND a.payment_transaction_id NOT IN(1641,2399,3336,3582)) THEN RAISE EXCEPTION 'CHAIN_FOREIGN_PAYMENT_ON_CANDIDATE'; END IF;
 -- No other August link of the four payments may be released.
 IF (SELECT count(*) FROM jsonb_array_elements(before_state->'augustAllocations') j
   WHERE (j->>'payment_transaction_id')::bigint IN(1641,2399,3336,3582))<>13 THEN RAISE EXCEPTION 'CHAIN_AUGUST_RELEASE_SCOPE_DRIFT'; END IF;

 -- Keep original IDs for existing desired pairs; changes are recorded in audit.
 DELETE FROM public.ledger_payable_allocations a USING pc_chain_original_ids old
 WHERE a.id=old.allocation_id AND a.payment_transaction_id=old.payment_id
   AND NOT EXISTS(SELECT 1 FROM pc_chain_targets c WHERE c.payable_id=a.payable_id AND c.payment_id=a.payment_transaction_id);
 UPDATE public.ledger_payable_allocations a SET allocated_amount=p.original_amount
 FROM pc_chain_targets c JOIN public.ledger_payables p ON p.id=c.payable_id
 WHERE a.payable_id=c.payable_id AND a.payment_transaction_id=c.payment_id AND a.allocated_amount<>p.original_amount
 AND EXISTS(SELECT 1 FROM pc_chain_original_ids old WHERE old.allocation_id=a.id AND old.payment_id=a.payment_transaction_id);
 INSERT INTO public.ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount)
 SELECT c.payable_id,c.payment_id,p.original_amount FROM pc_chain_targets c JOIN public.ledger_payables p ON p.id=c.payable_id
 WHERE NOT EXISTS(SELECT 1 FROM public.ledger_payable_allocations a WHERE a.payable_id=c.payable_id AND a.payment_transaction_id=c.payment_id)
 ORDER BY c.payment_id,c.payable_id;
 UPDATE public.ledger_transactions SET party_id=phuong WHERE id=1641;
 FOR r IN SELECT p.* FROM public.ledger_payables p JOIN pc_chain_affected s ON s.id=p.id LOOP
   SELECT coalesce(sum(a.allocated_amount),0) INTO paid_amount FROM public.ledger_payable_allocations a
   JOIN public.ledger_transactions t ON t.id=a.payment_transaction_id AND t.status='confirmed' WHERE a.payable_id=r.id;
   IF r.status='cancelled' OR paid_amount>r.original_amount THEN RAISE EXCEPTION 'CHAIN_PAYABLE_INVALID:%',r.id; END IF;
   UPDATE public.ledger_payables SET status=CASE WHEN paid_amount=original_amount THEN 'paid'
     WHEN paid_amount>0 THEN 'partially_paid' ELSE 'unpaid' END,updated_at=now() WHERE id=r.id;
 END LOOP;
 IF (SELECT count(*) FROM public.ledger_payable_allocations WHERE payment_transaction_id IN(1641,2399,3336,3582))<>57
 OR EXISTS(SELECT 1 FROM pc_chain_targets c JOIN public.ledger_payables p ON p.id=c.payable_id
   WHERE NOT EXISTS(SELECT 1 FROM public.ledger_payable_allocations a WHERE a.payable_id=c.payable_id
     AND a.payment_transaction_id=c.payment_id AND a.allocated_amount=p.original_amount) OR p.status<>'paid')
 OR (SELECT count(*) FROM public.ledger_payable_allocations WHERE payable_id=388)<>1
 OR EXISTS(SELECT 1 FROM public.ledger_payable_allocations WHERE id=928)
 OR NOT EXISTS(SELECT 1 FROM public.ledger_payable_allocations WHERE id=119 AND payable_id=388 AND payment_transaction_id=1638 AND allocated_amount=130000)
 OR (SELECT sum(allocated_amount) FROM public.ledger_payable_allocations WHERE payable_id=388) IS DISTINCT FROM 130000
 OR NOT EXISTS(SELECT 1 FROM public.ledger_payables WHERE id=388 AND status='partially_paid' AND original_amount=3300000
   AND original_amount-(SELECT sum(allocated_amount) FROM public.ledger_payable_allocations WHERE payable_id=388)=3170000) THEN
   RAISE EXCEPTION 'CHAIN_TARGET_POSTSTATE_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM public.ledger_payables p JOIN pc_chain_affected s ON s.id=p.id WHERE p.status IS DISTINCT FROM
   (SELECT CASE WHEN coalesce(sum(a.allocated_amount),0)=p.original_amount THEN 'paid'
     WHEN coalesce(sum(a.allocated_amount),0)>0 THEN 'partially_paid' ELSE 'unpaid' END
    FROM public.ledger_payable_allocations a JOIN public.ledger_transactions t ON t.id=a.payment_transaction_id
    WHERE a.payable_id=p.id AND t.status='confirmed')) THEN RAISE EXCEPTION 'CHAIN_STATUS_POSTSTATE_INVALID'; END IF;
 SELECT snapshot INTO after_state FROM pc_chain_snapshot;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(before_state->'allocations') b
   JOIN pc_chain_targets c ON c.payable_id=(b->>'payable_id')::bigint AND c.payment_id=(b->>'payment_transaction_id')::bigint
   WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(after_state->'allocations') a
     WHERE a-'allocated_amount'=b-'allocated_amount')) THEN RAISE EXCEPTION 'CHAIN_RETAINED_ALLOCATION_ID_CHANGED'; END IF;
 -- Only intended transaction party, payable statuses, and four payment links may differ.
 SELECT jsonb_agg(CASE WHEN (j->>'id')::bigint=1641 THEN jsonb_set(j,'{party_id}',to_jsonb(phuong)) ELSE j END ORDER BY (j->>'id')::bigint)
 INTO expected_json FROM jsonb_array_elements(before_state->'transactions') j;
 IF after_state->'transactions' IS DISTINCT FROM expected_json THEN RAISE EXCEPTION 'CHAIN_TRANSACTION_CHANGED'; END IF;
 FOR r IN SELECT j FROM jsonb_array_elements(before_state->'payables') j LOOP
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(after_state->'payables') a
     WHERE a->>'id'=r.j->>'id' AND CASE WHEN (a->>'id')::bigint IN(SELECT id FROM pc_chain_affected)
       THEN a-'status'-'updated_at'=r.j-'status'-'updated_at' ELSE a=r.j END) THEN RAISE EXCEPTION 'CHAIN_PAYABLE_SOURCE_CHANGED'; END IF;
 END LOOP;
 IF (after_state-ARRAY['transactions','payables','allocations','augustAllocations','augustSummary'])
   IS DISTINCT FROM (before_state-ARRAY['transactions','payables','allocations','augustAllocations','augustSummary']) THEN
   RAISE EXCEPTION 'CHAIN_PROTECTED_SCOPE_CHANGED'; END IF;
 SELECT coalesce(jsonb_agg(j ORDER BY (j->>'id')::bigint),'[]') INTO expected_json
 FROM jsonb_array_elements(before_state->'allocations') j WHERE (j->>'payment_transaction_id')::bigint NOT IN(1641,2399,3336,3582);
 IF expected_json IS DISTINCT FROM (SELECT coalesce(jsonb_agg(j ORDER BY (j->>'id')::bigint),'[]')
   FROM jsonb_array_elements(after_state->'allocations') j WHERE (j->>'payment_transaction_id')::bigint NOT IN(1641,2399,3336,3582)) THEN
   RAISE EXCEPTION 'CHAIN_FOREIGN_ALLOCATION_CHANGED'; END IF;
 SELECT coalesce(jsonb_agg(j ORDER BY (j->>'id')::bigint),'[]') INTO expected_json
 FROM jsonb_array_elements(before_state->'augustAllocations') j WHERE (j->>'payment_transaction_id')::bigint<>1641
   AND NOT((j->>'payment_transaction_id')::bigint=2399 AND (j->>'payable_id')::bigint=388);
 IF after_state->'augustAllocations' IS DISTINCT FROM expected_json
   OR (after_state->'augustSummary'->>'count')::integer<>289
   OR (after_state->'augustSummary'->>'amount')::numeric<>46053076 THEN RAISE EXCEPTION 'CHAIN_AUGUST_PRESERVATION_FAILED'; END IF;
 INSERT INTO public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
 VALUES(actor_user_id,'payable_allocation_chain_corrected','transaction',1641,
   jsonb_build_object('scope',before_state,'periodApprovals',approved_periods),
   jsonb_build_object('scope',after_state,'protectedUnpaid388',3170000,'unallocated3582',1296000),
   'Atomic Phuong period-level cross-check correction; #2399 supplier original missing, explicitly approved evidence exception. Original allocation IDs/full rows archived in before_snapshot; '
   'unchanged pairs retain IDs. Payment requests/results and source snapshots stay historical. '
   '936000 already deducted in September; October HD015517/HD015523 differences remain unresolved. '
   'No Carlsberg invoice allocation. Requires new approved August rebuild protection manifest.');
 SELECT snapshot INTO expected_json FROM pc_chain_snapshot;
 IF expected_json-'audits' IS DISTINCT FROM after_state-'audits'
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(before_state->'audits') b
     WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expected_json->'audits') a WHERE a=b)) THEN
   RAISE EXCEPTION 'CHAIN_AUDIT_SIDE_EFFECT'; END IF;
 RAISE NOTICE 'CHAIN_REVIEW_OK: allocated 79824000, unallocated #3582 1296000, unpaid #388 3170000';
END
$chain$;
SELECT snapshot AS proposed_after FROM pc_chain_snapshot;
-- No operational execution path is enabled by this review file.
DROP VIEW pc_chain_snapshot;
ROLLBACK;
