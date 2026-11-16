import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {installAutoFixture,enableAuto,autoContext,observe,tableId,scope} from './helpers/tables-auto-normal-fixture.mjs';
import {context,confirm,addOrder} from './helpers/tables-cleaning-fixture.mjs';
import {applyPaymentObservations,autoNormalActivation} from '../lib/sales/table-auto-normal.ts';
import {buildTableOverview} from '../lib/sales/table-overview.ts';
import {babaTableCatalog} from '../lib/sales/baba-table-catalog.ts';
const scalar=async(db,sql)=>(await db.query(sql)).rows[0];
function view(ctx,day){return buildTableOverview({businessDate:day,now:new Date(ctx.serverNow),catalog:babaTableCatalog(),
 enabled:true,sync:ctx.snapshot.sync,orders:ctx.snapshot.orders,receipts:ctx.receipts.map(r=>({receiptId:r.id,orderId:r.order_id,tableName:r.table_name,
 businessDate:r.business_date,paymentStatus:r.payment_status,isCanceled:r.is_canceled,paidAt:r.ref_date}))});}

test('automatic payment observations use formal follow-up SQL with isolated PGlite',async t=>{
 const db=new PGlite(),day=await installAutoFixture(db);let activation;
 try{
 await t.test('install defaults OFF; existing manual config/functions remain intact',async()=>{
  assert.equal((await autoContext(db,day,'00000000-0000-4000-8000-000000000001')).enabled,false);
  assert.equal((await context(db,day)).enabled,false);
  await db.exec('update table_operations_private.config set enabled=true');
  const manual=await context(db,day);assert.ok(manual.keys[tableId]);
  activation=await enableAuto(db);
 });
 await t.test('GET never inserts; duplicate observer inserts once, old receipt starts now',async()=>{
  const ctx=await autoContext(db,day,activation);
  assert.ok(ctx.keys[tableId]);assert.deepEqual(ctx.observations,{});
  assert.equal((await scalar(db,'select count(*)::int n from table_operations_private.payment_observations')).n,0);
  assert.equal((await observe(db,day,activation,ctx)).saved,1);
  const first=(await autoContext(db,day,activation)).observations[tableId];
  assert.ok(Date.parse(first.firstVerifiedAt)>Date.parse(ctx.receipts[0].ref_date));
  assert.equal((await observe(db,day,activation)).saved,0);
  assert.deepEqual((await autoContext(db,day,activation)).observations[tableId],first);
 });
 await t.test('29:59 / 30:00 / 30:01 exact DB predicate and server projection',async()=>{
  // Same transaction_timestamp for deterministic boundaries, with no API clock injection.
  for(const seconds of [1799,1800,1801]){
   await db.exec('begin');
   try{
    await db.query("update table_operations_private.payment_observations set first_verified_at=statement_timestamp()-($1::text||' seconds')::interval",[seconds]);
    const ctx=await autoContext(db,day,activation),o=ctx.observations[tableId];
    assert.equal(o.expired,seconds>=1800);
    const base=view(ctx,day);applyPaymentObservations(base,ctx.observations,ctx.keys);
    assert.equal(base.tables.find(t=>t.id===tableId).state,seconds>=1800?'idle':'paid');
   }finally{await db.exec('rollback');}
  }
 });
 await t.test('repeated collection metadata does not move first verification',async()=>{
  const before=(await autoContext(db,day,activation)).observations[tableId];
  for(let i=0;i<3;i++){
   await db.exec("update pos_sales_receipts set status_changed_at=clock_timestamp(),raw_json=raw_json||jsonb_build_object('ModifiedDate',clock_timestamp());update pos_open_orders_private.sync_state set last_success_at=clock_timestamp()");
   assert.equal((await observe(db,day,activation)).saved,0);
  }
  assert.deepEqual((await autoContext(db,day,activation)).observations[tableId],before);
 });
 await t.test('manual confirmation remains real, takes priority and stays separate from observations',async()=>{
  const c=await context(db,day);await confirm(db,day,c);
  const a=await autoContext(db,day,activation);assert.ok(a.cleanedTableIds.includes(tableId));
  assert.equal((await scalar(db,'select count(*)::int n from table_operations_private.cleaning_events')).n,1);
 });
 await t.test('new active order blocks old timer; cancel/restore cannot resurrect it',async()=>{
  await addOrder(db,day);
  let c=await autoContext(db,day,activation);assert.equal(c.keys[tableId],undefined);assert.equal(c.observations[tableId],undefined);
  await db.exec("update pos_open_orders_private.orders set status=5,status_class='canceled'");
  c=await autoContext(db,day,activation);assert.ok(c.keys[tableId]);assert.equal(c.observations[tableId],undefined);
  await observe(db,day,activation,c);assert.ok((await autoContext(db,day,activation)).observations[tableId]);
 });
 await t.test('amount change -> restore invalidates irreversibly; renewed verification is a new first time',async()=>{
  const old=(await autoContext(db,day,activation)).keys[tableId].autoKey;
  await db.exec('update pos_sales_receipts set final_amount=200000;update pos_sales_receipts set final_amount=100000');
  const c=await autoContext(db,day,activation);assert.notEqual(c.keys[tableId].autoKey,old);assert.equal(c.observations[tableId],undefined);
  await observe(db,day,activation,c);
 });
 await t.test('receipt menu revisions and restore invalidate; metadata-only order reinsert preserves time',async()=>{
  await db.exec("insert into pos_sales_receipt_lines values(1,100,'cukcuk','Synthetic',1,100000,false)");
  await observe(db,day,activation);
  const c=await autoContext(db,day,activation);
  await db.exec('update pos_sales_receipt_lines set quantity=2;update pos_sales_receipt_lines set quantity=1');
  assert.equal((await autoContext(db,day,activation)).observations[tableId],undefined);
  await observe(db,day,activation);
  const first=(await autoContext(db,day,activation)).observations[tableId];
  await db.exec(`create temporary table retained as select * from pos_open_orders_private.orders;
   delete from pos_open_orders_private.orders;insert into pos_open_orders_private.orders select * from retained;drop table retained;`);
  assert.deepEqual((await autoContext(db,day,activation)).observations[tableId],first);
  assert.notEqual((await autoContext(db,day,activation)).keys[tableId].autoKey,c.keys[tableId].autoKey);
 });
 await t.test('cancel/reissue, newest receipt alone starts a new cycle',async()=>{
  await db.exec('update pos_sales_receipts set is_canceled=true,payment_status=4');
  assert.equal((await autoContext(db,day,activation)).keys[tableId],undefined);
  await db.query(`insert into pos_sales_receipts(id,source,branch_id,business_date,payment_status,is_canceled,total_amount,final_amount,ref_date,ref_no,raw_json)
   select 101,source,branch_id,business_date,3,false,100000,100000,clock_timestamp(),'101','{"OrderId":"new-paid","TableName":"BAR4"}' from pos_sales_receipts where id=100`);
  const c=await autoContext(db,day,activation);assert.equal(c.keys[tableId].receiptId,101);assert.equal(c.observations[tableId],undefined);
  await observe(db,day,activation,c);assert.equal((await autoContext(db,day,activation)).observations[tableId].receiptId,101);
 });
 await t.test('failure/delay/future sync, collecting lease and duplicate receipt links never certify timers',async()=>{
  for(const set of ["last_error_code='provider_timeout'","last_success_at=clock_timestamp()-interval '11 minutes'","last_success_at=clock_timestamp()+interval '1 minute'"]){
   await db.exec('update pos_open_orders_private.sync_state set '+set);
   assert.deepEqual((await autoContext(db,day,activation)).observations,{});
   await db.exec('update pos_open_orders_private.sync_state set last_error_code=null,last_success_at=clock_timestamp()');
  }
  await db.query(`insert into pos_open_orders_private.runs(id,scope,branch_id,business_date,owner_token,status,lease_until)
   values('00000000-0000-4000-8000-000000000099',$1,split_part($1,':',2),$2,'00000000-0000-4000-8000-000000000098','collecting',clock_timestamp()+interval '1 minute')`,[scope,day]);
  assert.deepEqual((await autoContext(db,day,activation)).observations,{});
  await db.exec('delete from pos_open_orders_private.runs');
  await db.exec('update pos_sales_receipts set is_canceled=false,payment_status=3,raw_json=(select raw_json from pos_sales_receipts where id=101) where id=100');
  assert.equal((await autoContext(db,day,activation)).keys[tableId],undefined);
  await db.exec('update pos_sales_receipts set is_canceled=true,payment_status=4 where id=100');
 });
 await t.test('business-day cutoff rejects previous day; 03:00 configured conversion is authoritative',async()=>{
  const d=(await db.query("select public.store_business_date_for_timestamp_v1('2026-11-17 02:59:59+07')::text a,public.store_business_date_for_timestamp_v1('2026-11-17 03:00:00+07')::text b")).rows[0];
  assert.deepEqual(d,{a:'2026-11-16',b:'2026-11-17'});
  await assert.rejects(()=>autoContext(db,'2020-01-01',activation),/stale/);
  await assert.rejects(()=>observe(db,'2020-01-01',activation,{snapshot:{},receipts:[],keys:{}}),/stale/);
  for(const [change,restore] of [
   ["business_date=business_date-1","business_date=business_date+1"],
   ["branch_id='other-branch'",`branch_id=split_part('${scope}',':',2)`],
   ["source='other-source'","source='cukcuk'"]]){
   await observe(db,day,activation);
   await db.exec('update pos_sales_receipts set '+change+' where id=101');
   assert.equal((await autoContext(db,day,activation)).keys[tableId],undefined);
   await db.exec('update pos_sales_receipts set '+restore+' where id=101');
   assert.equal((await autoContext(db,day,activation)).observations[tableId],undefined,'Connection restoration must not resurrect timer');
  }
 });
 await t.test('OFF -> ON and config recreation rotate generation/key, no old timer reuse; manual OFF independent',async()=>{
  await db.exec('update table_operations_private.auto_config set enabled=false');
  assert.equal((await autoContext(db,day,activation)).enabled,false);
  const next=await enableAuto(db);assert.notEqual(next,activation);
  assert.equal((await autoContext(db,day,activation)).enabled,false);
  activation=next;assert.deepEqual((await autoContext(db,day,activation)).observations,{});
  await db.exec('update table_operations_private.config set enabled=false');
  const c=await autoContext(db,day,activation);assert.equal(c.manualEnabled,false);assert.ok(c.keys[tableId]);
  await observe(db,day,activation,c);
  await db.exec('delete from table_operations_private.auto_config;insert into table_operations_private.auto_config(singleton) values(true)');
  assert.equal((await autoContext(db,day,activation)).enabled,false);
 });
 await t.test('RLS and privileges: no direct access, service-only INVOKER RPCs',async()=>{
  assert.equal((await scalar(db,"select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='table_operations_private' and c.relname in('auto_config','payment_observations','auto_invalidations') and c.relrowsecurity")).n,3);
  for(const role of ['anon','authenticated','service_role']){
   assert.equal((await db.query("select has_table_privilege($1,'table_operations_private.payment_observations','INSERT') allowed",[role])).rows[0].allowed,false);
   assert.equal((await db.query("select has_function_privilege($1,'public.tables_observe_payments_v1(text,date,uuid,jsonb,jsonb,jsonb)','EXECUTE') allowed",[role])).rows[0].allowed,role==='service_role');
  }
 });
 }finally{await db.close();}
});

test('automatic app gate requires dedicated switch, read permission and an activation key',()=>{
 const names=['BABA_TABLE_AUTO_NORMAL_ENABLED','BABA_TABLE_AUTO_NORMAL_ACTIVATION','POS_OPEN_ORDERS_READ_ENABLED'],before=names.map(n=>process.env[n]);
 try{process.env.BABA_TABLE_AUTO_NORMAL_ENABLED='true';process.env.POS_OPEN_ORDERS_READ_ENABLED='true';
  delete process.env.BABA_TABLE_AUTO_NORMAL_ACTIVATION;assert.equal(autoNormalActivation(),null);
  process.env.BABA_TABLE_AUTO_NORMAL_ACTIVATION='00000000-0000-4000-8000-000000000001';assert.ok(autoNormalActivation());
  process.env.BABA_TABLE_AUTO_NORMAL_ENABLED='false';assert.equal(autoNormalActivation(),null);
 }finally{names.forEach((n,i)=>before[i]===undefined?delete process.env[n]:process.env[n]=before[i]);}
});

test('#8885 merge membership blocks both source tables and receipt target; no fabricated observation',async()=>{
 const db=new PGlite(),day=await installAutoFixture(db),activation=await enableAuto(db);
 try{
  await db.exec('delete from pos_sales_receipts');
  await db.query(`insert into pos_sales_receipts(id,source,branch_id,business_date,payment_status,is_canceled,total_amount,final_amount,ref_date,ref_no,raw_json)
   values(8885,'cukcuk',split_part($1,':',2),$2,3,false,1090000,1090000,clock_timestamp()-interval '10 seconds','8885','{"OrderId":"target","TableName":"2"}')`,[scope,day]);
  for(const name of ['BAR8','BAR9','BAR11']){
   await addOrder(db,day,{id:'merged-'+name,name,status:4});
   await db.query("update pos_open_orders_private.orders set closure_receipt_id=8885,closure_merged_into_order_id='target',closure_confirmed_at=clock_timestamp() where order_id=$1",['merged-'+name]);
  }
  const c=await autoContext(db,day,activation);assert.deepEqual(c.observations,{});
  for(const name of ['BAR8','BAR9','BAR11','2']){
   const id=babaTableCatalog().tables.find(t=>t.name===name).id;assert.equal(c.keys[id],undefined);
  }
  assert.equal((await observe(db,day,activation,c,[])).saved,0);
 }finally{await db.close();}
});

test('canceling newest payment cannot revive older receipt timer; disabled hooks fail closed',async()=>{
 const db=new PGlite(),day=await installAutoFixture(db),activation=await enableAuto(db);
 try{
  await observe(db,day,activation);
  await db.query(`insert into pos_sales_receipts(id,source,branch_id,business_date,payment_status,is_canceled,total_amount,final_amount,ref_date,ref_no,raw_json)
   select 101,source,branch_id,business_date,3,false,100000,100000,clock_timestamp(),'101','{"OrderId":"latest","TableName":"BAR4"}' from pos_sales_receipts where id=100`);
  assert.equal((await autoContext(db,day,activation)).keys[tableId].receiptId,101);
  await observe(db,day,activation);
  await db.exec('update pos_sales_receipts set is_canceled=true,payment_status=4 where id=101');
  const c=await autoContext(db,day,activation);assert.equal(c.keys[tableId],undefined);assert.deepEqual(c.observations,{});
  const base=view(c,day);applyPaymentObservations(base,c.observations,c.keys,c.reviewTableIds);
  assert.equal(base.tables.find(t=>t.id===tableId).state,'unknown');
  await db.exec('alter table public.pos_sales_receipts disable trigger tables_auto_receipt_invalidation');
  assert.equal((await autoContext(db,day,activation)).enabled,false);
 }finally{await db.close();}
});
