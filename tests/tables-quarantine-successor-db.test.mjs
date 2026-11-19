// 2026-11-19 P0: DB eligibility for a table whose earlier order A is quarantined while a
// clearly newer order B was paid. Real migration chain in production order on PGlite:
// v1..v3 -> cleaning -> auto-normal -> v4 quarantine -> successor evidence. Synthetic ids.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {installCleaningFixture,context,confirm,tableId,scope} from './helpers/tables-cleaning-fixture.mjs';
import {AUTO_NORMAL,enableAuto,autoContext,observe} from './helpers/tables-auto-normal-fixture.mjs';
import {buildTableOverview} from '../lib/sales/table-overview.ts';
import {babaTableCatalog} from '../lib/sales/baba-table-catalog.ts';
const view=(ctx,day)=>buildTableOverview({businessDate:day,now:new Date(),catalog:babaTableCatalog(),enabled:true,sync:ctx.snapshot.sync,
 orders:ctx.snapshot.orders,receipts:ctx.receipts.map(r=>({receiptId:r.id,orderId:r.order_id,tableName:r.table_name,
 businessDate:r.business_date,paymentStatus:r.payment_status,isCanceled:r.is_canceled,paidAt:r.ref_date}))});

const dir='../supabase/migrations/';
const QUARANTINE=readFileSync(new URL(dir+'20261119080000_pos_open_orders_vanished_quarantine.sql',import.meta.url),'utf8');
const SUCCESSOR=readFileSync(new URL(dir+'20261119123459_tables_quarantine_successor_evidence.sql',import.meta.url),'utf8');
const RUN='00000000-0000-4000-8000-000000000001';

async function setup({successor=true}={}){
 const db=new PGlite();
 const day=await installCleaningFixture(db,{afterCleaning:async d=>{
  await d.exec(AUTO_NORMAL);await d.exec(QUARANTINE);if(successor)await d.exec(SUCCESSOR);}});
 await db.exec('update table_operations_private.config set enabled=true');
 return {db,day};
}
// Times are minutes before now. The fixture's paid receipt 100 (paid-order, BAR4) is at -1.
async function put(db,day,{id,name='BAR4',status=1,start,observed=0,quarantined=null}){
 await db.query(`insert into pos_open_orders_private.orders(scope,business_date,order_id,order_no,status,status_class,order_date,total_amount,
  table_name,has_lines,run_id,observed_at,quarantined_at,quarantine_reason)
  values($1,$2,$3,$3,$4,'open',clock_timestamp()-($5||' minutes')::interval,100000,$6,false,$7,clock_timestamp()-($8||' minutes')::interval,
  case when $9::int is null then null else clock_timestamp()-($9||' minutes')::interval end,case when $9::int is null then null else 'vanished_unconfirmed' end)`,
  [scope,day,id,status,String(start),name,RUN,String(observed),quarantined]);
}
const A=(db,day,o={})=>put(db,day,{id:'order-a',start:60,observed:40,quarantined:35,...o});
const B=(db,day,o={})=>put(db,day,{id:'paid-order',start:20,observed:5,...o});
const rows=async(db,sql)=>(await db.query(sql)).rows;

test('RED on production chain: quarantined A blocks paid B forever; GREEN with successor evidence',async()=>{
 const before=await setup({successor:false});
 try{
  await A(before.db,before.day);await B(before.db,before.day);
  assert.equal((await context(before.db,before.day)).keys[tableId],undefined);
 }finally{await before.db.close();}
 const {db,day}=await setup();
 try{
  await A(db,day);await B(db,day);
  const receipts=await rows(db,'select to_jsonb(r) r from pos_sales_receipts r order by id');
  const orders=await rows(db,'select to_jsonb(o) o from pos_open_orders_private.orders o order by order_id');
  const ctx=await context(db,day);
  assert.equal(ctx.keys[tableId].receiptId,100);
  // The server projection independently agrees: paid by B, A kept as a quarantine record.
  const tile=view(ctx,day).tables.find(t=>t.id===tableId);
  assert.equal(tile.state,'paid');assert.ok(tile.orders.find(o=>o.id==='order-a').quarantined);
  const epoch=(await rows(db,`select table_operations_private.evidence_v1('${scope}','${day}','${tableId}') e`))[0].e.orderEpoch;
  assert.deepEqual(epoch.filter(v=>v[0]==='quarantined').map(v=>[v[1],v[3]]),[['order-a','vanished_unconfirmed']]);
  await db.exec('set role service_role');
  assert.equal((await confirm(db,day,ctx)).saved,true);
  await db.exec('reset role');
  assert.ok((await context(db,day)).cleanedTableIds.includes(tableId));
  // A's source row, quarantine and every receipt remain exactly as they were.
  assert.deepEqual(await rows(db,'select to_jsonb(r) r from pos_sales_receipts r order by id'),receipts);
  assert.deepEqual(await rows(db,'select to_jsonb(o) o from pos_open_orders_private.orders o order by order_id'),orders);
 }finally{await db.close();}
});

test('insufficient independence or ordering keeps the table blocked',async t=>{
 const cases={
  'B started inside the quarantine window':async(db,day)=>{await A(db,day);await B(db,day,{start:38});},
  'B started before A was last listed (possible merge target)':async(db,day)=>{await A(db,day);await B(db,day,{start:50});},
  'B has no retained order row (receipt only)':async(db,day)=>{await A(db,day);},
  'B listed at a different table':async(db,day)=>{await A(db,day);await B(db,day,{name:'BAR5'});},
  'A is a normal unfinished order':async(db,day)=>{await A(db,day,{quarantined:null});await B(db,day);},
  'A last observation after its quarantine time':async(db,day)=>{await A(db,day,{observed:30});await B(db,day);},
  'another live order at the table':async(db,day)=>{await A(db,day);await B(db,day);await put(db,day,{id:'order-c',start:2});},
 };
 for(const [name,arrange] of Object.entries(cases))await t.test(name,async()=>{
  const {db,day}=await setup();
  try{await arrange(db,day);assert.equal((await context(db,day)).keys[tableId],undefined);}finally{await db.close();}
 });
});

test('C after B invalidates; A reappearing or re-quarantined never resurrects an old cleaning',async t=>{
 const {db,day}=await setup();
 try{
  await A(db,day);await B(db,day);
  const ctx=await context(db,day);
  await db.exec('set role service_role');await confirm(db,day,ctx);await db.exec('reset role');
  await t.test('C entering takes precedence and appends an invalidation',async()=>{
   await put(db,day,{id:'order-c',start:0.5});
   assert.equal((await context(db,day)).keys[tableId],undefined);
   assert.equal((await rows(db,'select count(*)::int n from table_operations_private.invalidations'))[0].n,1);
   await db.exec("delete from pos_open_orders_private.orders where order_id='order-c'");
   const after=await context(db,day);
   assert.ok(after.keys[tableId]);assert.ok(!after.cleanedTableIds.includes(tableId));
  });
 }finally{await db.close();}
 const second=await setup();
 try{
  const {db:d,day:dd}=second;
  await A(d,dd);await B(d,dd);
  const ctx=await context(d,dd);
  await d.exec('set role service_role');await confirm(d,dd,ctx);await d.exec('reset role');
  await t.test('A listed again blocks and the stale screen cannot confirm',async()=>{
   await d.exec("update pos_open_orders_private.orders set quarantined_at=null,quarantine_reason=null,observed_at=clock_timestamp() where order_id='order-a'");
   assert.equal((await context(d,dd)).keys[tableId],undefined);
   await d.exec('set role service_role');
   await assert.rejects(confirm(d,dd,ctx,{requestId:'00000000-0000-4000-8000-000000000005'}),/stale/);
   await d.exec('reset role');
  });
  await t.test('re-quarantine gives a new generation, old event stays retired',async()=>{
   await d.exec("update pos_open_orders_private.orders set observed_at=clock_timestamp()-interval '3 minutes',quarantined_at=clock_timestamp()-interval '2 minutes',quarantine_reason='vanished_unconfirmed' where order_id='order-a'");
   // A now vanished AFTER B started: B is no longer clearly newer.
   assert.equal((await context(d,dd)).keys[tableId],undefined);
   await d.exec("update pos_open_orders_private.orders set observed_at=clock_timestamp()-interval '31 minutes',quarantined_at=clock_timestamp()-interval '30 minutes' where order_id='order-a'");
   const again=await context(d,dd);
   assert.ok(again.keys[tableId]);
   assert.notEqual(again.keys[tableId].evidenceKey,ctx.keys[tableId].evidenceKey);
   assert.ok(!again.cleanedTableIds.includes(tableId));
  });
 }finally{await second.db.close();}
});

test('automatic observation: autoKey follows quarantine changes; 30-minute timer cannot carry over',async()=>{
 const {db,day}=await setup();
 try{
  await A(db,day);await B(db,day);
  const activation=await enableAuto(db);
  const ctx=await autoContext(db,day,activation);
  assert.ok(ctx.keys[tableId].autoKey);
  assert.equal((await observe(db,day,activation,ctx)).saved,1);
  assert.ok((await autoContext(db,day,activation)).observations[tableId]);
  await db.exec("update pos_open_orders_private.orders set quarantined_at=quarantined_at+interval '1 second' where order_id='order-a'");
  const changed=await autoContext(db,day,activation);
  assert.notEqual(changed.keys[tableId].autoKey,ctx.keys[tableId].autoKey);
  assert.equal(changed.observations[tableId],undefined);
 }finally{await db.close();}
});

test('compatibility: tables without quarantine keep identical keys, events and observations; only evidence_v1 changes',async()=>{
 const {db,day}=await setup({successor:false});
 try{
  await B(db,day);
  const activation=await enableAuto(db);
  const ctx=await context(db,day);
  await db.exec('set role service_role');await confirm(db,day,ctx);await db.exec('reset role');
  await observe(db,day,activation);
  const manual=await context(db,day),auto=await autoContext(db,day,activation);
  const fns=`select p.oid::regprocedure::text f,md5(pg_get_functiondef(p.oid)) h,p.prosecdef,p.provolatile,p.proacl::text acl from pg_proc p
   join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','table_operations_private','pos_open_orders_private') order by 1`;
  const before=await rows(db,fns);
  await db.exec(SUCCESSOR);
  const after=await rows(db,fns);
  assert.deepEqual(after.map(r=>r.f),before.map(r=>r.f));
  const changed=after.filter((r,i)=>r.h!==before[i].h).map(r=>r.f);
  assert.deepEqual(changed,['table_operations_private.evidence_v1(text,date,uuid)']);
  const ev=after.find(r=>r.f===changed[0]),old=before.find(r=>r.f===changed[0]);
  assert.deepEqual([ev.prosecdef,ev.provolatile,ev.acl],[old.prosecdef,old.provolatile,old.acl]);
  assert.deepEqual(await context(db,day),manual);
  const noClock=value=>({...value,serverNow:null});
  assert.deepEqual(noClock(await autoContext(db,day,activation)),noClock(auto));
  assert.ok(manual.cleanedTableIds.includes(tableId));
  for(const role of ['anon','authenticated','service_role']){
   await db.exec('set role '+role);
   await assert.rejects(db.query(`select table_operations_private.evidence_v1('${scope}','${day}','${tableId}')`),/permission denied/);
   await db.exec('reset role');
  }
 }finally{await db.close();}
});

test('collection unhealthy or in flight still blocks every key',async()=>{
 const {db,day}=await setup();
 try{
  await A(db,day);await B(db,day);
  await db.exec("update pos_open_orders_private.sync_state set last_error_code='orders_vanished_unconfirmed'");
  assert.deepEqual((await context(db,day)).keys,{});
  await db.exec('update pos_open_orders_private.sync_state set last_error_code=null');
  await db.query(`insert into pos_open_orders_private.runs(id,scope,branch_id,business_date,owner_token,status,lease_until)
   values('00000000-0000-4000-8000-000000000009',$1,split_part($1,':',2),$2,'00000000-0000-4000-8000-000000000008','collecting',clock_timestamp()+interval '1 minute')`,[scope,day]);
  assert.deepEqual((await context(db,day)).keys,{});
 }finally{await db.close();}
});
