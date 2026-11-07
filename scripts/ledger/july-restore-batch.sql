-- Template, NOT a migration. No installation, no HTTP, no automatic execution.
-- Render with july-restore-dry-run.mjs, review, then obtain separate DB approval.
-- Run the WHOLE rendered file in a privileged SQL session. Placeholders fail closed.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
SET LOCAL baba.july_restore_actor='__ACTOR_USER_ID__';
SET LOCAL baba.july_restore_approval='__OWNER_APPROVAL__';
CREATE TEMP TABLE july_restore_input(payload jsonb NOT NULL, approved_payload_canonical text NOT NULL) ON COMMIT DROP;
INSERT INTO july_restore_input VALUES (__REVIEWED_PAYLOAD__);

-- Validate the reviewed envelope BEFORE acquiring any operating-table write lock.
DO $approved_batch$
DECLARE
  manifest jsonb; canonical text; actual_rows bigint[]; actual_delta jsonb;
  safe49 constant boolean := '__SAFE49_PROFILE__';
  expected_contract constant jsonb := '__APPROVED_49_CONTRACT__';
BEGIN
  SELECT payload,approved_payload_canonical INTO STRICT manifest,canonical FROM july_restore_input;
  IF encode(sha256(convert_to(canonical,'UTF8')),'hex')<>'__APPROVED_PAYLOAD_DIGEST__'
    OR canonical::jsonb IS DISTINCT FROM manifest
    OR manifest->>'bundleDigest' IS DISTINCT FROM '__APPROVED_BUNDLE_DIGEST__' THEN RAISE EXCEPTION 'JULY_APPROVED_PAYLOAD_MISMATCH'; END IF;
  IF safe49 THEN
    IF manifest->'batch49Contract' IS DISTINCT FROM expected_contract OR jsonb_array_length(manifest->'actions')<>49 THEN RAISE EXCEPTION 'JULY_BATCH_49_REQUIRED'; END IF;
    SELECT array_agg((r->>'row')::bigint ORDER BY (r->>'row')::bigint) INTO actual_rows
      FROM jsonb_array_elements(manifest->'actions') act,jsonb_array_elements(act->'rows') r;
    IF actual_rows IS DISTINCT FROM ARRAY(SELECT value::bigint FROM jsonb_array_elements_text(expected_contract->'rows'))
      OR (SELECT count(DISTINCT r->>'key') FROM jsonb_array_elements(manifest->'actions') act,jsonb_array_elements(act->'rows') r)<>49
      OR (SELECT count(DISTINCT act->>'key') FROM jsonb_array_elements(manifest->'actions') act)<>49
      OR (SELECT count(DISTINCT act->>'economicKey') FROM jsonb_array_elements(manifest->'actions') act)<>49 THEN RAISE EXCEPTION 'JULY_BATCH_ROW_OR_SUBMISSION_DUPLICATE'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(manifest->'actions') act WHERE act->>'kind' NOT IN('expense','meal','income','transfer')
      OR jsonb_array_length(act->'rows')<>1 OR act->'rowNumbers' IS DISTINCT FROM jsonb_build_array((act->'rows'->0->>'row')::bigint)
      OR act->>'key' IS DISTINCT FROM 'sheet-row-'||(act->'rows'->0->>'row')
      OR act->>'economicKey' IS DISTINCT FROM act->'rows'->0->>'key'
      OR act->'rows'->0->>'key' IS DISTINCT FROM 'sheet:1BRT2ul07GftjqVPwcIf35o3LDJ6RjPIdWL_YeiRqDx4:tab:829182003:row:'||(act->'rows'->0->>'row')) THEN RAISE EXCEPTION 'JULY_BATCH_SUBMISSION_SCOPE'; END IF;
    SELECT jsonb_object_agg(account,amount) INTO actual_delta FROM (
      SELECT e->>'account' account,sum((e->>'amount')::numeric) amount
      FROM jsonb_array_elements(manifest->'actions') act,jsonb_array_elements(act->'effects') e GROUP BY e->>'account') x;
    IF actual_delta IS DISTINCT FROM expected_contract->'fundDelta' THEN RAISE EXCEPTION 'JULY_BATCH_APPROVED_DELTA_MISMATCH'; END IF;
  END IF;
END $approved_batch$;

-- Preserve existing rows in full, not merely their counts or sums. Only selected
-- July payables may change; allocations and all pre-existing card links may not.
CREATE TEMP TABLE july_original_ids(name text PRIMARY KEY, ids bigint[]) ON COMMIT DROP;
DO $capture_ids$
DECLARE n text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('baba:ledger:july-restore-v1'));
  LOCK TABLE public.ledger_transactions,public.ledger_movements,public.ledger_audit_logs IN SHARE ROW EXCLUSIVE MODE;
  IF NOT '__SAFE49_PROFILE__'::boolean THEN
    LOCK TABLE public.ledger_payables,public.ledger_payable_allocations,public.ledger_card_reconciliations,
      public.ledger_card_reconciliation_lines,public.ledger_candidates IN SHARE ROW EXCLUSIVE MODE;
  END IF;
  FOREACH n IN ARRAY ARRAY['ledger_transactions','ledger_movements','ledger_audit_logs',
    'ledger_payable_allocations','ledger_card_reconciliations','ledger_card_reconciliation_lines'] LOOP
    EXECUTE format('INSERT INTO july_original_ids SELECT %L,array_agg(id) FROM public.%I',n,n);
  END LOOP;
END $capture_ids$;

CREATE OR REPLACE FUNCTION pg_temp.july_protected() RETURNS jsonb LANGUAGE plpgsql AS $snapshot$
DECLARE r record; j jsonb; result jsonb:='{}';
BEGIN
  FOR r IN SELECT * FROM july_original_ids LOOP
    EXECUTE format('SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.%I x WHERE id=ANY($1)',r.name) INTO j USING r.ids;
    result:=result||jsonb_build_object(r.name,j);
  END LOOP;
  -- The reviewed 49 use manual RPC only: no inventory/POS writer is reachable.
  -- Keep ledger/closure/card protection; avoid two whole operational-source scans.
  FOR r IN SELECT unnest(ARRAY['ledger_fund_accounts','ledger_month_closures','ledger_month_closure_history']
    || CASE WHEN '__SAFE49_PROFILE__'::boolean THEN ARRAY[]::text[] ELSE
       ARRAY['inventory_logs','inventory','pos_sales_receipts','pos_sales_receipt_lines','pos_sales_receipt_payments'] END) name LOOP
    IF to_regclass('public.'||r.name) IS NULL THEN RAISE EXCEPTION 'JULY_PROTECTION_TABLE_MISSING: %',r.name; END IF;
    EXECUTE format('SELECT to_jsonb(md5(coalesce(string_agg(to_jsonb(x)::text,''|'' ORDER BY to_jsonb(x)::text),''''))) FROM public.%I x',r.name) INTO j;
    result:=result||jsonb_build_object(r.name,j);
  END LOOP;
  SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) INTO j FROM public.ledger_payables p
   WHERE NOT EXISTS(SELECT 1 FROM july_restore_input i,
     jsonb_array_elements(i.payload->'actions') a,jsonb_array_elements(coalesce(a->'allocations','[]')) x
     WHERE a->>'kind'='payable_payment' AND (x->>'payableId')::bigint=p.id);
  result:=result||jsonb_build_object('otherPayables',j);
  SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) INTO j FROM public.ledger_candidates c
   WHERE NOT EXISTS(SELECT 1 FROM july_restore_input i,jsonb_array_elements(i.payload->'actions') a
     WHERE a->>'kind'='inventory' AND (a->>'candidateId')::bigint=c.id);
  RETURN result||jsonb_build_object('otherCandidates',j);
END $snapshot$;

DO $restore$
DECLARE
  manifest jsonb; a jsonb; row_data jsonb; row_number jsonb; effect jsonb; allocation jsonb;
  actor bigint; approval text; before_state jsonb; before_cash jsonb; after_cash jsonb;
  result jsonb; tx public.ledger_transactions%ROWTYPE; account_id bigint; tx_id bigint;
  v_source_type text; v_source_key text; payload_hash text; date_value date; amount_value numeric;
  from_id bigint; to_id bigint; audit_count int; row_count int; expected_count int;
  expected_effects jsonb; actual_effects jsonb; expected_record jsonb; actual_record jsonb;
  created_count int:=0; linked_count int:=0; unchanged_count int:=0; applied boolean;
  before_card numeric; after_card numeric;
  before_batch_funds jsonb; after_batch_funds jsonb; remaining_delta jsonb:='{"store_cash":0,"vuong_personal_custody":0,"cho_personal_custody":0,"baba_corporate_bank":0}';
  safe49 constant boolean := '__SAFE49_PROFILE__';
BEGIN
  SELECT payload INTO STRICT manifest FROM july_restore_input;
  actor:=current_setting('baba.july_restore_actor',true)::bigint;
  approval:=current_setting('baba.july_restore_approval',true);
  IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=actor AND is_active AND app_login_enabled AND lower(role::text) IN ('owner','master')) THEN
    RAISE EXCEPTION 'JULY_ACTOR_REQUIRED';
  END IF;
  IF approval IS DISTINCT FROM ('APPROVED:july-restore:'||(manifest->>'bundleDigest')||(CASE WHEN safe49 THEN ':__APPROVED_PAYLOAD_DIGEST__' ELSE '' END)) THEN RAISE EXCEPTION 'JULY_SEPARATE_APPROVAL_REQUIRED'; END IF;
  IF manifest->>'status' IS DISTINCT FROM 'REVIEWABLE' OR (manifest->>'sourceRows')::int<>395 THEN RAISE EXCEPTION 'JULY_INCOMPLETE_SOURCE'; END IF;
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN RAISE EXCEPTION 'JULY_BOUNDARY_HISTORY_MISSING'; END IF;
  IF NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261105153442') THEN RAISE EXCEPTION 'JULY_BOUNDARY_MIGRATION_REQUIRED'; END IF;
  PERFORM public.ledger_assert_month_open_v1(date '2026-07-01');
  -- Opening IDs and old special transactions must exist; never create/repair them.
  IF (SELECT count(*) FROM public.ledger_transactions WHERE id IN(3,4,5,6,1190,3804,4207,4208,4209,4210))<>10 THEN RAISE EXCEPTION 'JULY_PROTECTED_BASELINE_MISSING'; END IF;
  FOR expected_record IN SELECT value FROM jsonb_array_elements(manifest->'openings') LOOP
    IF NOT EXISTS(SELECT 1 FROM public.ledger_transactions t JOIN public.ledger_movements m ON m.transaction_id=t.id JOIN public.ledger_fund_accounts f ON f.id=m.fund_account_id
      WHERE t.id=(expected_record->>'id')::bigint AND t.type='opening' AND t.status='confirmed'
      AND t.business_date='2026-07-01' AND t.amount=(expected_record->>'amount')::numeric
      AND f.code=expected_record->>'account' AND m.amount=t.amount
      AND (SELECT count(*) FROM public.ledger_movements WHERE transaction_id=t.id)=1) THEN RAISE EXCEPTION 'JULY_OPENING_MISMATCH'; END IF;
  END LOOP;
  -- Runtime-reviewed subsets reject newly added July entries/movements, even
  -- when another writer used a different source key after the GET observation.
  -- Exact replays exclude only transactions audited by THIS selected row set.
  IF manifest ? 'runtimePreflight' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',t.id,'type',t.type,'status',t.status,
      'business_date',t.business_date,'recognition_month',t.recognition_month,'amount',t.amount,
      'category_id',t.category_id,'source_type',t.source_type,'source_key',t.source_key) ORDER BY t.id),'[]')
      INTO actual_record FROM public.ledger_transactions t
      WHERE (t.business_date BETWEEN date '2026-07-01' AND date '2026-07-31' OR t.recognition_month=date '2026-07-01')
      AND NOT EXISTS(SELECT 1 FROM public.ledger_audit_logs l WHERE l.action='july_restore_row' AND l.entity_id=t.id
        AND l.reason IN(SELECT selected_row.value->>'key' FROM jsonb_array_elements(manifest->'actions') selected_action(value),jsonb_array_elements(selected_action.value->'rows') selected_row(value)));
    IF actual_record IS DISTINCT FROM manifest->'runtimePreflight'->'transactions' THEN RAISE EXCEPTION 'JULY_RUNTIME_TRANSACTION_DRIFT'; END IF;
    SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]') INTO actual_record
      FROM public.ledger_candidates c WHERE c.business_date BETWEEN date '2026-07-01' AND date '2026-07-31';
    IF actual_record IS DISTINCT FROM manifest->'runtimePreflight'->'candidates' THEN RAISE EXCEPTION 'JULY_RUNTIME_CANDIDATE_DRIFT'; END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.id,'transaction_id',m.transaction_id,'fund_account_id',m.fund_account_id,'amount',m.amount) ORDER BY m.id),'[]')
      INTO actual_record FROM public.ledger_movements m
      WHERE m.transaction_id IN(SELECT (x->>'id')::bigint FROM jsonb_array_elements(manifest->'runtimePreflight'->'transactions') x);
    IF actual_record IS DISTINCT FROM manifest->'runtimePreflight'->'movements' THEN RAISE EXCEPTION 'JULY_RUNTIME_MOVEMENT_DRIFT'; END IF;
    SELECT jsonb_agg(jsonb_build_object('id',f.id,'code',f.code,'type',f.type,'is_active',f.is_active,
      'is_business_fund',f.is_business_fund,'active_from',f.active_from,'active_to',f.active_to) ORDER BY f.id)
      INTO actual_record FROM public.ledger_fund_accounts f WHERE f.id IN(SELECT (x->>'id')::bigint FROM jsonb_array_elements(manifest->'runtimePreflight'->'accounts') x);
    IF actual_record IS DISTINCT FROM manifest->'runtimePreflight'->'accounts' THEN RAISE EXCEPTION 'JULY_RUNTIME_ACCOUNT_DRIFT'; END IF;
    SELECT jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'kind',c.kind,'is_active',c.is_active) ORDER BY c.id)
      INTO actual_record FROM public.ledger_categories c WHERE c.id IN(SELECT (x->>'id')::bigint FROM jsonb_array_elements(manifest->'runtimePreflight'->'categories') x);
    IF actual_record IS DISTINCT FROM manifest->'runtimePreflight'->'categories' THEN RAISE EXCEPTION 'JULY_RUNTIME_CATEGORY_DRIFT'; END IF;
  END IF;
  before_state:=pg_temp.july_protected();
  IF safe49 THEN
    SELECT jsonb_object_agg(code,balance) INTO before_batch_funds FROM (
      SELECT f.code,coalesce(sum(m.amount) FILTER(WHERE t.status='confirmed'),0) balance
      FROM public.ledger_fund_accounts f LEFT JOIN public.ledger_movements m ON m.fund_account_id=f.id LEFT JOIN public.ledger_transactions t ON t.id=m.transaction_id
      WHERE f.code IN('store_cash','vuong_personal_custody','cho_personal_custody','baba_corporate_bank') GROUP BY f.code) x;
  END IF;
  SELECT coalesce(sum(m.amount),0) INTO before_card FROM public.ledger_movements m
    JOIN public.ledger_transactions t ON t.id=m.transaction_id JOIN public.ledger_fund_accounts f ON f.id=m.fund_account_id
    WHERE f.code='card_clearing' AND t.status='confirmed';
  SELECT jsonb_object_agg(code,balance) INTO before_cash FROM (
    SELECT f.code,coalesce(sum(m.amount) FILTER(WHERE t.status='confirmed' AND t.business_date>='2026-08-01'),0) balance
    FROM public.ledger_fund_accounts f LEFT JOIN public.ledger_movements m ON m.fund_account_id=f.id LEFT JOIN public.ledger_transactions t ON t.id=m.transaction_id
    WHERE f.code IN('store_cash','vuong_personal_custody','cho_personal_custody','baba_corporate_bank') GROUP BY f.code) x;

  FOR a IN SELECT value FROM jsonb_array_elements(manifest->'actions') LOOP
    date_value:=(a->>'date')::date;amount_value:=(a->>'amount')::numeric;
    IF date_value NOT BETWEEN date '2026-07-01' AND date '2026-07-31' OR amount_value<=0 THEN RAISE EXCEPTION 'JULY_ACTION_SCOPE'; END IF;
    payload_hash:=md5(a::text);
    expected_count:=jsonb_array_length(a->'rows');
    SELECT count(*) INTO audit_count FROM public.ledger_audit_logs l
     WHERE l.action='july_restore_row' AND l.reason IN(SELECT value->>'key' FROM jsonb_array_elements(a->'rows'));
    IF audit_count NOT IN(0,expected_count) THEN RAISE EXCEPTION 'JULY_PARTIAL_OR_DUPLICATE_ROW_AUDIT'; END IF;
    applied:=audit_count=expected_count;
    IF safe49 AND NOT applied THEN
      FOR effect IN SELECT value FROM jsonb_array_elements(a->'effects') LOOP
        remaining_delta:=jsonb_set(remaining_delta,ARRAY[effect->>'account'],to_jsonb((remaining_delta->>(effect->>'account'))::numeric+(effect->>'amount')::numeric));
      END LOOP;
    END IF;
    IF applied THEN
      IF (SELECT count(DISTINCT reason) FROM public.ledger_audit_logs l WHERE l.action='july_restore_row'
        AND l.reason IN(SELECT value->>'key' FROM jsonb_array_elements(a->'rows')))<>expected_count THEN RAISE EXCEPTION 'JULY_DUPLICATE_ROW_AUDIT'; END IF;
      IF EXISTS(SELECT 1 FROM public.ledger_audit_logs l WHERE l.action='july_restore_row'
        AND l.reason IN(SELECT value->>'key' FROM jsonb_array_elements(a->'rows'))
        AND l.after_snapshot->>'actionHash' IS DISTINCT FROM payload_hash) THEN RAISE EXCEPTION 'JULY_REPLAY_CONFLICT'; END IF;
      SELECT DISTINCT l.entity_id INTO STRICT tx_id FROM public.ledger_audit_logs l WHERE l.action='july_restore_row'
        AND l.reason IN(SELECT value->>'key' FROM jsonb_array_elements(a->'rows'));
      unchanged_count:=unchanged_count+1;
    ELSIF a->>'kind'='link' THEN
      tx_id:=(a->>'transactionId')::bigint;linked_count:=linked_count+1;
    ELSIF a->>'kind'='inventory' THEN
      SELECT to_jsonb(c) INTO STRICT actual_record FROM public.ledger_candidates c WHERE id=(a->>'candidateId')::bigint FOR UPDATE;
      IF actual_record IS DISTINCT FROM a->'candidateSnapshot' OR actual_record->>'status'<>'pending'
        OR actual_record->>'business_date'<>date_value::text OR actual_record->>'proposed_recognition_month'<>'2026-07-01'
        OR (actual_record->>'proposed_amount')::numeric<>amount_value THEN RAISE EXCEPTION 'JULY_INVENTORY_SOURCE_DRIFT'; END IF;
      SELECT id INTO STRICT from_id FROM public.ledger_fund_accounts WHERE code=a->'effects'->0->>'account' AND is_active;
      result:=public.ledger_resolve_inventory_candidate_v1((a->>'candidateId')::bigint,'immediate',(a->>'categoryId')::bigint,
        (a->>'partyId')::bigint,from_id,NULL,a->>'evidence',a->>'evidence',actor);
      IF result->>'status' IS DISTINCT FROM 'confirmed' THEN RAISE EXCEPTION 'JULY_RPC_FAILED: %',result->>'status'; END IF;
      tx_id:=(result->>'transactionId')::bigint;created_count:=created_count+1;
    ELSIF a->>'kind'='payable_payment' THEN
      -- Explicit July payable allocation only; never FIFO or a later-month cost.
      FOR allocation IN SELECT value FROM jsonb_array_elements(a->'allocations') LOOP
        IF NOT EXISTS(SELECT 1 FROM public.ledger_payables p JOIN public.ledger_transactions t ON t.id=p.expense_transaction_id
          WHERE p.id=(allocation->>'payableId')::bigint AND p.party_id=(a->>'partyId')::bigint
          AND t.business_date BETWEEN date '2026-07-01' AND date '2026-07-31' AND t.status='confirmed') THEN RAISE EXCEPTION 'JULY_PAYABLE_SOURCE'; END IF;
      END LOOP;
      SELECT f.id INTO STRICT from_id FROM public.ledger_fund_accounts f WHERE f.code=a->'effects'->0->>'account';
      result:=public.ledger_pay_payables_v2(md5('july-restore:'||(a->>'key'))::uuid,(a->>'partyId')::bigint,from_id,
        (date_value+time '03:00') AT TIME ZONE 'Asia/Ho_Chi_Minh',amount_value,a->'allocations',a->>'evidence',actor);
      IF result->>'status' IS DISTINCT FROM 'paid' THEN RAISE EXCEPTION 'JULY_RPC_FAILED: %',result->>'status'; END IF;
      tx_id:=(result->>'paymentTransactionId')::bigint;created_count:=created_count+1;
    ELSE
      v_source_type:=CASE WHEN a->>'kind'='pos' THEN 'pos_sales_daily_payment' WHEN a->>'kind'='card_deposit' THEN 'card_settlement_deposit' ELSE 'manual' END;
      v_source_key:=CASE WHEN a->>'kind'='pos' THEN 'pos:'||date_value||':'||(a->>'bucket') ELSE 'july-restore:'||(a->>'key') END;
      IF EXISTS(SELECT 1 FROM public.ledger_transactions WHERE ledger_transactions.source_type=v_source_type AND ledger_transactions.source_key=v_source_key) THEN
        RAISE EXCEPTION 'JULY_EXISTING_SOURCE_REQUIRES_LINK';
      END IF;
      IF a->>'kind' IN('expense','income','meal','transfer') THEN
        from_id:=NULL;to_id:=NULL;
        FOR effect IN SELECT value FROM jsonb_array_elements(a->'effects') LOOP
          SELECT id INTO STRICT account_id FROM public.ledger_fund_accounts WHERE code=effect->>'account' AND is_active;
          IF (effect->>'amount')::numeric<0 THEN from_id:=account_id;ELSE to_id:=account_id;END IF;
        END LOOP;
        result:=public.ledger_create_manual_transaction_v1(CASE WHEN a->>'kind' IN('expense','meal') THEN 'expense' ELSE a->>'kind' END,
          (date_value+time '03:00') AT TIME ZONE 'Asia/Ho_Chi_Minh',CASE WHEN a->>'kind'='transfer' THEN NULL ELSE date '2026-07-01' END,
          amount_value,(a->>'categoryId')::bigint,(a->>'partyId')::bigint,from_id,to_id,a->>'evidence',a->>'evidence',actor,v_source_key);
        IF result->>'status' IS DISTINCT FROM 'created' THEN RAISE EXCEPTION 'JULY_RPC_FAILED: %',result->>'status'; END IF;
        tx_id:=(result->>'transactionId')::bigint;
      ELSIF a->>'kind' IN('pos','card_deposit') THEN
        -- POS sync RPC updates existing days; FIFO deposit RPC reallocates links.
        -- Use their INSERT contract only. No UPDATE, matching or fee recognition.
        IF a->>'kind'='pos' AND NOT EXISTS(SELECT 1 FROM public.ledger_categories WHERE id=(a->>'categoryId')::bigint AND kind='income' AND name='POS 매출' AND is_active) THEN RAISE EXCEPTION 'JULY_POS_CATEGORY'; END IF;
        INSERT INTO public.ledger_transactions(operation_id,type,status,business_date,occurred_at,recognition_month,amount,category_id,
          source_type,source_key,source_snapshot,source_fingerprint,source_synced_at,memo,created_by,confirmed_by)
        VALUES(md5('july-restore:'||(a->>'key'))::uuid,CASE WHEN a->>'kind'='pos' THEN 'sales' ELSE 'card_settlement_deposit' END,'confirmed',date_value,
          (date_value+time '03:00') AT TIME ZONE 'Asia/Ho_Chi_Minh',CASE WHEN a->>'kind'='pos' THEN date '2026-07-01' END,amount_value,
          CASE WHEN a->>'kind'='pos' THEN (a->>'categoryId')::bigint END,v_source_type,v_source_key,a,payload_hash,now(),a->>'evidence',actor,actor) RETURNING id INTO tx_id;
        FOR effect IN SELECT value FROM jsonb_array_elements(a->'effects') LOOP
          SELECT id INTO STRICT account_id FROM public.ledger_fund_accounts WHERE code=effect->>'account' AND is_active;
          INSERT INTO public.ledger_movements(transaction_id,fund_account_id,amount) VALUES(tx_id,account_id,(effect->>'amount')::numeric);
        END LOOP;
        IF a->>'kind'='card_deposit' THEN
          SELECT id INTO STRICT account_id FROM public.ledger_fund_accounts WHERE code='baba_corporate_bank';
          INSERT INTO public.ledger_card_reconciliations(deposit_transaction_id,deposit_date,destination_fund_account_id,deposit_amount,memo)
            VALUES(tx_id,date_value,account_id,amount_value,a->>'evidence');
        END IF;
      ELSE RAISE EXCEPTION 'JULY_UNSUPPORTED_ACTION'; END IF;
      created_count:=created_count+1;
    END IF;
    SELECT * INTO STRICT tx FROM public.ledger_transactions WHERE id=tx_id;
    IF tx.status<>'confirmed' OR tx.business_date<>date_value OR tx.amount<>amount_value THEN RAISE EXCEPTION 'JULY_TRANSACTION_MISMATCH'; END IF;
    IF a->>'kind'='link' THEN
      IF to_jsonb(tx) IS DISTINCT FROM a->'transactionSnapshot' THEN RAISE EXCEPTION 'JULY_LINK_SOURCE_DRIFT'; END IF;
    ELSE
      IF tx.type IS DISTINCT FROM (CASE WHEN a->>'kind' IN('expense','meal','inventory') THEN 'expense' WHEN a->>'kind'='pos' THEN 'sales' WHEN a->>'kind'='card_deposit' THEN 'card_settlement_deposit' ELSE a->>'kind' END) THEN RAISE EXCEPTION 'JULY_ECONOMIC_TYPE_MISMATCH'; END IF;
      IF a->>'kind' IN('expense','income','meal','inventory','pos') AND (tx.recognition_month IS DISTINCT FROM date '2026-07-01' OR tx.category_id IS DISTINCT FROM (a->>'categoryId')::bigint) THEN RAISE EXCEPTION 'JULY_RECOGNITION_MISMATCH'; END IF;
      IF a->>'kind' NOT IN('expense','income','meal','inventory','pos') AND (tx.recognition_month IS NOT NULL OR tx.category_id IS NOT NULL) THEN RAISE EXCEPTION 'JULY_DUPLICATE_PROFIT'; END IF;
    END IF;
    IF a->>'kind'='inventory' AND NOT EXISTS(SELECT 1 FROM public.ledger_candidates c WHERE c.id=(a->>'candidateId')::bigint
      AND c.status='confirmed' AND c.resolved_transaction_id=tx_id
      AND (to_jsonb(c)-ARRAY['status','resolved_transaction_id','resolved_by','resolved_at','updated_at'])
        =((a->'candidateSnapshot')-ARRAY['status','resolved_transaction_id','resolved_by','resolved_at','updated_at'])) THEN RAISE EXCEPTION 'JULY_INVENTORY_LINK_MISMATCH'; END IF;
    SELECT coalesce(jsonb_object_agg(f.code,m.amount),'{}') INTO actual_effects FROM public.ledger_movements m JOIN public.ledger_fund_accounts f ON f.id=m.fund_account_id WHERE m.transaction_id=tx_id;
    SELECT coalesce(jsonb_object_agg(e->>'account',(e->>'amount')::numeric),'{}') INTO expected_effects FROM jsonb_array_elements(a->'effects') e;
    IF actual_effects IS DISTINCT FROM expected_effects THEN RAISE EXCEPTION 'JULY_MOVEMENT_MISMATCH'; END IF;
    IF NOT applied THEN
      FOR row_data IN SELECT value FROM jsonb_array_elements(a->'rows') LOOP
        INSERT INTO public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,after_snapshot,reason)
        VALUES(actor,'july_restore_row','transaction',tx_id,jsonb_build_object('actionHash',payload_hash,'sourceRow',row_data,'economicKey',a->>'economicKey'),row_data->>'key');
      END LOOP;
    END IF;
  END LOOP;
  IF safe49 THEN
    IF created_count+unchanged_count<>49 OR linked_count<>0
      OR (SELECT count(*) FROM public.ledger_audit_logs l WHERE l.action='july_restore_row' AND l.reason IN(
        SELECT r->>'key' FROM jsonb_array_elements(manifest->'actions') act,jsonb_array_elements(act->'rows') r))<>49 THEN RAISE EXCEPTION 'JULY_BATCH_49_POSTFLIGHT'; END IF;
    SELECT jsonb_object_agg(code,balance) INTO after_batch_funds FROM (
      SELECT f.code,coalesce(sum(m.amount) FILTER(WHERE t.status='confirmed'),0) balance
      FROM public.ledger_fund_accounts f LEFT JOIN public.ledger_movements m ON m.fund_account_id=f.id LEFT JOIN public.ledger_transactions t ON t.id=m.transaction_id
      WHERE f.code IN('store_cash','vuong_personal_custody','cho_personal_custody','baba_corporate_bank') GROUP BY f.code) x;
    IF EXISTS(SELECT 1 FROM jsonb_each_text(remaining_delta) d WHERE (after_batch_funds->>d.key)::numeric-(before_batch_funds->>d.key)::numeric<>d.value::numeric) THEN RAISE EXCEPTION 'JULY_BATCH_FUND_DELTA_MISMATCH'; END IF;
  END IF;
  IF pg_temp.july_protected() IS DISTINCT FROM before_state THEN RAISE EXCEPTION 'JULY_PROTECTED_STATE_CHANGED'; END IF;
  SELECT jsonb_object_agg(code,balance) INTO after_cash FROM (
    SELECT f.code,coalesce(sum(m.amount) FILTER(WHERE t.status='confirmed' AND t.business_date>='2026-08-01'),0) balance
    FROM public.ledger_fund_accounts f LEFT JOIN public.ledger_movements m ON m.fund_account_id=f.id LEFT JOIN public.ledger_transactions t ON t.id=m.transaction_id
    WHERE f.code IN('store_cash','vuong_personal_custody','cho_personal_custody','baba_corporate_bank') GROUP BY f.code) x;
  IF after_cash IS DISTINCT FROM before_cash THEN RAISE EXCEPTION 'JULY_LIVE_FUNDS_CHANGED'; END IF;
  SELECT coalesce(sum(m.amount),0) INTO after_card FROM public.ledger_movements m
    JOIN public.ledger_transactions t ON t.id=m.transaction_id JOIN public.ledger_fund_accounts f ON f.id=m.fund_account_id
    WHERE f.code='card_clearing' AND t.status='confirmed';
  IF after_card IS DISTINCT FROM before_card THEN RAISE EXCEPTION 'JULY_CURRENT_CARD_CLEARING_CHANGED: resolve historical carryover without a balancing plug'; END IF;
  -- Full 31*4 targets only when no held/risk rows remain. Partial batches still
  -- verify each created/linked movement above without manufacturing balancing rows.
  IF (manifest->>'fullRestoreReady')::boolean THEN
    FOR expected_record IN SELECT value FROM jsonb_array_elements(manifest->'daily') LOOP
      SELECT coalesce(sum(m.amount),0) INTO amount_value FROM public.ledger_movements m
      JOIN public.ledger_transactions t ON t.id=m.transaction_id JOIN public.ledger_fund_accounts f ON f.id=m.fund_account_id
      WHERE t.status='confirmed' AND t.business_date BETWEEN date '2026-07-01' AND (expected_record->>'date')::date AND f.code=expected_record->>'account';
      IF amount_value<>(expected_record->>'target')::numeric THEN RAISE EXCEPTION 'JULY_DAILY_CLOSING_MISMATCH'; END IF;
    END LOOP;
  END IF;
  RAISE NOTICE 'JULY_BATCH created %, linked %, unchanged %, fullRestoreReady %',created_count,linked_count,unchanged_count,manifest->>'fullRestoreReady';
END $restore$;
COMMIT;
