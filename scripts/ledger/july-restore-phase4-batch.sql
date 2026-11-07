-- REVIEW ONLY: no automatic runner. Replace BOTH approval placeholders only after owner approval.
-- Historical July cash recording; no inventory/POS write, source scan or capital adjustment.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='90s';
SET LOCAL standard_conforming_strings=on;
SET LOCAL baba.july_phase4_actor='__ACTOR_USER_ID__';
SET LOCAL baba.july_phase4_approval='__OWNER_APPROVAL__';
CREATE TEMP TABLE july_phase4_input(canonical text NOT NULL,payload jsonb NOT NULL) ON COMMIT DROP;
INSERT INTO july_phase4_input VALUES(__PAYLOAD_LITERAL__,__PAYLOAD_LITERAL__::jsonb);
DO $gate$
DECLARE p jsonb;c text;r jsonb;actor bigint;actual bigint[];
BEGIN
 SELECT canonical,payload INTO STRICT c,p FROM july_phase4_input;
 IF current_setting('baba.july_phase4_approval') IS DISTINCT FROM 'APPROVED:__PAYLOAD_DIGEST__'
  OR encode(sha256(convert_to(c,'UTF8')),'hex')<>'__PAYLOAD_DIGEST__' OR c::jsonb IS DISTINCT FROM p
  OR encode(sha256(convert_to(p->>'bundleCanonical','UTF8')),'hex') IS DISTINCT FROM p->>'bundleDigest'
  OR (p->>'bundleCanonical')::jsonb IS DISTINCT FROM p->'bundle' THEN RAISE EXCEPTION 'JULY_PHASE4_APPROVAL'; END IF;
 actor:=current_setting('baba.july_phase4_actor')::bigint;
 IF NOT EXISTS(SELECT 1 FROM public.users WHERE id=actor AND is_active AND app_login_enabled AND lower(role::text) IN('owner','master')) THEN RAISE EXCEPTION 'JULY_PHASE4_OWNER'; END IF;
 SELECT array_agg((a->>'row')::bigint ORDER BY (a->>'row')::bigint) INTO actual FROM jsonb_array_elements(p->'bundle'->'actions') a;
 IF actual IS DISTINCT FROM ARRAY[26,33,75,78,181,207,252,289,299]::bigint[]
  OR (SELECT count(DISTINCT a->>'key') FROM jsonb_array_elements(p->'bundle'->'actions') a)<>9
  OR (SELECT count(DISTINCT a->>'sourceKey') FROM jsonb_array_elements(p->'bundle'->'actions') a)<>9
  OR (SELECT sum((a->>'amount')::numeric) FROM jsonb_array_elements(p->'bundle'->'actions') a)<>324100000
  OR jsonb_array_length(p->'bundle'->'completedRows')<>145
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'bundle'->'actions') a WHERE
   (a->>'actionCanonical')::jsonb IS DISTINCT FROM a-'actionCanonical'-'actionHash'
   OR encode(sha256(convert_to(a->>'actionCanonical','UTF8')),'hex') IS DISTINCT FROM a->>'actionHash'
   OR a->>'key' IS DISTINCT FROM 'sheet:1BRT2ul07GftjqVPwcIf35o3LDJ6RjPIdWL_YeiRqDx4:tab:829182003:row:'||(a->>'row')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p->'bundle'->'completedRows') done WHERE done.value=a->>'row')
   OR a->>'date' NOT BETWEEN '2026-07-01' AND '2026-07-31'
   OR a->>'kind' NOT IN('transfer','expense','rent_preledger_conversion','payroll_advance')
   OR (a->>'amount')::numeric<=0 OR (a->>'amount')::numeric<>trunc((a->>'amount')::numeric)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(a->'effects') e WHERE e->>'account' NOT IN('store_cash','vuong_personal_custody','cho_personal_custody','baba_corporate_bank')))
 THEN RAISE EXCEPTION 'JULY_PHASE4_SCOPE'; END IF;
 FOR r IN SELECT value FROM jsonb_each(p->'bundle'->'rpcContracts') LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(r->>'signature') AND encode(sha256(convert_to(replace(prosrc,E'\r\n',E'\n'),'UTF8')),'hex')=r->>'hash') THEN RAISE EXCEPTION 'JULY_PHASE4_RPC_CONTRACT: %',r->>'signature'; END IF;
 END LOOP;
END $gate$;

-- July month lock BEFORE ledger write locks, matching the native manual/advance RPCs.
SELECT pg_advisory_xact_lock(hashtext('baba:ledger:july-restore-v1'));
DO $advance_locks$
DECLARE request_key text;
BEGIN
 FOR request_key IN SELECT 'ledger-payroll-advance:'||(elem->>'requestId') FROM july_phase4_input i,jsonb_array_elements(i.payload->'bundle'->'actions') elem WHERE elem->>'kind'='payroll_advance' ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(request_key,0));
 END LOOP;
END $advance_locks$;
SELECT pg_advisory_xact_lock(hashtext('ledger_month_close:2026-07'));
SELECT public.ledger_assert_month_open_v1(date '2026-07-01');
LOCK TABLE public.ledger_transactions,public.ledger_movements,public.ledger_audit_logs,public.payroll_monthly_adjustments,public.ledger_rent_contract_payments IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.payroll_payment_batches,public.ledger_month_closures IN SHARE MODE;
SELECT id FROM public.ledger_fund_accounts ORDER BY id FOR SHARE;
SELECT id FROM public.users WHERE id IN(4,10) ORDER BY id FOR SHARE;
SELECT id FROM public.ledger_categories WHERE id=70 FOR SHARE;
SELECT id FROM public.ledger_rent_contracts WHERE id=1 FOR UPDATE;
CREATE TEMP TABLE july_phase4_original_ids(name text PRIMARY KEY,ids bigint[]) ON COMMIT DROP;
DO $ids$
DECLARE n text;
BEGIN
 FOREACH n IN ARRAY ARRAY['ledger_transactions','ledger_movements','ledger_audit_logs','ledger_candidates','ledger_payables','ledger_payable_allocations','ledger_card_reconciliations','ledger_card_reconciliation_lines','ledger_card_fee_closures','ledger_card_fee_allocation_lines','ledger_fund_accounts','ledger_month_closures','ledger_month_closure_history','ledger_rent_contracts','ledger_rent_contract_payments','ledger_recurring_expense_plans','ledger_owner_participants','ledger_owner_investments','payroll_monthly_adjustments','payroll_payment_batches'] LOOP
  EXECUTE format('INSERT INTO july_phase4_original_ids SELECT %L,array_agg(id ORDER BY id) FROM public.%I',n,n);
 END LOOP;
END $ids$;
CREATE OR REPLACE FUNCTION pg_temp.july_phase4_protected() RETURNS jsonb LANGUAGE plpgsql AS $protect$
DECLARE r record;h text;result jsonb:='{}';projection text;
BEGIN
 FOR r IN SELECT * FROM july_phase4_original_ids ORDER BY name LOOP
  -- ONLY payment1 link metadata may change; every economic field stays protected.
  projection:=CASE WHEN r.name='ledger_rent_contract_payments' THEN 'CASE WHEN id=1 THEN to_jsonb(x)-''source''-''payment_transaction_id''-''updated_at'' ELSE to_jsonb(x) END' ELSE 'to_jsonb(x)' END;
  EXECUTE format('SELECT md5(coalesce(string_agg((%s)::text,''|'' ORDER BY id),'''')) FROM public.%I x WHERE id=ANY($1)',projection,r.name) INTO h USING r.ids;
  result:=result||jsonb_build_object(r.name,h);
  IF r.name NOT IN('ledger_transactions','ledger_movements','ledger_audit_logs','payroll_monthly_adjustments') THEN
   EXECUTE format('SELECT count(*)::text FROM public.%I',r.name) INTO h;result:=result||jsonb_build_object(r.name||':count',h);
  END IF;
 END LOOP;
 RETURN result;
END $protect$;
CREATE OR REPLACE FUNCTION pg_temp.july_phase4_funds(cutoff date) RETURNS jsonb LANGUAGE sql AS $funds$
 SELECT jsonb_object_agg(code,balance) FROM (
 SELECT f.code,coalesce(sum(m.amount) FILTER(WHERE t.status='confirmed' AND (cutoff IS NULL OR t.business_date>=cutoff)),0) balance
 FROM public.ledger_fund_accounts f LEFT JOIN public.ledger_movements m ON m.fund_account_id=f.id LEFT JOIN public.ledger_transactions t ON t.id=m.transaction_id
 WHERE f.code IN('store_cash','vuong_personal_custody','cho_personal_custody','baba_corporate_bank','card_clearing') GROUP BY f.code) x
$funds$;
DO $restore$
DECLARE p jsonb;a jsonb;e jsonb;r jsonb;result jsonb;actual jsonb;expected jsonb;protected jsonb;before_funds jsonb;before_live jsonb;after_funds jsonb;
 actor bigint:=current_setting('baba.july_phase4_actor')::bigint;tx public.ledger_transactions%rowtype;rent public.ledger_rent_contract_payments%rowtype;
 tx_id bigint;from_id bigint;to_id bigint;adjustment_id bigint;n integer;created integer:=0;new_moves integer:=0;new_advances integer:=0;applied boolean;replay_count integer;
 delta jsonb:='{"store_cash":0,"vuong_personal_custody":0,"cho_personal_custody":0,"baba_corporate_bank":0}';
BEGIN
 SELECT payload INTO STRICT p FROM july_phase4_input;
 protected:=pg_temp.july_phase4_protected();before_funds:=pg_temp.july_phase4_funds(NULL);before_live:=pg_temp.july_phase4_funds(date '2026-08-01');
 -- All-or-none existing audit set: partial foreign batches require review, never an implicit resume.
 SELECT count(*) INTO replay_count FROM public.ledger_audit_logs au WHERE au.action='july_restore_row' AND au.reason IN(SELECT element->>'key' FROM jsonb_array_elements(p->'bundle'->'actions') element);
 IF replay_count NOT IN(0,9) THEN RAISE EXCEPTION 'JULY_PHASE4_PARTIAL_AUDITS'; END IF;
 IF (SELECT count(*) FROM public.ledger_audit_logs WHERE action='july_restore_row')<>144+replay_count
  OR (SELECT count(*) FROM public.ledger_transactions WHERE status='confirmed' AND (id BETWEEN 4227 AND 4275 OR id BETWEEN 4292 AND 4324 OR id BETWEEN 4327 AND 4436))<>192
  OR NOT EXISTS(SELECT 1 FROM public.ledger_transactions WHERE id=1190 AND status='confirmed') THEN RAISE EXCEPTION 'JULY_PHASE4_BASELINE'; END IF;
 FOR expected IN SELECT value FROM jsonb_array_elements(p->'bundle'->'closures') LOOP
  IF NOT EXISTS(SELECT 1 FROM public.ledger_month_closures cl WHERE cl.id=(expected->>'id')::bigint AND cl.month=(expected->>'month')::date AND cl.status=expected->>'status' AND cl.revision=(expected->>'revision')::integer AND cl.snapshot_hash=expected->>'snapshot_hash') THEN RAISE EXCEPTION 'JULY_PHASE4_CLOSURE_DRIFT'; END IF;
 END LOOP;
 FOR expected IN SELECT value FROM jsonb_array_elements(p->'bundle'->'accounts') LOOP
  IF NOT EXISTS(SELECT 1 FROM public.ledger_fund_accounts f WHERE f.id=(expected->>'id')::bigint AND f.code=expected->>'code' AND f.type=expected->>'type' AND f.is_active=(expected->>'is_active')::boolean AND f.is_business_fund=(expected->>'is_business_fund')::boolean AND f.active_from=(expected->>'active_from')::date AND f.active_to IS NOT DISTINCT FROM (expected->>'active_to')::date) THEN RAISE EXCEPTION 'JULY_PHASE4_ACCOUNT_DRIFT'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.payroll_payment_batches WHERE payroll_month=date '2026-07-01') THEN RAISE EXCEPTION 'JULY_PHASE4_PAYROLL_ALREADY_PAID'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.ledger_categories c WHERE c.id=70 AND c.is_active AND c.kind='expense' AND c.name=p->'bundle'->'category'->>'name') THEN RAISE EXCEPTION 'JULY_PHASE4_CATEGORY_DRIFT'; END IF;
 -- No unrelated July adjustment may overlap the two source-sheet deductions.
 IF EXISTS(SELECT 1 FROM public.payroll_monthly_adjustments adj WHERE payroll_month=date '2026-07-01' AND NOT(replay_count=9 AND source_type='manual' AND source_key IN(SELECT 'ledger-payroll-advance:'||(element->>'requestId') FROM jsonb_array_elements(p->'bundle'->'actions') element WHERE element->>'kind'='payroll_advance'))) THEN RAISE EXCEPTION 'JULY_PHASE4_ADVANCE_OVERLAP'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.ledger_rent_contracts c WHERE c.id=1 AND to_jsonb(c)=to_jsonb(jsonb_populate_record(NULL::public.ledger_rent_contracts,p->'bundle'->'rentContract'))) THEN RAISE EXCEPTION 'JULY_PHASE4_RENT_CONTRACT_DRIFT'; END IF;
 FOR a IN SELECT value FROM jsonb_array_elements(p->'bundle'->'actions') LOOP
  adjustment_id:=NULL;from_id:=NULL;to_id:=NULL;
  SELECT count(*) INTO n FROM public.ledger_audit_logs WHERE action='july_restore_row' AND reason=a->>'key';
  IF n>1 THEN RAISE EXCEPTION 'JULY_PHASE4_DUPLICATE_ROW'; END IF;applied:=n=1;
  IF applied THEN
   SELECT entity_id INTO STRICT tx_id FROM public.ledger_audit_logs WHERE action='july_restore_row' AND reason=a->>'key' AND after_snapshot->>'actionHash'=a->>'actionHash' AND after_snapshot->>'bundleDigest'=p->>'bundleDigest';
  ELSE
   IF EXISTS(SELECT 1 FROM public.ledger_transactions WHERE source_key=a->>'sourceKey') THEN RAISE EXCEPTION 'JULY_PHASE4_SOURCE_COLLISION'; END IF;
   IF EXISTS(SELECT 1 FROM public.ledger_transactions old_t JOIN public.ledger_movements old_m ON old_m.transaction_id=old_t.id JOIN public.ledger_fund_accounts old_f ON old_f.id=old_m.fund_account_id WHERE old_t.status='confirmed' AND old_t.business_date=(a->>'date')::date AND old_t.amount=(a->>'amount')::numeric AND EXISTS(SELECT 1 FROM jsonb_array_elements(a->'effects') eff WHERE eff->>'account'=old_f.code AND (eff->>'amount')::numeric=old_m.amount) AND NOT EXISTS(SELECT 1 FROM public.ledger_audit_logs au WHERE au.action='july_restore_row' AND au.entity_id=old_t.id)) THEN RAISE EXCEPTION 'JULY_PHASE4_UNLINKED_PAYMENT'; END IF;
  END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(a->'effects') LOOP
   IF (e->>'amount')::numeric<0 THEN SELECT id INTO STRICT from_id FROM public.ledger_fund_accounts WHERE code=e->>'account' AND is_active AND is_business_fund AND type<>'card_clearing';
   ELSE SELECT id INTO STRICT to_id FROM public.ledger_fund_accounts WHERE code=e->>'account' AND is_active AND is_business_fund AND type<>'card_clearing';END IF;
  END LOOP;
  IF a->>'kind'='payroll_advance' THEN
   SELECT value INTO STRICT expected FROM jsonb_array_elements(p->'bundle'->'employees') u WHERE (u->>'id')::bigint=(a->>'userId')::bigint;
   IF NOT EXISTS(SELECT 1 FROM public.users u WHERE u.id=(a->>'userId')::bigint AND u.is_active AND NOT u.is_system_account AND coalesce(u.payroll_eligible_override,lower(u.role::text) NOT IN('owner','master')) AND u.username=expected->>'username') THEN RAISE EXCEPTION 'JULY_PHASE4_EMPLOYEE_DRIFT'; END IF;
   IF NOT applied THEN
    result:=public.ledger_create_payroll_advance_payment_v1(a->>'requestId',(a->>'userId')::bigint,(a->>'amount')::numeric,((a->>'date')::date+time '12:00') AT TIME ZONE 'Asia/Ho_Chi_Minh',from_id,a->>'key',actor);
    IF result->>'status' IS DISTINCT FROM 'created' THEN RAISE EXCEPTION 'JULY_PHASE4_ADVANCE_RPC: %',result->>'status'; END IF;tx_id:=(result->>'transactionId')::bigint;new_advances:=new_advances+1;
   END IF;
   SELECT id INTO STRICT adjustment_id FROM public.payroll_monthly_adjustments WHERE source_type='manual' AND source_key='ledger-payroll-advance:'||(a->>'requestId') AND user_id=(a->>'userId')::bigint AND kind='advance' AND category='advance' AND amount=(a->>'amount')::numeric AND payroll_month=date '2026-07-01' AND business_date=(a->>'date')::date AND cancelled_at IS NULL;
  ELSIF a->>'kind' IN('expense','transfer') AND NOT applied THEN
   result:=public.ledger_create_manual_transaction_v1(a->>'kind',((a->>'date')::date+time '12:00') AT TIME ZONE 'Asia/Ho_Chi_Minh',CASE WHEN a->>'kind'='expense' THEN date '2026-07-01' END,(a->>'amount')::numeric,(a->>'categoryId')::bigint,NULL,from_id,to_id,'July source row '||(a->>'row'),a->>'key',actor,a->>'sourceKey');
   IF result->>'status' IS DISTINCT FROM 'created' THEN RAISE EXCEPTION 'JULY_PHASE4_MANUAL_RPC: %',result->>'status'; END IF;tx_id:=(result->>'transactionId')::bigint;
  ELSIF a->>'kind'='rent_preledger_conversion' THEN
   SELECT * INTO STRICT rent FROM public.ledger_rent_contract_payments WHERE id=1;
   IF to_jsonb(rent)-'source'-'payment_transaction_id'-'updated_at' IS DISTINCT FROM to_jsonb(jsonb_populate_record(NULL::public.ledger_rent_contract_payments,p->'bundle'->'rentPayment'))-'source'-'payment_transaction_id'-'updated_at' THEN RAISE EXCEPTION 'JULY_PHASE4_RENT_PAYMENT_DRIFT'; END IF;
   IF NOT applied THEN
    IF rent.source<>'pre_ledger' OR rent.payment_transaction_id IS NOT NULL THEN RAISE EXCEPTION 'JULY_PHASE4_RENT_ALREADY_LINKED'; END IF;
    -- Existing legacy import contract: actual historical payment, NEVER monthly expense.
    INSERT INTO public.ledger_transactions(operation_id,type,occurred_at,business_date,amount,status,source_type,source_key,source_snapshot,source_fingerprint,source_synced_at,memo,created_by,confirmed_by)
    VALUES(gen_random_uuid(),'prepaid_expense_payment',((a->>'date')::date+time '12:00') AT TIME ZONE 'Asia/Ho_Chi_Minh',(a->>'date')::date,(a->>'amount')::numeric,'confirmed','legacy_sheet_detail',a->>'sourceKey',jsonb_build_object('sourceRowKey',a->>'key','accountingTreatment','cash_outflow_only_no_monthly_expense','rentContractId',1,'replacesPreLedgerPaymentId',1),a->>'actionHash',now(),'Historical July rent, convert existing pre-ledger payment',actor,actor) RETURNING id INTO tx_id;
    INSERT INTO public.ledger_movements(transaction_id,fund_account_id,amount) VALUES(tx_id,from_id,-(a->>'amount')::numeric);
    result:=public.ledger_link_rent_payment_v1(1,tx_id,1,a->>'key',actor);
    IF result->>'status' IS DISTINCT FROM 'converted' THEN RAISE EXCEPTION 'JULY_PHASE4_RENT_RPC: %',result->>'status'; END IF;
   END IF;
   IF NOT EXISTS(SELECT 1 FROM public.ledger_rent_contract_payments WHERE id=1 AND source='ledger' AND payment_transaction_id=tx_id AND amount=300000000 AND paid_on=date '2026-07-03' AND fund_account_id=2 AND pre_ledger_reference='sheet:2026-07:row:33') THEN RAISE EXCEPTION 'JULY_PHASE4_RENT_LINK'; END IF;
  END IF;
  SELECT * INTO STRICT tx FROM public.ledger_transactions WHERE id=tx_id;
  IF tx.status<>'confirmed' OR tx.business_date<>(a->>'date')::date OR tx.amount<>(a->>'amount')::numeric OR tx.source_key IS DISTINCT FROM a->>'sourceKey' OR tx.economic_effect_sign<>1 OR tx.correction_of_id IS NOT NULL
   OR tx.type IS DISTINCT FROM (CASE a->>'kind' WHEN 'rent_preledger_conversion' THEN 'prepaid_expense_payment' WHEN 'payroll_advance' THEN 'payroll_payment' ELSE a->>'kind' END)
   OR tx.source_type IS DISTINCT FROM (CASE WHEN a->>'kind'='rent_preledger_conversion' THEN 'legacy_sheet_detail' ELSE 'manual' END)
   OR tx.recognition_month IS DISTINCT FROM (CASE WHEN a->>'kind'='expense' THEN date '2026-07-01' END) OR tx.category_id IS DISTINCT FROM (a->>'categoryId')::bigint OR tx.party_id IS NOT NULL THEN RAISE EXCEPTION 'JULY_PHASE4_TX_CONTRACT'; END IF;
  IF a->>'kind'='payroll_advance' AND (tx.source_snapshot->>'paymentKind' IS DISTINCT FROM 'advance' OR (tx.source_snapshot->>'payrollAdjustmentId')::bigint IS DISTINCT FROM adjustment_id OR tx.source_snapshot->>'requestId' IS DISTINCT FROM a->>'requestId' OR (tx.source_snapshot->>'userId')::bigint IS DISTINCT FROM (a->>'userId')::bigint) THEN RAISE EXCEPTION 'JULY_PHASE4_ADVANCE_LINK'; END IF;
  SELECT jsonb_object_agg(f.code,m.amount) INTO actual FROM public.ledger_movements m JOIN public.ledger_fund_accounts f ON f.id=m.fund_account_id WHERE m.transaction_id=tx_id;
  SELECT jsonb_object_agg(eff->>'account',(eff->>'amount')::numeric) INTO expected FROM jsonb_array_elements(a->'effects') eff;
  IF actual IS DISTINCT FROM expected OR (SELECT count(*) FROM public.ledger_movements WHERE transaction_id=tx_id)<>jsonb_array_length(a->'effects') THEN RAISE EXCEPTION 'JULY_PHASE4_ROW_MOVEMENTS'; END IF;
  IF NOT applied THEN
   created:=created+1;new_moves:=new_moves+jsonb_array_length(a->'effects');
   INSERT INTO public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,after_snapshot,reason) VALUES(actor,'july_restore_row','transaction',tx_id,jsonb_build_object('actionHash',a->>'actionHash','bundleDigest',p->>'bundleDigest','sourceRow',a->>'row','transactionIds',jsonb_build_array(tx_id),'workflow',a->>'kind'),a->>'key');
   FOR e IN SELECT value FROM jsonb_array_elements(a->'effects') LOOP delta:=jsonb_set(delta,ARRAY[e->>'account'],to_jsonb((delta->>(e->>'account'))::numeric+(e->>'amount')::numeric));END LOOP;
  END IF;
 END LOOP;
 IF replay_count=0 AND delta IS DISTINCT FROM p->'bundle'->'fundDelta' THEN RAISE EXCEPTION 'JULY_PHASE4_BATCH_DELTA'; END IF;
 IF created<>9-replay_count OR new_moves<>(CASE WHEN replay_count=0 THEN 14 ELSE 0 END) OR new_advances<>(CASE WHEN replay_count=0 THEN 2 ELSE 0 END) THEN RAISE EXCEPTION 'JULY_PHASE4_BATCH_COUNT'; END IF;
 IF (SELECT count(*) FROM public.ledger_transactions WHERE NOT(id=ANY(coalesce((SELECT ids FROM july_phase4_original_ids WHERE name='ledger_transactions'),'{}'::bigint[]))))<>created
  OR (SELECT count(*) FROM public.ledger_movements WHERE NOT(id=ANY(coalesce((SELECT ids FROM july_phase4_original_ids WHERE name='ledger_movements'),'{}'::bigint[]))))<>new_moves
  OR (SELECT count(*) FROM public.payroll_monthly_adjustments WHERE NOT(id=ANY(coalesce((SELECT ids FROM july_phase4_original_ids WHERE name='payroll_monthly_adjustments'),'{}'::bigint[]))))<>new_advances THEN RAISE EXCEPTION 'JULY_PHASE4_UNEXPECTED_INSERT'; END IF;
 after_funds:=pg_temp.july_phase4_funds(NULL);
 IF EXISTS(SELECT 1 FROM jsonb_each_text(delta) d WHERE (after_funds->>d.key)::numeric-(before_funds->>d.key)::numeric<>d.value::numeric)
  OR after_funds->'card_clearing' IS DISTINCT FROM before_funds->'card_clearing' OR pg_temp.july_phase4_funds(date '2026-08-01') IS DISTINCT FROM before_live THEN RAISE EXCEPTION 'JULY_PHASE4_BOUNDARY'; END IF;
 IF pg_temp.july_phase4_protected() IS DISTINCT FROM protected THEN RAISE EXCEPTION 'JULY_PHASE4_PROTECTED_CHANGED'; END IF;
END $restore$;
COMMIT;
