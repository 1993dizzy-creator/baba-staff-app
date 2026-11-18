// Local, disposable PostgreSQL only. No production connection or credentials.
// P0-B: a delayed POS deduction must not consume a later-business-date restock.
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {nativeInventoryPostgres} from './helpers/inventory-native-postgres.mjs';
import {initializePosCloseDatabase} from './helpers/pos-business-day-close-fixture.mjs';
import {initializeResolutionSchema,initializeWork} from './helpers/payment-upgrade-fixture.mjs';
import {reproduceOperatingInventoryContract} from './helpers/payment-upgrade-inventory-fixture.mjs';

const read=n=>readFileSync('supabase/migrations/'+n,'utf8');
const p0=read('20261101180623_pos_stock_check_boundary_guard.sql');
const p0b=read('20261118075543_pos_delayed_deduction_restock_boundary.sql');
const q=async(db,s,a=[])=>(await db.query(s,a)).rows;
const saleAt='2026-10-12T10:00:00Z',saleDay='2026-10-12';

test('POS delayed deduction: later-business-date restock boundary (P0-B)',{timeout:180000},async t=>{
 const rt=await nativeInventoryPostgres({testContext:t});
 async function setup({stock=0,installP0B=true}={}){
  const db=new rt.Database();
  await initializePosCloseDatabase(db);
  await db.exec(read('20260912160056_add_pos_business_day_close_checks.sql'));
  await initializeResolutionSchema(db,{migration:'select 1'});
  await initializeWork(db,{migration:'select 1',beforeMigration:reproduceOperatingInventoryContract});
  await db.exec('alter table inventory alter column quantity type numeric(10,2);alter table inventory_logs add column created_at timestamptz default clock_timestamp(),alter column prev_quantity type numeric(10,2),alter column new_quantity type numeric(10,2),alter column change_quantity type numeric(10,2)');
  await db.exec(p0);
  if(installP0B)await db.exec(p0b);
  await db.query("insert into inventory(id,quantity,item_name,unit) values(1,$1,'Q3','bottle'),(2,100,'Other','unit')",[stock]);
  await db.exec("insert into pos_item_mappings values(1,'Q3','direct',true,1,1,1,false),(2,'OTHER','direct',true,1,2,1,false)");
  await db.query("insert into pos_sales_receipts(id,ref_id,ref_no,business_date,ref_date,payment_status,is_canceled,final_amount,revision,updated_at) values(10,'ref-10','synthetic',$1,$2,3,false,100000,0,now())",[saleDay,saleAt]);
  await db.exec("insert into pos_sales_receipt_lines(receipt_id,receipt_ref_id,item_code,item_name,quantity,unit_price,payment_status,is_canceled,raw_json) values(10,'ref-10','Q3','Item',1,100000,3,false,'{}')");
  return db;
 }
 async function candidate(db,{workflow='initial_apply',quantity=1}={}){
  const r=(await q(db,'select to_jsonb(r) r from pos_sales_receipts r where id=10'))[0].r;
  const b=(await q(db,"insert into pos_inventory_deduction_batches(flow_version,business_date_from,business_date_to,source,status,receipt_count,ready_receipt_count,created_by) values('sales_db_v1',$1,$1,$2,'previewed',1,1,'owner') returning id",[saleDay,workflow==='reprocess_modified'?'reprocess_modified':'manual_preview']))[0].id;
  const fingerprint=randomUUID(),hash=randomUUID();
  const br=(await q(db,"insert into pos_inventory_deduction_receipts(batch_id,receipt_id,business_date,status,inventory_affecting_hash,amount_hash,previewed_receipt_updated_at,selected_for_apply,workflow_type,receipt_content_fingerprint,line_summary) values($1,10,$2,'ready',$3,'amount',$4,true,$5,$6,'{\"hashVersion\":2}') returning id",[b,saleDay,hash,r.updated_at,workflow,fingerprint]))[0].id;
  const line=(await q(db,'select id from pos_sales_receipt_lines where receipt_id=10'))[0].id;
  await db.query("insert into pos_inventory_deductions(receipt_id,invoice_ref_id,batch_id,batch_receipt_id,receipt_line_id,ref_detail_id,pos_item_code,pos_item_name,mapping_id,mapping_type,inventory_item_id,operation_type,status,flow_version,business_date,mapping_snapshot,inventory_affecting_hash,amount_hash,idempotency_key,quantity_sold,deduct_quantity_per_unit,deduct_quantity_total,deduct_quantity) values(10,'ref-10',$1,$2,$3,'detail','Q3','Item',1,'direct',1,'preview','selected','sales_db_v1',$4,'{\"mappingVersion\":1}',$5,'amount',$6,$7,1,$7,$7)",[b,br,line,saleDay,hash,randomUUID(),quantity]);
  return {b,br,r,hash,fingerprint};
 }
 const apply=async(db,c)=>(await q(db,"select apply_sales_inventory_deduction_batch($1,'owner',$2::jsonb) r",[c.b,JSON.stringify([{receiptId:10,currentInventoryHash:c.hash,currentReceiptUpdatedAt:c.r.updated_at,applyAllowed:true}])]))[0].r;
 const reprocess=async(db,c)=>(await q(db,"select reprocess_modified_sales_inventory_deduction_receipt($1,'owner',$2,$3,$4) r",[c.br,c.r.updated_at,c.fingerprint,c.hash]))[0].r;
 async function cancel(db){await db.query('update pos_sales_receipts set is_canceled=true,updated_at=clock_timestamp() where id=10');const r=(await q(db,'select to_jsonb(r) r from pos_sales_receipts r where id=10'))[0].r;return (await q(db,"select rollback_canceled_sales_inventory_deduction_receipt(10,'owner',$1,'cancel-fingerprint') r",[r.updated_at]))[0].r;}
 // A non-POS stock increase (purchase quick_save) entered now for the given business date.
 async function restock(db,{qty=1,businessDate,reason='purchase',source='quick_save'}){
  const prev=Number((await q(db,'select quantity from inventory where id=1'))[0].quantity);
  await db.query('update inventory set quantity=quantity+$1 where id=1',[qty]);
  await db.query("insert into inventory_logs(item_id,reason,source,business_date,prev_quantity,new_quantity,change_quantity) values(1,$1,$2,$3,$4,$5,$6)",[reason,source,businessDate,prev,prev+qty,qty]);
 }
 const stock=async db=>Number((await q(db,'select quantity from inventory where id=1'))[0].quantity);
 const snapshot=async db=>({stock:await q(db,'select id,quantity from inventory order by id'),deductions:await q(db,'select to_jsonb(d) d from pos_inventory_deductions d order by id'),logs:await q(db,'select to_jsonb(l) l from inventory_logs l order by id')});
 const review=async db=>(await q(db,'select inventory_deduction_pending_status status,inventory_deduction_processing_error reason from pos_sales_receipts where id=10'))[0];

 await t.test('Q3 replay: short stock, later-date purchase, delayed deduction is held for review with no movement',async()=>{
  const db=await setup({stock:0});
  await restock(db,{businessDate:'2026-11-15'});
  const c=await candidate(db),before=await snapshot(db);
  const result=await apply(db,c);
  assert.equal(result.result,'needs_check');assert.equal(result.batchRolledBack,true);
  assert.deepEqual(await snapshot(db),before,'No stock, log or deduction may change');
  assert.deepEqual(await review(db),{status:'needs_check',reason:'stock_check_boundary_requires_review'});
  assert.deepEqual((await q(db,'select status,selected_for_apply from pos_inventory_deduction_receipts where id=$1',[c.br]))[0],{status:'failed',selected_for_apply:false});
 });
 await t.test('same business date late purchase entry still auto-deducts',async()=>{
  const db=await setup({stock:0});await restock(db,{businessDate:saleDay});
  assert.equal((await apply(db,await candidate(db))).ok,true);assert.equal(await stock(db),0);
 });
 await t.test('purchase backdated before the sale business date still auto-deducts',async()=>{
  const db=await setup({stock:0});await restock(db,{businessDate:'2026-10-11'});
  assert.equal((await apply(db,await candidate(db))).ok,true);assert.equal(await stock(db),0);
 });
 await t.test('later-date restock with sufficient prior stock does not block a correct late deduction',async()=>{
  const db=await setup({stock:5});await restock(db,{businessDate:'2026-11-15'});
  assert.equal((await apply(db,await candidate(db))).ok,true);assert.equal(await stock(db),5);
 });
 await t.test('deduction dipping only partly into the later restock is held (boundary is strict)',async()=>{
  const db=await setup({stock:1});await restock(db,{qty:2,businessDate:'2026-11-15'});
  const c=await candidate(db,{quantity:2}),before=await snapshot(db);
  assert.equal((await apply(db,c)).result,'needs_check');assert.deepEqual(await snapshot(db),before);
  const ok=await setup({stock:2});await restock(ok,{qty:2,businessDate:'2026-11-15'});
  assert.equal((await apply(ok,await candidate(ok,{quantity:2}))).ok,true);assert.equal(await stock(ok),2);
 });
 await t.test('POS reversals and earlier POS restores are not treated as restocks',async()=>{
  const db=await setup({stock:3});
  assert.equal((await apply(db,await candidate(db))).ok,true);assert.equal(await stock(db),2);
  await restock(db,{businessDate:'2026-11-15'});
  assert.equal((await cancel(db)).result,'applied','Restoring a canceled sale is never blocked by a later restock');
  assert.equal(await stock(db),4);
 });
 await t.test('modified receipt reprocess that would consume a later-date restock is held, history kept',async()=>{
  const db=await setup({stock:1});
  assert.equal((await apply(db,await candidate(db))).ok,true);assert.equal(await stock(db),0);
  await restock(db,{businessDate:'2026-11-15'});
  const c=await candidate(db,{workflow:'reprocess_modified',quantity:2}),before=await snapshot(db);
  assert.equal((await reprocess(db,c)).result,'needs_check');assert.deepEqual(await snapshot(db),before);
  assert.equal((await review(db)).reason,'stock_check_boundary_requires_review');
 });
 await t.test('P0 count boundary is unchanged and still evaluated first',async()=>{
  for(const [at,allowed] of [['2026-10-12T09:59:59Z',true],['2026-10-12T10:00:01Z',false]]){
   const db=await setup({stock:50});
   await db.query("insert into inventory_logs(item_id,reason,source,created_at,change_quantity) values(1,'stock_check','edit_form',$1,0)",[at]);
   const c=await candidate(db),before=await snapshot(db),result=await apply(db,c);
   if(allowed){assert.equal(result.ok,true);assert.equal(await stock(db),49);}
   else{assert.equal(result.result,'needs_check');assert.deepEqual(await snapshot(db),before);}
  }
 });
 await t.test('direct POS log insert cannot bypass P0-B; guard identity, ACL and trigger binding preserved',async()=>{
  const plain=await setup({stock:0,installP0B:false});
  const identity=async db=>(await q(db,"select p.oid::int oid,p.proowner::int owner,p.proacl::text acl,p.prosecdef,p.proconfig,(select count(*)::int from pg_trigger where tgname='inventory_logs_pos_stock_check_boundary' and tgfoid=p.oid and tgenabled='O') bound from pg_proc p where proname='guard_pos_inventory_stock_check_boundary'"))[0];
  const beforeIdentity=await identity(plain);await plain.exec(p0b);
  assert.deepEqual(await identity(plain),beforeIdentity);
  await restock(plain,{businessDate:'2026-11-15'});
  await assert.rejects(plain.query("insert into inventory_logs(item_id,source,reason,related_receipt_id,prev_quantity,new_quantity,change_quantity) values(1,'pos_sales','sale_deduction',10,1,0,-1)"),e=>e.code==='P0S01'&&/restock_after_sale/.test(e.detail));
  await plain.exec("insert into inventory_logs(item_id,source,reason,change_quantity) values(1,'edit_form','other',0)");
  const permissions=(await q(plain,"select has_function_privilege('anon','guard_pos_inventory_stock_check_boundary()','execute') anon,has_function_privilege('authenticated','guard_pos_inventory_stock_check_boundary()','execute') authenticated"))[0];
  assert.deepEqual(permissions,{anon:false,authenticated:false});
 });
 await t.test('batch closed by the app after a failed apply is rejected by the RPC; retry batch applies once',async()=>{
  const db=await setup({stock:10}),failed=await candidate(db);
  // Same statements as closeFailedApplyBatch (conditional on previewed).
  await db.query("update pos_inventory_deduction_batches set status='failed',error_message='apply_rpc_failed:57014' where id=$1 and status='previewed'",[failed.b]);
  await db.query("update pos_inventory_deduction_receipts set status='failed',selected_for_apply=false,error_message='apply_rpc_failed:57014' where batch_id=$1 and status='ready'",[failed.b]);
  const before=await snapshot(db);
  await assert.rejects(apply(db,failed),e=>e.code==='P0001'&&/status failed/.test(e.message));
  assert.deepEqual(await snapshot(db),before);
  assert.equal((await q(db,"select status from pos_inventory_deductions where batch_id=$1",[failed.b]))[0].status,'selected','Failed candidate evidence is kept');
  const retry=await candidate(db);assert.equal((await apply(db,retry)).ok,true);assert.equal(await stock(db),9);
  await assert.rejects(apply(db,failed),e=>e.code==='P0001');assert.equal(await stock(db),9);
 });
 // BABA business day: Asia/Ho_Chi_Minh (UTC+7) with a 03:00 cutoff, as written by
 // the POS sync (receipt.business_date) and inventory writers (log.business_date).
 const ict=s=>new Date(s+'+07:00').toISOString();
 const bdOf=iso=>new Date(Date.parse(iso)+4*3600e3).toISOString().slice(0,10);
 async function scenario({sale,restockAt,restockBd=bdOf(ict(restockAt)),prior=0}){
  const db=await setup({stock:prior}),saleIso=ict(sale);
  await db.query('update pos_sales_receipts set ref_date=$1,business_date=$2 where id=10',[saleIso,bdOf(saleIso)]);
  await db.query('update pos_sales_receipt_lines set business_date=$1 where receipt_id=10',[bdOf(saleIso)]).catch(()=>{});
  await db.query("update inventory set quantity=quantity+1 where id=1");
  await db.query("insert into inventory_logs(item_id,reason,source,business_date,prev_quantity,new_quantity,change_quantity,created_at) values(1,'purchase','quick_save',$1,$2,$3,1,$4)",[restockBd,prior,prior+1,ict(restockAt)]);
  const c=await candidate(db);await db.query('update pos_inventory_deduction_receipts set business_date=$1 where id=$2',[bdOf(saleIso),c.br]);
  const before=await snapshot(db),result=await apply(db,c);
  return {db,result,before};
 }
 await t.test('03:00 business-day boundary scenarios (short prior stock: only the restock could pay)',async()=>{
  for(const [name,sale,restockAt,held] of [
   ['02:58 sale, 03:02 restock -> next business day',      '2026-11-17T02:58:00','2026-11-17T03:02:00',true],
   ['02:50 sale, 03:10 restock -> next business day',      '2026-11-17T02:50:00','2026-11-17T03:10:00',true],
   ['23:50 sale, 00:10 restock -> same business day',      '2026-11-16T23:50:00','2026-11-17T00:10:00',false],
   ['02:10 sale, 02:55 restock -> same business day',      '2026-11-17T02:10:00','2026-11-17T02:55:00',false],
   ['20:00 sale, next-day 18:00 restock -> later day',     '2026-11-16T20:00:00','2026-11-17T18:00:00',true],
  ]){
   const {db,result,before}=await scenario({sale,restockAt});
   if(held){assert.equal(result.result,'needs_check',name);assert.deepEqual(await snapshot(db),before,name);}
   else{assert.equal(result.ok,true,name);assert.equal(await stock(db),0,name);}
  }
 });
 await t.test('03:00 boundary never holds a deduction that existing stock already covers',async()=>{
  for(const [sale,restockAt] of [['2026-11-17T02:58:00','2026-11-17T03:02:00'],['2026-11-16T20:00:00','2026-11-17T18:00:00']]){
   const {db,result}=await scenario({sale,restockAt,prior:1});
   assert.equal(result.ok,true);assert.equal(await stock(db),1);
  }
 });
 await t.test('backdated restock: business date on/before sale allows, later business date holds',async()=>{
  for(const [restockBd,held] of [['2026-11-15',false],['2026-11-16',false],['2026-11-17',true]]){
   const {db,result}=await scenario({sale:'2026-11-16T20:00:00',restockAt:'2026-11-18T15:00:00',restockBd});
   assert.equal(result.result==='needs_check',held,restockBd);
   if(!held)assert.equal(await stock(db),0);
  }
 });
 await t.test('legacy NULL business_date restock is dated from created_at with the 03:00 rule',async()=>{
  for(const [restockAt,held] of [['2026-11-17T01:00:00',false],['2026-11-17T02:59:59',false],['2026-11-17T03:00:00',true],['2026-11-17T05:00:00',true]]){
   const {db,result}=await scenario({sale:'2026-11-16T20:00:00',restockAt,restockBd:null});
   assert.equal(result.result==='needs_check',held,restockAt);
  }
  // Neither business_date nor created_at: fail toward review, never toward deduction.
  const db=await setup({stock:0});
  await db.query("update inventory set quantity=1 where id=1");
  await db.query("insert into inventory_logs(item_id,reason,source,business_date,prev_quantity,new_quantity,change_quantity,created_at) values(1,'purchase','quick_save',null,0,1,1,null)");
  assert.equal((await apply(db,await candidate(db))).result,'needs_check');
 });
 await t.test('migration aborts when the P0 trigger is missing',async()=>{
  const db=await setup({installP0B:false});
  await db.exec('drop trigger inventory_logs_pos_stock_check_boundary on inventory_logs');
  await assert.rejects(db.exec(p0b),/P0 stock-check boundary trigger is missing/);await db.exec('rollback');
 });
});
