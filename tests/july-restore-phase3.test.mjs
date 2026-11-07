import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {phase3Plan,renderPhase3} from '../scripts/ledger/july-restore-phase3-plan.mjs';
import {rpcContracts} from '../scripts/ledger/july-restore-rpc-contracts.mjs';
import {sha,WEAK} from '../scripts/ledger/july-restore-phase2.mjs';
const root=process.env.JULY_PHASE3_INPUT_DIR;
const options={skip:!root};
const read=p=>readFileSync(p,'utf8');
const load=p=>JSON.parse(read(join(root,p)));
function evidence(){
 const prior=load('phase2-final-20261107-r2/reviewed-345.json'),csv=read(join(root,'phase2-final-20261107-r2/remaining-345-status.csv')),phase2=load('phase2-final-20261107-r2/bundle.json'),capture=load('phase3-runtime-20261107/runtime-readonly.json');
 return {prior,csv,phase2,capture,result:phase3Plan(prior,csv,phase2,capture)};
}
const approval=p=>renderPhase3(p).replaceAll('__ACTOR_USER_ID__','2').replaceAll('__OWNER_APPROVAL__','APPROVED:'+sha(JSON.stringify(p)));
const tables=['ledger_transactions','ledger_movements','ledger_audit_logs','ledger_candidates','ledger_payables','ledger_payable_allocations','ledger_card_reconciliations','ledger_card_reconciliation_lines','ledger_card_fee_closures','ledger_card_fee_allocation_lines','ledger_fund_accounts','ledger_month_closures','ledger_month_closure_history','inventory_logs','inventory'];
async function dump(db,selected=tables){const r={};for(const t of selected)r[t]=(await db.query(`select * from ${t} order by id`)).rows;return JSON.stringify(r);}
async function exec(db,sql){try{return await db.exec(sql);}catch(e){throw Error(e.message);}}
async function fixture(){
 const {capture,result}=evidence(),{PGlite}=createRequire(process.env.JULY_QA_PACKAGE_JSON||import.meta.url)('@electric-sql/pglite'),db=new PGlite();
 await db.exec(read('tests/ledger-july-opening-oneoff-db.test.mjs').match(/const FIXTURE = `([\s\S]*?)`;/)[1]);
 const candidates=read('supabase/migrations/202608210003_add_inventory_purchase_candidates.sql');
 await db.exec(candidates.slice(candidates.indexOf('create table public.ledger_inventory_category_mappings'),candidates.indexOf('alter table public.ledger_inventory_category_mappings enable')));
 await db.exec(`alter table ledger_candidates add column source_drift_snapshot jsonb,add column source_drift_fingerprint text,add column source_drift_detected_at timestamptz;
  alter table ledger_categories add column kind text default 'expense',add column is_active boolean default true;
  alter table ledger_parties add column type text default 'supplier',add column is_active boolean default true;
  create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key);insert into supabase_migrations.schema_migrations values('20261105153442');
  create schema inventory_ledger_private;
  create table inventory(id bigint primary key,quantity numeric,purchase_price numeric,updated_at timestamptz);
  create table inventory_logs(id bigint primary key,item_id bigint,item_name text,item_name_vi text,category text,category_vi text,unit text,change_quantity numeric,new_purchase_price numeric,new_supplier text,business_date date,created_at timestamptz,source text,reason text,billed_amount numeric,purchase_supplier_partner_id bigint,correction_of_inventory_log_id bigint,prev_quantity numeric,new_quantity numeric,prev_note text,new_note text);
  create table ledger_inventory_projection_status(inventory_log_id bigint primary key,status text);
  create table ledger_month_closure_history(id bigint primary key,month date,snapshot_hash text);
  create table ledger_card_reconciliations(id bigint primary key,status text);insert into ledger_card_reconciliations select id,'matched' from generate_series(1,69) id;
  create table ledger_card_reconciliation_lines(id bigint primary key,pos_card_transaction_id bigint);insert into ledger_card_reconciliation_lines values(1,1190);
  create table ledger_card_fee_closures(id bigint primary key);create table ledger_card_fee_allocation_lines(id bigint primary key);
  create table business_partners(id bigint primary key,name text,is_active boolean,payment_mode text,default_fund_account_id bigint,default_payment_term_days integer);
  create table business_partner_ledger_parties(business_partner_id bigint,ledger_party_id bigint);
  create table business_partner_supplier_aliases(id bigint,business_partner_id bigint,normalized_name text,status text);`);
 for(const c of capture.tables.categories)await db.query('insert into ledger_categories values($1,$2,$3,$4) on conflict(id) do update set name=excluded.name,kind=excluded.kind,is_active=excluded.is_active',[c.id,c.name,c.kind,c.is_active]);
 for(const p of capture.tables.parties)await db.query('insert into ledger_parties values($1,$2,$3,$4) on conflict(id) do update set name=excluded.name,type=excluded.type,is_active=excluded.is_active',[p.id,p.name,p.type,p.is_active]);
 for(const m of capture.tables.categoryMappings)await db.query('insert into ledger_inventory_category_mappings(inventory_category,ledger_category_id,is_active) values($1,$2,$3)',[m.inventory_category,m.ledger_category_id,m.is_active]);
 for(const m of capture.tables.supplierMappings)await db.query('insert into ledger_supplier_party_mappings(supplier_name,party_id,is_active) values($1,$2,$3)',[m.supplier_name,m.party_id,m.is_active]);
 // Load the already-applied rows AS DATA. Never run any phase-1/phase-2 SQL.
 const tableColumns=async table=>(await db.query("select column_name,data_type from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position",[table])).rows;
 async function insertData(table,rows,transform=x=>x){const cols=await tableColumns(table);for(const source of rows){const r=transform(source),fields=cols.filter(c=>Object.hasOwn(r,c.column_name));await db.query(`insert into ${table}(${fields.map(c=>c.column_name).join(',')}) values(${fields.map((_,i)=>'$'+(i+1)).join(',')})`,fields.map(c=>c.data_type==='jsonb'&&r[c.column_name]!==null?JSON.stringify(r[c.column_name]):r[c.column_name]));}}
 const completed=capture.tables.julyTransactions.filter(t=>t.id>=4227&&t.id<=4275||t.id>=4292&&t.id<=4324);
 await insertData('ledger_transactions',completed,r=>({...r,created_by:2,confirmed_by:2}));
 await insertData('ledger_movements',capture.tables.movements.filter(m=>completed.some(t=>t.id===m.transaction_id)));
 await insertData('ledger_audit_logs',capture.tables.julyAudits,r=>({...r,actor_user_id:2,entity_type:'transaction'}));
 await insertData('ledger_candidates',capture.tables.candidates,r=>({...r,resolved_by:r.resolved_by?2:null}));
 await insertData('inventory_logs',capture.tables.inventoryLogs);await insertData('inventory',capture.tables.inventoryItems);
 await db.exec(`insert into ledger_payables(id,expense_transaction_id,party_id,original_amount,status) values(1830,3804,9,15426000,'paid');
  insert into ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount) values(1830,100,15426000);
  alter table ledger_transactions alter column id restart with 6000;
  select setval(pg_get_serial_sequence('ledger_movements','id'),(select max(id)+1000 from ledger_movements),false);
  select setval(pg_get_serial_sequence('ledger_audit_logs','id'),(select max(id)+1000 from ledger_audit_logs),false);
  select setval(pg_get_serial_sequence('ledger_candidates','id'),(select max(id)+1000 from ledger_candidates),false);`);
 const contracts=rpcContracts();for(const v of Object.values(contracts))await db.exec(v.sql);
 const month=read('supabase/migrations/202608210008_add_ledger_month_close_corrections.sql');
 await db.exec(month.slice(month.indexOf('create or replace function public.ledger_candidate_resolution_month_guard_v1'),month.indexOf('create or replace function public.ledger_confirmed_candidate_drift_v1')));
 return {db,payload:result.payload,result};
}

test('lock_sources production hash: correction child and root share origin locks; independent sources/extra months preserved without writes',options,async()=>{
 const {db}=await fixture();try{
  const hashes=Object.fromEntries(Object.entries(rpcContracts()).map(([k,v])=>[k,v.hash]));
  assert.deepEqual(hashes,{resolver:'edcfb9d5429307c6fa0690d8d89cfa005b02b8fd13749fab480793b32ed7c4d5',manual:'cff7e12cf6dceee07552c66ad28244c56180e8652d13a0c5130d6d44a8652b5f',sync:'d0265e0158f840b9fd11eaef5a62b979ad4878626ad5709f7f4d090d339e2235',lock:'df9b3ce8ceb8a3f754ca504aeaef6f3274c51ab997c899fe3fb9c76dc2556739',economics:'a2fbc33e168932f305a58993c8b8e0f763d793e946870c07df19568f2831632e'});
  const observed=(await db.query("select encode(sha256(convert_to(replace(prosrc,E'\\r\\n',E'\\n'),'UTF8')),'hex') hash from pg_proc where oid='inventory_ledger_private.lock_sources(text[],date[])'::regprocedure")).rows[0].hash;
  assert.equal(observed,hashes.lock);
  await db.exec("insert into inventory_logs select (jsonb_populate_record(null::inventory_logs,to_jsonb(l)||jsonb_build_object('id',990001,'correction_of_inventory_log_id',6231,'business_date','2026-08-02'))).* from inventory_logs l where id=6231");
  const before=await dump(db);
  await db.exec('BEGIN');
  await db.query("select inventory_ledger_private.lock_sources(array[$1,$2,$1,null,$3],array[date '2026-06-01'])",['inventory-log:990001','inventory-log:6231','inventory-log:5566']);
  // PGlite's sole backend reports backend_pid=0 and pg_locks.pid=NULL.
  const locked=async key=>(await db.query("select exists(select 1 from pg_locks where (pid=pg_backend_pid() or (pg_backend_pid()=0 and pid is null)) and locktype='advisory' and objsubid=1 and granted and classid=(case when hashtext($1)<0 then 4294967295 else 0 end)::oid and objid=(hashtext($1)::bigint & 4294967295)::oid) held",[key])).rows[0].held;
  for(const key of ['ledger_inventory_candidate:inventory-log:6231','ledger_inventory_candidate:inventory-log:5566','ledger_month_close:2026-07','ledger_month_close:2026-06','ledger_inventory_rebook:4298'])assert.equal(await locked(key),true,key);
  assert.equal(await locked('ledger_inventory_candidate:inventory-log:990001'),false);
  assert.equal(await locked('ledger_month_close:2026-08'),false);
  assert.equal(await dump(db),before);await db.exec('ROLLBACK');assert.equal(await dump(db),before);
 }finally{await db.close();}
});

test('95-row cohort is extracted from prior CSV/JSON; completed83 and held217 retained; money/fund conservation',options,()=>{
 const {result,capture,prior,csv,phase2}=evidence();
 assert.equal(result.rows.length,95);assert.equal(result.remaining.length,312);assert.equal(result.remaining.filter(r=>r.state==='hold').length,217);
 assert.deepEqual(Object.fromEntries(Object.entries(result.summary.byState).map(([k,v])=>[k,[v.rows,v.paid]])),{ready:[62,'63821342'],linked_restricted:[7,'21909900'],evidence_needed:[17,'24058900'],separate_hold:[9,'2049000']});
 assert.equal(result.summary.paid,'111839142');assert.deepEqual(result.summary.fundDelta,{store_cash:'-20267000',vuong_personal_custody:'-4110000',cho_personal_custody:'-14952000',baba_corporate_bank:'-24492342'});
 assert.ok(WEAK.every(n=>result.rows.find(r=>r.row===n).phase3State!=='ready'));
 assert.equal(result.rows.some(r=>r.row===211),false);
 for(const n of [9,99,128,209,272,287,317,352])assert.equal(result.rows.find(r=>r.row===n).phase3State,'ready');
 for(const a of result.payload.bundle.actions)assert.ok(!result.payload.bundle.completedRows.includes(a.row));
 const modified=structuredClone(capture);modified.tables.candidates.push({source_key:'inventory-log:5566'});
 assert.equal(phase3Plan(prior,csv,phase2,modified).rows.find(r=>r.row===6).phase3State,'evidence_needed');
});

test('actual 62-row atomic draft: multi-log categories, exact split funds, sheet group cost once, 82 old rows/card/source preserved and identical replay',options,async()=>{
 const {db,payload}=await fixture();try{
  const beforeSources=await dump(db,['inventory_logs','inventory','ledger_payables','ledger_payable_allocations','ledger_card_reconciliations','ledger_card_reconciliation_lines','ledger_month_closures']);
  const beforeOld=JSON.stringify((await db.query('select * from ledger_transactions where id<6000 order by id')).rows);
  await exec(db,approval(payload));
  const n=(await db.query("select count(*) n from ledger_audit_logs where action='july_restore_row'")).rows[0].n;assert.equal(n,144);
  assert.equal((await db.query('select sum(amount)::bigint::text n from ledger_transactions where id>=6000')).rows[0].n,'63821342');
  const actual=(await db.query('select f.code,sum(m.amount)::bigint::text amount from ledger_movements m join ledger_fund_accounts f on f.id=m.fund_account_id where m.transaction_id>=6000 group by f.code')).rows;
  assert.deepEqual(Object.fromEntries(actual.map(r=>[r.code,r.amount])),payload.bundle.fundDelta);
  assert.equal(await dump(db,['inventory_logs','inventory','ledger_payables','ledger_payable_allocations','ledger_card_reconciliations','ledger_card_reconciliation_lines','ledger_month_closures']),beforeSources);
  assert.equal(JSON.stringify((await db.query('select * from ledger_transactions where id<6000 order by id')).rows),beforeOld);
  assert.equal((await db.query("select count(*) n from ledger_transactions where id>=6000 and source_type='manual'")).rows[0].n,29);
  const first=await dump(db);await exec(db,approval(payload));assert.equal(await dump(db),first);
 }finally{await db.close();}
});

test('grouped sheet cost claims: exact dismissed snapshots cannot auto-post; changed source creates pending review with zero new expense/outflow',options,async()=>{
 const {db,payload}=await fixture();try{
  await exec(db,approval(payload));
  const c=(await db.query("select * from ledger_candidates where source_key='inventory-log:5566'")).rows[0];assert.equal(c.status,'dismissed');assert.match(c.dismissal_reason,/july-phase3-group:/);
  const before=await dump(db,['ledger_transactions','ledger_movements']);
  const call=async(snapshot,amount,fingerprint)=>(await db.query("select inventory_ledger_private.sync_candidate($1::jsonb,2) result",[JSON.stringify([{sourceKey:c.source_key,businessDate:'2026-07-01',amount,snapshot,fingerprint}])])).rows[0].result;
  const same=await call(c.source_snapshot,c.proposed_amount,c.source_fingerprint);assert.equal(same.unchangedCount,1);assert.equal(await dump(db,['ledger_transactions','ledger_movements']),before);
  const changed={...c.source_snapshot,purchase_price:Number(c.source_snapshot.purchase_price)+1,purchase_amount:Number(c.source_snapshot.purchase_amount)+Number(c.source_snapshot.change_quantity)};
  const drift=await call(changed,changed.purchase_amount,sha(changed));assert.equal(drift.pendingReviewCount,1);assert.equal(drift.autoConfirmedImmediateCount,0);assert.equal(drift.autoConfirmedPayableCount,0);
  assert.equal(await dump(db,['ledger_transactions','ledger_movements']),before);
 }finally{await db.close();}
});

test('last component failure and changed stock/card rows roll back ALL 62 rows, claims, audits and movements',options,async()=>{
 for(const injection of [
  "create function inject() returns trigger language plpgsql as $$begin if new.source_key='inventory-log:8083' then raise exception 'LAST_COMPONENT';end if;return new;end$$;create trigger inject before insert on ledger_candidates for each row execute function inject()",
  "create function inject() returns trigger language plpgsql as $$begin update inventory set quantity=quantity+1 where id=(new.source_snapshot->>'item_id')::bigint;return new;end$$;create trigger inject after insert on ledger_candidates for each row execute function inject()",
  "create function inject() returns trigger language plpgsql as $$begin insert into ledger_card_reconciliation_lines values(999,1190);return new;end$$;create trigger inject after insert on ledger_candidates for each row when(new.source_key='inventory-log:5566') execute function inject()",
 ]){const {db,payload}=await fixture();try{
   await db.exec(injection);const before=await dump(db);await assert.rejects(exec(db,approval(payload)),/LAST_COMPONENT|PROTECTED_CHANGED/);await db.exec('ROLLBACK');assert.equal(await dump(db),before);
  }finally{await db.close();}}
});

test('approval, payload, RPC hash and source claims fail closed before cost registration',options,async()=>{
 const {db,payload}=await fixture();try{
  const before=await dump(db);
  for(const sql of [renderPhase3(payload),approval(payload).replace('"amount":"172000"','"amount":"172001"')]){
   await assert.rejects(exec(db,sql),/APPROVAL/);await db.exec('ROLLBACK');assert.equal(await dump(db),before);
  }
  await db.exec("create or replace function inventory_ledger_private.sync_candidate(p_rows jsonb,p_actor_user_id bigint) returns jsonb language sql as $$select '{}'::jsonb$$");
  await assert.rejects(exec(db,approval(payload)),/RPC_CONTRACT_CHANGED/);await db.exec('ROLLBACK');assert.equal(await dump(db),before);
 }finally{await db.close();}
});

test('historical payable payment is blocked by existing August active_from; no fake July cost or allocation',options,async()=>{
 const {db}=await fixture();try{
  const source=read('supabase/migrations/202608210004_add_ledger_payable_payments.sql').split('create or replace function public.ledger_pay_payables_v1')[1];
  await db.exec('create or replace function public.ledger_pay_payables_v1'+source.slice(0,source.indexOf('end $$;')+8));
  const before=await dump(db),r=(await db.query("select ledger_pay_payables_v1(4,1,'2026-07-21T03:00:00+07',1880000,'[]'::jsonb,'July historical',2) result")).rows[0].result;
  assert.equal(r.status,'invalid_account');assert.equal(await dump(db),before);
 }finally{await db.close();}
});
