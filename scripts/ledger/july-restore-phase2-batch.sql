-- LOCAL REVIEW DRAFT. Not a migration. Never execute without separate owner DB approval.
-- One source log / one original sheet row / one immediate expense. No inventory writer.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='90s';
SET LOCAL standard_conforming_strings=on;
SET LOCAL baba.july_phase2_actor='__ACTOR_USER_ID__';
SET LOCAL baba.july_phase2_approval='__OWNER_APPROVAL__';
CREATE TEMP TABLE july_phase2_input(canonical text NOT NULL,payload jsonb NOT NULL) ON COMMIT DROP;
INSERT INTO july_phase2_input VALUES (__PAYLOAD_LITERAL__,__PAYLOAD_LITERAL__::jsonb);

-- Approval and exact bundle scope are checked before operational locks or writes.
DO $approval$
DECLARE p jsonb; c text; ids bigint[]; deltas jsonb;
BEGIN
 SELECT canonical,payload INTO STRICT c,p FROM july_phase2_input;
 IF current_setting('baba.july_phase2_approval') IS DISTINCT FROM 'APPROVED:__PAYLOAD_DIGEST__'
   OR encode(sha256(convert_to(c,'UTF8')),'hex')<>'__PAYLOAD_DIGEST__' OR c::jsonb IS DISTINCT FROM p
   OR encode(sha256(convert_to(p->>'bundleCanonical','UTF8')),'hex') IS DISTINCT FROM p->>'bundleDigest'
   OR (p->>'bundleCanonical')::jsonb IS DISTINCT FROM p->'bundle' THEN RAISE EXCEPTION 'JULY_PHASE2_APPROVAL_REQUIRED'; END IF;
 SELECT array_agg((a->>'row')::bigint ORDER BY (a->>'row')::bigint) INTO ids FROM jsonb_array_elements(p->'bundle'->'actions') a;
 IF ids IS DISTINCT FROM ARRAY[__EXACT_ROWS__]::bigint[]
  OR (SELECT count(DISTINCT a->>'key') FROM jsonb_array_elements(p->'bundle'->'actions') a)<>cardinality(ids)
  OR (SELECT count(DISTINCT a->'logExpected'->>'id') FROM jsonb_array_elements(p->'bundle'->'actions') a)<>cardinality(ids)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'bundle'->'actions') a WHERE
    (a->>'row')::bigint=ANY(ARRAY[11,17,30,43,45,56,67,91,95,96,108,125,126,136,147,163,173,185,191,193,198,216,220,221,225,236,238,249,258,262,275,277,282,284,291,298,302,306,311,314,319,331,340,353,357,363,368,374,381,395]::bigint[])
    OR a->>'key' IS DISTINCT FROM 'sheet:1BRT2ul07GftjqVPwcIf35o3LDJ6RjPIdWL_YeiRqDx4:tab:829182003:row:'||(a->>'row')
    OR a->>'sourceKey' IS DISTINCT FROM 'july-restore:'||(a->>'key')
    OR a->>'date' NOT BETWEEN '2026-07-01' AND '2026-07-31'
    OR a->>'account' NOT IN('store_cash','vuong_personal_custody','cho_personal_custody','baba_corporate_bank')
    OR (a->>'amount')::numeric<=0 OR (a->>'amount')::numeric<>trunc((a->>'amount')::numeric))
  THEN RAISE EXCEPTION 'JULY_PHASE2_SCOPE_OR_DUPLICATE'; END IF;
 SELECT jsonb_object_agg(code,delta) INTO deltas FROM (
  SELECT f.code,coalesce(sum(-(a->>'amount')::numeric),0) delta FROM
   unnest(ARRAY['store_cash','vuong_personal_custody','cho_personal_custody','baba_corporate_bank']) f(code)
   LEFT JOIN jsonb_array_elements(p->'bundle'->'actions') a ON a->>'account'=f.code GROUP BY f.code) d;
 IF deltas IS DISTINCT FROM (SELECT jsonb_object_agg(key,value::numeric) FROM jsonb_each_text(p->'bundle'->'fundDelta')) THEN RAISE EXCEPTION 'JULY_PHASE2_APPROVED_DELTA'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.users WHERE id=current_setting('baba.july_phase2_actor')::bigint AND is_active AND app_login_enabled AND lower(role::text) IN('owner','master')) THEN RAISE EXCEPTION 'JULY_PHASE2_ACTOR'; END IF;
 IF NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261105153442') THEN RAISE EXCEPTION 'JULY_PHASE2_FUND_BOUNDARY_NOT_INSTALLED'; END IF;
 IF (SELECT encode(sha256(convert_to(replace(prosrc,E'\r\n',E'\n'),'UTF8')),'hex') FROM pg_proc WHERE oid='public.ledger_resolve_inventory_candidate_v1(bigint,text,bigint,bigint,bigint,date,text,text,bigint)'::regprocedure) IS DISTINCT FROM '__RESOLVER_BODY_DIGEST__' THEN RAISE EXCEPTION 'JULY_PHASE2_RESOLVER_CONTRACT_CHANGED'; END IF;
END $approval$;

CREATE TEMP TABLE july_phase2_original_ids(name text PRIMARY KEY,ids bigint[]) ON COMMIT DROP;
DO $locks$
DECLARE n text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('baba:ledger:july-restore-v1'));
 PERFORM pg_advisory_xact_lock(hashtext('ledger_month_close:2026-07'));
 IF public.ledger_month_is_closed_v1(date '2026-07-01') THEN RAISE EXCEPTION 'JULY_PHASE2_MONTH_CLOSED'; END IF;
 -- Ledger writers are serialized for this short batch. No POS/inventory table lock.
 LOCK TABLE public.ledger_transactions,public.ledger_movements,public.ledger_candidates,public.ledger_audit_logs IN SHARE ROW EXCLUSIVE MODE;
 -- Source rows only. Existing stock may change before this transaction; never pin
 -- live inventory quantities to an earlier review snapshot.
 PERFORM 1 FROM public.inventory_logs l WHERE l.id IN(SELECT (a->'logExpected'->>'id')::bigint FROM july_phase2_input i,jsonb_array_elements(i.payload->'bundle'->'actions') a) ORDER BY l.id FOR SHARE;
 PERFORM 1 FROM public.inventory i WHERE i.id IN(SELECT (a->'logExpected'->>'item_id')::bigint FROM july_phase2_input p,jsonb_array_elements(p.payload->'bundle'->'actions') a) ORDER BY i.id FOR SHARE;
 FOREACH n IN ARRAY ARRAY['ledger_transactions','ledger_movements','ledger_audit_logs','ledger_candidates','ledger_payables','ledger_payable_allocations','ledger_card_reconciliations','ledger_card_reconciliation_lines','ledger_card_fee_closures','ledger_card_fee_allocation_lines','ledger_fund_accounts','ledger_month_closures','ledger_month_closure_history'] LOOP
  EXECUTE format('INSERT INTO july_phase2_original_ids SELECT %L,array_agg(id ORDER BY id) FROM public.%I',n,n);
 END LOOP;
END $locks$;

CREATE OR REPLACE FUNCTION pg_temp.july_phase2_protected() RETURNS jsonb LANGUAGE plpgsql AS $protect$
DECLARE n record; h text; result jsonb:='{}';
BEGIN
 FOR n IN SELECT * FROM july_phase2_original_ids ORDER BY name LOOP
  EXECUTE format('SELECT md5(coalesce(string_agg(to_jsonb(x)::text,''|'' ORDER BY id),'''')) FROM public.%I x WHERE id=ANY($1)',n.name) INTO h USING n.ids;
  result:=result||jsonb_build_object(n.name,h);
  IF n.name NOT IN('ledger_transactions','ledger_movements','ledger_audit_logs','ledger_candidates') THEN
   EXECUTE format('SELECT count(*) FROM public.%I',n.name) INTO h;
   result:=result||jsonb_build_object(n.name||':count',h);
  END IF;
 END LOOP;
 -- Closures/account metadata must not gain or lose rows either.
 result:=result||jsonb_build_object('closureCount',(SELECT count(*) FROM public.ledger_month_closures),'historyCount',(SELECT count(*) FROM public.ledger_month_closure_history),'accountCount',(SELECT count(*) FROM public.ledger_fund_accounts));
 SELECT md5(coalesce(string_agg(to_jsonb(l)::text,'|' ORDER BY l.id),'')) INTO h FROM public.inventory_logs l
  WHERE l.id IN(SELECT (a->'logExpected'->>'id')::bigint FROM july_phase2_input i,jsonb_array_elements(i.payload->'bundle'->'actions') a);
 result:=result||jsonb_build_object('sourceLogs',h);
 SELECT md5(coalesce(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id),'')) INTO h FROM public.inventory x
  WHERE x.id IN(SELECT (a->'logExpected'->>'item_id')::bigint FROM july_phase2_input i,jsonb_array_elements(i.payload->'bundle'->'actions') a);
 RETURN result||jsonb_build_object('sourceStock',h);
END $protect$;
CREATE OR REPLACE FUNCTION pg_temp.july_phase2_funds(cutoff date) RETURNS jsonb LANGUAGE sql AS $funds$
 SELECT jsonb_object_agg(code,balance) FROM (
 SELECT f.code,coalesce(sum(m.amount) FILTER(WHERE t.status='confirmed' AND (cutoff IS NULL OR t.business_date>=cutoff)),0) balance
 FROM public.ledger_fund_accounts f LEFT JOIN public.ledger_movements m ON m.fund_account_id=f.id LEFT JOIN public.ledger_transactions t ON t.id=m.transaction_id
 WHERE f.code IN('store_cash','vuong_personal_custody','cho_personal_custody','baba_corporate_bank','card_clearing') GROUP BY f.code) x
$funds$;

DO $restore$
DECLARE p jsonb; a jsonb; expected jsonb; actual jsonb; snapshot jsonb; result jsonb;
 actor bigint:=current_setting('baba.july_phase2_actor')::bigint; log public.inventory_logs%rowtype;
 tx public.ledger_transactions%rowtype; candidate public.ledger_candidates%rowtype;
 candidate_id bigint; tx_id bigint; account_id bigint; audit_count integer;
 before_state jsonb; before_funds jsonb; before_live jsonb; after_funds jsonb;
 remaining_delta jsonb:='{"store_cash":0,"vuong_personal_custody":0,"cho_personal_custody":0,"baba_corporate_bank":0}';
 created integer:=0; replayed integer:=0;
BEGIN
 SELECT payload INTO STRICT p FROM july_phase2_input;
 before_state:=pg_temp.july_phase2_protected();before_funds:=pg_temp.july_phase2_funds(NULL);before_live:=pg_temp.july_phase2_funds(date '2026-08-01');
 -- Pin reviewed 8~10 closure hashes; no closing/reclosing or current-balance adjustment.
 FOR expected IN SELECT value FROM jsonb_array_elements(p->'bundle'->'closures') LOOP
  IF NOT EXISTS(SELECT 1 FROM public.ledger_month_closures c WHERE c.id=(expected->>'id')::bigint AND to_jsonb(c)->>'month'=expected->>'month' AND c.status=expected->>'status' AND c.revision=(expected->>'revision')::integer AND c.snapshot_hash=expected->>'snapshot_hash') THEN RAISE EXCEPTION 'JULY_PHASE2_CLOSURE_DRIFT'; END IF;
 END LOOP;
 FOR a IN SELECT value FROM jsonb_array_elements(p->'bundle'->'actions') LOOP
  expected:=a->'logExpected';
  SELECT * INTO STRICT log FROM public.inventory_logs WHERE id=(expected->>'id')::bigint;
  SELECT jsonb_object_agg(k,to_jsonb(log)->k) INTO actual FROM jsonb_object_keys(expected-'created_at') k;
  IF actual IS DISTINCT FROM expected-'created_at' OR log.created_at IS DISTINCT FROM (expected->>'created_at')::timestamptz
   OR log.reason<>'purchase' OR log.change_quantity<=0 OR log.billed_amount IS NOT NULL OR log.purchase_supplier_partner_id IS NOT NULL
   OR log.correction_of_inventory_log_id IS NOT NULL OR log.business_date<>(a->>'date')::date
   OR round(log.change_quantity*log.new_purchase_price,3)<>(a->>'amount')::numeric THEN RAISE EXCEPTION 'JULY_PHASE2_SOURCE_DRIFT'; END IF;
  SELECT id INTO STRICT account_id FROM public.ledger_fund_accounts WHERE code=a->>'account' AND is_active AND is_business_fund AND type<>'card_clearing';
  IF NOT EXISTS(SELECT 1 FROM public.ledger_categories WHERE id=(a->>'categoryId')::bigint AND kind='expense' AND is_active)
   OR NOT EXISTS(SELECT 1 FROM public.ledger_inventory_category_mappings WHERE inventory_category=log.category AND ledger_category_id=(a->>'categoryId')::bigint AND is_active)
   OR NOT EXISTS(SELECT 1 FROM public.ledger_supplier_party_mappings WHERE lower(btrim(supplier_name))=lower(btrim(log.new_supplier)) AND party_id=(a->>'partyId')::bigint AND is_active)
   OR NOT EXISTS(SELECT 1 FROM public.ledger_parties WHERE id=(a->>'partyId')::bigint AND is_active) THEN RAISE EXCEPTION 'JULY_PHASE2_MAPPING_DRIFT'; END IF;
  IF EXISTS(SELECT 1 FROM public.ledger_payables pay JOIN public.ledger_transactions t ON t.id=pay.expense_transaction_id WHERE pay.party_id=(a->>'partyId')::bigint AND t.business_date<'2026-08-01' AND pay.status<>'cancelled') THEN RAISE EXCEPTION 'JULY_PHASE2_EXISTING_PAYABLE'; END IF;
  snapshot:=jsonb_build_object('inventory_log_id',log.id,'item_id',log.item_id,
   'item_name',coalesce(nullif(log.item_name,''),nullif(log.item_name_vi,''),'-'),'item_name_vi',log.item_name_vi,
   'category',log.category,'category_vi',log.category_vi,'unit',log.unit,'change_quantity',log.change_quantity,
   'purchase_price',log.new_purchase_price,'purchase_amount',round(log.change_quantity*log.new_purchase_price,3),
   'supplier',nullif(btrim(log.new_supplier),''),'business_date',log.business_date,
   'inventory_log_created_at',to_char(log.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'+00:00','source',log.source,'reason',log.reason);
  SELECT count(*) INTO audit_count FROM public.ledger_audit_logs WHERE action='july_restore_row' AND reason=a->>'key';
  IF audit_count>0 THEN
   IF audit_count<>1 THEN RAISE EXCEPTION 'JULY_PHASE2_REPLAY_AUDIT_COUNT'; END IF;
   SELECT entity_id INTO STRICT tx_id FROM public.ledger_audit_logs WHERE action='july_restore_row' AND reason=a->>'key' AND after_snapshot->>'actionHash'=a->>'actionHash';
   SELECT * INTO STRICT candidate FROM public.ledger_candidates WHERE source_type='inventory_purchase_log' AND source_key='inventory-log:'||log.id AND status='confirmed' AND resolved_transaction_id=tx_id;
   IF candidate.proposed_amount<>(a->>'amount')::numeric OR candidate.source_snapshot IS DISTINCT FROM snapshot
    OR candidate.source_fingerprint IS DISTINCT FROM encode(sha256(convert_to(snapshot::text,'UTF8')),'hex')
    OR candidate.business_date<>(a->>'date')::date OR candidate.proposed_recognition_month<>date '2026-07-01'
    OR candidate.proposed_category_id IS DISTINCT FROM (a->>'categoryId')::bigint OR candidate.proposed_party_id IS DISTINCT FROM (a->>'partyId')::bigint THEN RAISE EXCEPTION 'JULY_PHASE2_REPLAY_CANDIDATE'; END IF;
   replayed:=replayed+1;
  ELSE
   IF EXISTS(SELECT 1 FROM public.ledger_candidates WHERE source_key='inventory-log:'||log.id)
    OR EXISTS(SELECT 1 FROM public.ledger_inventory_projection_status WHERE inventory_log_id=log.id)
    OR EXISTS(SELECT 1 FROM public.ledger_transactions WHERE source_key=a->>'sourceKey' OR source_snapshot->>'inventory_log_id'=log.id::text)
    OR EXISTS(SELECT 1 FROM public.ledger_transactions t JOIN public.ledger_movements m ON m.transaction_id=t.id WHERE t.id=ANY((SELECT ids FROM july_phase2_original_ids WHERE name='ledger_transactions')::bigint[]) AND t.business_date=(a->>'date')::date AND t.status='confirmed' AND t.amount=(a->>'amount')::numeric AND m.fund_account_id=account_id AND m.amount=-(a->>'amount')::numeric) THEN RAISE EXCEPTION 'JULY_PHASE2_EXISTING_ECONOMIC_EVENT'; END IF;
   -- Same source snapshot contract as the existing projector. Never call a sync
   -- RPC that might automatically post or mutate the source log.
   INSERT INTO public.ledger_candidates(candidate_type,source_type,source_key,business_date,proposed_amount,proposed_category_id,proposed_party_id,proposed_recognition_month,source_snapshot,source_fingerprint)
    VALUES('inventory_purchase','inventory_purchase_log','inventory-log:'||log.id,log.business_date,(a->>'amount')::numeric,(a->>'categoryId')::bigint,(a->>'partyId')::bigint,date '2026-07-01',snapshot,encode(sha256(convert_to(snapshot::text,'UTF8')),'hex')) RETURNING id INTO candidate_id;
   result:=public.ledger_resolve_inventory_candidate_v1(candidate_id,'immediate',(a->>'categoryId')::bigint,(a->>'partyId')::bigint,account_id,NULL,'July sheet row '||(a->>'row'),a->>'key',actor);
   IF result->>'status' IS DISTINCT FROM 'confirmed' OR result->>'payableId' IS NOT NULL THEN RAISE EXCEPTION 'JULY_PHASE2_RPC_FAILED'; END IF;
   tx_id:=(result->>'transactionId')::bigint;
   -- Only the just-created transaction is given the exact original-row key.
   -- Candidate identity remains inventory-log:<id>, preventing future source sync
   -- from creating the same inventory cost a second time.
   UPDATE public.ledger_transactions SET source_key=a->>'sourceKey' WHERE id=tx_id AND source_type='inventory_purchase_candidate' AND source_key='candidate:'||candidate_id;
   IF NOT FOUND THEN RAISE EXCEPTION 'JULY_PHASE2_NEW_TRANSACTION_IDENTITY'; END IF;
   INSERT INTO public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,after_snapshot,reason)
    VALUES(actor,'july_restore_row','transaction',tx_id,jsonb_build_object('actionHash',a->>'actionHash','bundleDigest',p->>'bundleDigest','row',a->>'row','inventoryLogId',log.id,'sourceKey',a->>'sourceKey'),a->>'key');
   remaining_delta:=jsonb_set(remaining_delta,ARRAY[a->>'account'],to_jsonb((remaining_delta->>(a->>'account'))::numeric-(a->>'amount')::numeric));
   created:=created+1;
  END IF;
  SELECT * INTO STRICT tx FROM public.ledger_transactions WHERE id=tx_id;
  IF tx.status<>'confirmed' OR tx.type<>'expense' OR tx.source_type<>'inventory_purchase_candidate' OR tx.source_key IS DISTINCT FROM a->>'sourceKey'
   OR tx.business_date<>(a->>'date')::date OR tx.recognition_month<>date '2026-07-01' OR tx.amount<>(a->>'amount')::numeric
   OR tx.party_id IS DISTINCT FROM (a->>'partyId')::bigint OR tx.category_id IS DISTINCT FROM (a->>'categoryId')::bigint
   OR tx.source_snapshot IS DISTINCT FROM snapshot OR tx.source_fingerprint IS DISTINCT FROM encode(sha256(convert_to(snapshot::text,'UTF8')),'hex')
   OR (SELECT count(*) FROM public.ledger_movements WHERE transaction_id=tx_id)<>1
   OR NOT EXISTS(SELECT 1 FROM public.ledger_movements WHERE transaction_id=tx_id AND fund_account_id=account_id AND amount=-(a->>'amount')::numeric)
   OR EXISTS(SELECT 1 FROM public.ledger_payables WHERE expense_transaction_id=tx_id) THEN RAISE EXCEPTION 'JULY_PHASE2_POSTCONDITION'; END IF;
 END LOOP;
 IF created+replayed<>jsonb_array_length(p->'bundle'->'actions') THEN RAISE EXCEPTION 'JULY_PHASE2_BATCH_COUNT'; END IF;
 IF (SELECT count(*) FROM public.ledger_transactions WHERE NOT(id=ANY(coalesce((SELECT ids FROM july_phase2_original_ids WHERE name='ledger_transactions'),'{}'::bigint[]))))<>created
  OR (SELECT count(*) FROM public.ledger_movements WHERE NOT(id=ANY(coalesce((SELECT ids FROM july_phase2_original_ids WHERE name='ledger_movements'),'{}'::bigint[]))))<>created
  OR (SELECT count(*) FROM public.ledger_candidates WHERE NOT(id=ANY(coalesce((SELECT ids FROM july_phase2_original_ids WHERE name='ledger_candidates'),'{}'::bigint[]))))<>created
  THEN RAISE EXCEPTION 'JULY_PHASE2_UNEXPECTED_NEW_RECORD'; END IF;
 after_funds:=pg_temp.july_phase2_funds(NULL);
 IF EXISTS(SELECT 1 FROM jsonb_each_text(remaining_delta) d WHERE (after_funds->>d.key)::numeric-(before_funds->>d.key)::numeric<>d.value::numeric)
  OR after_funds->'card_clearing' IS DISTINCT FROM before_funds->'card_clearing'
  OR pg_temp.july_phase2_funds(date '2026-08-01') IS DISTINCT FROM before_live THEN RAISE EXCEPTION 'JULY_PHASE2_FUND_BOUNDARY'; END IF;
 IF pg_temp.july_phase2_protected() IS DISTINCT FROM before_state THEN RAISE EXCEPTION 'JULY_PHASE2_PROTECTED_DATA_CHANGED'; END IF;
END $restore$;
COMMIT;
