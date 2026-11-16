import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {nativeInventoryPostgres} from './helpers/inventory-native-postgres.mjs';
import {AUTO_NORMAL,installAutoFixture,enableAuto,autoContext,observe,scope,tableId} from './helpers/tables-auto-normal-fixture.mjs';
import {installCleaningFixture,context,confirm,addOrder} from './helpers/tables-cleaning-fixture.mjs';
const operation=name=>readFileSync(new URL('../docs/sql/tables-auto-normal-v1-'+name+'.sql',import.meta.url),'utf8');
const attempt=p=>p.then(value=>({value}),error=>({error}));
test('native PostgreSQL automatic observations: atomicity, concurrency, privileges and preserved manual cleaning',
 {skip:!process.env.QA_POSTGRES_BIN&&'QA_POSTGRES_BIN not set',timeout:180000},async t=>{
 const cwd=process.cwd(),dir=path.join(cwd,'.local/tables-auto-normal');mkdirSync(dir,{recursive:true});process.chdir(dir);
 const runtime=await nativeInventoryPostgres({testContext:t}),metrics=[];t.diagnostic(runtime.version);
 async function scenario(name,run){await t.test(name,{timeout:30000},async()=>{
  const db=new runtime.Database();await db.ready;const day=await installAutoFixture(db);
  await db.exec('update table_operations_private.config set enabled=true');const activation=await enableAuto(db);
  const a=await runtime.connect(db.name),b=await runtime.connect(db.name);
  try{await run({db,a,b,day,activation});assert.equal(Number((await db.query('select deadlocks from pg_stat_database where datname=current_database()')).rows[0].deadlocks),0);}
  finally{await a.query('rollback');await b.query('rollback');await a.end();await b.end();await db.close();}
 });}
 try{
 await scenario('concurrent observers persist exactly one DB first_verified_at',async({db,a,b,day,activation})=>{
  const c=await autoContext(db,day,activation),start=Date.now();
  const both=await Promise.all([observe(a,day,activation,c),observe(b,day,activation,c)]);
  assert.equal(both.reduce((s,x)=>s+x.saved,0),1);
  const rows=(await db.query('select first_verified_at from table_operations_private.payment_observations')).rows;
  assert.equal(rows.length,1);assert.ok(new Date(rows[0].first_verified_at).getTime()>=start);
 });
 await scenario('GET transaction holds no POS SHARE or collector advisory locks',async({a,b,day,activation})=>{
  await a.query('begin');await autoContext(a,day,activation);await b.query("set statement_timeout='700ms'");
  await addOrder({query:(...args)=>b.query(...args)},day);
  assert.equal((await b.query("select pg_try_advisory_xact_lock(hashtextextended('pos_open_orders:'||$1,0)) ok",[scope])).rows[0].ok,true);
 });
 await scenario('collector/receipt lock contention aborts independent observer in 150ms, then retry succeeds',async({db,a,b,day,activation})=>{
  const c=await autoContext(db,day,activation);
  for(const lock of ["select pg_advisory_xact_lock(hashtextextended('pos_open_orders:'||$1,0))",'update pos_sales_receipts set total_amount=total_amount']){
   await b.query('begin');await b.query(lock,lock.includes('$1')?[scope]:[]);const start=performance.now();
   const r=await attempt(observe(a,day,activation,c));assert.equal(r.error?.code,'55P03');
   metrics.push({case:'observer-contention',ms:performance.now()-start});await b.query('rollback');
  }
  assert.equal((await observe(a,day,activation,c)).saved,1);
 });
 await scenario('receipt/order changes between read and observe reject exact stale snapshot',async({db,a,b,day,activation})=>{
  let c=await autoContext(db,day,activation);
  await b.query('update pos_sales_receipts set final_amount=120000');await assert.rejects(()=>observe(a,day,activation,c),/stale/);
  c=await autoContext(db,day,activation);await addOrder({query:(...args)=>b.query(...args)},day);
  await assert.rejects(()=>observe(a,day,activation,c),/stale/);
  assert.equal(Number((await db.query('select count(*) n from table_operations_private.payment_observations')).rows[0].n),0);
 });
 await scenario('observer-first commit then POS mutation invalidates; restoration cannot resurrect',async({db,a,b,day,activation})=>{
  await a.query('begin');await observe(a,day,activation);await a.query('commit');
  await b.query('update pos_sales_receipts set final_amount=120000;update pos_sales_receipts set final_amount=100000');
  assert.deepEqual((await autoContext(db,day,activation)).observations,{});
  assert.equal((await observe(a,day,activation)).saved,1);
 });
 await scenario('manual confirmation races observer safely; automatic expiry creates no cleaning event',async({db,a,b,day,activation})=>{
  const c=await context(db,day);
  await Promise.all([observe(a,day,activation),confirm(b,day,c)]);
  await db.exec("update table_operations_private.payment_observations set first_verified_at=clock_timestamp()-interval '31 minutes'");
  const auto=await autoContext(db,day,activation);assert.equal(auto.observations[tableId].expired,true);assert.ok(auto.cleanedTableIds.includes(tableId));
  assert.equal(Number((await db.query('select count(*) n from table_operations_private.cleaning_events')).rows[0].n),1);
  const repeated=await confirm(db,day,c);assert.equal(repeated.saved,true);
  assert.equal(Number((await db.query('select count(*) n from table_operations_private.cleaning_events')).rows[0].n),1);
 });
 await scenario('OFF->ON serializes with observer; old activation cannot be used',async({db,a,b,day,activation})=>{
  const c=await autoContext(db,day,activation);await b.query('begin;update table_operations_private.auto_config set enabled=false');
  const r=await attempt(observe(a,day,activation,c));assert.equal(r.error?.code,'55P03');await b.query('commit');
  assert.equal((await observe(a,day,activation,c)).enabled,false);
  const next=await enableAuto(db);assert.notEqual(next,activation);
  assert.deepEqual((await autoContext(db,day,next)).observations,{});
 });
 await scenario('OFF hooks bypass audit tables; ON metadata does too; manual config is independent',async({db,a,b,day,activation})=>{
  await observe(db,day,activation);const key=(await autoContext(db,day,activation)).keys[tableId].autoKey;
  await db.exec('update table_operations_private.config set enabled=false;update table_operations_private.config set enabled=true');
  assert.equal((await autoContext(db,day,activation)).keys[tableId].autoKey,key);
  await b.query('begin;lock table table_operations_private.payment_observations,table_operations_private.auto_invalidations in access exclusive mode');
  await a.query("set statement_timeout='700ms'");const start=performance.now();
  await a.query('update pos_sales_receipts set status_changed_at=clock_timestamp()');
  await db.exec('update table_operations_private.auto_config set enabled=false');
  await a.query('update pos_sales_receipts set final_amount=110000');
  metrics.push({case:'metadata-and-off-writes-under-audit-lock',ms:performance.now()-start});
 });
 await scenario('service INVOKER only; actual anon/authenticated denied and RLS direct data forbidden',async({a,day,activation})=>{
  for(const role of ['anon','authenticated']){
   await a.query('set role '+role);
   await assert.rejects(()=>autoContext(a,day,activation),/permission denied/);await a.query('reset role');
  }
  await a.query('set role service_role');assert.equal((await autoContext(a,day,activation)).enabled,true);
  await assert.rejects(()=>a.query('select * from table_operations_private.payment_observations'),/permission denied/);
  assert.equal((await observe(a,day,activation)).saved,1);await a.query('reset role');
 });
 await scenario('500 receipts / 2500 lines: coherent snapshot, bounded observer and no ledger rewrites',async({db,a,b,day,activation})=>{
  await db.exec(`insert into pos_sales_receipts(id,source,branch_id,business_date,payment_status,is_canceled,total_amount,final_amount,ref_date,ref_no,raw_json)
   select 1000+g,source,branch_id,business_date,3,false,100000,100000,ref_date,'load-'||g,jsonb_build_object('OrderId','load-'||g,'TableName','outside-catalog') from pos_sales_receipts cross join generate_series(1,499) g where id=100;
   insert into pos_sales_receipt_lines select r.id*10+g,r.id,'cukcuk','Synthetic',1,20000,false from pos_sales_receipts r cross join generate_series(1,5) g;`);
  const checksum=async()=> (await db.query("select md5(string_agg(to_jsonb(r)::text,'' order by id)) h from pos_sales_receipts r")).rows[0].h;
  const before=await checksum(),start=performance.now();await observe(a,day,activation);const elapsed=performance.now()-start;
  const c=await autoContext(db,day,activation);assert.ok(c.observations[tableId]);assert.equal(await checksum(),before);
  metrics.push({case:'500-receipts-2500-lines-observe',ms:elapsed});
  await a.query('begin');await autoContext(a,day,activation);const writer=performance.now();await b.query('update pos_sales_receipts set status_changed_at=clock_timestamp() where id=100');
  metrics.push({case:'writer-during-open-auto-get',ms:performance.now()-writer});
 });
 await t.test('operator Preflight/Postflight/start/stop/emergency/recover run against actual formal SQL',async()=>{
  const db=new runtime.Database();await db.ready;
  const checks=async name=>{
   const results=await db.exec(operation(name)),rows=results.flatMap(x=>x.rows??[]);
   assert.ok(rows.filter(r=>'pass'in r).length>=6);assert.ok(rows.filter(r=>'pass'in r).every(r=>r.pass),JSON.stringify(rows));
   return rows.find(r=>r.existing_function_hashes)?.existing_function_hashes;
  };
  try{
   const day=await installCleaningFixture(db);await db.exec(`update table_operations_private.config set enabled=true;
    insert into supabase_migrations.schema_migrations(version,name) values('20261115103656','tables_cleaning_v1')`);
   const before=await checks('preflight');
   await db.exec(AUTO_NORMAL);await db.exec("insert into supabase_migrations.schema_migrations(version,name) values('20261116095122','tables_auto_normal_v1')");
   const after=await checks('postflight');for(const key of Object.keys(before))assert.equal(after[key],before[key]);
   await db.exec(operation('start'));const activation=(await db.query('select activation_key from table_operations_private.auto_config')).rows[0].activation_key;
   await observe(db,day,activation);assert.ok((await autoContext(db,day,activation)).observations[tableId]);
   await db.exec(operation('stop'));assert.equal((await autoContext(db,day,activation)).enabled,false);
   await db.exec(operation('emergency-disable'));await addOrder(db,day);await db.exec('delete from pos_open_orders_private.orders');
   await db.exec(operation('recover'));await checks('postflight');
   await db.exec(operation('start'));const next=(await db.query('select activation_key from table_operations_private.auto_config')).rows[0].activation_key;
   assert.notEqual(next,activation);assert.deepEqual((await autoContext(db,day,next)).observations,{});
   assert.equal((await context(db,day)).enabled,true);
   metrics.push({case:'operator-sql',preflight:true,postflight:true,manualPreserved:true,recovery:true});
  }finally{await db.close();}
 });
 }finally{writeFileSync(path.join(dir,'native-metrics.json'),JSON.stringify({version:runtime.version,metrics},null,2));process.chdir(cwd);}
});
