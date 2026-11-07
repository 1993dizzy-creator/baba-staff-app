-- STRUCTURE ONLY. Separate owner approval required; no historical data import here.
begin;
do $type$
declare definition text;
begin
 select pg_get_constraintdef(oid) into strict definition from pg_constraint where conrelid='public.ledger_transactions'::regclass and conname='ledger_transactions_type_check';
 execute 'alter table public.ledger_transactions drop constraint ledger_transactions_type_check';
 execute format('alter table public.ledger_transactions add constraint ledger_transactions_type_check check ((%s) or type = %L)',substring(definition from 8 for length(definition)-8),'historical_cash_event');
end $type$;

create table public.ledger_import_rows(
 source_key text primary key,
 profile_key text not null,
 period date not null check(period=date_trunc('month',period)::date),
 business_date date not null,
 source_row integer not null check(source_row>0),
 source_canonical text not null,
 source_snapshot jsonb not null check(jsonb_typeof(source_snapshot)='object'),
 source_fingerprint text not null check(source_fingerprint ~ '^[a-f0-9]{64}$'),
 cash_effects jsonb not null check(jsonb_typeof(cash_effects)='array'),
 reference_effects jsonb not null check(jsonb_typeof(reference_effects)='array'),
 source_role text not null,
 cash_status text not null check(cash_status in('existing_link','recorded','reference_only')),
 cash_transaction_id bigint unique references public.ledger_transactions(id),
 existing_transaction_ids bigint[] not null default '{}',
 economic_status text not null check(economic_status in('unclassified','source_identified','resolved')),
 batch_digest text not null check(batch_digest ~ '^[a-f0-9]{64}$'),
 cash_sealed boolean not null default false,
 created_by bigint not null references public.users(id),
 created_at timestamptz not null default now(),
 check(business_date>=period and business_date<(period+interval '1 month')::date),
 check((cash_status='recorded')=(cash_transaction_id is not null)),
 check(cash_status<>'existing_link' or cardinality(existing_transaction_ids)>0),
 unique(profile_key,source_row)
);
create index ledger_import_rows_period on public.ledger_import_rows(period,economic_status);
create table public.ledger_import_source_claims(
 id bigint generated always as identity primary key,
 source_kind text not null check(source_kind in('pos_payment','pos_receipt','inventory_log','payable','payroll_adjustment','owner_investment','document')),
 source_id text not null check(length(btrim(source_id)) between 1 and 200),
 anchor_key text not null references public.ledger_import_rows(source_key),
 member_keys text[] not null,
 economic_transaction_id bigint references public.ledger_transactions(id),
 created_by bigint not null references public.users(id),
 created_at timestamptz not null default now(),
 unique(source_kind,source_id)
);
alter table public.ledger_import_rows enable row level security;
alter table public.ledger_import_source_claims enable row level security;
revoke all on public.ledger_import_rows,public.ledger_import_source_claims from public,anon,authenticated,service_role;
revoke all on sequence public.ledger_import_source_claims_id_seq from public,anon,authenticated,service_role;
grant select on public.ledger_import_rows,public.ledger_import_source_claims to service_role;

create schema ledger_import_private;
revoke all on schema ledger_import_private from public,anon,authenticated,service_role;
create function ledger_import_private.assert_actor(actor bigint) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if not exists(select 1 from public.users where id=actor and is_active and app_login_enabled and lower(role::text) in('owner','master')) then raise exception 'CASH_IMPORT_OWNER_REQUIRED';end if;
end $$;
create function ledger_import_private.funds(start_date date,end_date date) returns jsonb language sql stable set search_path=pg_catalog,public as $$
 select jsonb_object_agg(code,balance) from (
 select f.code,coalesce(sum(m.amount) filter(where t.status='confirmed' and t.business_date>=start_date and t.business_date<end_date),0) balance
 from public.ledger_fund_accounts f left join public.ledger_movements m on m.fund_account_id=f.id left join public.ledger_transactions t on t.id=m.transaction_id
 where f.code in('store_cash','vuong_personal_custody','cho_personal_custody','baba_corporate_bank','card_clearing') group by f.code) x
$$;
-- Two compact snapshots of affected ledger/protection objects, never stock/POS scans.
create function ledger_import_private.protected(period_start date) returns jsonb language plpgsql set search_path=pg_catalog,public as $$
declare result jsonb:='{}';n text;h text;
begin
 select md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by t.id),'')) into h from public.ledger_transactions t where not(t.source_type='sheet_cash_import' and t.business_date>=period_start and t.business_date<(period_start+interval '1 month')::date);
 result:=jsonb_build_object('transactions',h);
 select md5(coalesce(string_agg(to_jsonb(m)::text,'|' order by m.id),'')) into h from public.ledger_movements m join public.ledger_transactions t on t.id=m.transaction_id where not(t.source_type='sheet_cash_import' and t.business_date>=period_start and t.business_date<(period_start+interval '1 month')::date);
 result:=result||jsonb_build_object('movements',h);
 foreach n in array array['ledger_fund_accounts','ledger_candidates','ledger_payables','ledger_payable_allocations','ledger_card_reconciliations','ledger_card_reconciliation_lines','ledger_card_fee_closures','ledger_card_fee_allocation_lines','ledger_month_closures','ledger_month_closure_history','ledger_rent_contracts','ledger_rent_contract_payments','ledger_owner_investments','payroll_monthly_adjustments','payroll_payment_batches'] loop
  execute format('select md5(coalesce(string_agg(to_jsonb(x)::text,''|'' order by id),'''')) from public.%I x',n) into h;
  result:=result||jsonb_build_object(n,h);
 end loop;
 return result;
end $$;

create function ledger_import_private.anchors(r jsonb) returns bigint[] language plpgsql set search_path=pg_catalog,public as $$
declare ids bigint[];au public.ledger_audit_logs%rowtype;
begin
 if r->>'knownTransactionId' is not null then
  ids:=array[(r->>'knownTransactionId')::bigint];
 else
  select * into strict au from public.ledger_audit_logs where action=coalesce(r->>'anchorAuditAction','july_restore_row') and reason=r->>'key';
  if jsonb_typeof(au.after_snapshot->'transactionIds')='array' then
   select array_agg(value::bigint order by value::bigint) into ids from jsonb_array_elements_text(au.after_snapshot->'transactionIds');
  else ids:=array[au.entity_id];end if;
  if r->>'expectedActionHash' is not null and au.after_snapshot->>'actionHash' is distinct from r->>'expectedActionHash' then raise exception 'CASH_IMPORT_ANCHOR_ACTION_DRIFT';end if;
 end if;
 if cardinality(ids)=0 or exists(select 1 from unnest(ids) i where i is null or not exists(select 1 from public.ledger_transactions t where t.id=i and t.status='confirmed' and t.business_date=(r->>'date')::date)) then raise exception 'CASH_IMPORT_ANCHOR_MISSING';end if;
 if r->>'expectedSourceKey' is not null and not exists(select 1 from public.ledger_transactions where id=any(ids) and source_key=r->>'expectedSourceKey') then raise exception 'CASH_IMPORT_ANCHOR_KEY_DRIFT';end if;
 return ids;
end $$;

create function ledger_import_private.assert_effects(ids bigint[],expected jsonb) returns void language plpgsql set search_path=pg_catalog,public as $$
declare actual jsonb;
begin
 select coalesce(jsonb_object_agg(code,amount),'{}') into actual from (
 select f.code,sum(m.amount) amount from public.ledger_movements m join public.ledger_fund_accounts f on f.id=m.fund_account_id where m.transaction_id=any(ids) and f.is_business_fund and f.code<>'card_clearing' group by f.code) x;
 if actual is distinct from (select coalesce(jsonb_object_agg(e->>'account',(e->>'amount')::numeric),'{}') from jsonb_array_elements(expected) e) then raise exception 'CASH_IMPORT_MOVEMENT_MISMATCH';end if;
end $$;

create function public.ledger_import_cash_v1(p_canonical text,p_digest text,p_approval text,p_actor bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare p jsonb;r jsonb;e jsonb;goal jsonb;expected jsonb;prior public.ledger_import_rows%rowtype;
 period_start date;cutoff date;ids bigint[];tx bigint;account bigint;amount numeric;actual numeric;boundary date;
 before_protected jsonb;before_live jsonb;before_funds jsonb;after_funds jsonb;delta jsonb;
 new_rows integer:=0;new_cash integer:=0;new_legs integer:=0;new_refs integer:=0;new_claims integer:=0;existing_rows integer:=0;replay boolean;
begin
 perform ledger_import_private.assert_actor(p_actor);
 if p_digest is null or p_approval is distinct from 'APPROVED:'||p_digest or encode(sha256(convert_to(p_canonical,'UTF8')),'hex') is distinct from p_digest then raise exception 'CASH_IMPORT_APPROVAL';end if;
 p:=p_canonical::jsonb;period_start:=(p->>'period')::date;cutoff:=(p->>'cutoff')::date;
 -- Bind the data approval to this immutable structure version, including direct
 -- RPC calls (not only the operator SQL wrapper).
 if coalesce(jsonb_typeof(p->'engineContracts'),'')<>'array' or jsonb_array_length(p->'engineContracts')<>14 or (select count(distinct entry->>'signature') from jsonb_array_elements(p->'engineContracts') entry)<>14 then raise exception 'CASH_IMPORT_ENGINE_CONTRACT';end if;
 for expected in select value from jsonb_array_elements(p->'engineContracts') loop
  if not exists(select 1 from pg_proc where oid=to_regprocedure(expected->>'signature') and encode(sha256(convert_to(replace(prosrc,E'\r\n',E'\n'),'UTF8')),'hex')=expected->>'hash' and prosecdef=(expected->>'securityDefiner')::boolean and array_to_string(proconfig,',') in('search_path=pg_catalog, public','search_path=pg_catalog,public')) then raise exception 'CASH_IMPORT_ENGINE_CONTRACT';end if;
 end loop;
 if p->>'version' is distinct from 'cash-import-v1' or period_start is null or cutoff is null or period_start<>date_trunc('month',period_start)::date or cutoff<=(period_start+interval '1 month'-interval '1 day')::date
  or coalesce((p->>'sourceRows')::integer,0) not between 1 and 1000 or coalesce(jsonb_typeof(p->'fundDelta'),'')<>'object'
  or (select count(*) from jsonb_object_keys(p->'fundDelta'))<>4
  or exists(select 1 from jsonb_object_keys(p->'fundDelta') k where k not in('store_cash','vuong_personal_custody','cho_personal_custody','baba_corporate_bank'))
  or jsonb_array_length(p->'rows')<>(p->>'sourceRows')::integer or jsonb_array_length(p->'targets')<>extract(day from (period_start+interval '1 month'-interval '1 day'))::integer*4
  or (select count(distinct x->>'key') from jsonb_array_elements(p->'rows') x)<>(p->>'sourceRows')::integer
  or (select count(distinct ((x->>'date')||':'||(x->>'account'))) from jsonb_array_elements(p->'targets') x)<>jsonb_array_length(p->'targets') then raise exception 'CASH_IMPORT_SCOPE';end if;
 perform pg_advisory_xact_lock(hashtext('baba:ledger:cash-import-v1'));
 perform pg_advisory_xact_lock(hashtext('ledger_month_close_serial'));
 perform pg_advisory_xact_lock(hashtext('ledger_month_close'),hashtext(period_start::text));
 perform pg_advisory_xact_lock(hashtext('ledger_month_close:'||to_char(period_start,'YYYY-MM')));
 perform public.ledger_assert_month_open_v1(period_start);

 lock table public.ledger_transactions,public.ledger_movements,public.ledger_audit_logs,public.ledger_import_rows,public.ledger_import_source_claims in share row exclusive mode;
 lock table public.ledger_month_closures in share mode;
 perform id from public.ledger_fund_accounts order by id for share;
 -- A declared boundary must be a real opening for every protected business fund;
 -- an arbitrary date is not permission to omit historical cash from live totals.
 if exists(select 1 from public.ledger_fund_accounts f where f.code in('store_cash','vuong_personal_custody','cho_personal_custody','baba_corporate_bank') and not exists(select 1 from public.ledger_transactions t join public.ledger_movements m on m.transaction_id=t.id where m.fund_account_id=f.id and t.status='confirmed' and t.type='opening' and t.business_date=cutoff)) then raise exception 'CASH_IMPORT_REAL_CUTOFF_OPENING_REQUIRED';end if;
 before_protected:=ledger_import_private.protected(period_start);before_live:=ledger_import_private.funds(cutoff,'infinity'::date);before_funds:=ledger_import_private.funds(period_start,cutoff);
 for expected in select value from jsonb_array_elements(p->'closures') loop
  if not exists(select 1 from public.ledger_month_closures c where c.id=(expected->>'id')::bigint and c.month=(expected->>'month')::date and c.status=expected->>'status' and c.revision=(expected->>'revision')::integer and c.snapshot_hash=expected->>'snapshot_hash') then raise exception 'CASH_IMPORT_CLOSURE_DRIFT';end if;
 end loop;
 for r in select value from jsonb_array_elements(p->'rows') loop
  if (r->>'date')::date<period_start or (r->>'date')::date>=(period_start+interval '1 month')::date
   or right(r->>'key',length(':row:'||(r->>'row'))) is distinct from ':row:'||(r->>'row')
   or (r->>'sourceCanonical')::jsonb is distinct from jsonb_build_object('key',r->>'key','date',r->>'date','effects',r->'effects','referenceEffects',r->'referenceEffects','sourceSnapshot',r->'sourceSnapshot')
   or r->>'sourceRole' is distinct from r->'sourceSnapshot'->'mapping'->>'group'
   or encode(sha256(convert_to(r->>'sourceCanonical','UTF8')),'hex') is distinct from r->>'sourceFingerprint'
   or (select count(distinct e->>'account') from jsonb_array_elements(r->'effects') e)<>jsonb_array_length(r->'effects')
   or exists(select 1 from jsonb_array_elements(r->'effects') e where e->>'account' not in('store_cash','vuong_personal_custody','cho_personal_custody','baba_corporate_bank') or (e->>'amount')::numeric=0 or (e->>'amount')::numeric<>trunc((e->>'amount')::numeric))
   or exists(select 1 from jsonb_array_elements(r->'referenceEffects') e where e->>'account'<>'card_clearing' or (e->>'amount')::numeric=0) then raise exception 'CASH_IMPORT_SOURCE_PAYLOAD';end if;
  select * into prior from public.ledger_import_rows where source_key=r->>'key';replay:=found;
  if replay then
   if prior.source_canonical is distinct from r->>'sourceCanonical' or prior.batch_digest<>p_digest or prior.profile_key<>p->>'profileKey' or not prior.cash_sealed then raise exception 'CASH_IMPORT_SOURCE_CONFLICT';end if;
  end if;
  ids:='{}';tx:=null;
  if r->>'cashStatus'='existing_link' then
   ids:=ledger_import_private.anchors(r);existing_rows:=existing_rows+1;
   perform ledger_import_private.assert_effects(ids,r->'effects');
   if replay and prior.existing_transaction_ids is distinct from ids then raise exception 'CASH_IMPORT_ANCHOR_DRIFT';end if;
  elsif r->>'cashStatus'='cash_record_pending' and jsonb_array_length(r->'effects')>0 then
   if exists(select 1 from public.ledger_audit_logs where action='july_restore_row' and reason=r->>'key') then raise exception 'CASH_IMPORT_ALREADY_RESTORED';end if;
   if replay then
    tx:=prior.cash_transaction_id;
    if not exists(select 1 from public.ledger_transactions t where t.id=tx and t.status='confirmed' and t.type='historical_cash_event' and t.source_key='sheet-cash:'||(r->>'key') and t.source_type='sheet_cash_import' and t.business_date=(r->>'date')::date and t.source_fingerprint=r->>'sourceFingerprint' and t.recognition_month is null and t.category_id is null and t.economic_effect_sign=1) then raise exception 'CASH_IMPORT_REPLAY_TRANSACTION_DRIFT';end if;
   else
    if exists(select 1 from public.ledger_transactions where source_key='sheet-cash:'||(r->>'key')) then raise exception 'CASH_IMPORT_ORPHAN_TRANSACTION';end if;
    select greatest(coalesce(sum(-(e->>'amount')::numeric) filter(where (e->>'amount')::numeric<0),0),coalesce(sum((e->>'amount')::numeric) filter(where (e->>'amount')::numeric>0),0)) into amount from jsonb_array_elements(r->'effects') e;
    insert into public.ledger_transactions(operation_id,type,occurred_at,business_date,amount,status,source_type,source_key,source_snapshot,source_fingerprint,source_synced_at,memo,created_by,confirmed_by)
    values(gen_random_uuid(),'historical_cash_event',((r->>'date')::date+time '12:00') at time zone 'Asia/Ho_Chi_Minh',(r->>'date')::date,amount,'confirmed','sheet_cash_import','sheet-cash:'||(r->>'key'),jsonb_build_object('sourceRowKey',r->>'key','sourceRow',r->>'row','economicStatus','unclassified','cashOnly',true),r->>'sourceFingerprint',now(),'과거 자금 기록 · 분류 대기',p_actor,p_actor) returning id into tx;
    new_cash:=new_cash+1;
    for e in select value from jsonb_array_elements(r->'effects') loop
     select id into strict account from public.ledger_fund_accounts where code=e->>'account' and is_active and is_business_fund and type<>'card_clearing';
     insert into public.ledger_movements(transaction_id,fund_account_id,amount) values(tx,account,(e->>'amount')::numeric);new_legs:=new_legs+1;
    end loop;
   end if;
   perform ledger_import_private.assert_effects(array[tx],r->'effects');
  elsif r->>'cashStatus'='reference_only' and jsonb_array_length(r->'effects')=0 and jsonb_array_length(r->'referenceEffects')>0 then
   if not replay then new_refs:=new_refs+1;end if;
  else raise exception 'CASH_IMPORT_ROW_STATE';end if;
  if not replay then
   insert into public.ledger_import_rows(source_key,profile_key,period,business_date,source_row,source_canonical,source_snapshot,source_fingerprint,cash_effects,reference_effects,source_role,cash_status,cash_transaction_id,existing_transaction_ids,economic_status,batch_digest,created_by)
   values(r->>'key',p->>'profileKey',period_start,(r->>'date')::date,(r->>'row')::integer,r->>'sourceCanonical',r->'sourceSnapshot',r->>'sourceFingerprint',r->'effects',r->'referenceEffects',r->>'sourceRole',case r->>'cashStatus' when 'cash_record_pending' then 'recorded' else r->>'cashStatus' end,tx,ids,case when r->>'cashStatus'='existing_link' then 'resolved' else 'unclassified' end,p_digest,p_actor);
   new_rows:=new_rows+1;
  end if;
  -- Reserve only already-confirmed inventory sources from phases2/3. The211
  -- unclassified cash rows never manufacture inventory/payment claims.
  for e in select value from jsonb_array_elements(r->'sourceClaims') loop
   if r->>'cashStatus'<>'existing_link' or e->>'kind'<>'inventory_log' or not exists(select 1 from public.inventory_logs where id=(e->>'id')::bigint) then raise exception 'CASH_IMPORT_BOOTSTRAP_SOURCE';end if;
   if replay then
    if not exists(select 1 from public.ledger_import_source_claims c where c.source_kind=e->>'kind' and c.source_id=e->>'id' and c.anchor_key=r->>'key') then raise exception 'CASH_IMPORT_BOOTSTRAP_DRIFT';end if;
   else
    insert into public.ledger_import_source_claims(source_kind,source_id,anchor_key,member_keys,created_by) values(e->>'kind',e->>'id',r->>'key',array[r->>'key'],p_actor);new_claims:=new_claims+1;
   end if;
  end loop;
 end loop;
 if existing_rows<>(p->>'existingRows')::integer or new_rows not in(0,(p->>'sourceRows')::integer)
  or (new_rows>0 and (new_cash<>(p->>'newCashRows')::integer or new_legs<>(p->>'newMovementLegs')::integer or new_refs<>(p->>'referenceRows')::integer or new_claims<>coalesce((p->>'bootstrapClaims')::integer,0))) then raise exception 'CASH_IMPORT_BATCH_COUNTS';end if;
 -- Independent daily target proof using the latest real opening for EACH fund.
 for goal in select value from jsonb_array_elements(p->'targets') loop
  if (goal->>'date')::date<period_start or (goal->>'date')::date>=(period_start+interval '1 month')::date or goal->>'account' not in('store_cash','vuong_personal_custody','cho_personal_custody','baba_corporate_bank') then raise exception 'CASH_IMPORT_TARGET_SCOPE';end if;
  select f.id into strict account from public.ledger_fund_accounts f where f.code=goal->>'account';
  select max(t.business_date) into boundary from public.ledger_transactions t join public.ledger_movements m on m.transaction_id=t.id where m.fund_account_id=account and t.type='opening' and t.status='confirmed' and t.business_date<=period_start;
  if boundary is null then raise exception 'CASH_IMPORT_OPENING_REQUIRED';end if;
  select coalesce(sum(m.amount),0) into actual from public.ledger_movements m join public.ledger_transactions t on t.id=m.transaction_id where m.fund_account_id=account and t.status='confirmed' and t.business_date>=boundary and t.business_date<=(goal->>'date')::date;
  if actual<>(goal->>'target')::numeric then raise exception 'CASH_IMPORT_DAILY_TARGET: % %',goal->>'date',goal->>'account';end if;
 end loop;
 after_funds:=ledger_import_private.funds(period_start,cutoff);
 for e in select jsonb_build_object('key',key,'value',value) from jsonb_each(p->'fundDelta') loop
  if (after_funds->>(e->>'key'))::numeric-(before_funds->>(e->>'key'))::numeric<>(case when new_rows>0 then (e->>'value')::numeric else 0 end) then raise exception 'CASH_IMPORT_BATCH_DELTA';end if;
 end loop;
 if before_live is distinct from ledger_import_private.funds(cutoff,'infinity'::date) or before_funds->'card_clearing' is distinct from after_funds->'card_clearing' or before_protected is distinct from ledger_import_private.protected(period_start) then raise exception 'CASH_IMPORT_PROTECTED_CHANGED';end if;
 if new_rows>0 then
  update public.ledger_import_rows set cash_sealed=true where profile_key=p->>'profileKey' and period=period_start;
  insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,after_snapshot,reason) values(p_actor,'cash_import_batch','cash_import',null,jsonb_build_object('batchDigest',p_digest,'cashRows',new_cash,'referenceRows',new_refs,'movementLegs',new_legs,'cashReconciled',true,'economicClosed',false),p->>'profileKey');
 end if;
 return jsonb_build_object('status',case when new_rows=0 then 'duplicate' else 'imported' end,'registryRows',new_rows,'cashRows',new_cash,'movementLegs',new_legs,'referenceRows',new_refs,'matchedCells',jsonb_array_length(p->'targets'),'cashReconciled',true,'economicClosed',false);
end $$;

-- No setting/GUC escape hatch: once sealed, old/new business-fund movements and
-- their confirmed transactions cannot be rewritten through ANY native RPC.
create function public.ledger_import_movement_guard_v1() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare old_date date;new_date date;old_fund bigint;new_fund bigint;
begin
 if tg_op<>'INSERT' then select business_date into old_date from public.ledger_transactions where id=old.transaction_id;old_fund:=old.fund_account_id;end if;
 if tg_op<>'DELETE' then select business_date into new_date from public.ledger_transactions where id=new.transaction_id;new_fund:=new.fund_account_id;end if;
 if exists(select 1 from public.ledger_import_rows r where r.cash_sealed and ((old_date>=r.period and old_date<(r.period+interval '1 month')::date and exists(select 1 from public.ledger_fund_accounts where id=old_fund and is_business_fund and code<>'card_clearing')) or (new_date>=r.period and new_date<(r.period+interval '1 month')::date and exists(select 1 from public.ledger_fund_accounts where id=new_fund and is_business_fund and code<>'card_clearing')))) then raise exception 'CASH_IMPORT_PERIOD_SEALED_REUSE_CASH';end if;
 return case when tg_op='DELETE' then old else new end;
end $$;
create trigger ledger_import_movement_guard before insert or update or delete on public.ledger_movements for each row execute function public.ledger_import_movement_guard_v1();
create function public.ledger_import_transaction_guard_v1() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if tg_op='INSERT' and new.source_type='cash_import_recognition' and new.source_key='cash-import-economics:'||(new.source_snapshot->>'anchorKey')
  and new.type in('expense_recognition','income','sales') and new.recognition_month is not null and new.category_id is not null
  and exists(select 1 from public.ledger_import_source_claims c join public.ledger_import_rows r on r.source_key=c.anchor_key where c.anchor_key=new.source_snapshot->>'anchorKey' and c.economic_transaction_id is null and r.economic_status='source_identified' and r.source_role not in('pos_card','card_deposit')) then return new;end if;
 if exists(select 1 from public.ledger_import_rows r where r.cash_sealed and ((tg_op<>'INSERT' and old.business_date>=r.period and old.business_date<(r.period+interval '1 month')::date) or (tg_op<>'DELETE' and new.business_date>=r.period and new.business_date<(r.period+interval '1 month')::date))) then raise exception 'CASH_IMPORT_PERIOD_SEALED_USE_LINK_RPC';end if;
 return case when tg_op='DELETE' then old else new end;
end $$;

-- Optional FOLLOW-UP only: explicit economic approval, identified source group,
-- one unique non-cash journal. Never called by the241-row cash batch.
create function public.ledger_recognize_import_group_v1(p_canonical text,p_digest text,p_approval text,p_actor bigint) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare p jsonb;r public.ledger_import_rows%rowtype;t public.ledger_transactions%rowtype;tx bigint;members text[];
begin
 perform ledger_import_private.assert_actor(p_actor);
 if p_approval is distinct from 'APPROVED_ECONOMICS:'||p_digest or encode(sha256(convert_to(p_canonical,'UTF8')),'hex') is distinct from p_digest then raise exception 'CASH_IMPORT_ECONOMIC_APPROVAL';end if;
 p:=p_canonical::jsonb;
 perform pg_advisory_xact_lock(hashtext('baba:ledger:cash-import-v1'));
 select * into strict r from public.ledger_import_rows where source_key=p->>'anchorKey' for update;
 select * into t from public.ledger_transactions where source_type='cash_import_recognition' and source_key='cash-import-economics:'||r.source_key;
 if found then if t.source_fingerprint<>p_digest then raise exception 'CASH_IMPORT_ECONOMIC_CONFLICT';end if;return jsonb_build_object('status','duplicate','transactionId',t.id,'newCashMovements',0);end if;
 if not r.cash_sealed or r.economic_status<>'source_identified' or r.source_role in('pos_card','card_deposit')
  or not exists(select 1 from public.ledger_import_source_claims where anchor_key=r.source_key)
  or exists(select 1 from public.ledger_import_source_claims where anchor_key=r.source_key and (economic_transaction_id is not null or source_kind in('payable','payroll_adjustment','owner_investment')))
  or p->>'type' not in('expense_recognition','income','sales') or coalesce(length(btrim(p->>'reason')),0)<10
  or coalesce((p->>'amount')::numeric,0)<=0 or (p->>'amount')::numeric<>trunc((p->>'amount')::numeric)
  or (p->>'recognitionMonth')::date is null or (p->>'recognitionMonth')::date<>date_trunc('month',(p->>'recognitionMonth')::date)::date
  or (p->>'businessDate')::date is null or date_trunc('month',(p->>'businessDate')::date)::date<>(p->>'recognitionMonth')::date
  or not exists(select 1 from public.ledger_categories where id=(p->>'categoryId')::bigint and is_active and kind=case when p->>'type'='expense_recognition' then 'expense' else 'income' end) then raise exception 'CASH_IMPORT_ECONOMIC_EVIDENCE_REQUIRED';end if;
 perform public.ledger_assert_month_open_v1((p->>'recognitionMonth')::date);
 select array_agg(distinct member) into members from public.ledger_import_source_claims c,unnest(c.member_keys) member where c.anchor_key=r.source_key;
 if exists(select 1 from public.ledger_import_rows where source_key=any(members) and (economic_status='resolved' or source_role in('pos_card','card_deposit'))) then raise exception 'CASH_IMPORT_ALREADY_RECOGNIZED';end if;
 insert into public.ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,status,source_type,source_key,source_snapshot,source_fingerprint,source_synced_at,memo,created_by,confirmed_by)
 values(gen_random_uuid(),p->>'type',(p->>'businessDate')::date+time '12:00' at time zone 'Asia/Ho_Chi_Minh',(p->>'businessDate')::date,(p->>'recognitionMonth')::date,(p->>'amount')::numeric,(p->>'categoryId')::bigint,'confirmed','cash_import_recognition','cash-import-economics:'||r.source_key,p,p_digest,now(),p->>'reason',p_actor,p_actor) returning id into tx;
 -- Deliberately NO ledger_movements/payable/advance/investment writes.
 update public.ledger_import_source_claims set economic_transaction_id=tx where anchor_key=r.source_key;
 update public.ledger_import_rows set economic_status='resolved' where source_key=any(members);
 insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,after_snapshot,reason) values(p_actor,'cash_import_economic_recognized','transaction',tx,jsonb_build_object('digest',p_digest,'anchorKey',r.source_key,'cashTransactionId',r.cash_transaction_id,'newCashMovements',0),p->>'reason');
 return jsonb_build_object('status','recognized','transactionId',tx,'newCashMovements',0);
end $$;
create trigger ledger_import_transaction_guard before insert or update or delete on public.ledger_transactions for each row execute function public.ledger_import_transaction_guard_v1();
create function public.ledger_import_registry_guard_v1() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if old.cash_sealed and (tg_op='DELETE' or (to_jsonb(old)-'economic_status') is distinct from (to_jsonb(new)-'economic_status')) then raise exception 'CASH_IMPORT_IMMUTABLE_SOURCE';end if;
 return case when tg_op='DELETE' then old else new end;
end $$;
create trigger ledger_import_registry_guard before update or delete on public.ledger_import_rows for each row execute function public.ledger_import_registry_guard_v1();

create function public.ledger_link_import_source_v1(p_row_key text,p_source_kind text,p_source_id text,p_anchor_key text,p_economic_tx bigint,p_actor bigint) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.ledger_import_rows%rowtype;a public.ledger_import_rows%rowtype;c public.ledger_import_source_claims%rowtype;table_name text;present boolean;claim_id bigint;movement_ids bigint[];
begin
 perform ledger_import_private.assert_actor(p_actor);
 perform pg_advisory_xact_lock(hashtext('baba:ledger:cash-import-v1'));
 select * into strict r from public.ledger_import_rows where source_key=p_row_key for update;
 select * into strict a from public.ledger_import_rows where source_key=p_anchor_key for update;
 -- The same invoice can have cash payments in different months. Ownership is
 -- global per source; each member keeps its own immutable cash/period record.
 if not r.cash_sealed or not a.cash_sealed then raise exception 'CASH_IMPORT_LINK_SCOPE';end if;
 table_name:=case p_source_kind when 'pos_payment' then 'pos_sales_receipt_payments' when 'pos_receipt' then 'pos_sales_receipts' when 'inventory_log' then 'inventory_logs' when 'payable' then 'ledger_payables' when 'payroll_adjustment' then 'payroll_monthly_adjustments' when 'owner_investment' then 'ledger_owner_investments' when 'document' then null else '' end;
 if table_name='' or nullif(btrim(p_source_id),'') is null then raise exception 'CASH_IMPORT_SOURCE_KIND';end if;
 if table_name is not null then execute format('select exists(select 1 from public.%I where id=$1)',table_name) into present using p_source_id::bigint;if not present then raise exception 'CASH_IMPORT_SOURCE_MISSING';end if;end if;
 if p_economic_tx is not null and (not exists(select 1 from public.ledger_transactions where id=p_economic_tx and status='confirmed') or exists(select 1 from public.ledger_movements where transaction_id=p_economic_tx and transaction_id<>coalesce(r.cash_transaction_id,0) and not(transaction_id=any(r.existing_transaction_ids)))) then raise exception 'CASH_IMPORT_LINK_MUST_REUSE_CASH';end if;
 select * into c from public.ledger_import_source_claims where source_kind=p_source_kind and source_id=p_source_id for update;
 if found then
  if c.anchor_key<>p_anchor_key or (c.economic_transaction_id is not null and c.economic_transaction_id is distinct from p_economic_tx) then raise exception 'CASH_IMPORT_SOURCE_ALREADY_CLAIMED';end if;
  if p_row_key=any(c.member_keys) and c.economic_transaction_id is not distinct from p_economic_tx then return jsonb_build_object('status','duplicate','claimId',c.id,'cashTransactionId',r.cash_transaction_id);end if;
  update public.ledger_import_source_claims set member_keys=case when p_row_key=any(member_keys) then member_keys else array_append(member_keys,p_row_key) end,economic_transaction_id=coalesce(economic_transaction_id,p_economic_tx) where id=c.id;claim_id:=c.id;
 else
  insert into public.ledger_import_source_claims(source_kind,source_id,anchor_key,member_keys,economic_transaction_id,created_by) values(p_source_kind,p_source_id,p_anchor_key,array[p_row_key],p_economic_tx,p_actor) returning id into claim_id;
 end if;
 if r.economic_status='unclassified' then update public.ledger_import_rows set economic_status='source_identified' where source_key=p_row_key;end if;
 select array_agg(id order by id) into movement_ids from public.ledger_movements where transaction_id=coalesce(r.cash_transaction_id,0) or transaction_id=any(r.existing_transaction_ids);
 insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,after_snapshot,reason) values(p_actor,'cash_import_source_linked','cash_import_claim',claim_id,jsonb_build_object('rowKey',p_row_key,'cashTransactionId',r.cash_transaction_id,'cashMovementIds',movement_ids,'economicStatus','source_identified'),p_anchor_key);
 return jsonb_build_object('status','linked','claimId',claim_id,'cashTransactionId',r.cash_transaction_id,'cashMovementIds',movement_ids,'newCashMovements',0);
end $$;

create function public.ledger_cash_import_status_v1(p_month date,p_actor bigint) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare n integer;pending integer;sealed boolean;
begin
 perform ledger_import_private.assert_actor(p_actor);
 select count(*),count(*) filter(where economic_status<>'resolved'),coalesce(bool_and(cash_sealed),false) into n,pending,sealed from public.ledger_import_rows where period=date_trunc('month',p_month)::date;
 return jsonb_build_object('rows',n,'cashReconciled',n>0 and sealed,'economicClosed',n>0 and sealed and pending=0,'economicPending',pending);
end $$;

create function public.ledger_preflight_cash_import_v1(p_canonical text,p_digest text,p_actor bigint) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare p jsonb;r jsonb;goal jsonb;ids bigint[];account bigint;boundary date;actual numeric;added numeric;bad integer:=0;n integer:=0;
begin
 perform ledger_import_private.assert_actor(p_actor);
 if encode(sha256(convert_to(p_canonical,'UTF8')),'hex') is distinct from p_digest then raise exception 'CASH_IMPORT_PREFLIGHT_DIGEST';end if;
 p:=p_canonical::jsonb;
 for r in select value from jsonb_array_elements(p->'rows') loop
  if r->>'cashStatus'='existing_link' then ids:=ledger_import_private.anchors(r);perform ledger_import_private.assert_effects(ids,r->'effects');end if;
  if r->>'cashStatus'='cash_record_pending' and exists(select 1 from public.ledger_audit_logs where action='july_restore_row' and reason=r->>'key') then raise exception 'CASH_IMPORT_ALREADY_RESTORED';end if;
 end loop;
 for goal in select value from jsonb_array_elements(p->'targets') loop
  select id into strict account from public.ledger_fund_accounts where code=goal->>'account';
  select max(t.business_date) into boundary from public.ledger_transactions t join public.ledger_movements m on m.transaction_id=t.id where m.fund_account_id=account and t.status='confirmed' and t.type='opening' and t.business_date<=(p->>'period')::date;
  if boundary is null then raise exception 'CASH_IMPORT_OPENING_REQUIRED';end if;
  select coalesce(sum(m.amount),0) into actual from public.ledger_movements m join public.ledger_transactions t on t.id=m.transaction_id where m.fund_account_id=account and t.status='confirmed' and t.business_date>=boundary and t.business_date<=(goal->>'date')::date;
  select coalesce(sum((effect->>'amount')::numeric),0) into added from jsonb_array_elements(p->'rows') item,jsonb_array_elements(item->'effects') effect where item->>'cashStatus'='cash_record_pending' and (item->>'date')::date<=(goal->>'date')::date and effect->>'account'=goal->>'account' and not exists(select 1 from public.ledger_import_rows where source_key=item->>'key');
  n:=n+1;if actual+added<>(goal->>'target')::numeric then bad:=bad+1;end if;
 end loop;
 return jsonb_build_object('status',case when bad=0 then 'ready' else 'blocked' end,'matchedCells',n-bad,'mismatches',bad,'productionWrites',0,'economicClosed',false);
end $$;
create function public.ledger_import_close_guard_v1() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if new.status='closed' and exists(select 1 from public.ledger_import_rows where period=new.month and (not cash_sealed or economic_status<>'resolved')) then raise exception 'CASH_RECONCILED_NOT_ECONOMIC_CLOSED';end if;return new;
end $$;
create trigger ledger_import_close_guard before insert or update on public.ledger_month_closures for each row execute function public.ledger_import_close_guard_v1();

revoke all on all functions in schema ledger_import_private from public,anon,authenticated,service_role;
revoke all on function public.ledger_import_cash_v1(text,text,text,bigint),public.ledger_link_import_source_v1(text,text,text,text,bigint,bigint),public.ledger_cash_import_status_v1(date,bigint),public.ledger_preflight_cash_import_v1(text,text,bigint),public.ledger_recognize_import_group_v1(text,text,text,bigint) from public,anon,authenticated;
grant execute on function public.ledger_import_cash_v1(text,text,text,bigint),public.ledger_link_import_source_v1(text,text,text,text,bigint,bigint),public.ledger_cash_import_status_v1(date,bigint),public.ledger_preflight_cash_import_v1(text,text,bigint),public.ledger_recognize_import_group_v1(text,text,text,bigint) to service_role;
revoke all on function public.ledger_import_movement_guard_v1(),public.ledger_import_transaction_guard_v1(),public.ledger_import_registry_guard_v1(),public.ledger_import_close_guard_v1() from public,anon,authenticated,service_role;
commit;
