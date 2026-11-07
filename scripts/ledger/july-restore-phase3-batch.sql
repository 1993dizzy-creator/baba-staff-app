-- REVIEW DRAFT ONLY. Separate owner DB approval required. No source/stock/POS writes.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='90s';
SET LOCAL standard_conforming_strings=on;
SET LOCAL baba.july_phase3_actor='__ACTOR_USER_ID__';
SET LOCAL baba.july_phase3_approval='__OWNER_APPROVAL__';
CREATE TEMP TABLE july_phase3_input(canonical text NOT NULL,payload jsonb NOT NULL) ON COMMIT DROP;
INSERT INTO july_phase3_input VALUES(__PAYLOAD_LITERAL__,__PAYLOAD_LITERAL__::jsonb);
DO $approval$
DECLARE p jsonb;c text;r jsonb;actual bigint[];deltas jsonb;
BEGIN
 SELECT canonical,payload INTO STRICT c,p FROM july_phase3_input;
 IF current_setting('baba.july_phase3_approval') IS DISTINCT FROM 'APPROVED:__PAYLOAD_DIGEST__'
  OR encode(sha256(convert_to(c,'UTF8')),'hex')<>'__PAYLOAD_DIGEST__' OR c::jsonb IS DISTINCT FROM p
  OR encode(sha256(convert_to(p->>'bundleCanonical','UTF8')),'hex') IS DISTINCT FROM p->>'bundleDigest'
  OR (p->>'bundleCanonical')::jsonb IS DISTINCT FROM p->'bundle' THEN RAISE EXCEPTION 'JULY_PHASE3_APPROVAL'; END IF;
 SELECT array_agg((a->>'row')::bigint ORDER BY (a->>'row')::bigint) INTO actual FROM jsonb_array_elements(p->'bundle'->'actions') a;
 IF actual IS DISTINCT FROM ARRAY[__EXACT_ROWS__]::bigint[]
  OR cardinality(actual)<>(SELECT count(DISTINCT a->>'key') FROM jsonb_array_elements(p->'bundle'->'actions') a)
  OR (SELECT count(*) FROM jsonb_array_elements(p->'bundle'->'actions') a,jsonb_array_elements(a->'sources') s)<>(SELECT count(DISTINCT s->'logExpected'->>'id') FROM jsonb_array_elements(p->'bundle'->'actions') a,jsonb_array_elements(a->'sources') s)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'bundle'->'actions') a WHERE
   (a->>'row')::bigint=ANY(ARRAY[11,17,30,43,45,56,67,91,95,96,108,125,126,136,147,163,173,185,191,193,198,216,220,221,225,236,238,249,258,262,275,277,282,284,291,298,302,306,311,314,319,331,340,353,357,363,368,374,381,16,27,29,31,32,58,85,107,138,159,160,161,162,174,218,228,229,264,278,280,293,312,313,321,325,326,339,341,342,354,355,359,371,395,8,61,81,109,271,349]::bigint[])
   OR a->>'key' IS DISTINCT FROM 'sheet:1BRT2ul07GftjqVPwcIf35o3LDJ6RjPIdWL_YeiRqDx4:tab:829182003:row:'||(a->>'row')
   OR a->>'sourceKey' IS DISTINCT FROM 'july-restore:'||(a->>'key') OR a->>'date' NOT BETWEEN '2026-07-01' AND '2026-07-31'
   OR a->>'workflow' NOT IN('canonical_components','sheet_paid_group') OR (a->>'amount')::numeric<=0
   OR (a->>'amount')::numeric<>trunc((a->>'amount')::numeric)
   OR (a->>'amount')::numeric<>(SELECT -sum((e->>'amount')::numeric) FROM jsonb_array_elements(a->'effects') e)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(a->'effects') e WHERE (e->>'amount')::numeric>=0 OR e->>'account' NOT IN('store_cash','vuong_personal_custody','cho_personal_custody','baba_corporate_bank')))
  THEN RAISE EXCEPTION 'JULY_PHASE3_SCOPE_DUPLICATE'; END IF;
 SELECT jsonb_object_agg(code,delta) INTO deltas FROM (
  SELECT f.code,coalesce(sum((e->>'amount')::numeric),0) delta FROM unnest(ARRAY['store_cash','vuong_personal_custody','cho_personal_custody','baba_corporate_bank']) f(code)
  LEFT JOIN (SELECT e FROM jsonb_array_elements(p->'bundle'->'actions') a,jsonb_array_elements(a->'effects') e) x ON e->>'account'=f.code GROUP BY f.code) q;
 IF deltas IS DISTINCT FROM (SELECT jsonb_object_agg(key,value::numeric) FROM jsonb_each_text(p->'bundle'->'fundDelta')) THEN RAISE EXCEPTION 'JULY_PHASE3_APPROVED_DELTA'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.users WHERE id=current_setting('baba.july_phase3_actor')::bigint AND is_active AND app_login_enabled AND lower(role::text) IN('owner','master')) THEN RAISE EXCEPTION 'JULY_PHASE3_ACTOR'; END IF;
 IF NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261105153442') THEN RAISE EXCEPTION 'JULY_PHASE3_BOUNDARY_NOT_INSTALLED'; END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(p->'bundle'->'rpcContracts') LOOP
  IF (SELECT encode(sha256(convert_to(replace(prosrc,E'\r\n',E'\n'),'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure(r->>'signature')) IS DISTINCT FROM r->>'hash' THEN RAISE EXCEPTION 'JULY_PHASE3_RPC_CONTRACT_CHANGED: %',r->>'signature'; END IF;
 END LOOP;
END $approval$;

CREATE TEMP TABLE july_phase3_original_ids(name text PRIMARY KEY,ids bigint[]) ON COMMIT DROP;
DO $lock$
DECLARE n text;keys text[];
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('baba:ledger:july-restore-v1'));
 SELECT array_agg('inventory-log:'||(s->'logExpected'->>'id') ORDER BY (s->'logExpected'->>'id')::bigint) INTO keys FROM july_phase3_input i,jsonb_array_elements(i.payload->'bundle'->'actions') a,jsonb_array_elements(a->'sources') s;
 -- Reserve the COMPLETE source set before month/ledger locks, as existing RPCs require.
 PERFORM inventory_ledger_private.lock_sources(keys,ARRAY[date '2026-07-01']);
 PERFORM public.ledger_assert_month_open_v1(date '2026-07-01');
 PERFORM 1 FROM public.inventory x WHERE id IN(SELECT (s->'logExpected'->>'item_id')::bigint FROM july_phase3_input i,jsonb_array_elements(i.payload->'bundle'->'actions') a,jsonb_array_elements(a->'sources') s) ORDER BY id FOR SHARE;
 LOCK TABLE public.ledger_transactions,public.ledger_movements,public.ledger_candidates,public.ledger_audit_logs IN SHARE ROW EXCLUSIVE MODE;
 FOREACH n IN ARRAY ARRAY['ledger_transactions','ledger_movements','ledger_audit_logs','ledger_candidates','ledger_payables','ledger_payable_allocations','ledger_card_reconciliations','ledger_card_reconciliation_lines','ledger_card_fee_closures','ledger_card_fee_allocation_lines','ledger_fund_accounts','ledger_month_closures','ledger_month_closure_history'] LOOP
  EXECUTE format('INSERT INTO july_phase3_original_ids SELECT %L,array_agg(id ORDER BY id) FROM public.%I',n,n);
 END LOOP;
END $lock$;
CREATE OR REPLACE FUNCTION pg_temp.july_phase3_protected() RETURNS jsonb LANGUAGE plpgsql AS $protect$
DECLARE r record;h text;result jsonb:='{}';
BEGIN
 FOR r IN SELECT * FROM july_phase3_original_ids ORDER BY name LOOP
  EXECUTE format('SELECT md5(coalesce(string_agg(to_jsonb(x)::text,''|'' ORDER BY id),'''')) FROM public.%I x WHERE id=ANY($1)',r.name) INTO h USING r.ids;
  result:=result||jsonb_build_object(r.name,h);
  IF r.name NOT IN('ledger_transactions','ledger_movements','ledger_candidates','ledger_audit_logs') THEN
   EXECUTE format('SELECT count(*)::text FROM public.%I',r.name) INTO h;result:=result||jsonb_build_object(r.name||':count',h);
  END IF;
 END LOOP;
 SELECT md5(coalesce(string_agg(to_jsonb(l)::text,'|' ORDER BY id),'')) INTO h FROM public.inventory_logs l WHERE id IN(SELECT (s->'logExpected'->>'id')::bigint FROM july_phase3_input i,jsonb_array_elements(i.payload->'bundle'->'actions') a,jsonb_array_elements(a->'sources') s);
 result:=result||jsonb_build_object('sourceLogs',h);
 SELECT md5(coalesce(string_agg(to_jsonb(x)::text,'|' ORDER BY id),'')) INTO h FROM public.inventory x WHERE id IN(SELECT (s->'logExpected'->>'item_id')::bigint FROM july_phase3_input i,jsonb_array_elements(i.payload->'bundle'->'actions') a,jsonb_array_elements(a->'sources') s);
 RETURN result||jsonb_build_object('sourceStock',h);
END $protect$;
CREATE OR REPLACE FUNCTION pg_temp.july_phase3_funds(cutoff date) RETURNS jsonb LANGUAGE sql AS $funds$
 SELECT jsonb_object_agg(code,balance) FROM (
 SELECT f.code,coalesce(sum(m.amount) FILTER(WHERE t.status='confirmed' AND (cutoff IS NULL OR t.business_date>=cutoff)),0) balance
 FROM public.ledger_fund_accounts f LEFT JOIN public.ledger_movements m ON m.fund_account_id=f.id LEFT JOIN public.ledger_transactions t ON t.id=m.transaction_id
 WHERE f.code IN('store_cash','vuong_personal_custody','cho_personal_custody','baba_corporate_bank','card_clearing') GROUP BY f.code) x
$funds$;
CREATE OR REPLACE FUNCTION pg_temp.july_phase3_snapshot(l public.inventory_logs) RETURNS jsonb LANGUAGE sql AS $source$
 SELECT jsonb_build_object('inventory_log_id',l.id,'item_id',l.item_id,'item_name',coalesce(nullif(l.item_name,''),nullif(l.item_name_vi,''),'-'),
 'item_name_vi',l.item_name_vi,'category',l.category,'category_vi',l.category_vi,'unit',l.unit,'change_quantity',l.change_quantity,
 'purchase_price',l.new_purchase_price,'purchase_amount',round(l.change_quantity*l.new_purchase_price,3),'supplier',nullif(btrim(l.new_supplier),''),
 'business_date',l.business_date,'inventory_log_created_at',to_char(l.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'+00:00','source',l.source,'reason',l.reason)
$source$;
DO $restore$
DECLARE p jsonb;a jsonb;s jsonb;e jsonb;expected jsonb;actual jsonb;snapshot jsonb;result jsonb;protected jsonb;before_funds jsonb;before_live jsonb;after_funds jsonb;
 actor bigint:=current_setting('baba.july_phase3_actor')::bigint;l public.inventory_logs%rowtype;tx public.ledger_transactions%rowtype;c public.ledger_candidates%rowtype;
 tx_id bigint;group_tx bigint;candidate_id bigint;account_id bigint;v_source_key text;v_claim_reason text;applied boolean;cnt integer;
 new_tx integer:=0;new_candidates integer:=0;row_tx_ids bigint[];expected_tx_ids bigint[];net numeric;source_count integer;
 delta jsonb:='{"store_cash":0,"vuong_personal_custody":0,"cho_personal_custody":0,"baba_corporate_bank":0}';
BEGIN
 SELECT payload INTO STRICT p FROM july_phase3_input;
 protected:=pg_temp.july_phase3_protected();before_funds:=pg_temp.july_phase3_funds(NULL);before_live:=pg_temp.july_phase3_funds(date '2026-08-01');
 FOR expected IN SELECT value FROM jsonb_array_elements(p->'bundle'->'closures') LOOP
  IF NOT EXISTS(SELECT 1 FROM public.ledger_month_closures cl WHERE cl.id=(expected->>'id')::bigint AND cl.month=(expected->>'month')::date AND cl.status=expected->>'status' AND cl.revision=(expected->>'revision')::integer AND cl.snapshot_hash=expected->>'snapshot_hash') THEN RAISE EXCEPTION 'JULY_PHASE3_CLOSURE_DRIFT'; END IF;
 END LOOP;
 FOR a IN SELECT value FROM jsonb_array_elements(p->'bundle'->'actions') LOOP
  row_tx_ids:='{}';expected_tx_ids:='{}';group_tx:=NULL;net:=0;source_count:=0;
  SELECT count(*) INTO cnt FROM public.ledger_audit_logs WHERE action='july_restore_row' AND reason=a->>'key';
  IF cnt>1 THEN RAISE EXCEPTION 'JULY_PHASE3_DUPLICATE_AUDIT'; END IF;
  applied:=cnt=1;
  IF applied THEN
   SELECT ARRAY(SELECT value::bigint FROM jsonb_array_elements_text(after_snapshot->'transactionIds')) INTO STRICT expected_tx_ids FROM public.ledger_audit_logs WHERE action='july_restore_row' AND reason=a->>'key' AND after_snapshot->>'actionHash'=a->>'actionHash';
  ELSE
   IF EXISTS(SELECT 1 FROM public.ledger_transactions WHERE source_key=a->>'sourceKey') THEN RAISE EXCEPTION 'JULY_PHASE3_EXISTING_ROW'; END IF;
   IF EXISTS(SELECT 1 FROM public.ledger_transactions old_tx JOIN public.ledger_movements old_m ON old_m.transaction_id=old_tx.id JOIN public.ledger_fund_accounts old_f ON old_f.id=old_m.fund_account_id
    WHERE old_tx.id=ANY((SELECT ids FROM july_phase3_original_ids WHERE name='ledger_transactions')::bigint[]) AND old_tx.status='confirmed' AND old_tx.business_date=(a->>'date')::date AND old_tx.amount=(a->>'amount')::numeric
     AND EXISTS(SELECT 1 FROM jsonb_array_elements(a->'effects') eff WHERE eff->>'account'=old_f.code AND (eff->>'amount')::numeric=old_m.amount)
     AND NOT EXISTS(SELECT 1 FROM public.ledger_audit_logs au WHERE au.action='july_restore_row' AND au.entity_id=old_tx.id)) THEN RAISE EXCEPTION 'JULY_PHASE3_UNLINKED_PAYMENT'; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM public.ledger_payables pay JOIN public.ledger_transactions t ON t.id=pay.expense_transaction_id WHERE pay.party_id=(a->>'partyId')::bigint AND t.business_date<'2026-08-01' AND pay.status<>'cancelled') THEN RAISE EXCEPTION 'JULY_PHASE3_EXISTING_PAYABLE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.ledger_parties WHERE id=(a->>'partyId')::bigint AND is_active) THEN RAISE EXCEPTION 'JULY_PHASE3_PARTY'; END IF;
  -- Verify every source before creating any grouped cost. No prior/after-month source.
  FOR s IN SELECT value FROM jsonb_array_elements(a->'sources') LOOP
   expected:=s->'logExpected';SELECT * INTO STRICT l FROM public.inventory_logs WHERE id=(expected->>'id')::bigint;
   SELECT jsonb_object_agg(k,to_jsonb(l)->k) INTO actual FROM jsonb_object_keys(expected-'created_at') k;
   IF actual IS DISTINCT FROM expected-'created_at' OR l.created_at IS DISTINCT FROM (expected->>'created_at')::timestamptz
    OR l.reason<>'purchase' OR l.billed_amount IS NOT NULL OR l.purchase_supplier_partner_id IS NOT NULL OR l.correction_of_inventory_log_id IS NOT NULL
    OR l.business_date<>(a->>'date')::date OR round(l.change_quantity*l.new_purchase_price,3)<>(s->>'amount')::numeric
    OR ((s->>'correction')::boolean AND l.change_quantity>=0) OR (NOT(s->>'correction')::boolean AND l.change_quantity<=0)
    OR EXISTS(SELECT 1 FROM public.inventory_logs WHERE correction_of_inventory_log_id=l.id) THEN RAISE EXCEPTION 'JULY_PHASE3_SOURCE_DRIFT'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.ledger_supplier_party_mappings WHERE lower(btrim(supplier_name))=lower(btrim(l.new_supplier)) AND party_id=(a->>'partyId')::bigint AND is_active)
    OR NOT EXISTS(SELECT 1 FROM public.ledger_inventory_category_mappings WHERE inventory_category=l.category AND ledger_category_id=(s->>'categoryId')::bigint AND is_active)
    OR NOT EXISTS(SELECT 1 FROM public.ledger_categories WHERE id=(s->>'categoryId')::bigint AND kind='expense' AND is_active) THEN RAISE EXCEPTION 'JULY_PHASE3_MAPPING_DRIFT'; END IF;
   net:=net+(s->>'amount')::numeric;
   IF NOT applied AND (EXISTS(SELECT 1 FROM public.ledger_candidates WHERE source_key='inventory-log:'||l.id)
    OR EXISTS(SELECT 1 FROM public.ledger_inventory_projection_status WHERE inventory_log_id=l.id)
    OR EXISTS(SELECT 1 FROM public.ledger_transactions WHERE source_snapshot->>'inventory_log_id'=l.id::text)) THEN RAISE EXCEPTION 'JULY_PHASE3_EXISTING_SOURCE'; END IF;
  END LOOP;
  IF net<>(a->>'calculatedAmount')::numeric THEN RAISE EXCEPTION 'JULY_PHASE3_NET_SOURCE'; END IF;
  IF a->>'workflow'='sheet_paid_group' THEN
   IF jsonb_array_length(a->'effects')<>1 OR NOT EXISTS(SELECT 1 FROM public.ledger_categories WHERE id=(a->>'groupCategoryId')::bigint AND kind='expense' AND is_active) THEN RAISE EXCEPTION 'JULY_PHASE3_GROUP_CATEGORY'; END IF;
   SELECT id INTO STRICT account_id FROM public.ledger_fund_accounts WHERE code=a->'effects'->0->>'account' AND is_active AND is_business_fund AND type<>'card_clearing';
   IF applied THEN SELECT id INTO STRICT group_tx FROM public.ledger_transactions WHERE source_type='manual' AND source_key=a->>'sourceKey';
   ELSE
    result:=public.ledger_create_manual_transaction_v1('expense',((a->>'date')::date+time '03:00') AT TIME ZONE 'Asia/Ho_Chi_Minh',date '2026-07-01',(a->>'amount')::numeric,(a->>'groupCategoryId')::bigint,(a->>'partyId')::bigint,account_id,NULL,'July original sheet row '||(a->>'row'),a->>'key',actor,a->>'sourceKey');
    IF result->>'status' IS DISTINCT FROM 'created' THEN RAISE EXCEPTION 'JULY_PHASE3_MANUAL_RPC: %',result->>'status'; END IF;
    group_tx:=(result->>'transactionId')::bigint;new_tx:=new_tx+1;
    UPDATE public.ledger_transactions SET source_snapshot=jsonb_build_object('restoreProfile','july-phase3-sheet-group','sourceRowKey',a->>'key','sourceLogs',a->'sources','sourceCalculated',a->>'calculatedAmount','sheetPaid',a->>'amount') WHERE id=group_tx AND source_type='manual' AND source_key=a->>'sourceKey';
   END IF;
   SELECT * INTO STRICT tx FROM public.ledger_transactions WHERE id=group_tx;
   IF tx.type<>'expense' OR tx.status<>'confirmed' OR tx.business_date<>(a->>'date')::date OR tx.recognition_month<>date '2026-07-01' OR tx.amount<>(a->>'amount')::numeric OR tx.category_id IS DISTINCT FROM (a->>'groupCategoryId')::bigint OR tx.party_id IS DISTINCT FROM (a->>'partyId')::bigint
    OR tx.source_snapshot->>'sourceRowKey' IS DISTINCT FROM a->>'key' OR tx.source_snapshot->'sourceLogs' IS DISTINCT FROM a->'sources'
    OR (SELECT count(*) FROM public.ledger_movements WHERE transaction_id=group_tx)<>1 OR NOT EXISTS(SELECT 1 FROM public.ledger_movements WHERE transaction_id=group_tx AND fund_account_id=account_id AND amount=-(a->>'amount')::numeric) THEN RAISE EXCEPTION 'JULY_PHASE3_GROUP_COST_MISMATCH'; END IF;
   row_tx_ids:=ARRAY[group_tx];
  ELSIF net<>(a->>'amount')::numeric OR EXISTS(SELECT 1 FROM jsonb_array_elements(a->'sources') x WHERE (x->>'correction')::boolean) THEN RAISE EXCEPTION 'JULY_PHASE3_COMPONENT_TOTAL'; END IF;
  FOR s IN SELECT value FROM jsonb_array_elements(a->'sources') LOOP
   IF (s->>'correction')::boolean THEN CONTINUE; END IF;
   source_count:=source_count+1;
   SELECT * INTO STRICT l FROM public.inventory_logs WHERE id=(s->'logExpected'->>'id')::bigint;
   snapshot:=pg_temp.july_phase3_snapshot(l);
   v_source_key:=CASE WHEN source_count=1 THEN a->>'sourceKey' ELSE (a->>'sourceKey')||':inventory-log:'||l.id END;
   v_claim_reason:='july-phase3-group:'||(a->>'key')||':tx:'||group_tx;
   IF applied THEN SELECT * INTO STRICT c FROM public.ledger_candidates WHERE source_type='inventory_purchase_log' AND source_key='inventory-log:'||l.id;
   ELSE
    INSERT INTO public.ledger_candidates(candidate_type,source_type,source_key,business_date,proposed_amount,proposed_category_id,proposed_party_id,proposed_recognition_month,source_snapshot,source_fingerprint)
    VALUES('inventory_purchase','inventory_purchase_log','inventory-log:'||l.id,l.business_date,(s->>'amount')::numeric,(s->>'categoryId')::bigint,(a->>'partyId')::bigint,date '2026-07-01',snapshot,encode(sha256(convert_to(snapshot::text,'UTF8')),'hex')) RETURNING id INTO candidate_id;
    new_candidates:=new_candidates+1;
    IF a->>'workflow'='canonical_components' THEN
     SELECT id INTO STRICT account_id FROM public.ledger_fund_accounts WHERE code=s->>'account' AND is_active AND is_business_fund AND type<>'card_clearing';
     result:=public.ledger_resolve_inventory_candidate_v1(candidate_id,'immediate',(s->>'categoryId')::bigint,(a->>'partyId')::bigint,account_id,NULL,'July grouped receipt '||(a->>'row'),a->>'key',actor);
     IF result->>'status' IS DISTINCT FROM 'confirmed' OR result->>'payableId' IS NOT NULL THEN RAISE EXCEPTION 'JULY_PHASE3_COMPONENT_RPC'; END IF;
     tx_id:=(result->>'transactionId')::bigint;new_tx:=new_tx+1;
     UPDATE public.ledger_transactions t SET source_key=CASE WHEN source_count=1 THEN a->>'sourceKey' ELSE (a->>'sourceKey')||':inventory-log:'||l.id END WHERE t.id=tx_id AND t.source_type='inventory_purchase_candidate' AND t.source_key='candidate:'||candidate_id;
     IF NOT FOUND THEN RAISE EXCEPTION 'JULY_PHASE3_COMPONENT_IDENTITY'; END IF;
    ELSE
     -- The ONE actual sheet expense already represents this source. Dismiss its
     -- independent candidate with an explicit cost reference, never as "no purchase".
     -- Existing sync leaves this exact dismissed snapshot unchanged; later source
     -- drift is forced to pending review, rather than automatically reposting cost.
     result:=public.ledger_resolve_inventory_candidate_v1(candidate_id,'dismiss',NULL,NULL,NULL,NULL,'Cost already grouped in sheet row '||(a->>'row'),v_claim_reason,actor);
     IF result->>'status' IS DISTINCT FROM 'dismissed' THEN RAISE EXCEPTION 'JULY_PHASE3_GROUP_CLAIM_RPC'; END IF;
    END IF;
    SELECT * INTO STRICT c FROM public.ledger_candidates WHERE id=candidate_id;
   END IF;
   IF c.source_snapshot IS DISTINCT FROM snapshot OR c.source_fingerprint IS DISTINCT FROM encode(sha256(convert_to(snapshot::text,'UTF8')),'hex') OR c.proposed_amount<>(s->>'amount')::numeric OR c.business_date<>(a->>'date')::date OR c.proposed_recognition_month<>date '2026-07-01' OR c.proposed_category_id IS DISTINCT FROM (s->>'categoryId')::bigint OR c.proposed_party_id IS DISTINCT FROM (a->>'partyId')::bigint THEN RAISE EXCEPTION 'JULY_PHASE3_CLAIM_MISMATCH'; END IF;
   IF a->>'workflow'='canonical_components' THEN
    IF c.status<>'confirmed' OR c.resolved_transaction_id IS NULL THEN RAISE EXCEPTION 'JULY_PHASE3_CONFIRMED_CLAIM'; END IF;
    tx_id:=c.resolved_transaction_id;SELECT * INTO STRICT tx FROM public.ledger_transactions WHERE id=tx_id;
    SELECT id INTO STRICT account_id FROM public.ledger_fund_accounts WHERE code=s->>'account' AND is_active AND is_business_fund AND type<>'card_clearing';
    IF tx.source_key IS DISTINCT FROM v_source_key OR tx.source_type<>'inventory_purchase_candidate' OR tx.type<>'expense' OR tx.status<>'confirmed' OR tx.business_date<>(a->>'date')::date OR tx.recognition_month<>date '2026-07-01' OR tx.amount<>(s->>'amount')::numeric OR tx.category_id IS DISTINCT FROM (s->>'categoryId')::bigint OR tx.party_id IS DISTINCT FROM (a->>'partyId')::bigint OR tx.source_snapshot IS DISTINCT FROM snapshot
     OR tx.source_fingerprint IS DISTINCT FROM c.source_fingerprint OR (SELECT count(*) FROM public.ledger_movements WHERE transaction_id=tx_id)<>1 OR NOT EXISTS(SELECT 1 FROM public.ledger_movements WHERE transaction_id=tx_id AND fund_account_id=account_id AND amount=-(s->>'amount')::numeric) THEN RAISE EXCEPTION 'JULY_PHASE3_COMPONENT_MISMATCH'; END IF;
    row_tx_ids:=array_append(row_tx_ids,tx_id);
   ELSIF c.status<>'dismissed' OR c.resolved_transaction_id IS NOT NULL OR c.dismissal_reason IS DISTINCT FROM v_claim_reason THEN RAISE EXCEPTION 'JULY_PHASE3_DISMISSED_CLAIM'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.ledger_payables WHERE expense_transaction_id=ANY(row_tx_ids)) THEN RAISE EXCEPTION 'JULY_PHASE3_NEW_PAYABLE'; END IF;
  SELECT jsonb_object_agg(code,amount) INTO actual FROM (SELECT f.code,sum(m.amount) amount FROM public.ledger_movements m JOIN public.ledger_fund_accounts f ON f.id=m.fund_account_id WHERE m.transaction_id=ANY(row_tx_ids) GROUP BY f.code) q;
  SELECT jsonb_object_agg(eff->>'account',(eff->>'amount')::numeric) INTO expected FROM jsonb_array_elements(a->'effects') eff;
  IF actual IS DISTINCT FROM expected OR (SELECT sum(amount) FROM public.ledger_transactions WHERE id=ANY(row_tx_ids))<>(a->>'amount')::numeric THEN RAISE EXCEPTION 'JULY_PHASE3_ROW_TOTAL'; END IF;
  IF applied THEN
   IF expected_tx_ids IS DISTINCT FROM row_tx_ids THEN RAISE EXCEPTION 'JULY_PHASE3_REPLAY_IDS'; END IF;
  ELSE
   INSERT INTO public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,after_snapshot,reason)
   VALUES(actor,'july_restore_row','transaction',row_tx_ids[1],jsonb_build_object('actionHash',a->>'actionHash','bundleDigest',p->>'bundleDigest','workflow',a->>'workflow','transactionIds',to_jsonb(row_tx_ids),'sourceRow',a->>'row','sourceIds',(SELECT jsonb_agg(zsrc->'logExpected'->'id') FROM jsonb_array_elements(a->'sources') zsrc)),a->>'key');
   FOR e IN SELECT value FROM jsonb_array_elements(a->'effects') LOOP delta:=jsonb_set(delta,ARRAY[e->>'account'],to_jsonb((delta->>(e->>'account'))::numeric+(e->>'amount')::numeric));END LOOP;
  END IF;
 END LOOP;
 IF (SELECT count(*) FROM public.ledger_transactions WHERE NOT(id=ANY(coalesce((SELECT ids FROM july_phase3_original_ids WHERE name='ledger_transactions'),'{}'::bigint[]))))<>new_tx
  OR (SELECT count(*) FROM public.ledger_movements WHERE NOT(id=ANY(coalesce((SELECT ids FROM july_phase3_original_ids WHERE name='ledger_movements'),'{}'::bigint[]))))<>new_tx
  OR (SELECT count(*) FROM public.ledger_candidates WHERE NOT(id=ANY(coalesce((SELECT ids FROM july_phase3_original_ids WHERE name='ledger_candidates'),'{}'::bigint[]))))<>new_candidates THEN RAISE EXCEPTION 'JULY_PHASE3_UNEXPECTED_NEW_RECORD'; END IF;
 after_funds:=pg_temp.july_phase3_funds(NULL);
 IF EXISTS(SELECT 1 FROM jsonb_each_text(delta) d WHERE (after_funds->>d.key)::numeric-(before_funds->>d.key)::numeric<>d.value::numeric)
  OR after_funds->'card_clearing' IS DISTINCT FROM before_funds->'card_clearing' OR pg_temp.july_phase3_funds(date '2026-08-01') IS DISTINCT FROM before_live THEN RAISE EXCEPTION 'JULY_PHASE3_FUND_BOUNDARY'; END IF;
 IF pg_temp.july_phase3_protected() IS DISTINCT FROM protected THEN RAISE EXCEPTION 'JULY_PHASE3_PROTECTED_CHANGED'; END IF;
END $restore$;
COMMIT;
