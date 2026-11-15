import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {installCleaningFixture,context,confirm,addOrder,tableId,scope,branch} from './helpers/tables-cleaning-fixture.mjs';
import {BABA_TABLES} from '../lib/sales/baba-table-catalog.ts';

test('formal cleaning migration: gates, idempotence, revisions, new orders, permissions and read consistency',async t=>{
 const db=new PGlite();const day=await installCleaningFixture(db);
 try{
  assert.deepEqual((await db.query('select table_id,table_name from table_operations_private.catalog order by table_name')).rows,
   BABA_TABLES.map(t=>({table_id:t.MapObjectID,table_name:t.MapObjectName})).sort((a,b)=>a.table_name<b.table_name?-1:1));
  assert.deepEqual(await context(db,day),{enabled:false});
  await db.exec('update table_operations_private.config set enabled=true');
  let initial=await context(db,day);assert.ok(initial.keys[tableId]);
  await db.exec('delete from table_operations_private.config');assert.deepEqual(await context(db,day),{enabled:false});
  await assert.rejects(confirm(db,day,initial),/disabled/);await db.exec('insert into table_operations_private.config values(true,true)');
  await db.exec('update table_operations_private.config set enabled=false');await assert.rejects(confirm(db,day,initial),/disabled/);
  await db.exec('update table_operations_private.config set enabled=true');
  initial=await context(db,day); // Config generation changed; the original proof is stale.
  const receiptBefore=(await db.query('select to_jsonb(r) r from pos_sales_receipts r')).rows;
  await db.exec('set role service_role');
  const saved=await confirm(db,day,initial);assert.equal(saved.saved,true);
  assert.equal((await confirm(db,day,initial)).eventId,saved.eventId);
  assert.equal((await confirm(db,day,initial,{actorId:2,requestId:'00000000-0000-4000-8000-000000000002'})).eventId,saved.eventId);
  assert.ok((await context(db,day)).cleanedTableIds.includes(tableId));
  await assert.rejects(confirm(db,day,initial,{actorId:2}),/request_conflict/);
  await db.exec('reset role');
  assert.equal((await db.query('select count(*) n from table_operations_private.cleaning_events')).rows[0].n,1);
  assert.deepEqual((await db.query('select to_jsonb(r) r from pos_sales_receipts r')).rows,receiptBefore);
  await t.test('new order always wins and invalidates the old event even after cancellation',async()=>{
   await addOrder(db,day);assert.equal((await context(db,day)).keys[tableId],undefined);
   await assert.rejects(confirm(db,day,initial),/stale/);
   await db.exec("update pos_open_orders_private.orders set status=5");
   const after=await context(db,day);assert.ok(after.keys[tableId]);assert.ok(!after.cleanedTableIds.includes(tableId));
   assert.notEqual(after.keys[tableId].evidenceKey,initial.keys[tableId].evidenceKey);
   await db.exec('delete from pos_open_orders_private.orders');
   const retained=await context(db,day);assert.ok(!retained.cleanedTableIds.includes(tableId));
   assert.notEqual(retained.keys[tableId].evidenceKey,initial.keys[tableId].evidenceKey,'old cleaning cannot resurrect after snapshot removal');
  });
  await t.test('cancellation/reissue, new receipt and menu revision reject stale screens',async()=>{
   await db.exec("update pos_sales_receipts set is_canceled=true,payment_status=4 where id=100");
   assert.equal((await context(db,day)).keys[tableId],undefined);await assert.rejects(confirm(db,day,initial),/stale/);
   await db.query(`insert into pos_sales_receipts(id,source,branch_id,business_date,payment_status,is_canceled,total_amount,final_amount,ref_date,ref_no,raw_json)
    select 101,source,branch_id,business_date,3,false,total_amount,final_amount,clock_timestamp(),'101',raw_json from pos_sales_receipts where id=100`);
   const reissued=await context(db,day);assert.equal(reissued.keys[tableId].receiptId,101);assert.ok(!reissued.cleanedTableIds.includes(tableId));
   await db.exec("insert into pos_sales_receipt_lines values(1,101,'cukcuk','Synthetic',1,100000,false)");
   await assert.rejects(confirm(db,day,reissued,{requestId:'00000000-0000-4000-8000-000000000003'}),/stale/);
   // Audit remains independent: a ledger maintenance delete must not be blocked by cleaning.
   await db.exec('delete from pos_sales_receipts where id=100');
   assert.equal((await db.query('select count(*) n from table_operations_private.cleaning_events')).rows[0].n,1);
  });
  await t.test('unhealthy, in-flight collection and wrong business date block cleaning',async()=>{
   await db.exec("update pos_open_orders_private.sync_state set last_error_code='incomplete'");
   assert.deepEqual((await context(db,day)).keys,{});await db.exec('update pos_open_orders_private.sync_state set last_error_code=null');
   await db.query(`insert into pos_open_orders_private.runs(id,scope,branch_id,business_date,owner_token,status,lease_until)
     values('00000000-0000-4000-8000-000000000009',$1,$2,$3,'00000000-0000-4000-8000-000000000008','collecting',clock_timestamp()+interval '1 minute')`,[scope,branch,day]);
   assert.deepEqual((await context(db,day)).keys,{});await db.exec('delete from pos_open_orders_private.runs');
   await db.exec("update pos_open_orders_private.sync_state set last_success_at=clock_timestamp()-interval '11 minutes'");
   assert.deepEqual((await context(db,day)).keys,{});await db.exec('update pos_open_orders_private.sync_state set last_success_at=clock_timestamp()');
   await assert.rejects(context(db,'2000-01-01'),/stale/);
   const boundary=(await db.query("select public.store_business_date_for_timestamp_v1('2026-11-15T02:59:59+07:00')::text a,public.store_business_date_for_timestamp_v1('2026-11-15T03:00:00+07:00')::text b")).rows[0];
   assert.deepEqual(boundary,{a:'2026-11-14',b:'2026-11-15'});
  });
  await t.test('merge closures block cleaning for origin and misleading receipt table',async()=>{
   await addOrder(db,day,{id:'merged',name:'BAR9',status:4});
   await db.exec("update pos_open_orders_private.orders set closure_receipt_id=101,closure_merged_into_order_id='paid-order',closure_evidence_hash=repeat('a',32)");
   assert.equal((await context(db,day)).keys[tableId],undefined);
   await db.exec('delete from pos_open_orders_private.orders');
  });
  await t.test('inactive employees and browser DB roles cannot write or read private data',async()=>{
   const ctx=await context(db,day);await db.exec('update users set app_login_enabled=false where id=1');
   await assert.rejects(confirm(db,day,ctx),/forbidden/);await db.exec('update users set app_login_enabled=true where id=1');
   for(const role of ['anon','authenticated']){
    await db.exec('set role '+role);await assert.rejects(context(db,day),/permission denied/);
    await assert.rejects(db.query('select * from table_operations_private.cleaning_events'),/permission denied/);await db.exec('reset role');
   }
   await db.exec('set role service_role');await assert.rejects(db.query('delete from table_operations_private.cleaning_events'),/permission denied/);await db.exec('reset role');
  });
 }finally{await db.close();}
});

test('retained identical paid orders keep cleaning; canceled later receipts and reverted menus cannot resurrect it',async()=>{
 const db=new PGlite(),day=await installCleaningFixture(db);
 try{
  await db.exec('update table_operations_private.config set enabled=true');
  await addOrder(db,day,{id:'paid-order',status:4});await db.exec("update pos_open_orders_private.orders set order_date=clock_timestamp()-interval '2 minutes'");
  const initial=await context(db,day);assert.ok(initial.keys[tableId]);await confirm(db,day,initial);
  const original=(await db.query('select to_jsonb(o) r from pos_open_orders_private.orders o')).rows[0].r;
  await db.exec('delete from pos_open_orders_private.orders');
  await db.query('insert into pos_open_orders_private.orders select * from jsonb_populate_record(null::pos_open_orders_private.orders,$1::jsonb)',[JSON.stringify(original)]);
  assert.ok((await context(db,day)).cleanedTableIds.includes(tableId));
  await db.exec(`insert into pos_sales_receipts(id,source,branch_id,business_date,payment_status,is_canceled,total_amount,final_amount,ref_date,ref_no,raw_json)
   select 101,source,branch_id,business_date,3,false,total_amount,final_amount,clock_timestamp(),'101','{"OrderId":"new-paid","TableName":"BAR4"}' from pos_sales_receipts where id=100;
   update pos_sales_receipts set payment_status=4,is_canceled=true where id=101;`);
  const changed=await context(db,day);assert.ok(!changed.cleanedTableIds.includes(tableId));assert.notEqual(changed.keys[tableId].evidenceKey,initial.keys[tableId].evidenceKey);
  await confirm(db,day,changed,{requestId:'00000000-0000-4000-8000-000000000002'});
  await db.exec("insert into pos_sales_receipt_lines values(9,100,'cukcuk','Synthetic',1,100000,false);delete from pos_sales_receipt_lines where id=9;");
  const reverted=await context(db,day);assert.ok(!reverted.cleanedTableIds.includes(tableId));assert.notEqual(reverted.keys[tableId].evidenceKey,changed.keys[tableId].evidenceKey);
 }finally{await db.close();}
});
