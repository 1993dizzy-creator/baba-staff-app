import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFileSync,existsSync,writeFileSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {resolve as pathResolve} from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import net from 'node:net';
import pg from 'pg';
import {initializePosCloseDatabase,daySource,closeDay,ledgerState,addCardSettlement} from './helpers/pos-business-day-close-fixture.mjs';
import {initializeResolutionSchema,seedPending,review,request} from './helpers/pos-pending-resolution-fixture.mjs';
import {initializeWork,work,correct,correction} from './helpers/pos-resolution-work-fixture.mjs';
const run=promisify(execFile),delay=ms=>new Promise(r=>setTimeout(r,ms));
const engineSignatures=['apply_sales_inventory_deduction_batch(bigint,text,jsonb)','reprocess_modified_sales_inventory_deduction_receipt(bigint,text,timestamptz,text,text)','rollback_canceled_sales_inventory_deduction_receipt(bigint,text,timestamptz,text)'];
const query=async(db,sql,args=[])=>(await db.query(sql,args)).rows;
async function operationalContracts(db){
 for(const signature of engineSignatures){
  const definition=(await query(db,'select pg_get_functiondef($1::regprocedure) d',['public.'+signature]))[0].d;
  // Repository functions, NOT production exports. Preserve body CRLF exactly.
  const crlf=definition.replace(/\r\n?/g,'\n').replace(/\n/g,'\r\n');
  await db.exec(crlf);
  const stored=(await query(db,'select pg_get_functiondef($1::regprocedure) d',['public.'+signature]))[0].d;
  assert.equal(stored.indexOf('begin\n'),-1);assert.ok(stored.includes('begin\r\n'));
  writeFileSync('.qa-review/pos-resolution/p0-audit/repository-crlf-'+signature.split('(')[0]+'.sql',stored);
 }
 await db.exec(`create function public.set_pos_sales_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now();return new;end$$;
 create trigger trg_pos_sales_receipts_updated_at before update on public.pos_sales_receipts for each row execute function public.set_pos_sales_updated_at();`);
}
async function resolve2(db,id,patch={}){
 const r=request(await review(db,id),{requestId:randomUUID(),...patch});
 return (await query(db,'select sales_resolve_pending_receipt_v2($1,1,$2::jsonb) r',[id,JSON.stringify(r)]))[0].r;
}
async function seed(db,id=10,date='2026-10-17',amount=100000){
 await seedPending(db,{id,date,amount,refNo:String(id)});
 await db.query(`update pos_sales_receipt_lines set source='cukcuk',ref_detail_id='detail-'||id,sort_order=1,amount=unit_price,final_amount=unit_price,discount_amount=0,tax_rate=0,tax_amount=0,pre_tax_amount=unit_price,is_option=false,is_excluded=false,mapping_status='direct',ref_detail_type=1 where receipt_id=$1`,[id]);
}
async function stock(db){await db.exec(`insert into inventory(id,quantity,item_name,unit) values(1,100,'Target','unit'),(2,100,'Unrelated keg fixture','unit');insert into pos_item_mappings values(1,'TEST','direct',true,1,1,1,false);`);}
async function plan(db,id,workflow){
 const w=await work(db,id);const l=w.state.lines.find(l=>!l.is_excluded);
 const activeCount=Number((await query(db,`select count(*) n from pos_inventory_deductions d where receipt_id=$1 and d.operation_type is distinct from 'revert' and d.status='applied' and not exists(select 1 from pos_inventory_deductions r where r.reversal_of_deduction_id=d.id)`,[id]))[0].n);
 const qty=Number(l.quantity),current=Number((await query(db,'select quantity from inventory where id=1'))[0].quantity);
 const p={workflow,activeCount,contentFingerprint:'content-'+id+'-'+w.version,inventoryHash:'inventory-'+id+'-'+w.version,amountHash:'amount-'+id+'-'+w.version,hashVersion:2,
  lines:[{receiptLineId:l.id,refDetailId:l.ref_detail_id,posItemCode:'TEST',itemName:'Item',quantitySold:qty,mappingType:'direct',mappingId:1,mappingSnapshot:{mappingVersion:1},deductions:[{inventoryItemId:1,recipeId:null,recipeVersion:null,deductQuantity:qty,deductQuantityPerUnit:1,currentQuantity:current,afterQuantity:current-qty}]}]};
 return (await query(db,"select sales_preview_admin_resolution_inventory_v2($1,1,$2,$3::jsonb,'[]') r",[id,w.contextFingerprint,JSON.stringify(p)]))[0].r;
}
async function approve(db,id,r,patch={}){
 return (await query(db,'select sales_confirm_admin_resolution_inventory_v2($1,1,$2::jsonb) r',[id,JSON.stringify({requestId:randomUUID(),reviewId:r.reviewId,reason:'independent approval',...patch})]))[0].r;
}
async function allStock(db){return (await query(db,`select jsonb_build_object(
 'receipts',(select jsonb_agg(to_jsonb(r) order by id) from pos_sales_receipts r),
 'inventory',(select jsonb_agg(to_jsonb(r) order by id) from inventory r),
 'deductions',(select jsonb_agg(to_jsonb(r) order by id) from pos_inventory_deductions r),
 'batches',(select jsonb_agg(to_jsonb(r) order by id) from pos_inventory_deduction_batches r),
 'batchReceipts',(select jsonb_agg(to_jsonb(r) order by id) from pos_inventory_deduction_receipts r),
 'logs',(select jsonb_agg(to_jsonb(r) order by id) from inventory_logs r),
 'approvals',(select jsonb_agg(to_jsonb(r) order by request_id) from pos_sales_receipt_inventory_approvals r),
 'audit',(select jsonb_agg(to_jsonb(r) order by id) from pos_sales_receipt_resolution_history r)) s`))[0].s;}


import {reproduceOperatingInventoryContract} from './helpers/pos-resolution-operating-inventory-fixture.mjs';
import {createHash} from 'node:crypto';
const out='.qa-review/pos-resolution/operating-contract/';
const paths=['20261021070640_pos_pending_admin_resolutions.sql','20261021081604_pos_resolution_corrections_inventory_review.sql','20261021133856_pos_resolution_deduction_insert_guard.sql'];
const hash=s=>createHash('sha256').update(s).digest('hex');
const evidence={scope:'operating functions without processed_line_id + migrations 1/2/3',concurrencyRepeated:false,fullRegressionRepeated:false,productionOperations:false};
test('operating inventory contract: absent processed_line_id and unchanged migrations 1/2/3',{skip:!existsSync('.qa-review/pos-tools/node_modules/@embedded-postgres/windows-x64/dist/index.js')},async t=>{
 const binaries=await import('../.qa-review/pos-tools/node_modules/@embedded-postgres/windows-x64/dist/index.js');
 await mkdir(out,{recursive:true});const dataDir=pathResolve('.qa-review/pos-resolution/pg17-operating-contract-'+Date.now());await mkdir(dataDir,{recursive:true});evidence.dataDir=dataDir;
 await run(binaries.initdb,['-D',dataDir,'--encoding=UTF8','--locale=C','-U','postgres','-A','trust'],{windowsHide:true,timeout:30000});
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const server=spawn(binaries.postgres,['-D',dataDir,'-h','127.0.0.1','-p',String(port),'-c','fsync=off','-c','full_page_writes=off','-c','synchronous_commit=off'],{windowsHide:true,stdio:['ignore','pipe','pipe']});let logs='';server.stdout.on('data',v=>logs+=v);server.stderr.on('data',v=>logs+=v);
 const base={host:'127.0.0.1',port,user:'postgres',database:'postgres',connectionTimeoutMillis:1000};let c,db;
 try{
  for(let i=0;i<100;i++){try{c=new pg.Client(base);await c.connect();break}catch{await c.end().catch(()=>{});c=null;await delay(100)}}assert.ok(c,logs.slice(-1000));
  await c.query("set statement_timeout='15s';set timezone='UTC'");db={exec:s=>c.query(s),query:(...a)=>c.query(...a)};
  await initializePosCloseDatabase(db);await initializeResolutionSchema(db,{migration:''});await initializeWork(db,{migration:''});
  evidence.functions=await reproduceOperatingInventoryContract(db);
  await db.exec("create function public.set_pos_sales_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now();return new;end$$;create trigger trg_pos_sales_receipts_updated_at before update on pos_sales_receipts for each row execute function public.set_pos_sales_updated_at();");
  evidence.migrations=[];
  await t.test('operating two-engine fixtures contain no missing column and all three migrations install sequentially',async()=>{
   for(const f of evidence.functions){assert.equal(f.definition.includes('processed_line_id'),false);assert.ok(f.definition.includes('begin\r\n'));}
   for(const name of paths){const sql=readFileSync('supabase/migrations/'+name,'utf8');await db.exec(sql);evidence.migrations.push({name,sha256:hash(sql),appliedLocally:true});}
   const definitions=await query(db,"select pg_get_functiondef($1::regprocedure) d",['public.'+engineSignatures[1]]);assert.equal(definitions[0].d.includes('processed_line_id'),false);assert.ok(definitions[0].d.includes('POS_RESOLUTION_INVENTORY_APPROVAL_REQUIRED'));
   evidence.absentColumn=true;
  });
  await t.test('held admin receipt: initial apply -> correction -> real reprocess -> cancellation -> real rollback; history preserved and retries single-effect',async()=>{
   await stock(db);await seed(db);await resolve2(db,10);const initialReview=await plan(db,10,'initial_apply');assert.equal((await approve(db,10,initialReview)).status,'approved');assert.equal(Number((await query(db,'select quantity from inventory where id=1'))[0].quantity),99);
   let w=await work(db,10);await correct(db,correction(w,{requestId:randomUUID(),lines:w.state.lines.map(l=>({...l,quantity:2,unit_price:45000,discount_amount:0,tax_rate:0}))}));assert.equal((await work(db,10)).state.receipt.inventory_deduction_processing_paused,true);
   const rp=await plan(db,10,'reprocess_modified'),rid=randomUUID();assert.equal((await approve(db,10,rp,{requestId:rid})).status,'approved');await approve(db,10,rp,{requestId:rid});assert.equal(Number((await query(db,'select quantity from inventory where id=1'))[0].quantity),98);assert.equal(Number((await query(db,'select count(*) n from inventory_logs'))[0].n),3);
   w=await work(db,10);await correct(db,correction(w,{requestId:randomUUID(),decision:'canceled',refundConfirmed:true,refundEvidence:'fixture refund'}));const rb=await plan(db,10,'rollback_canceled'),bid=randomUUID();assert.equal((await approve(db,10,rb,{requestId:bid})).status,'approved');await approve(db,10,rb,{requestId:bid});
   assert.equal(Number((await query(db,'select quantity from inventory where id=1'))[0].quantity),100);assert.equal(Number((await query(db,'select count(*) n from inventory_logs'))[0].n),4);assert.equal(Number((await query(db,'select count(*) n from pos_inventory_deductions'))[0].n),4);
   evidence.lifecycle={initialStock:99,reprocessedStock:98,restoredStock:100,logs:4,deductions:4,duplicateRequestSingleEffect:true};
  });
  await t.test('operating rollback failure is atomic and the same approval request can retry',async()=>{
   await seed(db,11);await resolve2(db,11);await approve(db,11,await plan(db,11,'initial_apply'));let w=await work(db,11);await correct(db,correction(w,{requestId:randomUUID(),decision:'canceled',refundConfirmed:true,refundEvidence:'fixture refund'}),11);const r=await plan(db,11,'rollback_canceled'),requestId=randomUUID(),before=await allStock(db);
   await db.exec("create function qa_fail_contract() returns trigger language plpgsql as $$begin raise exception 'QA_OPERATING_ROLLBACK_FAILURE';end$$;create trigger qa_fail_contract before insert on pos_sales_receipt_inventory_approvals for each row execute function qa_fail_contract();");
   await assert.rejects(approve(db,11,r,{requestId}),/QA_OPERATING_ROLLBACK_FAILURE/);assert.deepEqual(await allStock(db),before);await db.exec('drop trigger qa_fail_contract on pos_sales_receipt_inventory_approvals;drop function qa_fail_contract()');assert.equal((await approve(db,11,r,{requestId})).status,'approved');assert.equal(Number((await query(db,'select quantity from inventory where id=1'))[0].quantity),100);evidence.rollbackAtomic=true;
  });
 }finally{writeFileSync(out+'evidence.json',JSON.stringify(evidence,null,2));if(c)await c.end();try{await run(binaries.pg_ctl,['-D',dataDir,'-m','fast','stop'],{windowsHide:true,timeout:15000})}catch{server.kill()}}
});
