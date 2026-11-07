-- ONE-OFF OPERATIONAL SEED. Not a migration. NOT executed by Claude.
-- 2026-07-01 (03:00 Asia/Ho_Chi_Minh) opening balances for the four business
-- fund accounts, from (2026)BABA - Sổ dự án: June month-end holdings = July opening.
--
--   fund_account_id 1  store_cash               202,299,186
--   fund_account_id 5  vuong_personal_custody    16,123,010
--   fund_account_id 3  cho_personal_custody         850,041
--   fund_account_id 2  baba_corporate_bank       381,587,580
--                                         total 600,859,817
--
-- Operator, before running (only after the owner's separate written approval):
--   1. Replace __ACTOR_USER_ID__ with your active owner/master users.id.
--   2. Replace __OWNER_APPROVAL__ with APPROVED:july-opening-4funds-20261106.
--   3. Run the read-only preflight (july-opening-4funds-20261106-preflight-READONLY.sql)
--      and keep its output as evidence; run it again after this file.
--   4. Run this WHOLE file in one privileged SQL session; never run fragments.
--
-- Behaviour:
--   * One transaction: 4 opening transactions + 4 movements (+amount on that account
--     only) + 4 audit logs, verified inside the transaction, then COMMIT.
--   * Fixed keys (source_type='opening_balance_seed'):
--     2026-07-01:store_cash / :vuong_personal_custody / :cho_personal_custody / :baba_corporate_bank
--   * Re-run with all four already present and identical: verified, no change.
--   * One to three present, any field/movement/audit different, another 2026-07-01
--     opening, or an orphan audit: RAISE, nothing written (no ON CONFLICT, no repair).
--   * card_clearing is never touched. 8/1 openings #3~#6, #1190, #3804, every
--     movement dated 2026-08-01 or later and all month closures are compared
--     before/after; any difference rolls the whole transaction back.
--   * July must be open (ledger_assert_month_open_v1) on every run, fresh or re-run;
--     a closed July stops even an identical re-run. The month guards also enforce it.
--   * 8/1 openings #3~#6 are verified one by one (account, amount, keys, exactly one
--     positive movement on that account) before anything is written; never repaired.
--   * This seed alone does NOT make July close at 300,353,642; that target needs the
--     July transactions restored separately.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL baba.audit_actor_user_id = '__ACTOR_USER_ID__';
SET LOCAL baba.july_opening_approval = '__OWNER_APPROVAL__';

DO $july_opening$
DECLARE
  c_seeds constant jsonb := '[
    {"fund_account_id":1,"code":"store_cash","type":"cash","amount":202299186},
    {"fund_account_id":5,"code":"vuong_personal_custody","type":"personal_custody","amount":16123010},
    {"fund_account_id":3,"code":"cho_personal_custody","type":"personal_custody","amount":850041},
    {"fund_account_id":2,"code":"baba_corporate_bank","type":"bank","amount":381587580}
  ]';
  c_total constant numeric := 600859817;
  c_august_total constant numeric := 300353642;
  c_august constant jsonb := '[
    {"id":3,"fund_account_id":1,"code":"store_cash","amount":95464986},
    {"id":4,"fund_account_id":5,"code":"vuong_personal_custody","amount":5231310},
    {"id":5,"fund_account_id":3,"code":"cho_personal_custody","amount":95470741},
    {"id":6,"fund_account_id":2,"code":"baba_corporate_bank","amount":104186605}
  ]';
  c_source_type constant text := 'opening_balance_seed';
  c_business_date constant date := date '2026-07-01';
  c_occurred_at constant timestamptz := timestamptz '2026-07-01 03:00:00+07';
  c_memo constant text := '2026년 7월 당월 시재 초기값';
  c_action constant text := 'opening_balance_seeded';
  c_reason constant text := '2026년 7월 기초시재 1회성 등록: (2026)BABA - Sổ dự án 6월 말 보유금 = 7월 초 당월시재 (합계 600,859,817₫)';
  c_approval constant text := 'APPROVED:july-opening-4funds-20261106';
  c_script constant text := 'scripts/ledger/july-opening-4funds-20261106-ONE-OFF.sql';
  v_actor_text text := current_setting('baba.audit_actor_user_id', true);
  v_approval text := current_setting('baba.july_opening_approval', true);
  v_actor bigint;
  v_seed record;
  v_aug record;
  v_snapshot jsonb;
  v_key text;
  v_existing integer;
  v_count integer;
  v_sum numeric;
  v_protected_before jsonb;
  v_protected_after jsonb;
  v_tx public.ledger_transactions%ROWTYPE;
  v_movement public.ledger_movements%ROWTYPE;
  v_audit public.ledger_audit_logs%ROWTYPE;
BEGIN
  -- 0. Operator and owner approval.
  IF v_actor_text IS NULL OR v_actor_text !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'JULY_OPENING_ACTOR_REQUIRED: set __ACTOR_USER_ID__ to the operator users.id';
  END IF;
  v_actor := v_actor_text::bigint;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=v_actor AND is_active
                 AND app_login_enabled AND lower(role::text) IN ('owner','master')) THEN
    RAISE EXCEPTION 'JULY_OPENING_ACTOR_FORBIDDEN: active owner/master users.id required';
  END IF;
  IF v_approval IS DISTINCT FROM c_approval THEN
    RAISE EXCEPTION 'JULY_OPENING_APPROVAL_REQUIRED: set __OWNER_APPROVAL__ to %', c_approval;
  END IF;

  -- 1. Serialize concurrent runs; lock the rows this seed depends on.
  PERFORM pg_advisory_xact_lock(hashtext('baba:ledger:july-opening-4funds-20261106'));
  PERFORM 1 FROM public.ledger_fund_accounts WHERE id IN (1,2,3,4,5) FOR SHARE;
  PERFORM 1 FROM public.ledger_transactions WHERE id IN (3,4,5,6,1190,3804) FOR SHARE;
  PERFORM 1 FROM public.ledger_transactions
   WHERE (source_type=c_source_type AND source_key LIKE '2026-07-01:%')
      OR (type='opening' AND business_date=c_business_date)
   FOR SHARE;

  -- 1b. July must be open on every run (fresh and re-run alike).
  PERFORM public.ledger_assert_month_open_v1(c_business_date);

  -- 2. Fund accounts are the four business accounts; card_clearing is not a seed.
  FOR v_seed IN SELECT * FROM jsonb_to_recordset(c_seeds) AS s(fund_account_id bigint, code text, type text, amount numeric) LOOP
    IF NOT EXISTS (SELECT 1 FROM public.ledger_fund_accounts WHERE id=v_seed.fund_account_id AND code=v_seed.code
                   AND type=v_seed.type AND is_active AND is_business_fund) OR v_seed.type='card_clearing' THEN
      RAISE EXCEPTION 'JULY_OPENING_FUND_ACCOUNT_MISMATCH: %', v_seed.code;
    END IF;
  END LOOP;

  -- 3. August opening baseline #3~#6 must be the known seed (300,353,642),
  --    checked transaction by transaction and movement by movement. Never repaired.
  FOR v_aug IN SELECT * FROM jsonb_to_recordset(c_august) AS a(id bigint, fund_account_id bigint, code text, amount numeric) LOOP
    IF NOT EXISTS (SELECT 1 FROM public.ledger_transactions t
                    WHERE t.id=v_aug.id AND t.type='opening' AND t.status='confirmed'
                      AND t.business_date=date '2026-08-01' AND t.source_type=c_source_type
                      AND t.source_key='2026-08-01:'||v_aug.code AND t.amount=v_aug.amount) THEN
      RAISE EXCEPTION 'JULY_OPENING_AUGUST_BASELINE_MISMATCH: transaction #% (%)', v_aug.id, v_aug.code;
    END IF;
    SELECT count(*) INTO v_count FROM public.ledger_movements m WHERE m.transaction_id=v_aug.id;
    IF v_count<>1 OR NOT EXISTS (SELECT 1 FROM public.ledger_movements m
                                  WHERE m.transaction_id=v_aug.id AND m.fund_account_id=v_aug.fund_account_id
                                    AND m.amount=v_aug.amount AND m.amount>0) THEN
      RAISE EXCEPTION 'JULY_OPENING_AUGUST_MOVEMENT_MISMATCH: transaction #% (%): % movements', v_aug.id, v_aug.code, v_count;
    END IF;
  END LOOP;
  SELECT count(*), coalesce(sum(t.amount),0) INTO v_count, v_sum FROM public.ledger_transactions t
   WHERE t.id IN (3,4,5,6) AND t.type='opening' AND t.status='confirmed' AND t.business_date=date '2026-08-01'
     AND t.source_type=c_source_type AND t.source_key LIKE '2026-08-01:%';
  IF v_count<>4 OR v_sum<>c_august_total THEN
    RAISE EXCEPTION 'JULY_OPENING_AUGUST_BASELINE_MISMATCH: count %, total %', v_count, v_sum;
  END IF;

  -- 4. Protected state captured before any write.
  SELECT jsonb_build_object(
    'transactions', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.ledger_transactions t WHERE t.id IN (3,4,5,6,1190,3804)),
    'movements', (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM public.ledger_movements m WHERE m.transaction_id IN (3,4,5,6,1190,3804)),
    'fromAugust', (SELECT jsonb_agg(jsonb_build_object('fund',x.fund_account_id,'count',x.n,'sum',x.s) ORDER BY x.fund_account_id)
                     FROM (SELECT m.fund_account_id, count(*) n, sum(m.amount) s FROM public.ledger_movements m
                             JOIN public.ledger_transactions t ON t.id=m.transaction_id
                            WHERE t.business_date>=date '2026-08-01' GROUP BY m.fund_account_id) x),
    'cardClearing', (SELECT jsonb_build_object('count',count(*),'sum',coalesce(sum(m.amount),0)) FROM public.ledger_movements m WHERE m.fund_account_id=4),
    'closures', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.month) FROM public.ledger_month_closures c),
    'fundAccounts', (SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id) FROM public.ledger_fund_accounts f)
  ) INTO v_protected_before;

  -- 5. Classify: all four, none, or stop.
  SELECT count(*) INTO v_existing FROM public.ledger_transactions
   WHERE source_type=c_source_type
     AND source_key IN ('2026-07-01:store_cash','2026-07-01:vuong_personal_custody','2026-07-01:cho_personal_custody','2026-07-01:baba_corporate_bank');
  IF v_existing NOT IN (0,4) THEN
    RAISE EXCEPTION 'JULY_OPENING_PARTIAL: % of 4 seed transactions exist; no repair attempted', v_existing;
  END IF;
  SELECT count(*) INTO v_count FROM public.ledger_transactions
   WHERE (type='opening' AND business_date=c_business_date) OR source_key LIKE '2026-07-01:%';
  IF v_count<>v_existing THEN
    RAISE EXCEPTION 'JULY_OPENING_CONFLICT: another 2026-07-01 opening or key exists (% rows vs % seeds)', v_count, v_existing;
  END IF;
  SELECT count(*) INTO v_count FROM public.ledger_audit_logs WHERE action=c_action AND reason=c_reason;
  IF v_count<>v_existing THEN
    RAISE EXCEPTION 'JULY_OPENING_AUDIT_CONFLICT: % seed audit rows for % seed transactions', v_count, v_existing;
  END IF;

  -- 6. Fresh run: insert 4 transactions, 4 movements, 4 audits.
  IF v_existing=0 THEN
    FOR v_seed IN SELECT * FROM jsonb_to_recordset(c_seeds) AS s(fund_account_id bigint, code text, type text, amount numeric) LOOP
      v_key := '2026-07-01:'||v_seed.code;
      v_snapshot := jsonb_build_object('basis','legacy_sheet_closing_balance','sheet','(2026)BABA - Sổ dự án',
        'sheet_month','2026-07','opening_date','2026-07-01','opening_amount',v_seed.amount,'fund_account_code',v_seed.code,
        'sheet_total',c_total,'evidence','2026-06 month-end holdings = 2026-07 opening (G1/H1/I1/K1)','script',c_script);
      INSERT INTO public.ledger_transactions(operation_id,type,status,business_date,occurred_at,recognition_month,amount,
        category_id,party_id,source_type,source_key,source_snapshot,source_fingerprint,source_synced_at,memo,
        created_by,confirmed_by,economic_effect_sign,display_snapshot)
      VALUES (md5('baba-ledger:july-opening-20261106:'||v_key)::uuid,'opening','confirmed',c_business_date,c_occurred_at,NULL,v_seed.amount,
        NULL,NULL,c_source_type,v_key,v_snapshot,md5(v_snapshot::text),now(),c_memo,
        v_actor,v_actor,1,'{}'::jsonb)
      RETURNING * INTO STRICT v_tx;
      INSERT INTO public.ledger_movements(transaction_id,fund_account_id,amount)
      VALUES (v_tx.id,v_seed.fund_account_id,v_seed.amount)
      RETURNING * INTO STRICT v_movement;
      INSERT INTO public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
      VALUES (v_actor,c_action,'transaction',v_tx.id,NULL,
        jsonb_build_object('amount',v_seed.amount,'accountCode',v_seed.code,'fundAccountId',v_seed.fund_account_id,
          'transaction',to_jsonb(v_tx),'movement',to_jsonb(v_movement),'approval',v_approval,'script',c_script),c_reason)
      RETURNING * INTO STRICT v_audit;
    END LOOP;
  END IF;

  -- 7. Verify all four exactly (fresh run and re-run alike).
  FOR v_seed IN SELECT * FROM jsonb_to_recordset(c_seeds) AS s(fund_account_id bigint, code text, type text, amount numeric) LOOP
    v_key := '2026-07-01:'||v_seed.code;
    v_snapshot := jsonb_build_object('basis','legacy_sheet_closing_balance','sheet','(2026)BABA - Sổ dự án',
      'sheet_month','2026-07','opening_date','2026-07-01','opening_amount',v_seed.amount,'fund_account_code',v_seed.code,
      'sheet_total',c_total,'evidence','2026-06 month-end holdings = 2026-07 opening (G1/H1/I1/K1)','script',c_script);
    SELECT * INTO STRICT v_tx FROM public.ledger_transactions WHERE source_type=c_source_type AND source_key=v_key;
    IF v_tx.type IS DISTINCT FROM 'opening' OR v_tx.status IS DISTINCT FROM 'confirmed'
       OR v_tx.business_date IS DISTINCT FROM c_business_date OR v_tx.occurred_at IS DISTINCT FROM c_occurred_at
       OR v_tx.recognition_month IS NOT NULL OR v_tx.category_id IS NOT NULL OR v_tx.party_id IS NOT NULL
       OR v_tx.correction_of_id IS NOT NULL OR v_tx.amount IS DISTINCT FROM v_seed.amount
       OR v_tx.economic_effect_sign IS DISTINCT FROM 1 OR v_tx.memo IS DISTINCT FROM c_memo
       OR v_tx.operation_id IS DISTINCT FROM md5('baba-ledger:july-opening-20261106:'||v_key)::uuid
       OR v_tx.source_snapshot IS DISTINCT FROM v_snapshot OR v_tx.source_fingerprint IS DISTINCT FROM md5(v_snapshot::text)
       OR v_tx.source_synced_at IS NULL OR v_tx.display_snapshot IS DISTINCT FROM '{}'::jsonb
       OR v_tx.confirmed_by IS DISTINCT FROM v_tx.created_by
       OR (v_existing=0 AND v_tx.created_by IS DISTINCT FROM v_actor) THEN
      RAISE EXCEPTION 'JULY_OPENING_MISMATCH: transaction % (%) differs from the seed', v_tx.id, v_key;
    END IF;
    SELECT count(*) INTO v_count FROM public.ledger_movements WHERE transaction_id=v_tx.id;
    SELECT * INTO v_movement FROM public.ledger_movements WHERE transaction_id=v_tx.id;
    IF v_count<>1 OR v_movement.fund_account_id IS DISTINCT FROM v_seed.fund_account_id
       OR v_movement.amount IS DISTINCT FROM v_seed.amount THEN
      RAISE EXCEPTION 'JULY_OPENING_MOVEMENT_MISMATCH: transaction % (%)', v_tx.id, v_key;
    END IF;
    SELECT count(*) INTO v_count FROM public.ledger_audit_logs WHERE entity_type='transaction' AND entity_id=v_tx.id;
    SELECT * INTO v_audit FROM public.ledger_audit_logs WHERE entity_type='transaction' AND entity_id=v_tx.id;
    IF v_count<>1 OR v_audit.action IS DISTINCT FROM c_action OR v_audit.reason IS DISTINCT FROM c_reason
       OR v_audit.actor_user_id IS DISTINCT FROM v_tx.created_by OR v_audit.before_snapshot IS NOT NULL
       OR v_audit.after_snapshot->>'accountCode' IS DISTINCT FROM v_seed.code
       OR (v_audit.after_snapshot->>'amount')::numeric IS DISTINCT FROM v_seed.amount
       OR (v_audit.after_snapshot->>'fundAccountId')::bigint IS DISTINCT FROM v_seed.fund_account_id
       OR v_audit.after_snapshot->>'approval' IS DISTINCT FROM c_approval THEN
      RAISE EXCEPTION 'JULY_OPENING_AUDIT_MISMATCH: transaction % (%)', v_tx.id, v_key;
    END IF;
  END LOOP;
  SELECT count(*), coalesce(sum(m.amount),0) INTO v_count, v_sum FROM public.ledger_movements m
    JOIN public.ledger_transactions t ON t.id=m.transaction_id
   WHERE t.source_type=c_source_type AND t.source_key LIKE '2026-07-01:%';
  IF v_count<>4 OR v_sum<>c_total THEN
    RAISE EXCEPTION 'JULY_OPENING_TOTAL_MISMATCH: % movements, total %', v_count, v_sum;
  END IF;
  SELECT count(*) INTO v_count FROM public.ledger_audit_logs WHERE action=c_action AND reason=c_reason;
  IF v_count<>4 THEN RAISE EXCEPTION 'JULY_OPENING_AUDIT_COUNT: %', v_count; END IF;

  -- 8. Nothing protected moved.
  SELECT jsonb_build_object(
    'transactions', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.ledger_transactions t WHERE t.id IN (3,4,5,6,1190,3804)),
    'movements', (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM public.ledger_movements m WHERE m.transaction_id IN (3,4,5,6,1190,3804)),
    'fromAugust', (SELECT jsonb_agg(jsonb_build_object('fund',x.fund_account_id,'count',x.n,'sum',x.s) ORDER BY x.fund_account_id)
                     FROM (SELECT m.fund_account_id, count(*) n, sum(m.amount) s FROM public.ledger_movements m
                             JOIN public.ledger_transactions t ON t.id=m.transaction_id
                            WHERE t.business_date>=date '2026-08-01' GROUP BY m.fund_account_id) x),
    'cardClearing', (SELECT jsonb_build_object('count',count(*),'sum',coalesce(sum(m.amount),0)) FROM public.ledger_movements m WHERE m.fund_account_id=4),
    'closures', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.month) FROM public.ledger_month_closures c),
    'fundAccounts', (SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id) FROM public.ledger_fund_accounts f)
  ) INTO v_protected_after;
  IF v_protected_after IS DISTINCT FROM v_protected_before THEN
    RAISE EXCEPTION 'JULY_OPENING_PROTECTED_STATE_CHANGED: rolling back';
  END IF;

  IF v_existing=4 THEN
    RAISE NOTICE 'JULY_OPENING_ALREADY_APPLIED: 4 identical seeds verified; nothing written';
  ELSE
    RAISE NOTICE 'JULY_OPENING_APPLIED: 4 transactions, 4 movements, 4 audits; total %', c_total;
  END IF;
END;
$july_opening$;

-- Read-only result inside the same transaction.
SELECT t.id, t.source_key, t.amount, m.fund_account_id, m.amount AS movement_amount,
       (SELECT count(*) FROM public.ledger_audit_logs a WHERE a.entity_type='transaction' AND a.entity_id=t.id) AS audit_rows
  FROM public.ledger_transactions t JOIN public.ledger_movements m ON m.transaction_id=t.id
 WHERE t.source_type='opening_balance_seed' AND t.source_key LIKE '2026-07-01:%'
 ORDER BY t.id;
COMMIT;
