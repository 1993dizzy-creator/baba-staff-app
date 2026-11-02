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

test('POS delayed reprocess investigation',{timeout:120000},async t=>{
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
  const fingerprint=workflow==='reprocess_modified'?'same-version':randomUUID(),hash='inventory-hash';
  const br=(await q(db,"insert into pos_inventory_deduction_receipts(batch_id,receipt_id,business_date,status,inventory_affecting_hash,amount_hash,previewed_receipt_updated_at,selected_for_apply,workflow_type,receipt_content_fingerprint,line_summary) values($1,10,'2026-10-12','ready',$2,'amount',$3,true,$4,$5,'{\"hashVersion\":2}') returning id",[b,hash,r.updated_at,workflow,fingerprint]))[0].id;
  const line=(await q(db,'select id from pos_sales_receipt_lines where receipt_id=10'))[0].id;
  for(const item of items)await db.query("insert into pos_inventory_deductions(receipt_id,invoice_ref_id,batch_id,batch_receipt_id,receipt_line_id,ref_detail_id,pos_item_code,pos_item_name,mapping_id,mapping_type,inventory_item_id,operation_type,status,flow_version,business_date,mapping_snapshot,inventory_affecting_hash,amount_hash,idempotency_key,quantity_sold,deduct_quantity_per_unit,deduct_quantity_total,deduct_quantity) values(10,'ref-10',$1,$2,$3,'detail',$4,'Item',$5,'direct',$5,'preview','selected','sales_db_v1','2026-10-12','{\"mappingVersion\":1}',$6,'amount',$7,$8,1,$8,$8)",[b,br,line,item===1?'TEST':'OTHER',item,hash,randomUUID(),quantity]);
  return {b,br,r,hash,fingerprint};
 }
 const apply=async(db,c)=>(await q(db,"select apply_sales_inventory_deduction_batch($1,'owner',$2::jsonb) r",[c.b,JSON.stringify([{receiptId:10,currentInventoryHash:c.hash,currentReceiptUpdatedAt:c.r.updated_at,applyAllowed:true}])]))[0].r;
 const reprocess=async(db,c)=>(await q(db,"select reprocess_modified_sales_inventory_deduction_receipt($1,'owner',$2,$3,$4) r",[c.br,c.r.updated_at,c.fingerprint,c.hash]))[0].r;

 const state=async db=>({stock:await q(db,'select id,quantity from inventory order by id'),logs:await q(db,'select to_jsonb(l) l from inventory_logs l order by id'),active:await q(db,"select to_jsonb(d) d from pos_inventory_deductions d where status='applied' order by id")});
 async function initial(db){
  await db.exec('update inventory set quantity=0.10 where id=1');
  assert.equal((await apply(db,await candidate(db,{quantity:0.0714}))).ok,true);
  assert.equal(Number((await q(db,'select quantity from inventory where id=1'))[0].quantity),0.03);
  await db.exec("update pos_sales_receipts set updated_at=clock_timestamp(),inventory_deduction_auto_eligible_at=clock_timestamp(),inventory_deduction_reprocess_required=true where id=10");
 }
 await t.test('initial apply -> 55 rolled-back failures -> delivery -> attempt 56 succeeds',async()=>{
  const db=await setup();await initial(db);const before=await state(db);
  for(let i=0;i<55;i++){
   const c=await candidate(db,{workflow:'reprocess_modified'});
   await assert.rejects(reprocess(db,c),e=>e.code==='23514'&&e.constraint==='pos_inventory_deduction_receipts_selection_check');
   assert.deepEqual((await q(db,'select status,selected_for_apply,error_message from pos_inventory_deduction_receipts where id=$1',[c.br]))[0],{status:'ready',selected_for_apply:true,error_message:null});
   assert.equal((await q(db,'select status from pos_inventory_deduction_batches where id=$1',[c.b]))[0].status,'previewed');
   await db.exec("update pos_sales_receipts set inventory_deduction_last_checked_at=clock_timestamp(),inventory_deduction_pending_status='failed' where id=10");
  }
  assert.deepEqual(await state(db),before);
  assert.equal((await q(db,"select count(*)::int n from pos_inventory_deduction_receipts where workflow_type='reprocess_modified' and receipt_content_fingerprint='same-version'"))[0].n,55);
  assert.equal((await q(db,'select inventory_deduction_auto_eligible_at is not null eligible from pos_sales_receipts where id=10'))[0].eligible,true);
  await db.exec("update inventory set quantity=quantity+2 where id=1;insert into inventory_logs(item_id,reason,source,change_quantity) values(1,'purchase','synthetic_test',2)");
  const c=await candidate(db,{workflow:'reprocess_modified'});assert.equal((await reprocess(db,c)).result,'applied');
  assert.equal(Number((await q(db,'select quantity from inventory where id=1'))[0].quantity),1.10);
  const after=await state(db);assert.equal((await reprocess(db,c)).result,'already_processed');assert.deepEqual(await state(db),after);
  t.diagnostic('Synthetic: 0.0714 initial deduction leaves 0.03; 55 x 23514 retain ready previews; +2 delivery permits attempt 56, leaving 1.10');
 });
 await t.test('local-only minimal fix persists failures; repeated failed call exposes reason overwrite',async()=>{
  const db=await setup();await initial(db);
  const sig='public.reprocess_modified_sales_inventory_deduction_receipt(bigint,text,timestamptz,text,text)';
  const original=(await q(db,'select pg_get_functiondef($1::regprocedure) d',[sig]))[0].d;
  const pattern=/(update public\.pos_inventory_deduction_receipts\s+set\s+status = 'failed',)(?! selected_for_apply)/g;
  assert.equal([...original.matchAll(pattern)].length,14);
  const patched=original.replace(pattern,"$1 selected_for_apply = false,");assert.ok(patched.includes('POS_STOCK_CHECK_P0_GUARD'));await db.exec(patched);
  const c=await candidate(db,{workflow:'reprocess_modified'}),before=await state(db);
  const result=await reprocess(db,c);assert.equal(result.failureReason,'insufficient_stock_after_reversal');assert.equal(result.result,'failed');assert.deepEqual(await state(db),before);
  assert.deepEqual((await q(db,'select status,selected_for_apply,error_message from pos_inventory_deduction_receipts where id=$1',[c.br]))[0],{status:'failed',selected_for_apply:false,error_message:result.failureReason});
  assert.equal((await q(db,'select error_message from pos_inventory_deduction_batches where id=$1',[c.b]))[0].error_message,result.failureReason);
  assert.equal((await reprocess(db,c)).failureReason,'not_reprocess_batch_receipt');
  for(const [reason,mutate] of [
   ['stale_preview',async c=>{c.hash='stale';}],
   ['not_reprocess_batch_receipt',async c=>{await db.query("update pos_inventory_deduction_batches set source='manual_preview' where id=$1",[c.b]);}],
   ['mapping_changed',async()=>{await db.exec('update pos_item_mappings set mapping_version=2 where id=1');}],
   ['candidate_metadata_missing',async c=>{await db.query('update pos_inventory_deductions set mapping_id=null where batch_receipt_id=$1',[c.br]);}],
   ['canceled_after_applied_not_supported',async()=>{await db.exec('update pos_sales_receipts set is_canceled=true where id=10');}]
  ]){
   await db.exec('update pos_item_mappings set mapping_version=1 where id=1;update pos_sales_receipts set is_canceled=false where id=10');
   const c=await candidate(db,{workflow:'reprocess_modified'});await mutate(c);const before=await state(db);assert.equal((await reprocess(db,c)).failureReason,reason);assert.deepEqual(await state(db),before);
   assert.deepEqual((await q(db,'select status,selected_for_apply,error_message from pos_inventory_deduction_receipts where id=$1',[c.br]))[0],{status:'failed',selected_for_apply:false,error_message:reason});
  }
  // Proposed terminal guard: after authorization/row locks and applied check,
  // preserve the first failed attempt; a new dependency version creates a new attempt.
  const terminal=`  if v_batch_receipt.status = 'failed' then
    return jsonb_build_object('result','failed','failureReason',v_batch_receipt.error_message,
      'receiptId',v_batch_receipt.receipt_id,'batchId',v_batch.id,
      'deductionReceiptId',v_batch_receipt.id,'reversedDeductionCount',0,'appliedDeductionCount',0);
  end if;

`;
  await db.exec(patched.replace("  if v_batch.source <> 'reprocess_modified'",terminal+"  if v_batch.source <> 'reprocess_modified'"));
  await db.exec('update pos_sales_receipts set is_canceled=false where id=10');
  const terminalCandidate=await candidate(db,{workflow:'reprocess_modified'});
  const first=await reprocess(db,terminalCandidate);
  const failedState=await q(db,'select to_jsonb(r) r from pos_inventory_deduction_receipts r where id=$1',[terminalCandidate.br]);
  assert.deepEqual(await reprocess(db,terminalCandidate),await reprocess(db,terminalCandidate));
  assert.equal((await reprocess(db,terminalCandidate)).failureReason,first.failureReason);
  assert.deepEqual(await q(db,'select to_jsonb(r) r from pos_inventory_deduction_receipts r where id=$1',[terminalCandidate.br]),failedState);
  t.diagnostic('14 failed UPDATE sites patched locally; six failure reasons verified; terminal guard preserves failure reason on repeated calls');
 });
 t.diagnostic(rt.version);
});
