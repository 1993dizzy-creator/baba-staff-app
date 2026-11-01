// Local, disposable PostgreSQL only. No production connection or credentials.
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {nativeInventoryPostgres} from './helpers/inventory-native-postgres.mjs';
import {initializePosCloseDatabase} from './helpers/pos-business-day-close-fixture.mjs';
import {initializeResolutionSchema,initializeWork} from './helpers/payment-upgrade-fixture.mjs';
import {reproduceOperatingInventoryContract} from './helpers/payment-upgrade-inventory-fixture.mjs';

const read=n=>readFileSync('supabase/migrations/'+n,'utf8');
const migration=read('20261101180623_pos_stock_check_boundary_guard.sql');
const q=async(db,s,a=[])=>(await db.query(s,a)).rows;
const saleAt='2026-10-12T10:00:00Z';

test('POS stock-check boundary: atomic engines and concurrent physical counts',{timeout:120000},async t=>{
 const rt=await nativeInventoryPostgres({testContext:t});
 async function setup({install=true}={}){
  const db=new rt.Database();
  await initializePosCloseDatabase(db);
  await db.exec(read('20260912160056_add_pos_business_day_close_checks.sql'));
  await initializeResolutionSchema(db,{migration:'select 1'});
  await initializeWork(db,{migration:'select 1',beforeMigration:reproduceOperatingInventoryContract});
  // Match the operating quantity precision, including rounding of 0.0714 to 0.07.
  await db.exec('alter table inventory alter column quantity type numeric(10,2);alter table inventory_logs add column created_at timestamptz default clock_timestamp(),alter column prev_quantity type numeric(10,2),alter column new_quantity type numeric(10,2),alter column change_quantity type numeric(10,2)');
  const catalog=()=>q(db,"select oid::int,proowner::int,proacl::text,prosecdef,proconfig from pg_proc where proname in ('apply_sales_inventory_deduction_batch','reprocess_modified_sales_inventory_deduction_receipt','rollback_canceled_sales_inventory_deduction_receipt') order by oid");
  const before=await catalog();if(install)await db.exec(migration);assert.deepEqual(await catalog(),before);
  await db.exec("insert into inventory(id,quantity,item_name,unit) values(1,100,'Stock','unit'),(2,100,'Other','unit');insert into pos_item_mappings values(1,'TEST','direct',true,1,1,1,false),(2,'OTHER','direct',true,1,2,1,false)");
  await db.query("insert into pos_sales_receipts(id,ref_id,ref_no,business_date,ref_date,payment_status,is_canceled,final_amount,revision,updated_at) values(10,'ref-10','synthetic','2026-10-12',$1,3,false,100000,0,now())",[saleAt]);
  await db.exec("insert into pos_sales_receipt_lines(receipt_id,receipt_ref_id,item_code,item_name,quantity,unit_price,payment_status,is_canceled,raw_json) values(10,'ref-10','TEST','Item',1,100000,3,false,'{}')");
  return db;
 }
 async function candidate(db,{workflow='initial_apply',quantity=1,items=[1]}={}){
  const r=(await q(db,'select to_jsonb(r) r from pos_sales_receipts r where id=10'))[0].r;
  const b=(await q(db,"insert into pos_inventory_deduction_batches(flow_version,business_date_from,business_date_to,source,status,receipt_count,ready_receipt_count,created_by) values('sales_db_v1','2026-10-12','2026-10-12','manual_preview','previewed',1,1,'owner') returning id"))[0].id;
  if(workflow==='reprocess_modified')await db.query("update pos_inventory_deduction_batches set source='reprocess_modified' where id=$1",[b]);
  const fingerprint=randomUUID(),hash=randomUUID();
  const br=(await q(db,"insert into pos_inventory_deduction_receipts(batch_id,receipt_id,business_date,status,inventory_affecting_hash,amount_hash,previewed_receipt_updated_at,selected_for_apply,workflow_type,receipt_content_fingerprint,line_summary) values($1,10,'2026-10-12','ready',$2,'amount',$3,true,$4,$5,'{\"hashVersion\":2}') returning id",[b,hash,r.updated_at,workflow,fingerprint]))[0].id;
  const line=(await q(db,'select id from pos_sales_receipt_lines where receipt_id=10'))[0].id;
  for(const item of items)await db.query("insert into pos_inventory_deductions(receipt_id,invoice_ref_id,batch_id,batch_receipt_id,receipt_line_id,ref_detail_id,pos_item_code,pos_item_name,mapping_id,mapping_type,inventory_item_id,operation_type,status,flow_version,business_date,mapping_snapshot,inventory_affecting_hash,amount_hash,idempotency_key,quantity_sold,deduct_quantity_per_unit,deduct_quantity_total,deduct_quantity) values(10,'ref-10',$1,$2,$3,'detail',$4,'Item',$5,'direct',$5,'preview','selected','sales_db_v1','2026-10-12','{\"mappingVersion\":1}',$6,'amount',$7,$8,1,$8,$8)",[b,br,line,item===1?'TEST':'OTHER',item,hash,randomUUID(),quantity]);
  return {b,br,r,hash,fingerprint};
 }
 const apply=async(db,c)=>(await q(db,"select apply_sales_inventory_deduction_batch($1,'owner',$2::jsonb) r",[c.b,JSON.stringify([{receiptId:10,currentInventoryHash:c.hash,currentReceiptUpdatedAt:c.r.updated_at,applyAllowed:true}])]))[0].r;
 const reprocess=async(db,c)=>(await q(db,"select reprocess_modified_sales_inventory_deduction_receipt($1,'owner',$2,$3,$4) r",[c.br,c.r.updated_at,c.fingerprint,c.hash]))[0].r;
 async function cancel(db){await db.query('update pos_sales_receipts set is_canceled=true,updated_at=clock_timestamp() where id=10');const r=(await q(db,'select to_jsonb(r) r from pos_sales_receipts r where id=10'))[0].r;return (await q(db,"select rollback_canceled_sales_inventory_deduction_receipt(10,'owner',$1,'cancel-fingerprint') r",[r.updated_at]))[0].r;}
 async function count(db,at='2026-10-13T10:00:00Z',item=1){await db.query("update inventory set quantity=50 where id=$1",[item]);await db.query("insert into inventory_logs(item_id,reason,source,created_at,change_quantity) values($1,'stock_check','edit_form',$2,0)",[item,at]);}
 const snapshot=async db=>({stock:await q(db,'select id,quantity from inventory order by id'),deductions:await q(db,'select to_jsonb(d) d from pos_inventory_deductions d order by id'),logs:await q(db,'select to_jsonb(l) l from inventory_logs l order by id')});
 async function locked(db,pid){
  for(let i=0;i<100;i++){
   if((await q(db,"select wait_event_type from pg_stat_activity where pid=$1",[pid]))[0]?.wait_event_type==='Lock')return;
   await new Promise(r=>setTimeout(r,20));
  }
  assert.fail('Concurrent operation never waited for the inventory lock');
 }

 await t.test('initial deduction, modification, cancel and idempotent retry before any count',async()=>{
  const db=await setup();assert.equal((await apply(db,await candidate(db))).ok,true);
  const c=await candidate(db,{workflow:'reprocess_modified',quantity:2});
  assert.equal((await reprocess(db,c)).result,'applied');
  const applied=await snapshot(db);assert.equal((await reprocess(db,c)).result,'already_processed');assert.deepEqual(await snapshot(db),applied);
  assert.equal((await cancel(db)).result,'applied');
  assert.equal(Number((await q(db,'select quantity from inventory where id=1'))[0].quantity),100);
  const restored=await snapshot(db);assert.equal((await cancel(db)).result,'already_processed');assert.deepEqual(await snapshot(db),restored);
 });
 await t.test('late initial deduction rolls back all items, retains count and persists review',async()=>{
  const db=await setup();await count(db,undefined,2);const c=await candidate(db,{items:[1,2]});const before=await snapshot(db);
  assert.equal((await apply(db,c)).result,'needs_check');assert.deepEqual(await snapshot(db),before);
  const r=(await q(db,'select inventory_deduction_pending_status,inventory_deduction_processing_error from pos_sales_receipts where id=10'))[0];
  assert.equal(r.inventory_deduction_pending_status,'needs_check');assert.equal(r.inventory_deduction_processing_error,'stock_check_boundary_requires_review');
  assert.equal((await q(db,'select status,review_reason from pos_inventory_deduction_receipts where id=$1',[c.br]))[0].review_reason,r.inventory_deduction_processing_error);
  assert.equal((await apply(db,await candidate(db,{items:[1,2]}))).result,'needs_check');assert.deepEqual((await snapshot(db)).stock,before.stock);
 });
 await t.test('later count blocks reprocess and cancel without changing prior audit history',async()=>{
  const db=await setup();await apply(db,await candidate(db));await count(db);
  const c=await candidate(db,{workflow:'reprocess_modified',quantity:2});const before=await snapshot(db);
  assert.equal((await reprocess(db,c)).result,'needs_check');assert.deepEqual(await snapshot(db),before);
  assert.equal((await cancel(db)).result,'needs_check');assert.deepEqual(await snapshot(db),before);
  assert.equal((await q(db,"select count(*)::int n from pos_inventory_deduction_receipts where workflow_type='rollback_canceled'"))[0].n,0);
 });
 await t.test('synthetic replay of 2601006796: October 11 count blocks October 12 restore/reapply',async()=>{
  const db=await setup();
  await db.exec("update pos_sales_receipts set ref_date='2026-10-09T13:00:09.387Z' where id=10;update inventory set quantity=0.6 where id=1");
  await apply(db,await candidate(db,{quantity:0.0714}));
  assert.equal(Number((await snapshot(db)).stock[0].quantity),0.53);
  await db.exec("update inventory set quantity=0.2 where id=1;insert into inventory_logs(item_id,reason,source,created_at,new_quantity) values(1,'stock_check','edit_form','2026-10-11T11:12:18.771293Z',0.2);update inventory set quantity=1.2 where id=1;insert into inventory_logs(item_id,reason,source,change_quantity) values(1,'purchase','edit_form',1)");
  const c=await candidate(db,{workflow:'reprocess_modified',quantity:1}),before=await snapshot(db);
  assert.equal((await reprocess(db,c)).result,'needs_check');assert.deepEqual(await snapshot(db),before);
 });
 await t.test('count boundary: older allowed; equal, later, unknown count time and missing sale time blocked',async()=>{
  for(const [at,allowed] of [['2026-10-12T09:59:59.999999Z',true],[saleAt,false],['2026-10-12T10:00:00.000001Z',false],[null,false]]){
   const db=await setup();await count(db,at);const before=await snapshot(db);const result=await apply(db,await candidate(db));
   if(allowed){assert.equal(result.ok,true);assert.equal(Number((await snapshot(db)).stock[0].quantity),49);}else{assert.equal(result.result,'needs_check');assert.deepEqual((await snapshot(db)).stock,before.stock);}
  }
  const db=await setup();await db.exec('update pos_sales_receipts set ref_date=null where id=10');assert.equal((await apply(db,await candidate(db))).result,'needs_check');
 });
 await t.test('concurrent count commits first: waiting sale observes it and cannot overwrite stock',async()=>{
  const db=await setup(),c=await candidate(db),writer=await rt.connect(db.name),reader=await rt.connect(db.name);
  await writer.query('begin');await count(writer);
  const pid=(await q(reader,'select pg_backend_pid() pid'))[0].pid;
  const pending=apply(reader,c);await locked(db,pid);await writer.query('commit');
  assert.equal((await pending).result,'needs_check');assert.equal(Number((await snapshot(db)).stock[0].quantity),50);
 });
 await t.test('concurrent sale commits first: later count becomes the final stock; repeatable read fails closed',async()=>{
  const db=await setup(),c=await candidate(db),sale=await rt.connect(db.name),counter=await rt.connect(db.name);
  await sale.query('begin');assert.equal((await apply(sale,c)).ok,true);
  const pid=(await q(counter,'select pg_backend_pid() pid'))[0].pid;
  const pending=(async()=>{await counter.query('begin');await count(counter);await counter.query('commit');})();
  await locked(db,pid);await sale.query('commit');await pending;
  assert.equal(Number((await snapshot(db)).stock[0].quantity),50);
  const db2=await setup(),c2=await candidate(db2);await db2.exec('begin isolation level repeatable read');
  assert.equal((await apply(db2,c2)).result,'needs_check');await db2.exec('commit');
 });
 await t.test('two concurrent reprocess/cancel requests produce only one set of movements',async()=>{
  const db=await setup();await apply(db,await candidate(db));
  const c=await candidate(db,{workflow:'reprocess_modified',quantity:2});
  const first=await rt.connect(db.name),second=await rt.connect(db.name);
  await first.query('begin');assert.equal((await reprocess(first,c)).result,'applied');
  const pid=(await q(second,'select pg_backend_pid() pid'))[0].pid;
  const retry=reprocess(second,c);await locked(db,pid);await first.query('commit');assert.equal((await retry).result,'already_processed');
  assert.equal(Number((await snapshot(db)).stock[0].quantity),98);
  await db.exec('update pos_sales_receipts set is_canceled=true where id=10');
  const time=(await q(db,'select to_jsonb(r) r from pos_sales_receipts r where id=10'))[0].r.updated_at;
  const run=async client=>(await q(client,"select rollback_canceled_sales_inventory_deduction_receipt(10,'owner',$1,'concurrent-cancel') r",[time]))[0].r;
  await first.query('begin');assert.equal((await run(first)).result,'applied');
  const retryCancel=run(second);await locked(db,pid);await first.query('commit');assert.equal((await retryCancel).result,'already_processed');
  assert.equal(Number((await snapshot(db)).stock[0].quantity),100);
 });
 await t.test('concurrent initial apply and a late conflict after a successful reversal remain atomic',async()=>{
  const db=await setup(),c=await candidate(db),first=await rt.connect(db.name),second=await rt.connect(db.name);
  await first.query('begin');assert.equal((await apply(first,c)).ok,true);
  const pid=(await q(second,'select pg_backend_pid() pid'))[0].pid;
  const retry=assert.rejects(apply(second,c),e=>e.code==='P0001');
  await locked(db,pid);await first.query('commit');await retry;
  assert.equal(Number((await snapshot(db)).stock[0].quantity),99);
  await count(db,undefined,2);
  const changed=await candidate(db,{workflow:'reprocess_modified',items:[2],quantity:2}),before=await snapshot(db);
  assert.equal((await reprocess(db,changed)).result,'needs_check');assert.deepEqual(await snapshot(db),before);
 });
 await t.test('direct POS log insert cannot bypass guard; unrelated audit entries remain valid',async()=>{
  const db=await setup();await count(db);const before=await snapshot(db);
  await assert.rejects(db.query("insert into inventory_logs(item_id,source,reason,related_receipt_id,change_quantity) values(1,'pos_sales','sale_deduction',10,-1)"),e=>e.code==='P0S01');
  assert.deepEqual(await snapshot(db),before);
  await db.exec("insert into inventory_logs(item_id,source,reason,change_quantity) values(1,'edit_form','other',0)");
  const permissions=(await q(db,"select has_function_privilege('anon','guard_pos_inventory_stock_check_boundary()','execute') anon,has_function_privilege('authenticated','guard_pos_inventory_stock_check_boundary()','execute') authenticated"))[0];
  assert.deepEqual(permissions,{anon:false,authenticated:false});
 });
 await t.test('unsupported engine definitions abort migration without a partial guard installation',async()=>{
  const db=await setup({install:false});
  const def=(await q(db,"select pg_get_functiondef('apply_sales_inventory_deduction_batch(bigint,text,jsonb)'::regprocedure) d"))[0].d;
  await db.exec(def.replace(/^begin\r?$/m,'begin\n  begin null; exception when others then null; end;'));
  await assert.rejects(db.exec(migration),/Unsupported stock engine definition/);await db.exec('rollback');
  assert.equal((await q(db,"select to_regprocedure('guard_pos_inventory_stock_check_boundary()') f"))[0].f,null);
  assert.equal((await q(db,"select count(*)::int n from pg_trigger where tgname='inventory_logs_pos_stock_check_boundary'"))[0].n,0);
 });
});
