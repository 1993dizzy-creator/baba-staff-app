-- MANUAL SQL EDITOR ONLY, AFTER SEPARATE APPROVAL. Never run as a migration.
-- Paste the freshly reviewed preflight manifest and actor below. Empty inputs refuse.
-- Target pairs and 108 account-day Sheet values are pinned to the supplied 2026-10-31 evidence.
-- Refresh/review them if the Sheet changes; a stale live account baseline refuses to run.
-- Rollback before COMMIT is automatic on ANY failed assertion. After commit,
-- restoration needs a separately approved atomic, audited status restoration:
-- re-confirm the 20 retained manuals, cancel only this batch's 20 corrections,
-- retain every original movement/audit, and recheck daily funds and monthly P&L.
-- Refuse restoration if October closed or subsequent corrections depend on this
-- batch. Never delete corrections/audits or reopen September.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $consolidate$
declare
  v_manifest jsonb := '[]'; -- APPROVED_MANIFEST
  v_expected_daily jsonb := '[{"business_date":"2026-10-01","account_code":"store_cash","amount":6057200},{"business_date":"2026-10-01","account_code":"baba_corporate_bank","amount":-13269294},{"business_date":"2026-10-01","account_code":"cho_personal_custody","amount":2823200},{"business_date":"2026-10-01","account_code":"vuong_personal_custody","amount":-50000},{"business_date":"2026-10-02","account_code":"store_cash","amount":8336900},{"business_date":"2026-10-02","account_code":"baba_corporate_bank","amount":-28779219},{"business_date":"2026-10-02","account_code":"cho_personal_custody","amount":6034600},{"business_date":"2026-10-02","account_code":"vuong_personal_custody","amount":0},{"business_date":"2026-10-03","account_code":"store_cash","amount":2853400},{"business_date":"2026-10-03","account_code":"baba_corporate_bank","amount":-11144600},{"business_date":"2026-10-03","account_code":"cho_personal_custody","amount":-32650000},{"business_date":"2026-10-03","account_code":"vuong_personal_custody","amount":0},{"business_date":"2026-10-04","account_code":"store_cash","amount":6972200},{"business_date":"2026-10-04","account_code":"baba_corporate_bank","amount":7978200},{"business_date":"2026-10-04","account_code":"cho_personal_custody","amount":620500},{"business_date":"2026-10-04","account_code":"vuong_personal_custody","amount":0},{"business_date":"2026-10-05","account_code":"store_cash","amount":-1453400},{"business_date":"2026-10-05","account_code":"baba_corporate_bank","amount":19489118},{"business_date":"2026-10-05","account_code":"cho_personal_custody","amount":1618200},{"business_date":"2026-10-05","account_code":"vuong_personal_custody","amount":0},{"business_date":"2026-10-06","account_code":"store_cash","amount":6985700},{"business_date":"2026-10-06","account_code":"baba_corporate_bank","amount":6661912},{"business_date":"2026-10-06","account_code":"cho_personal_custody","amount":2605600},{"business_date":"2026-10-06","account_code":"vuong_personal_custody","amount":0},{"business_date":"2026-10-07","account_code":"store_cash","amount":3877200},{"business_date":"2026-10-07","account_code":"baba_corporate_bank","amount":15300814},{"business_date":"2026-10-07","account_code":"cho_personal_custody","amount":0},{"business_date":"2026-10-07","account_code":"vuong_personal_custody","amount":0},{"business_date":"2026-10-08","account_code":"store_cash","amount":-5575000},{"business_date":"2026-10-08","account_code":"baba_corporate_bank","amount":15676708},{"business_date":"2026-10-08","account_code":"cho_personal_custody","amount":1294800},{"business_date":"2026-10-08","account_code":"vuong_personal_custody","amount":0},{"business_date":"2026-10-09","account_code":"store_cash","amount":2443400},{"business_date":"2026-10-09","account_code":"baba_corporate_bank","amount":14782114},{"business_date":"2026-10-09","account_code":"cho_personal_custody","amount":4906920},{"business_date":"2026-10-09","account_code":"vuong_personal_custody","amount":0},{"business_date":"2026-10-10","account_code":"store_cash","amount":-22090500},{"business_date":"2026-10-10","account_code":"baba_corporate_bank","amount":-122972609},{"business_date":"2026-10-10","account_code":"cho_personal_custody","amount":286800},{"business_date":"2026-10-10","account_code":"vuong_personal_custody","amount":-3000000},{"business_date":"2026-10-11","account_code":"store_cash","amount":2588000},{"business_date":"2026-10-11","account_code":"baba_corporate_bank","amount":10035900},{"business_date":"2026-10-11","account_code":"cho_personal_custody","amount":0},{"business_date":"2026-10-11","account_code":"vuong_personal_custody","amount":0},{"business_date":"2026-10-12","account_code":"store_cash","amount":-297600},{"business_date":"2026-10-12","account_code":"baba_corporate_bank","amount":13000906},{"business_date":"2026-10-12","account_code":"cho_personal_custody","amount":2205600},{"business_date":"2026-10-12","account_code":"vuong_personal_custody","amount":0},{"business_date":"2026-10-13","account_code":"store_cash","amount":2535400},{"business_date":"2026-10-13","account_code":"baba_corporate_bank","amount":5238818},{"business_date":"2026-10-13","account_code":"cho_personal_custody","amount":1855800},{"business_date":"2026-10-13","account_code":"vuong_personal_custody","amount":0},{"business_date":"2026-10-14","account_code":"store_cash","amount":511600},{"business_date":"2026-10-14","account_code":"baba_corporate_bank","amount":21273034},{"business_date":"2026-10-14","account_code":"cho_personal_custody","amount":3100800},{"business_date":"2026-10-14","account_code":"vuong_personal_custody","amount":0},{"business_date":"2026-10-15","account_code":"store_cash","amount":5067000},{"business_date":"2026-10-15","account_code":"baba_corporate_bank","amount":20132061},{"business_date":"2026-10-15","account_code":"cho_personal_custody","amount":2500000},{"business_date":"2026-10-15","account_code":"vuong_personal_custody","amount":0},{"business_date":"2026-10-16","account_code":"store_cash","amount":-21816800},{"business_date":"2026-10-16","account_code":"baba_corporate_bank","amount":25256416},{"business_date":"2026-10-16","account_code":"cho_personal_custody","amount":1407400},{"business_date":"2026-10-16","account_code":"vuong_personal_custody","amount":0},{"business_date":"2026-10-17","account_code":"store_cash","amount":7659300},{"business_date":"2026-10-17","account_code":"baba_corporate_bank","amount":-90461042},{"business_date":"2026-10-17","account_code":"cho_personal_custody","amount":1254000},{"business_date":"2026-10-17","account_code":"vuong_personal_custody","amount":0},{"business_date":"2026-10-18","account_code":"store_cash","amount":1243900},{"business_date":"2026-10-18","account_code":"baba_corporate_bank","amount":3292400},{"business_date":"2026-10-18","account_code":"cho_personal_custody","amount":0},{"business_date":"2026-10-18","account_code":"vuong_personal_custody","amount":0},{"business_date":"2026-10-19","account_code":"store_cash","amount":-3539200},{"business_date":"2026-10-19","account_code":"baba_corporate_bank","amount":30087597},{"business_date":"2026-10-19","account_code":"cho_personal_custody","amount":1030000},{"business_date":"2026-10-19","account_code":"vuong_personal_custody","amount":0},{"business_date":"2026-10-20","account_code":"store_cash","amount":2681800},{"business_date":"2026-10-20","account_code":"baba_corporate_bank","amount":-18136536},{"business_date":"2026-10-20","account_code":"cho_personal_custody","amount":4338600},{"business_date":"2026-10-20","account_code":"vuong_personal_custody","amount":280000},{"business_date":"2026-10-21","account_code":"store_cash","amount":-713000},{"business_date":"2026-10-21","account_code":"baba_corporate_bank","amount":-81357588},{"business_date":"2026-10-21","account_code":"cho_personal_custody","amount":3406600},{"business_date":"2026-10-21","account_code":"vuong_personal_custody","amount":2195000},{"business_date":"2026-10-22","account_code":"store_cash","amount":4614000},{"business_date":"2026-10-22","account_code":"baba_corporate_bank","amount":14091637},{"business_date":"2026-10-22","account_code":"cho_personal_custody","amount":0},{"business_date":"2026-10-22","account_code":"vuong_personal_custody","amount":0},{"business_date":"2026-10-23","account_code":"store_cash","amount":-5561000},{"business_date":"2026-10-23","account_code":"baba_corporate_bank","amount":19710325},{"business_date":"2026-10-23","account_code":"cho_personal_custody","amount":2061000},{"business_date":"2026-10-23","account_code":"vuong_personal_custody","amount":3000000},{"business_date":"2026-10-24","account_code":"store_cash","amount":5491800},{"business_date":"2026-10-24","account_code":"baba_corporate_bank","amount":17348800},{"business_date":"2026-10-24","account_code":"cho_personal_custody","amount":2034000},{"business_date":"2026-10-24","account_code":"vuong_personal_custody","amount":0},{"business_date":"2026-10-25","account_code":"store_cash","amount":753600},{"business_date":"2026-10-25","account_code":"baba_corporate_bank","amount":12920320},{"business_date":"2026-10-25","account_code":"cho_personal_custody","amount":3551400},{"business_date":"2026-10-25","account_code":"vuong_personal_custody","amount":0},{"business_date":"2026-10-26","account_code":"store_cash","amount":-21000},{"business_date":"2026-10-26","account_code":"baba_corporate_bank","amount":25171540},{"business_date":"2026-10-26","account_code":"cho_personal_custody","amount":1953600},{"business_date":"2026-10-26","account_code":"vuong_personal_custody","amount":0},{"business_date":"2026-10-27","account_code":"store_cash","amount":4471700},{"business_date":"2026-10-27","account_code":"baba_corporate_bank","amount":5963072},{"business_date":"2026-10-27","account_code":"cho_personal_custody","amount":2314900},{"business_date":"2026-10-27","account_code":"vuong_personal_custody","amount":-8600000}]'; -- Sheet snapshot 2026-10-31; live preflight must still match 108/108.
  v_expected_pairs constant jsonb := '[{"manual_id":2419,"automatic_id":2212,"business_date":"2026-10-02","amount":30000,"automatic_amount":330000,"final_amount":360000,"source_key":"sheet:2026-10:row19:manual"},{"manual_id":2420,"automatic_id":2232,"business_date":"2026-10-03","amount":30000,"automatic_amount":360000,"final_amount":390000,"source_key":"sheet:2026-10:row37:manual"},{"manual_id":2421,"automatic_id":2300,"business_date":"2026-10-06","amount":30000,"automatic_amount":330000,"final_amount":360000,"source_key":"sheet:2026-10:row78:manual"},{"manual_id":2422,"automatic_id":2335,"business_date":"2026-10-07","amount":30000,"automatic_amount":360000,"final_amount":390000,"source_key":"sheet:2026-10:row89:manual"},{"manual_id":2825,"automatic_id":2380,"business_date":"2026-10-08","amount":30000,"automatic_amount":360000,"final_amount":390000,"source_key":"sheet:2026-10:row102:meal-difference-30000"},{"manual_id":2826,"automatic_id":2457,"business_date":"2026-10-09","amount":30000,"automatic_amount":360000,"final_amount":390000,"source_key":"sheet:2026-10:row117:meal-difference-30000"},{"manual_id":2827,"automatic_id":2481,"business_date":"2026-10-10","amount":30000,"automatic_amount":390000,"final_amount":420000,"source_key":"sheet:2026-10:row131:meal-difference-30000"},{"manual_id":2828,"automatic_id":2521,"business_date":"2026-10-11","amount":30000,"automatic_amount":360000,"final_amount":390000,"source_key":"sheet:2026-10:row146:meal-difference-30000"},{"manual_id":2829,"automatic_id":2629,"business_date":"2026-10-15","amount":30000,"automatic_amount":300000,"final_amount":330000,"source_key":"sheet:2026-10:row197:meal-difference-30000"},{"manual_id":3338,"automatic_id":2663,"business_date":"2026-10-16","amount":30000,"automatic_amount":390000,"final_amount":420000,"source_key":"reconcile:2026-10:staff-meal:2026-10-16"},{"manual_id":3339,"automatic_id":2920,"business_date":"2026-10-18","amount":30000,"automatic_amount":360000,"final_amount":390000,"source_key":"reconcile:2026-10:staff-meal:2026-10-18"},{"manual_id":3340,"automatic_id":2943,"business_date":"2026-10-19","amount":30000,"automatic_amount":330000,"final_amount":360000,"source_key":"reconcile:2026-10:staff-meal:2026-10-19"},{"manual_id":3341,"automatic_id":2971,"business_date":"2026-10-20","amount":30000,"automatic_amount":360000,"final_amount":390000,"source_key":"reconcile:2026-10:staff-meal:2026-10-20"},{"manual_id":3342,"automatic_id":3011,"business_date":"2026-10-21","amount":30000,"automatic_amount":330000,"final_amount":360000,"source_key":"reconcile:2026-10:staff-meal:2026-10-21"},{"manual_id":3343,"automatic_id":3045,"business_date":"2026-10-22","amount":30000,"automatic_amount":360000,"final_amount":390000,"source_key":"reconcile:2026-10:staff-meal:2026-10-22"},{"manual_id":3344,"automatic_id":3082,"business_date":"2026-10-23","amount":30000,"automatic_amount":390000,"final_amount":420000,"source_key":"reconcile:2026-10:staff-meal:2026-10-23"},{"manual_id":3345,"automatic_id":3135,"business_date":"2026-10-24","amount":60000,"automatic_amount":330000,"final_amount":390000,"source_key":"reconcile:2026-10:staff-meal:2026-10-24"},{"manual_id":3346,"automatic_id":3175,"business_date":"2026-10-25","amount":30000,"automatic_amount":330000,"final_amount":360000,"source_key":"reconcile:2026-10:staff-meal:2026-10-25"},{"manual_id":3347,"automatic_id":3212,"business_date":"2026-10-26","amount":30000,"automatic_amount":300000,"final_amount":330000,"source_key":"reconcile:2026-10:staff-meal:2026-10-26"},{"manual_id":3348,"automatic_id":3246,"business_date":"2026-10-27","amount":30000,"automatic_amount":330000,"final_amount":360000,"source_key":"reconcile:2026-10:staff-meal:2026-10-27"}]'; -- Exact supplied 20, never inferred by amount alone.
  v_actor bigint := null; -- APPROVED_ACTOR
  v_manual public.ledger_transactions%rowtype;
  v_original public.ledger_transactions%rowtype;
  v_candidate public.ledger_candidates%rowtype;
  v_item jsonb; v_result jsonb; v_snapshot jsonb;
  v_id bigint; v_cash bigint; v_before_effective numeric;
  v_daily jsonb; v_profit jsonb; v_preserved jsonb; v_after jsonb;
  v_daily_hash_before text; v_daily_hash_after text;
  v_profit_hash_before text; v_profit_hash_after text;
  v_history_hash_before text; v_history_hash_after text;
  v_protected_tx_hash text; v_sep_closure_snapshot jsonb;
  v_operation uuid := gen_random_uuid();
  v_batch constant text := 'oct-2026-meal-consolidation-20-630000-v1';
begin
  if jsonb_array_length(v_manifest) <> 20 or jsonb_array_length(v_expected_daily) <> 108 or v_actor is null then
    raise exception 'APPROVED_MANIFEST_ACTOR_AND_108_VERIFIED_DAYS_REQUIRED';
  end if;
  if not exists(select 1 from public.users where id=v_actor and lower(role::text) in ('owner','master')
    and is_active and app_login_enabled) then raise exception 'ACTOR_FORBIDDEN'; end if;
  perform pg_advisory_xact_lock(hashtext('ledger_month_close:2026-10'));
  -- Freeze the small batch and its accounting baselines against concurrent writers.
  lock table public.ledger_transactions,public.ledger_movements,public.ledger_candidates,
    public.ledger_month_closures,public.ledger_audit_logs,public.ledger_fund_accounts in share row exclusive mode;
  if public.ledger_month_is_closed_v1('2026-10-01') then raise exception 'OCTOBER_CLOSED'; end if;
  if exists(select 1 from public.ledger_audit_logs where action='meal_manual_consolidation_completed'
    and after_snapshot->>'batch'=v_batch) then raise exception 'BATCH_ALREADY_APPLIED'; end if;
  if position('original_meal_business_date' in pg_get_functiondef(
    'public.ledger_adjust_open_meal_transaction_v1(bigint,numeric,text,bigint)'::regprocedure))=0 then
    raise exception 'INSTALL_REVIEWED_MEAL_MIGRATION_FIRST';
  end if;
  if (select count(distinct x->>'manual_id') from jsonb_array_elements(v_manifest) x) <> 20
    or (select count(distinct x->>'automatic_id') from jsonb_array_elements(v_manifest) x) <> 20 then
    raise exception 'DUPLICATE_MANIFEST_IDS';
  end if;
  if (select jsonb_agg((x->>'manual_id')::bigint order by (x->>'manual_id')::bigint) from jsonb_array_elements(v_manifest) x)
    is distinct from (select jsonb_agg((x->>'manual_id')::bigint order by (x->>'manual_id')::bigint) from jsonb_array_elements(v_expected_pairs) x)
    then raise exception 'EXACT_REVIEWED_20_IDS_REQUIRED'; end if;
  select id into strict v_cash from public.ledger_fund_accounts where code='store_cash' and is_business_fund and is_active;
  if (select sum(t.amount) from public.ledger_transactions t
    join jsonb_array_elements(v_manifest) x on t.id=(x->>'manual_id')::bigint) is distinct from 630000::numeric then
    raise exception 'EXPECTED_20_ROWS_630000';
  end if;
  -- The 108 evidence cells must be exactly the four business accounts x 27 dates.
  if (select count(*) from public.ledger_fund_accounts where is_business_fund and active_from<='2026-10-01'
    and (active_to is null or active_to>='2026-10-27')) <> 4
    or (select count(distinct (x->>'business_date',x->>'account_code')) from jsonb_array_elements(v_expected_daily) x)<>108
    or exists(select 1 from jsonb_array_elements(v_expected_daily) x
      where x->>'business_date' is null or (x->>'business_date')::date not between '2026-10-01' and '2026-10-27'
      or x->>'amount' is null or not exists(select 1 from public.ledger_fund_accounts f
        where f.code=x->>'account_code' and f.is_business_fund and f.active_from<='2026-10-01'
        and (f.active_to is null or f.active_to>='2026-10-27')))
    then raise exception 'INVALID_108_ACCOUNT_DAY_EVIDENCE'; end if;
  if exists(select 1 from jsonb_array_elements(v_expected_daily) x where (x->>'amount')::numeric is distinct from
    (select coalesce(sum(m.amount),0) from public.ledger_transactions t join public.ledger_movements m on m.transaction_id=t.id
      join public.ledger_fund_accounts f on f.id=m.fund_account_id where t.status='confirmed'
      and t.business_date=(x->>'business_date')::date and f.code=x->>'account_code')) then
    raise exception 'PREFLIGHT_108_ACCOUNT_DAYS_MISMATCH';
  end if;
  select jsonb_agg(to_jsonb(s) order by business_date,fund_account_id) into v_daily from (
    select t.business_date,m.fund_account_id,sum(m.amount) amount from public.ledger_transactions t
    join public.ledger_movements m on m.transaction_id=t.id where t.status='confirmed'
    group by 1,2) s;
  select jsonb_agg(to_jsonb(s) order by recognition_month,category_id,type) into v_profit from (
    select recognition_month,category_id,type,sum(amount*economic_effect_sign) amount from public.ledger_transactions
    where status='confirmed' group by 1,2,3) s;
  select jsonb_build_object('protectedTransactions',(select jsonb_agg(to_jsonb(t) order by id) from public.ledger_transactions t where id in(2112,2163)),
    'closures',(select jsonb_agg(to_jsonb(c) order by id) from public.ledger_month_closures c),
    'candidates',(select jsonb_agg(to_jsonb(c) order by id) from public.ledger_candidates c),
    'movements',(select jsonb_agg(to_jsonb(m) order by id) from public.ledger_movements m)) into v_preserved;
  -- Keep complete before-state only inside this locked transaction. Audit stores
  -- compact hashes and the 20-row manifest, never a full 3+ MB candidate dump.
  v_daily_hash_before := md5(coalesce(v_daily::text,'null'));
  v_profit_hash_before := md5(coalesce(v_profit::text,'null'));
  v_history_hash_before := md5(coalesce(v_preserved::text,'null'));
  v_protected_tx_hash := md5(coalesce((v_preserved->'protectedTransactions')::text,'null'));
  select coalesce(jsonb_agg(to_jsonb(c) order by id),'[]'::jsonb) into v_sep_closure_snapshot
    from public.ledger_month_closures c where month='2026-09-01'::date;
  if (select count(*) from public.ledger_transactions where id in(2112,2163))<>2
    or not exists(select 1 from public.ledger_transactions where id=2163 and correction_of_id=2112
      and business_date='2026-10-01' and source_type='ledger_correction') then raise exception 'TX2163_LINK_CHANGED'; end if;

  for v_item in select x from jsonb_array_elements(v_manifest) x order by (x->>'manual_id')::bigint loop
    select * into strict v_manual from public.ledger_transactions where id=(v_item->>'manual_id')::bigint for update;
    select * into strict v_original from public.ledger_transactions where id=(v_item->>'automatic_id')::bigint for update;
    select * into strict v_candidate from public.ledger_candidates where v_original.source_key='candidate:'||id::text for update;
    if v_manual.id in(2112,2163) or v_original.id in(2112,2163)
      or (v_item->>'business_date')::date is distinct from v_manual.business_date
      or md5(to_jsonb(v_manual)::text) is distinct from v_item->>'manual_hash'
      or md5(to_jsonb(v_original)::text) is distinct from v_item->>'automatic_hash'
      or md5(to_jsonb(v_candidate)::text) is distinct from v_item->>'candidate_hash'
      or (select md5(coalesce(jsonb_agg(to_jsonb(m) order by m.id),'[]')::text) from public.ledger_movements m
        where transaction_id=v_manual.id) is distinct from v_item->>'movement_hash'
      then raise exception 'STALE_OR_PROTECTED_MANIFEST %',v_manual.id; end if;
    if not exists(select 1 from jsonb_array_elements(v_expected_pairs) p where (p->>'manual_id')::bigint=v_manual.id
      and (p->>'automatic_id')::bigint=v_original.id and (p->>'business_date')::date=v_manual.business_date
      and (p->>'amount')::numeric=v_manual.amount and (p->>'automatic_amount')::numeric=v_original.amount
      and p->>'source_key'=v_manual.source_key) then raise exception 'SNAPSHOT_PAIR_CHANGED %',v_manual.id; end if;
    if v_manual.status<>'confirmed' or v_manual.source_type<>'manual' or v_manual.type<>'expense'
      or v_manual.economic_effect_sign<>1 or v_manual.correction_of_id is not null
      or v_manual.recognition_month<>'2026-10-01' or v_manual.business_date not between '2026-10-01' and '2026-10-31'
      or v_original.business_date<>v_manual.business_date or v_original.recognition_month<>'2026-10-01'
      or v_original.status<>'confirmed' or v_original.type<>'expense' or v_original.economic_effect_sign<>1
      or v_original.source_type<>'attendance_meal_daily_candidate' or v_original.correction_of_id is not null
      or (select count(*) from public.ledger_transactions where business_date=v_manual.business_date
        and source_type='attendance_meal_daily_candidate' and status='confirmed' and correction_of_id is null)<>1
      or v_original.category_id<>v_manual.category_id or not exists(select 1 from public.ledger_categories where id=v_manual.category_id and name='직원 식대' and kind='expense')
      or v_candidate.resolved_transaction_id is distinct from v_original.id or v_candidate.status<>'confirmed'
      or v_candidate.candidate_type<>'employee_meal' or v_candidate.source_type<>'attendance_meal_daily'
      or public.ledger_manual_transaction_blocker_v1(v_manual) is not null
      then raise exception 'UNSAFE_MEAL_PAIR %',v_manual.id; end if;
    if (select count(*) from public.ledger_movements where transaction_id=v_manual.id)<>1
      or not exists(select 1 from public.ledger_movements where transaction_id=v_manual.id and fund_account_id=v_cash and amount=-v_manual.amount)
      or (select count(*) from public.ledger_movements where transaction_id=v_original.id)<>1
      or not exists(select 1 from public.ledger_movements where transaction_id=v_original.id and fund_account_id=v_cash and amount=-v_original.amount)
      or not exists(select 1 from public.ledger_fund_accounts where id=v_cash and active_from<=v_manual.business_date
        and (active_to is null or active_to>=v_manual.business_date)) then raise exception 'UNSAFE_CASH_MOVEMENTS'; end if;
    select v_original.amount+coalesce(sum(amount*economic_effect_sign),0) into v_before_effective
      from public.ledger_transactions where correction_of_id=v_original.id and source_type='ledger_correction' and status='confirmed';
    if not exists(select 1 from jsonb_array_elements(v_expected_pairs) p where (p->>'manual_id')::bigint=v_manual.id
      and (p->>'final_amount')::numeric=v_before_effective+v_manual.amount) then raise exception 'EFFECTIVE_AMOUNT_CHANGED %',v_manual.id; end if;
    v_result:=public.ledger_cancel_manual_transaction_v1(v_manual.id,v_manual.updated_at,
      '식대 통합 · 원수기 #'||v_manual.id||' → 자동식대 #'||v_original.id,v_actor);
    if v_result->>'status' is distinct from 'cancelled' then raise exception 'CANCEL_FAILED %',v_result; end if;
    -- Append the same linked-delta format; do not mark source drift as reviewed
    -- merely because the already-booked manual expenditure is being transferred.
    v_snapshot:=jsonb_build_object('adjustmentType','employee_meal','batch',v_batch,
      'originalTransactionId',v_original.id,'manualTransactionId',v_manual.id,
      'previousEffectiveAmount',v_before_effective,'finalAmount',v_before_effective+v_manual.amount,
      'economicDelta',v_manual.amount,'originalSourceType',v_original.source_type,'originalSourceKey',v_original.source_key,
      'attributionPolicy','original_meal_business_date','businessDate',v_original.business_date,'adjustedAt',now());
    insert into public.ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,party_id,
      status,source_type,source_key,source_snapshot,source_fingerprint,source_synced_at,correction_of_id,memo,created_by,confirmed_by,economic_effect_sign)
    values(v_operation,'expense',now(),v_original.business_date,v_original.recognition_month,v_manual.amount,v_original.category_id,v_original.party_id,
      'confirmed','ledger_correction',v_batch||':'||v_manual.id,v_snapshot,md5(v_snapshot::text||':1')||md5(v_snapshot::text||':2'),now(),v_original.id,
      coalesce(nullif(btrim(v_manual.memo),''),'기존 수기 식대 통합')||' · 수기 #'||v_manual.id||' → 자동식대 #'||v_original.id,v_actor,v_actor,1) returning id into v_id;
    insert into public.ledger_movements(transaction_id,fund_account_id,amount) values(v_id,v_cash,-v_manual.amount);
    insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
    values(v_actor,'meal_manual_consolidated','transaction',v_id,to_jsonb(v_manual),
      v_snapshot||jsonb_build_object('adjustmentTransactionId',v_id,'operationId',v_operation),'기존 수기식대의 동일 영업일 연결형 정정 통합');
  end loop;
  select jsonb_agg(to_jsonb(s) order by business_date,fund_account_id) into v_after from (
    select t.business_date,m.fund_account_id,sum(m.amount) amount from public.ledger_transactions t
    join public.ledger_movements m on m.transaction_id=t.id where t.status='confirmed' group by 1,2) s;
  if v_after is distinct from v_daily then raise exception 'DAILY_ACCOUNT_MOVEMENTS_CHANGED'; end if;
  v_daily_hash_after := md5(coalesce(v_after::text,'null'));
  select jsonb_agg(to_jsonb(s) order by recognition_month,category_id,type) into v_after from (
    select recognition_month,category_id,type,sum(amount*economic_effect_sign) amount from public.ledger_transactions
    where status='confirmed' group by 1,2,3) s;
  if v_after is distinct from v_profit then raise exception 'MONTHLY_PROFIT_CHANGED'; end if;
  v_profit_hash_after := md5(coalesce(v_after::text,'null'));
  select jsonb_build_object('protectedTransactions',(select jsonb_agg(to_jsonb(t) order by id) from public.ledger_transactions t where id in(2112,2163)),
    'closures',(select jsonb_agg(to_jsonb(c) order by id) from public.ledger_month_closures c),
    'candidates',(select jsonb_agg(to_jsonb(c) order by id) from public.ledger_candidates c),
    'movements',(select jsonb_agg(to_jsonb(m) order by id) from public.ledger_movements m where transaction_id not in (
      select id from public.ledger_transactions where source_snapshot->>'batch'=v_batch))) into v_after;
  if v_after is distinct from v_preserved then raise exception 'PROTECTED_HISTORY_CHANGED'; end if;
  v_history_hash_after := md5(coalesce(v_after::text,'null'));
  insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,after_snapshot,reason)
  values(v_actor,'meal_manual_consolidation_completed','transaction',null,
    jsonb_build_object('batch',v_batch,'operationId',v_operation,'manifest',v_manifest,
      'expectedPairs',v_expected_pairs,'verifiedDaily',v_expected_daily,
      'atApplyChecks',jsonb_build_object(
        'dailyBeforeHash',v_daily_hash_before,'dailyAfterHash',v_daily_hash_after,
        'profitBeforeHash',v_profit_hash_before,'profitAfterHash',v_profit_hash_after,
        'historyBeforeHash',v_history_hash_before,'historyAfterHash',v_history_hash_after),
      'protectedTxHash',v_protected_tx_hash,'septemberClosureSnapshot',v_sep_closure_snapshot,
      'count',20,'amount',630000),
    '20건 630,000 VND 통합 · 전계좌 일변동 및 월손익 동일 · 108/108 검산 유지');
end;
$consolidate$;
commit;
