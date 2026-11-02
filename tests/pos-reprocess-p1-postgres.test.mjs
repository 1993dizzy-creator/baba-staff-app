// Local, disposable PostgreSQL only. No production connection or credentials.
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {nativeInventoryPostgres} from './helpers/inventory-native-postgres.mjs';
import {initializePosCloseDatabase} from './helpers/pos-business-day-close-fixture.mjs';
import {initializeResolutionSchema,initializeWork} from './helpers/payment-upgrade-fixture.mjs';
import {reproduceOperatingInventoryContract} from './helpers/payment-upgrade-inventory-fixture.mjs';

const read=n=>readFileSync('supabase/migrations/'+n,'utf8');
const migration=read('20261101180623_pos_stock_check_boundary_guard.sql');
const q=async(db,s,a=[])=>(await db.query(s,a)).rows;
const saleAt='2026-10-12T10:00:00Z';

test('POS P1-1 failure persistence and dedup',{timeout:120000},async t=>{
 const rt=await nativeInventoryPostgres({testContext:t});
 async function setup({install=true,p1=true}={}){
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
  if(p1){
   try { await db.exec(read('20261102101859_pos_reprocess_failure_persistence_and_dedup.sql')); }
   catch(e){await db.exec('rollback');t.diagnostic(JSON.stringify(await q(db,"select md5(replace(replace(prosrc, E'\\r\\n', E'\\n'), E'\\r', E'\\n')) hash from pg_proc where proname='reprocess_modified_sales_inventory_deduction_receipt'")));throw e;}
   assert.deepEqual(await catalog(),before);
  }
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

 async function plan(db,{quantity=1,fingerprint='same-version'}={}){
  const r=(await q(db,'select to_jsonb(r) r from pos_sales_receipts r where id=10'))[0].r;
  const line=(await q(db,'select id from pos_sales_receipt_lines where receipt_id=10'))[0].id;
  return {r,fingerprint,candidates:[{invoice_ref_id:'ref-10',ref_detail_id:'detail',pos_item_code:'TEST',pos_item_name:'Synthetic Glenfiddich',pos_quantity:1,mapping_type:'direct',inventory_item_id:1,deduct_quantity:quantity,receipt_line_id:line,mapping_id:1,recipe_id:null,mapping_snapshot:{mappingVersion:1},quantity_sold:1,deduct_quantity_per_unit:1,deduct_quantity_total:quantity,current_quantity_snapshot:0.03,after_quantity_snapshot:0.03-quantity}]};
 }
 const execute=async(db,p)=>(await q(db,"select prepare_and_apply_sales_inventory_reprocess(10,'owner',$1,$2,'inventory-hash',$3,$4) r",[p.r.updated_at,p.fingerprint,JSON.stringify({amount_hash:'amount',line_summary:{hashVersion:2}}),JSON.stringify(p.candidates)]))[0].r;
 await t.test('55 repeated requests keep one failed preview, then delivery creates one successful attempt',async()=>{
  const db=await setup();await initial(db);const p=await plan(db),before=await state(db);
  const first=await execute(db,p);assert.equal(first.failureReason,'insufficient_stock_after_reversal');
  for(let i=1;i<55;i++){
   p.candidates[0].current_quantity_snapshot=i;
   p.candidates[0].after_quantity_snapshot=i-1;
   assert.deepEqual(await execute(db,p),first);
  }
  await db.exec('update inventory set quantity=quantity+1 where id=2');
  assert.deepEqual(await execute(db,p),first);
  await db.exec('update inventory set quantity=quantity-1 where id=2');
  assert.deepEqual(await state(db),before);
  assert.equal((await q(db,"select count(*)::int n from pos_inventory_deduction_receipts where workflow_type='reprocess_modified'"))[0].n,1);
  const failed=(await q(db,'select to_jsonb(r) r from pos_inventory_deduction_receipts r where id=$1',[first.deductionReceiptId]))[0].r;
  assert.equal(failed.status,'failed');assert.equal(failed.selected_for_apply,false);assert.deepEqual(failed.reprocess_result,first);
  await db.exec("update inventory set quantity=quantity+2 where id=1;insert into inventory_logs(item_id,reason,source,change_quantity) values(1,'purchase','synthetic_test',2)");
  const success=await execute(db,p);assert.equal(success.result,'applied');assert.notEqual(success.deductionReceiptId,first.deductionReceiptId);
  assert.equal(Number((await q(db,'select quantity from inventory where id=1'))[0].quantity),1.10);
  for(const row of before.active)
   assert.deepEqual((await q(db,'select to_jsonb(d) d from pos_inventory_deductions d where id=$1',[row.d.id]))[0],row);
  assert.deepEqual((await q(db,'select to_jsonb(r) r from pos_inventory_deduction_receipts r where id=$1',[first.deductionReceiptId]))[0].r,failed);
  const after=await state(db);assert.equal((await execute(db,p)).result,'already_processed');assert.deepEqual(await state(db),after);
  assert.equal((await q(db,"select count(*)::int n from pos_inventory_deduction_receipts where workflow_type='reprocess_modified'"))[0].n,2);
  t.diagnostic('Before (b7e52a7c evidence): 55 ready previews / 55 x 23514; after: 1 failed preview / 0 x 23514; +2 delivery: 1 new success; failed audit unchanged');
 });
 // Corrupt-object cases are deliberate fault injection in disposable databases.
 async function dropReferences(db,table){
  for(const r of await q(db,'select conrelid::regclass::text t,conname n from pg_constraint where contype=\'f\' and confrelid=$1::regclass',[table]))
   await db.exec('alter table '+r.t+' drop constraint "'+r.n.replaceAll('"','""')+'"');
 }
 const cases=[
  ['not_reprocess_batch_receipt',true,async(db,c)=>db.query("update pos_inventory_deduction_batches set source='manual_preview' where id=$1",[c.b])],
  ['receipt_not_found',true,async db=>{await dropReferences(db,'pos_sales_receipts');await db.exec('delete from pos_sales_receipts where id=10');}],
  ['canceled_after_applied_not_supported',true,async db=>db.exec('update pos_sales_receipts set is_canceled=true where id=10')],
  ['stale_preview',true,async(db,c)=>{c.hash='changed';}],
  ['already_processed',true,async db=>db.exec("update pos_inventory_deduction_receipts set workflow_type='reprocess_modified',receipt_content_fingerprint='same-version' where status='applied'")],
  ['legacy_metadata_missing',true,async db=>db.exec("update pos_inventory_deductions set deduct_quantity_total=0 where status='applied'")],
  ['no_inventory_movement',false,async(db,c)=>db.query('delete from pos_inventory_deductions where batch_receipt_id=$1',[c.br])],
  ['initial_apply_required_or_not_reprocess',false,async()=>{}],
  ['candidate_metadata_missing',true,async(db,c)=>db.query('update pos_inventory_deductions set mapping_id=null where batch_receipt_id=$1',[c.br])],
  ['mapping_changed',true,async db=>db.exec('update pos_item_mappings set mapping_version=2 where id=1')],
  ['recipe_changed',true,async(db,c)=>{await db.exec('insert into pos_item_mapping_recipes values(11,1,1,true,1,1)');await db.query("update pos_inventory_deductions set recipe_id=11,mapping_snapshot=mapping_snapshot||'{\"recipeVersion\":2}' where batch_receipt_id=$1",[c.br]);}],
  ['inventory_item_missing',true,async db=>{await dropReferences(db,'inventory');await db.exec('delete from inventory where id=1');}],
  ['insufficient_stock_after_reversal',true,async()=>{}],
 ];
 for(const [reason,seed,mutate] of cases)await t.test('failure persistence: '+reason,async()=>{
  const db=await setup();if(seed)await initial(db);
  const c=await candidate(db,{workflow:'reprocess_modified'});await mutate(db,c);const before=await state(db);
  const result=await reprocess(db,c),row=(await q(db,'select to_jsonb(r) r from pos_inventory_deduction_receipts r where id=$1',[c.br]))[0].r;
  assert.equal(row.status,'failed');assert.equal(row.selected_for_apply,false);assert.equal(row.error_message,reason);
  assert.deepEqual(row.reprocess_result,result);assert.deepEqual(await state(db),before);
  assert.equal((await q(db,'select error_message from pos_inventory_deduction_batches where id=$1',[c.b]))[0].error_message,reason);
  assert.deepEqual(await reprocess(db,c),result);
  assert.deepEqual((await q(db,'select to_jsonb(r) r from pos_inventory_deduction_receipts r where id=$1',[c.br]))[0].r,row);
 });
 async function waitForLock(observer,pid){
  for(let i=0;i<100;i++){
   if((await q(observer,'select wait_event_type from pg_stat_activity where pid=$1',[pid]))[0]?.wait_event_type==='Lock')return;
   await new Promise(r=>setTimeout(r,20));
  }
  assert.fail('Expected a real PostgreSQL lock wait');
 }
 await t.test('failure persistence: candidate_changed across an actual row-lock wait',async()=>{
  const db=await setup();await initial(db);const c=await candidate(db,{workflow:'reprocess_modified'});
  const blocker=await rt.connect(db.name),observer=await rt.connect(db.name),pid=(await q(db,'select pg_backend_pid() pid'))[0].pid;
  await blocker.query('begin');await blocker.query("update pos_inventory_deductions set status='blocked' where batch_receipt_id=$1",[c.br]);
  const pending=reprocess(db,c);await waitForLock(observer,pid);await blocker.query('commit');
  const before=await state(observer),result=await pending;
  assert.equal(result.failureReason,'candidate_changed');assert.deepEqual(await state(db),before);
  assert.deepEqual((await q(db,'select status,selected_for_apply,error_message from pos_inventory_deduction_receipts where id=$1',[c.br]))[0],{status:'failed',selected_for_apply:false,error_message:'candidate_changed'});
  assert.deepEqual(await reprocess(db,c),result);
 });
 await t.test('concurrent automatic/manual calls serialize to one failed candidate',async()=>{
  const db=await setup();await initial(db);const p=await plan(db);
  const second=await rt.connect(db.name),observer=await rt.connect(db.name),pid=(await q(second,'select pg_backend_pid() pid'))[0].pid;
  await db.exec('begin');const first=await execute(db,p),pending=execute(second,p);
  await waitForLock(observer,pid);await db.exec('commit');assert.deepEqual(await pending,first);
  assert.equal((await q(db,"select count(*)::int n from pos_inventory_deduction_receipts where workflow_type='reprocess_modified'"))[0].n,1);
  await db.exec('update inventory set quantity=quantity+2 where id=1');
  const recovered=await Promise.all([execute(db,p),execute(second,p)]);
  assert.deepEqual(recovered.map(r=>r.result).sort(),['already_processed','applied']);
  assert.equal(Number((await q(db,'select quantity from inventory where id=1'))[0].quantity),1.10);
  assert.equal((await q(db,"select count(*)::int n from pos_inventory_deduction_receipts where workflow_type='reprocess_modified'"))[0].n,2);
 });
 await t.test('candidate-save and movement SQL exceptions leave no partial preview; retry recovers',async()=>{
  const db=await setup();await initial(db);const p=await plan(db);
  const before=await q(db,'select count(*)::int n from pos_inventory_deduction_batches');
  p.candidates[0].deduct_quantity_total='not-a-number';
  await assert.rejects(execute(db,p),e=>e.code==='22P02');
  assert.deepEqual(await q(db,'select count(*)::int n from pos_inventory_deduction_batches'),before);
  p.candidates[0].deduct_quantity_total=1;
  await db.exec("update inventory set quantity=2 where id=1;create function synthetic_fail_log() returns trigger language plpgsql as $$begin raise exception 'SYNTHETIC_LOG_FAILURE';end;$$;create trigger synthetic_fail_log before insert on inventory_logs for each row execute function synthetic_fail_log()");
  const stock=await state(db);await assert.rejects(execute(db,p),/SYNTHETIC_LOG_FAILURE/);assert.deepEqual(await state(db),stock);
  assert.deepEqual(await q(db,'select count(*)::int n from pos_inventory_deduction_batches'),before);
  await db.exec('drop trigger synthetic_fail_log on inventory_logs');assert.equal((await execute(db,p)).result,'applied');
 });
 await t.test('P0 still rolls back all movements and preserves its review reason on repeat',async()=>{
  const db=await setup();await initial(db);
  await db.exec("update inventory set quantity=10 where id=1;insert into inventory_logs(item_id,reason,source,created_at,change_quantity) values(1,'stock_check','edit_form','2026-10-13T10:00:00Z',0)");
  const p=await plan(db),before=await state(db),first=await execute(db,p);
  assert.equal(first.failureReason,'stock_check_boundary_requires_review');assert.deepEqual(await state(db),before);
  assert.equal((await execute(db,p)).failureReason,first.failureReason);
  const r=(await q(db,'select status,selected_for_apply,error_message from pos_inventory_deduction_receipts where id=$1',[first.deductionReceiptId]))[0];
  assert.deepEqual(r,{status:'failed',selected_for_apply:false,error_message:first.failureReason});
  assert.equal((await q(db,"select count(*)::int n from pos_inventory_deduction_receipts where workflow_type='reprocess_modified'"))[0].n,1);
 });
 await t.test('changed mapping plan and changed receipt version recover without rewriting failed audit',async()=>{
  const db=await setup();await initial(db);const p=await plan(db);
  await db.exec('update pos_item_mappings set mapping_version=2 where id=1');
  const first=await execute(db,p);assert.equal(first.failureReason,'mapping_changed');
  const audit=(await q(db,'select to_jsonb(r) r from pos_inventory_deduction_receipts r where id=$1',[first.deductionReceiptId]))[0];
  p.candidates[0].mapping_snapshot.mappingVersion=2;
  await db.exec('update inventory set quantity=2 where id=1');assert.equal((await execute(db,p)).result,'applied');
  assert.deepEqual((await q(db,'select to_jsonb(r) r from pos_inventory_deduction_receipts r where id=$1',[first.deductionReceiptId]))[0],audit);
  await db.exec('update pos_sales_receipts set updated_at=clock_timestamp() where id=10');
  assert.equal((await execute(db,p)).result,'stale_preview');
  const next=await plan(db,{quantity:0.5,fingerprint:'next-version'});next.candidates[0].mapping_snapshot.mappingVersion=2;
  assert.equal((await execute(db,next)).result,'applied');
 });
 await t.test('new RPC is service-only and unauthorized actors cannot save candidates',async()=>{
  const db=await setup();const p=await plan(db);
  const grants=await q(db,"select has_function_privilege('anon',oid,'execute') a,has_function_privilege('authenticated',oid,'execute') u,has_function_privilege('service_role',oid,'execute') s from pg_proc where proname='prepare_and_apply_sales_inventory_reprocess'");
  assert.deepEqual(grants,[{a:false,u:false,s:true}]);
  const r=(await q(db,"select prepare_and_apply_sales_inventory_reprocess(10,'staff',$1,$2,'inventory-hash',$3,$4) r",[p.r.updated_at,p.fingerprint,JSON.stringify({amount_hash:'amount',line_summary:{hashVersion:2}}),JSON.stringify(p.candidates)]))[0].r;
  assert.equal(r.failureReason,'permission_denied');assert.equal((await q(db,'select count(*)::int n from pos_inventory_deduction_batches'))[0].n,0);
 });
 await t.test('production TS adapter -> real DB RPC: dedup, replenishment, and error counts',async()=>{
  const previous=process.env.POS_REPROCESS_P1_ENABLED;process.env.POS_REPROCESS_P1_ENABLED='enabled';
  try{
  const db=await setup();await initial(db);const p=await plan(db);let rpcCalls=0,syntheticError=null;
  const m={exports:{}};
  const dependencies={
   'server-only':{},
   '@/lib/sales/inventory-deduction-lock':{isInventoryDeductionBusy:e=>e?.code==='55P03'},
   '@/lib/sales/inventory-deduction-unified-preview':{buildUnifiedInventoryDeductionPreview:async()=>({receipts:[{receiptId:10,operationType:'reprocess_modified',currentFingerprint:p.fingerprint,activeDeductionCount:1}]})},
   '@/lib/sales/inventory-deduction-preview':{buildInventoryDeductionPreview:async()=>({receipts:[{receiptId:10,refId:'ref-10',refNo:'2601006796-synthetic',businessDate:'2026-10-12',inventoryAffectingHash:'inventory-hash',amountHash:'amount',previewedReceiptUpdatedAt:p.r.updated_at,hashVersion:2,lines:[{receiptLineId:p.candidates[0].receipt_line_id,refDetailId:'detail',posItemCode:'TEST',itemName:'Synthetic Glenfiddich',quantitySold:1,mappingType:'direct',mappingId:1,mappingSnapshot:{mappingVersion:1},deductions:[{inventoryItemId:1,deductQuantity:1,currentQuantity:0.03,afterQuantity:-0.97,deductQuantityPerUnit:1,recipeId:null,recipeVersion:null}]}]}]})},
   '@/lib/supabase/server':{supabaseServer:{rpc:async(name,a)=>{
    assert.equal(name,'prepare_and_apply_sales_inventory_reprocess');rpcCalls++;
    if(syntheticError)return {data:null,error:syntheticError};
    return {data:(await q(db,'select prepare_and_apply_sales_inventory_reprocess($1,$2,$3,$4,$5,$6,$7) r',[a.p_receipt_id,a.p_actor_username,a.p_expected_receipt_updated_at,a.p_expected_receipt_content_fingerprint,a.p_expected_inventory_affecting_hash,a.p_preview,JSON.stringify(a.p_candidates)]))[0].r,error:null};
   }}},
  };
  const compiled=ts.transpileModule(readFileSync('lib/sales/inventory-deduction-reprocess.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},reportDiagnostics:true});assert.deepEqual(compiled.diagnostics,[]);
  new Function('require','module','exports',compiled.outputText)(name=>{assert.ok(name in dependencies,name);return dependencies[name];},m,m.exports);
  const run=()=>m.exports.prepareAndApplyReprocessInventoryDeduction({receiptId:10,actorUsername:'owner',expectedFingerprint:p.fingerprint,expectedInventoryAffectingHash:'inventory-hash',expectedReceiptUpdatedAt:p.r.updated_at});
  const first=await run();assert.equal(first.failureReason,'insufficient_stock_after_reversal');assert.equal(first.appliedDeductionCount,0);
  for(let i=1;i<55;i++){const r=await run();assert.equal(r.deductionReceiptId,first.deductionReceiptId);assert.equal(r.failureReason,first.failureReason);}
  assert.equal(rpcCalls,55);assert.equal((await q(db,"select count(*)::int n from pos_inventory_deduction_receipts where workflow_type='reprocess_modified'"))[0].n,1);
  await db.exec('update inventory set quantity=quantity+2 where id=1');assert.equal((await run()).result,'applied');
  assert.equal((await run()).result,'already_processed');
  for(const code of ['55P03','23514','08006']){
   syntheticError={code,message:'synthetic failure'};const r=await run();assert.equal(r.appliedDeductionCount,0);assert.equal(r.batchId,null);
   assert.equal(r.result,code==='55P03'?'stale_preview':'failed');
  }
  }finally{if(previous===undefined)delete process.env.POS_REPROCESS_P1_ENABLED;else process.env.POS_REPROCESS_P1_ENABLED=previous;}
 });
 await t.test('installation rejects engine drift before adding columns or changing P0',async()=>{
  const db=await setup({p1:false});
  const sig='public.reprocess_modified_sales_inventory_deduction_receipt(bigint,text,timestamptz,text,text)';
  const def=(await q(db,'select pg_get_functiondef($1::regprocedure) d',[sig]))[0].d;
  await db.exec(def.replace('legacy_metadata_missing','synthetic_drift'));
  await assert.rejects(db.exec(read('20261102101859_pos_reprocess_failure_persistence_and_dedup.sql')),/POS_REPROCESS_P1_ENGINE_DEFINITION_MISMATCH/);
  await db.exec('rollback');
  assert.equal((await q(db,"select count(*)::int n from information_schema.columns where table_name='pos_inventory_deduction_receipts' and column_name='reprocess_result'"))[0].n,0);
  assert.equal((await q(db,"select count(*)::int n from pg_trigger where tgname='inventory_logs_pos_stock_check_boundary' and tgenabled='O'"))[0].n,1);
 });
 // Flush these disposable test databases before the lifecycle's bounded 5s
 // shutdown. Many independent schemas can otherwise spend >5s syncing on Windows.
 const maintenance=await rt.connect('postgres');await maintenance.query('checkpoint');
 t.diagnostic(rt.version);
});
