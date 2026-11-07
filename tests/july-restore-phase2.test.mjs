import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {reconstruct,reviewRuntime,summary,sha,ASSIGNED,WEAK,FRUIT} from '../scripts/ledger/july-restore-phase2.mjs';
import {planPhase2,renderPhase2,PHASE2_RESOLVER_BODY_DIGEST} from '../scripts/ledger/july-restore-phase2-plan.mjs';
const read=p=>readFileSync(p,'utf8');
const root=process.env.JULY_PHASE2_INPUT_DIR;
const observed=()=>({source:JSON.parse(read(join(root,'dry-run-20261107-v2/395-row-dry-run.json'))),capture:JSON.parse(read(join(root,'phase2-runtime-20261107/runtime-readonly.json')))});

test('reconstruction preserves explicit exclusions/corrections, seven fruit rows and six weak rows', {skip:!root},()=>{
 const {source}=observed(),r=reconstruct(source),s=summary(r),by=n=>r.find(x=>x.row===n);
 assert.equal(r.length,345);assert.equal(r.filter(x=>x.inventoryIds.length).length,128);
 assert.deepEqual(s.byEvidence,{A:{rows:96,paid:'33471342'},B:{rows:32,paid:'85519800'},C:{rows:217,paid:'1046572285'}});
 assert.deepEqual(by(53).inventoryIds,[5914,5915,5916]);assert.deepEqual(by(53).excludedIds,[5912,5913]);
 assert.deepEqual(by(81).inventoryIds,[6212,6213,6214]);assert.deepEqual(by(81).excludedIds,[6217]);
 assert.deepEqual(by(111).correctionIds,[6421]);assert.deepEqual(by(137).correctionIds,[6196]);
 assert.equal(FRUIT.reduce((s,n)=>s+Number(by(n).paid),0),2294000);
 assert.ok(WEAK.every(n=>by(n).evidenceClass==='B'&&by(n).blockers.includes('OWNER_WEAK_SIX')));
 // A cross-row assignment is blocked, rather than counting the same log twice.
 const original=ASSIGNED[9];try{ASSIGNED[9]=[5580,5582];const dup=reconstruct(source);assert.ok(dup.find(x=>x.row===14).blockers.includes('CROSS_ROW_SOURCE_DUPLICATE'));}finally{ASSIGNED[9]=original;}
});

test('current scoped GET evidence yields only 33 exact single-log expenses; candidate/payable/source drift prevents promotion', {skip:!root},()=>{
 const {source,capture}=observed(),r=reconstruct(source),plan=planPhase2(r,capture);
 assert.equal(plan.summary.byState.ready.rows,33);assert.equal(plan.summary.byState.ready.paid,'7152000');
 assert.deepEqual(plan.summary.readyFundDelta,{store_cash:'-7152000',vuong_personal_custody:'0',cho_personal_custody:'0',baba_corporate_bank:'0'});
 assert.equal(plan.rows.filter(x=>x.previousPosLink).length,0); // Link metadata is appended only by the output adapter.
 for(const mutate of [
  x=>x.tables.candidates.push({source_key:'inventory-log:5615'}),
  x=>{x.tables.inventoryLogs.find(l=>l.id===5615).new_purchase_price+=1;},
  x=>{x.tables.inventoryLogs.find(l=>l.id===5615).business_date='2026-06-30';},
  x=>{x.tables.payables.push({id:999,party_id:7,expense_transaction_id:123,status:'paid'});x.tables.payableTransactions.push({id:123,business_date:'2026-06-30'});},
 ]){const c=structuredClone(capture);mutate(c);assert.notEqual(reviewRuntime(r,c).find(x=>x.row===16).state,'ready');}
 assert.throws(()=>reviewRuntime(r,{...capture,status:'BLOCKED_READ_CAPTURE'}),/INCOMPLETE/);
 assert.ok(plan.rows.filter(x=>WEAK.includes(x.row)).every(x=>x.state!=='ready'));
});

const key=n=>'sheet:1BRT2ul07GftjqVPwcIf35o3LDJ6RjPIdWL_YeiRqDx4:tab:829182003:row:'+n;
const makePayload=(logs,closures)=>{
 const actions=logs.map((l,i)=>{const row=[27,32][i],a={row,key:key(row),sourceKey:'july-restore:'+key(row),date:l.business_date,amount:String(l.change_quantity*l.new_purchase_price),account:'store_cash',categoryId:8,partyId:10,logExpected:l};return {...a,actionHash:sha(a)};});
 const bundle={profile:'july-phase2-single-log-immediate',actions,fundDelta:{store_cash:'-56000',vuong_personal_custody:'0',cho_personal_custody:'0',baba_corporate_bank:'0'},closures,cardCarryoverBlocked:'-6102347'};
 const bundleCanonical=JSON.stringify(bundle);return {bundle,bundleCanonical,bundleDigest:sha(bundleCanonical)};
};
const approve=p=>renderPhase2(p).replaceAll('__ACTOR_USER_ID__','2').replaceAll('__OWNER_APPROVAL__','APPROVED:'+sha(JSON.stringify(p)));
const tables=['ledger_transactions','ledger_movements','ledger_audit_logs','ledger_candidates','ledger_payables','ledger_payable_allocations','ledger_card_reconciliations','ledger_card_reconciliation_lines','ledger_card_fee_closures','ledger_card_fee_allocation_lines','ledger_month_closures','ledger_month_closure_history','inventory_logs','inventory'];
async function dump(db){const result={};for(const t of tables)result[t]=(await db.query(`select * from ${t} order by id`)).rows;return JSON.stringify(result);}
function deployedResolver(){
 const migration=name=>read('supabase/migrations/'+name).replaceAll('\r\n','\n');
 const initial=migration('202608210003_add_inventory_purchase_candidates.sql').split('create or replace function public.ledger_resolve_inventory_candidate_v1')[1];
 const definition='create or replace function public.ledger_resolve_inventory_candidate_v1'+initial.slice(0,initial.indexOf('end $$;')+8);
 const oldBody=definition.match(/as \$\$([\s\S]*?)\$\$;/)[1];let body=oldBody;
 const projection=migration('20260906114438_project_inventory_purchase_logs.sql');
 const locking=projection.split("v_oid := 'public.ledger_resolve_inventory_candidate_v1")[1].split("v_oid := 'public.ledger_sync")[0];
 const decode=s=>s.replaceAll("''","'");
 const anchor=decode(locking.match(/v_anchor := '((?:[^']|'')*)';/)[1]);
 const preamble=locking.match(/v_preamble := \$patch\$([\s\S]*?)\$patch\$;/)[1];
 assert.ok(body.includes(anchor));body=body.replaceAll(anchor,preamble+anchor);
 const verification=migration('20260921170100_add_inventory_payment_verification.sql').split('  -- The current reconciliation')[0];
 let patches=0;
 for(const m of verification.matchAll(/v_definition := replace\(v_definition,\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)'\);/g)){
  assert.ok(body.includes(decode(m[1])));body=body.replaceAll(decode(m[1]),decode(m[2]));patches++;
 }
 assert.equal(patches,4);assert.equal(sha(body),PHASE2_RESOLVER_BODY_DIGEST);
 const lockFunction=projection.slice(projection.indexOf('create function inventory_ledger_private.lock_sources'),projection.indexOf('alter function inventory_ledger_private.lock_sources'));
 return {body,oldBody,definition:definition.replace(oldBody,body),lockFunction};
}
async function fixture(){
 const {PGlite}=createRequire(process.env.JULY_QA_PACKAGE_JSON||import.meta.url)('@electric-sql/pglite'),db=new PGlite();
 await db.exec(read('tests/ledger-july-opening-oneoff-db.test.mjs').match(/const FIXTURE = `([\s\S]*?)`;/)[1]);
 const migration=read('supabase/migrations/202608210003_add_inventory_purchase_candidates.sql');
 await db.exec(migration.slice(migration.indexOf('create table public.ledger_inventory_category_mappings'),migration.indexOf('alter table public.ledger_inventory_category_mappings enable')));
 const resolver=deployedResolver();
 await db.exec('create schema inventory_ledger_private');
 await db.exec(resolver.definition);
 await db.exec(`alter table ledger_categories add column kind text default 'expense',add column is_active boolean default true;
  alter table ledger_parties add column is_active boolean default true;
  insert into ledger_parties values(10,'Chợ',true);
  create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key);insert into supabase_migrations.schema_migrations values('20261105153442');
  create table inventory(id bigint primary key,quantity numeric,purchase_price numeric,updated_at timestamptz);
  create table inventory_logs(id bigint primary key,item_id bigint,item_name text,item_name_vi text,category text,category_vi text,unit text,change_quantity numeric,new_purchase_price numeric,new_supplier text,business_date date,created_at timestamptz,source text,reason text,billed_amount numeric,purchase_supplier_partner_id bigint,correction_of_inventory_log_id bigint);
  create table ledger_inventory_projection_status(inventory_log_id bigint primary key,status text);
  create table ledger_month_closure_history(id bigint primary key,month date,snapshot_hash text);
  create table ledger_card_reconciliations(id bigint primary key,status text);insert into ledger_card_reconciliations values(69,'matched');
  create table ledger_card_reconciliation_lines(id bigint primary key,pos_card_transaction_id bigint);insert into ledger_card_reconciliation_lines values(1,1190);
  create table ledger_card_fee_closures(id bigint primary key);create table ledger_card_fee_allocation_lines(id bigint primary key);
  insert into ledger_inventory_category_mappings(inventory_category,ledger_category_id) values('Food',8);
  insert into ledger_supplier_party_mappings(supplier_name,party_id) values('Chợ',10);
  insert into inventory values(100,100,30000,now()),(101,20,26000,now());
  insert into inventory_logs values(10001,100,'Bread','Banh','Food','Food','piece',1,30000,'Chợ','2026-07-03','2026-07-03T05:00:00Z','quick_save','purchase',null,null,null),
   (10002,101,'Potato','Khoai','Food','Food','kg',1,26000,'Chợ','2026-07-03','2026-07-03T06:00:00Z','quick_save','purchase',null,null,null);
  insert into ledger_payables(id,expense_transaction_id,party_id,original_amount,status) values(1830,3804,9,15426000,'paid');
  insert into ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount) values(1830,100,15426000);`);
 await db.exec(resolver.lockFunction);
 const month=read('supabase/migrations/202608210008_add_ledger_month_close_corrections.sql');
 await db.exec(month.slice(month.indexOf('create or replace function public.ledger_candidate_resolution_month_guard_v1'),month.indexOf('create or replace function public.ledger_confirmed_candidate_drift_v1')));
 // Existing restored 49 are immutable pre-existing rows, never rerun their SQL.
 await db.exec(`insert into ledger_transactions(id,operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,status,source_type,source_key,created_by,confirmed_by)
  select 4227+n,gen_random_uuid(),'expense','2026-07-01T03:00:00+07','2026-07-01','2026-07-01',1234,8,'confirmed','manual','existing49:'||n,2,2 from generate_series(0,48) n;`);
 const logs=(await db.query('select to_jsonb(l) data from inventory_logs l order by id')).rows.map(r=>r.data);
 const closures=(await db.query('select id,month::text,status,revision,snapshot_hash from ledger_month_closures order by id')).rows;
 return {db,payload:makePayload(logs,closures)};
}

test('resolver normalized body exactly matches owner-observed production hash after both historical patches',async()=>{
 const r=deployedResolver();
 assert.equal(sha(r.oldBody),'71fe505c58e76dfbf33eec4a3adc98472521c14adb522e731c51990fd8f3ffa3');
 const {db}=await fixture();try{
  const result=(await db.query("select encode(sha256(convert_to(replace(prosrc,E'\\r\\n',E'\\n'),'UTF8')),'hex') hash from pg_proc where oid='public.ledger_resolve_inventory_candidate_v1(bigint,text,bigint,bigint,bigint,date,text,text,bigint)'::regprocedure")).rows[0];
  assert.equal(result.hash,PHASE2_RESOLVER_BODY_DIGEST);
 }finally{await db.close();}
});

test('resolver production contract: owner/master, immediate single expense/payment, pending confirmation, duplicate and closed-July guards',async()=>{
 const {db}=await fixture();try{
  const add=async(id,amount)=>Number((await db.query(`insert into ledger_candidates(candidate_type,source_type,source_key,business_date,proposed_amount,proposed_recognition_month,source_snapshot,source_fingerprint)
   values('inventory_purchase','inventory_purchase_log',$1,'2026-07-03',$2,'2026-07-01','{}',repeat('a',64)) returning id`,['inventory-log:'+id,amount])).rows[0].id);
  const call=async(id,actor)=>(await db.query("select ledger_resolve_inventory_candidate_v1($1,'immediate',8,10,1,null,'contract test','contract test',$2) result",[id,actor])).rows[0].result;
  const id=await add(10001,30000),before=await dump(db);
  for(const actor of [3,4,22,999])assert.equal((await call(id,actor)).status,'forbidden');
  assert.equal(await dump(db),before);
  await assert.rejects(add(10001,30000),e=>e.code==='23505');
  const owner=await call(id,2);assert.equal(owner.status,'confirmed');assert.equal(owner.payableId,null);
  const tx=(await db.query('select type,amount::bigint::text amount,business_date::text,recognition_month::text,confirmed_by from ledger_transactions where id=$1',[owner.transactionId])).rows[0];
  assert.deepEqual(tx,{type:'expense',amount:'30000',business_date:'2026-07-03',recognition_month:'2026-07-01',confirmed_by:2});
  assert.deepEqual((await db.query('select fund_account_id,amount::bigint::text amount from ledger_movements where transaction_id=$1',[owner.transactionId])).rows,[{fund_account_id:1,amount:'-30000'}]);
  assert.equal((await db.query('select status from ledger_candidates where id=$1',[id])).rows[0].status,'confirmed');
  assert.equal((await db.query('select count(*) n from ledger_payables')).rows[0].n,1);
  const first=await dump(db);assert.equal((await call(id,2)).status,'already_resolved');assert.equal(await dump(db),first);
  const second=await add(10002,26000);assert.equal((await call(second,1)).status,'confirmed');
  assert.equal((await db.query("select count(*) n from ledger_transactions where source_type='inventory_purchase_candidate'")).rows[0].n,2);
  const pending=await add(10003,12000);
  await db.exec("insert into ledger_month_closures(month,status,closed_by,summary_snapshot,snapshot_hash) values('2026-07-01','closed',2,'{}',repeat('b',64))");
  const closed=await dump(db);await assert.rejects(call(pending,2),/closed/i);assert.equal(await dump(db),closed);
 }finally{await db.close();}
});

test('batch uses canonical resolver once per log, exact source keys, no payables and identical replay; August/card/old49 preserved',async()=>{
 const {db,payload}=await fixture();try{
  const old=(await db.query('select jsonb_agg(t order by id) x from ledger_transactions t where id>=4227 and id<=4275')).rows[0].x;
  await db.exec(approve(payload));
  assert.equal((await db.query("select count(*) n from ledger_candidates where status='confirmed'")).rows[0].n,2);
  assert.deepEqual((await db.query("select source_key from ledger_transactions where source_type='inventory_purchase_candidate' order by id")).rows.map(r=>r.source_key),payload.bundle.actions.map(a=>a.sourceKey));
  assert.equal((await db.query('select count(*) n from ledger_payables')).rows[0].n,1);
  assert.equal((await db.query('select sum(m.amount)::bigint::text n from ledger_movements m join ledger_transactions t on t.id=m.transaction_id where t.source_type=\'inventory_purchase_candidate\'')).rows[0].n,'-56000');
  assert.deepEqual((await db.query('select jsonb_agg(t order by id) x from ledger_transactions t where id>=4227 and id<=4275')).rows[0].x,old);
  const first=await dump(db);await db.exec(approve(payload));assert.equal(await dump(db),first);
 }finally{await db.close();}
});

test('actual reviewed 33-row draft runs and replays in local DB with preserved source logs/stock and exact account delta',{skip:!root},async()=>{
 const {source,capture}=observed(),{payload}=planPhase2(reconstruct(source),capture),{db}=await fixture();
 try{
  await db.exec('delete from inventory_logs;delete from inventory');
  const neededLogs=payload.bundle.actions.map(a=>a.logExpected),itemIds=[...new Set(neededLogs.map(l=>l.item_id))];
  for(const i of capture.tables.inventoryItems.filter(i=>itemIds.includes(i.id)))await db.query('insert into inventory values($1,$2,$3,$4)',[i.id,i.quantity,i.purchase_price,i.updated_at]);
  const fields=Object.keys(neededLogs[0]);
  for(const l of neededLogs)await db.query(`insert into inventory_logs(${fields.join(',')}) values(${fields.map((_,i)=>'$'+(i+1)).join(',')})`,fields.map(f=>l[f]));
  const categoryIds=payload.bundle.actions.map(a=>a.categoryId),partyIds=payload.bundle.actions.map(a=>a.partyId);
  for(const c of capture.tables.categories.filter(c=>categoryIds.includes(c.id)))await db.query('insert into ledger_categories(id,name,kind,is_active) values($1,$2,$3,$4) on conflict(id) do update set name=excluded.name,kind=excluded.kind,is_active=excluded.is_active',[c.id,c.name,c.kind,c.is_active]);
  for(const p of capture.tables.parties.filter(p=>partyIds.includes(p.id)))await db.query('insert into ledger_parties(id,name,is_active) values($1,$2,$3) on conflict(id) do update set name=excluded.name,is_active=excluded.is_active',[p.id,p.name,p.is_active]);
  for(const m of capture.tables.categoryMappings.filter(m=>categoryIds.includes(m.ledger_category_id)))await db.query('insert into ledger_inventory_category_mappings(inventory_category,ledger_category_id,is_active) values($1,$2,$3)',[m.inventory_category,m.ledger_category_id,m.is_active]);
  for(const m of capture.tables.supplierMappings.filter(m=>partyIds.includes(m.party_id)&&m.supplier_name!=='Chợ'))await db.query('insert into ledger_supplier_party_mappings(supplier_name,party_id,is_active) values($1,$2,$3)',[m.supplier_name,m.party_id,m.is_active]);
  try{await db.exec(approve(payload));}catch(e){throw Error(e.message);}
  assert.equal((await db.query("select count(*) n from ledger_candidates where status='confirmed'")).rows[0].n,33);
  assert.equal((await db.query("select sum(m.amount)::bigint::text n from ledger_movements m join ledger_transactions t on t.id=m.transaction_id where t.source_type='inventory_purchase_candidate'")).rows[0].n,'-7152000');
  const after=await dump(db);try{await db.exec(approve(payload));}catch(e){throw Error(e.message);}assert.equal(await dump(db),after);
 }finally{await db.close();}
});

test('unapproved, changed payload/applied scope, missing boundary and changed resolver fail before writes',async()=>{
 const {db,payload}=await fixture();try{
  const before=await dump(db);
  for(const sql of [renderPhase2(payload),approve(payload).replace('"amount":"30000"','"amount":"30001"'),approve(payload).replaceAll(key(27),key(11))]){
   await assert.rejects(db.exec(sql));await db.exec('ROLLBACK');assert.equal(await dump(db),before);
  }
  await db.exec("delete from supabase_migrations.schema_migrations");
  await assert.rejects(db.exec(approve(payload)),/BOUNDARY_NOT_INSTALLED/);await db.exec('ROLLBACK');assert.equal(await dump(db),before);
  await db.exec("insert into supabase_migrations.schema_migrations values('20261105153442');create or replace function public.ledger_resolve_inventory_candidate_v1(p_candidate_id bigint,p_resolution text,p_category_id bigint,p_party_id bigint,p_fund_account_id bigint,p_due_date date,p_memo text,p_reason text,p_actor_user_id bigint) returns jsonb language sql as $$select '{}'::jsonb$$");
  await assert.rejects(db.exec(approve(payload)),/RESOLVER_CONTRACT_CHANGED/);await db.exec('ROLLBACK');assert.equal(await dump(db),before);
 }finally{await db.close();}
});

test('error on last row or protection breach rolls back all earlier expense/candidate/audit writes',async()=>{
 for(const injection of [
  "create function inject() returns trigger language plpgsql as $$begin if new.source_key='inventory-log:10002' then raise exception 'INJECT_LAST_ROW';end if;return new;end$$;create trigger inject before insert on ledger_candidates for each row execute function inject()",
  "create function inject() returns trigger language plpgsql as $$begin update inventory set quantity=quantity+1 where id=100;return new;end$$;create trigger inject after insert on ledger_candidates for each row execute function inject()",
  "create function inject() returns trigger language plpgsql as $$begin update ledger_card_reconciliation_lines set pos_card_transaction_id=999;return new;end$$;create trigger inject after insert on ledger_candidates for each row execute function inject()",
  "create function inject() returns trigger language plpgsql as $$begin insert into ledger_card_reconciliation_lines values(999,1190);return new;end$$;create trigger inject after insert on ledger_candidates for each row when(new.source_key='inventory-log:10001') execute function inject()",
 ]){const {db,payload}=await fixture();try{
   await db.exec(injection);const before=await dump(db);await assert.rejects(db.exec(approve(payload)),/INJECT_LAST_ROW|PROTECTED_DATA_CHANGED/);await db.exec('ROLLBACK');assert.equal(await dump(db),before);
  }finally{await db.close();}}
});
