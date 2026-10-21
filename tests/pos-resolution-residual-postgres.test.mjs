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

import {setupKegSafety} from './helpers/keg-safety-fixture.mjs';
import {createHash} from 'node:crypto';
const out='.qa-review/pos-resolution/residual-review/';
const digest=s=>createHash('sha256').update(s).digest('hex');
const signatures=[...engineSignatures,'admin_update_paid_sales_receipt(bigint,bigint,uuid,text,text,text,numeric,text,numeric,jsonb,numeric)','sales_close_business_day_v1(date,text,jsonb,jsonb,bigint,text,boolean,bigint)','pos_sales_close_private.build_source(date)'];
const report={productionQuery:{verified:false,reason:'MCP tool call requires approval, but approval policy is never'},scenarios:[],flagOff:true};
async function definitions(db){return await query(db,"select p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition,encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') sha256 from pg_proc p where p.oid=any($1::regprocedure[]) order by p.oid::regprocedure::text",[signatures.map(s=>s.startsWith('pos_sales_')?s:'public.'+s)]);}
async function installKeg(db){
 const adapter={...db,exec:async sql=>{
  if(sql.includes('create role anon;')){
   for(const m of sql.matchAll(/create table (\w+)\(([^;]+)\);/g))for(const col of m[2].split(',')){
    const c=col.trim().match(/^(\w+) (bigint|text|timestamptz|numeric|int)(.*)$/);if(c)await db.exec('alter table '+m[1]+' add column if not exists '+c[1]+' '+c[2]);
   }
  }else await db.exec(sql);
 }};await setupKegSafety(adapter);
}
async function kegSeed(db,item=3){
 await db.query("insert into inventory(id,quantity,item_name,unit,package_content_quantity,package_content_unit) values($1,100,'Keg fixture','Keg',30000,'ml') on conflict(id) do update set unit='Keg',package_content_quantity=30000,package_content_unit='ml'",[item]);
 await db.exec("insert into pos_products(id,pos_item_id,item_code,item_name,unit_name,is_active) values(50,'beer','BEER','Beer','Glass',true) on conflict do nothing;");
 await db.query("insert into inventory_keg_tracking_mappings(inventory_item_id,target_type,pos_product_id,quantity_per_pos_unit) values($1,'product',50,330)",[item]);
 await db.query("insert into inventory_keg_sessions(inventory_item_id,status,started_at,started_business_date,capacity_quantity,created_by) values($1,'active','2026-10-17T08:00Z','2026-10-17',30000,'owner')",[item]);
 await seed(db,500);await db.exec("update pos_sales_receipts set payment_status=3,ref_date='2026-10-17T09:00Z' where id=500;update pos_sales_receipt_lines set payment_status=3,item_id='beer',item_code='BEER',ref_date='2026-10-17T09:00Z' where receipt_id=500");
}
async function kegPreview(db,item,round=0){return (await query(db,"select inventory_preview_keg_change('replace',$1,null,$2::timestamptz,'2026-10-17','owner',(select quantity from inventory where id=$1)) r",[item,'2026-10-17T'+String(10+round).padStart(2,'0')+':00Z']))[0].r;}
async function kegApply(db,p,item){return (await query(db,"select inventory_apply_keg_change('replace',$1,null,$2::timestamptz,'2026-10-17','owner',$3,$4,$5::uuid,'mixed lock verification',true) r",[item,p.replacementAt,p.currentQuantity,p.previewToken,randomUUID()]))[0].r;}
async function candidate(db,id,qty,version,workflow='initial_apply'){
 const r=(await query(db,"select to_jsonb(r) r from pos_sales_receipts r where id=$1",[id]))[0].r;
 const l=(await query(db,'select id from pos_sales_receipt_lines where receipt_id=$1 order by id limit 1',[id]))[0];
 const batch=(await query(db,"insert into pos_inventory_deduction_batches(flow_version,business_date_from,business_date_to,source,status,receipt_count,ready_receipt_count,created_by) values('sales_db_v1','2026-10-17','2026-10-17',$1,'previewed',1,1,'owner') returning id",[workflow==='initial_apply'?'manual_preview':'reprocess_modified']))[0].id;
 const br=(await query(db,"insert into pos_inventory_deduction_receipts(batch_id,receipt_id,business_date,status,inventory_affecting_hash,amount_hash,previewed_receipt_updated_at,selected_for_apply,workflow_type,receipt_content_fingerprint,line_summary) values($1,$2,'2026-10-17','ready',$3,$4,$5,true,$6,$7,'{\"hashVersion\":2}') returning id",[batch,id,'i-'+version,'a-'+version,r.updated_at,workflow,'c-'+version]))[0].id;
 await db.query("insert into pos_inventory_deductions(invoice_ref_id,ref_detail_id,pos_item_code,pos_item_name,pos_quantity,mapping_type,inventory_item_id,deduct_quantity,status,flow_version,batch_id,batch_receipt_id,receipt_id,receipt_line_id,business_date,mapping_id,operation_type,mapping_snapshot,inventory_affecting_hash,amount_hash,idempotency_key,quantity_sold,deduct_quantity_per_unit,deduct_quantity_total) values($1,'normal-line','TEST','Item',$2,'direct',1,$2,'selected','sales_db_v1',$3,$4,$5,$6,'2026-10-17',1,'preview','{\"mappingVersion\":1}',$7,$8,$9,$2,1,$2)",[r.ref_id,qty,batch,br,id,l.id,'i-'+version,'a-'+version,'normal-'+randomUUID()]);
 return {batch,br,r,hash:'i-'+version,content:'c-'+version};
}
async function normalLifecycle(db){
 await stock(db);await seed(db);await db.exec("update pos_sales_receipts set payment_status=3 where id=10;update pos_sales_receipt_lines set payment_status=3 where receipt_id=10;insert into pos_sales_receipt_payments(source,receipt_id,receipt_ref_id,business_date,payment_type,payment_name,amount) values('cukcuk',10,'ref-10','2026-10-17',1,'Tiền mặt',100000)");
 let p=await candidate(db,10,1,1);let r=(await query(db,'select apply_sales_inventory_deduction_batch($1,\'owner\',$2::jsonb) r',[p.batch,JSON.stringify([{receiptId:10,currentInventoryHash:p.hash,currentReceiptUpdatedAt:p.r.updated_at,applyAllowed:true}])]))[0].r;assert.equal(r.status,'applied');
 const line=(await query(db,'select to_jsonb(l) l from pos_sales_receipt_lines l where receipt_id=10'))[0].l;
 const revised={...line,quantity:2,unit_price:45000,amount:90000,final_amount:90000,pre_tax_amount:90000,tax_rate:0,tax_amount:0,discount_amount:0};
 await query(db,"select admin_update_paid_sales_receipt(10,0,$1::uuid,'owner','normal correction','apply',null,'cash',90000,$2::jsonb,null)",[randomUUID(),JSON.stringify([revised])]);
 p=await candidate(db,10,2,2,'reprocess_modified');r=(await query(db,"select reprocess_modified_sales_inventory_deduction_receipt($1,'owner',$2,$3,$4) r",[p.br,p.r.updated_at,p.content,p.hash]))[0].r;assert.equal(r.result,'applied');
 const source=(await query(db,"select pos_sales_close_private.build_source('2026-10-17') s"))[0].s;
 const closed=(await query(db,"select sales_close_business_day_v1('2026-10-17',$1,$2,$3,1,'manual',false,null) r",[source.sourceFingerprint,source.sourceSnapshot,JSON.stringify(source.rows)]))[0].r;assert.equal(closed.status,'closed');
 await db.exec("update pos_sales_receipts set payment_status=4,is_canceled=true where id=10;update pos_sales_receipt_lines set payment_status=4,is_canceled=true where receipt_id=10");
 const canceled=(await query(db,'select to_jsonb(r) r from pos_sales_receipts r where id=10'))[0].r;
 r=(await query(db,"select rollback_canceled_sales_inventory_deduction_receipt(10,'owner',$1,'cancel-normal') r",[canceled.updated_at]))[0].r;assert.equal(r.result,'applied');
 return {quantity:Number((await query(db,'select quantity from inventory where id=1'))[0].quantity),logs:Number((await query(db,'select count(*) n from inventory_logs'))[0].n),deductions:await query(db,'select operation_type,status,count(*)::int n from pos_inventory_deductions group by operation_type,status order by operation_type,status'),receipt:(await query(db,'select revision,payment_status,is_canceled,final_amount,inventory_deduction_processing_paused from pos_sales_receipts where id=10'))[0],close:closed.status,receiptTotal:source.sourceSnapshot.receiptTotal,totals:source.sourceSnapshot.totalsByBucket,ledger:await query(db,"select source_key,amount,status from ledger_transactions where source_type='pos_sales_daily_payment' order by source_key")};
}

test('residual risk PostgreSQL17: targeted verification only; existing 292 cases not rerun',{skip:!existsSync('.qa-review/pos-tools/node_modules/@embedded-postgres/windows-x64/dist/index.js')},async t=>{
 const binaries=await import('../.qa-review/pos-tools/node_modules/@embedded-postgres/windows-x64/dist/index.js');
 const dataDir=pathResolve('.qa-review/pos-resolution/pg17-residual-'+Date.now());await mkdir(dataDir,{recursive:true});
 await run(binaries.initdb,['-D',dataDir,'--encoding=UTF8','--locale=C','-U','postgres','-A','trust'],{windowsHide:true,timeout:30000});
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const server=spawn(binaries.postgres,['-D',dataDir,'-h','127.0.0.1','-p',String(port),'-c','fsync=off','-c','full_page_writes=off','-c','synchronous_commit=off'],{windowsHide:true,stdio:['ignore','pipe','pipe']});let logs='';server.stdout.on('data',v=>logs+=v);server.stderr.on('data',v=>logs+=v);
 const clients=[],base={host:'127.0.0.1',port,user:'postgres',database:'postgres',connectionTimeoutMillis:1000};let dbNumber=0;
 async function connect(database='postgres'){const c=new pg.Client({...base,database});await c.connect();clients.push(c);await c.query("set statement_timeout='8s';set lock_timeout='3s';set deadlock_timeout='100ms';set timezone='UTC'");return c;}
 async function fresh(phase2=true,keg=false){
  const name='residual_'+(++dbNumber);await clients[0].query('create database '+name);const c=await connect(name);const db={exec:sql=>c.query(sql),query:(...args)=>c.query(...args)};
  await initializePosCloseDatabase({...db,exec:sql=>db.exec(sql.replace('create role anon; create role authenticated; create role service_role;',''))});await initializeResolutionSchema(db);
  await initializeWork(db,{migration:phase2?readFileSync('supabase/migrations/20261021081604_pos_resolution_corrections_inventory_review.sql','utf8'):'',beforeMigration:async db=>{
   await db.exec("create function set_pos_sales_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now();return new;end$$;create trigger trg_pos_sales_receipts_updated_at before update on pos_sales_receipts for each row execute function set_pos_sales_updated_at();");
   const defs=await definitions(db);writeFileSync(out+'local-before-functions.json',JSON.stringify(defs,null,2));
  }});
  if(keg)await installKeg(db);return {db,c,name};
 }
 async function waitForBlocked(c){for(let n=0;n<100;n++){if(Number((await clients[0].query('select count(*) n from pg_locks where pid=$1 and not granted',[c.processID])).rows[0].n)>0)return;await delay(10);}assert.fail('expected real PostgreSQL lock wait');}
 try{
  let ready=false;for(let i=0;i<100;i++){try{await connect();ready=true;break}catch{await delay(100)}}assert.ok(ready,logs.slice(-1000));await clients[0].query('create role anon;create role authenticated;create role service_role;');
  await t.test('flags OFF: unchanged normal editor/close and equivalent initial/reprocess/rollback results before vs after migration2',async()=>{
   const before=await fresh(false);const baseline=await normalLifecycle(before.db);const after=await fresh();const defs=await definitions(after.db);writeFileSync(out+'local-after-functions.json',JSON.stringify(defs,null,2));
   const old=JSON.parse(readFileSync(out+'local-before-functions.json','utf8'));const diffs=defs.map(d=>({signature:d.signature,beforeSHA256:old.find(o=>o.signature===d.signature).sha256,afterSHA256:d.sha256,changed:old.find(o=>o.signature===d.signature).sha256!==d.sha256}));
   assert.equal(diffs.filter(d=>d.changed).length,4);assert.ok(diffs.filter(d=>/admin_update_paid|sales_close_business_day/.test(d.signature)).every(d=>!d.changed));
   const current=await normalLifecycle(after.db);assert.deepEqual(current,baseline);assert.equal(current.quantity,100);assert.equal(current.logs,4);report.flagOffNormalRegression={baseline,current,definitions:diffs};
  });
  await t.test('five rounds: pending POS source writes, actual unrelated keg replacement and stock change coexist with inventory approval',async()=>{
   const {db,c,name}=await fresh(true,true);await stock(db);await kegSeed(db);const sync=await connect(name),keg=await connect(name),stockClient=await connect(name);const timings=[];
   for(let round=0;round<5;round++){
    const id=100+round;await seed(db,id);await resolve2(db,id);const review=await plan(db,id,'initial_apply'),kp=await kegPreview(db,3,round);
    await c.query('begin');await approve(db,id,review);let start=performance.now();
    const syncPending=sync.query("update pos_sales_receipts set synced_at=clock_timestamp() where id=500;update pos_sales_receipt_lines set updated_at=clock_timestamp() where receipt_id=500").then(()=>({ms:performance.now()-start}),e=>({code:e.code,message:e.message}));
    await waitForBlocked(sync);
    const kStart=performance.now();const kr=await kegApply({query:(...args)=>keg.query(...args)},kp,3);assert.equal(kr.ok,true);const kegMs=performance.now()-kStart;
    await stockClient.query('update inventory set quantity=quantity-1 where id=2');await delay(40);await c.query('commit');const sr=await syncPending;assert.ok(!sr.code,JSON.stringify(sr));timings.push({syncWaitMs:sr.ms,kegMs});
   }
   assert.equal(Number((await query(db,'select quantity from inventory where id=1'))[0].quantity),95);assert.equal(Number((await query(db,'select quantity from inventory where id=3'))[0].quantity),95);report.mixedUnrelated={rounds:5,timings,deadlocks:0,deliberateHoldMs:40,syncPath:'actual receipt/line sync DML, not external CukCuk HTTP'};
  });
  await t.test('actual same-item keg replacement first: approval waits then rejects stale stock without deadlock',async()=>{
   const {db,c,name}=await fresh(true,true);await stock(db);await kegSeed(db,1);const keg=await connect(name),timings=[];
   for(let round=0;round<5;round++){
    const id=200+round;await seed(db,id);await resolve2(db,id);const review=await plan(db,id,'initial_apply'),kp=await kegPreview(db,1,round);await keg.query('begin');await kegApply({query:(...args)=>keg.query(...args)},kp,1);
    const start=performance.now();const pending=approve(db,id,review).then(value=>({value}),error=>({code:error.code,message:error.message}));await waitForBlocked(c);await delay(40);await keg.query('commit');const result=await pending;assert.match(result.message||'',/STALE_PREVIEW/);assert.notEqual(result.code,'40P01');assert.equal((await work(db,id)).state.receipt.inventory_deduction_processing_paused,true);timings.push(performance.now()-start);
   }report.sharedKegFirst={rounds:5,waitMs:timings,deadlocks:0,staleApprovals:5};
  });
  await t.test('actual same-item approval first: keg replacement waits then rejects its outdated quantity/token',async()=>{
   const {db,c,name}=await fresh(true,true);await stock(db);await kegSeed(db,1);const keg=await connect(name);await seed(db);await resolve2(db,10);const review=await plan(db,10,'initial_apply'),kp=await kegPreview(db,1);
   await c.query('begin');await approve(db,10,review);const pending=kegApply({query:(...args)=>keg.query(...args)},kp,1).then(value=>({value}),error=>({code:error.code,message:error.message}));await waitForBlocked(keg);await delay(40);await c.query('commit');const result=await pending;assert.match(result.message||'',/QUANTITY_CONFLICT|STALE_PREVIEW/);assert.notEqual(result.code,'40P01');report.sharedApprovalFirst={deadlocks:0,result};
  });
  await t.test('same-receipt INSERT: FK protects new batch receipt and existing linked candidates; nullable legacy linkage remains writable',async()=>{
   const {db,c,name}=await fresh();await stock(db);await seed(db);await resolve2(db,10);
   const old=await candidate(db,10,1,'old');await db.query("update pos_inventory_deduction_receipts set status='skipped',selected_for_apply=false where id=$1",[old.br]);const r=await plan(db,10,'initial_apply');const other=await connect(name);await other.query("set lock_timeout='250ms'");
   const newBatch=(await query(db,"insert into pos_inventory_deduction_batches(flow_version,source,status) values('sales_db_v1','manual_preview','previewed') returning id"))[0].id;
   const fks=await query(db,"select conname,pg_get_constraintdef(oid) definition from pg_constraint where conrelid='pos_inventory_deductions'::regclass and contype='f'");
   await c.query('begin');await approve(db,10,r);
   await assert.rejects(other.query("insert into pos_inventory_deduction_receipts(batch_id,receipt_id,status,inventory_affecting_hash,amount_hash) values($1,10,'ready','new','new')",[newBatch]),e=>e.code==='55P03');
   await assert.rejects(other.query("insert into pos_inventory_deductions(receipt_id,batch_id,batch_receipt_id,operation_type,status) values(10,$1,$2,'preview','selected')",[old.batch,old.br]),e=>e.code==='55P03');
   const start=performance.now();const unlinked=await other.query("insert into pos_inventory_deductions(receipt_id,invoice_ref_id,operation_type,status) values(10,'ref-10','preview','previewed') returning id");const elapsed=performance.now()-start;assert.equal(unlinked.rows.length,1);
   await c.query('commit');report.sameReceiptInsert={foreignKeys:fks,newBatchReceiptBlocked:true,existingLinkedCandidateBlocked:true,nullableLinkInsertSucceeded:true,insertMs:elapsed,productionPermissionsVerified:false,normalAppPathsSupplyBatchAndBatchReceipt:true};
  });
  await t.test('same-receipt INSERT between context validation and legacy engine: nullable history can commit and approval still succeeds',async()=>{
   const {db,c,name}=await fresh();await stock(db);await seed(db);await resolve2(db,10);const r=await plan(db,10,'initial_apply');const gate=await connect(name),other=await connect(name);
   await db.exec("create function qa_pause_candidate() returns trigger language plpgsql as $$begin if current_setting('qa.pause',true)='on' then perform pg_advisory_xact_lock(190001);end if;return new;end$$;create trigger qa_pause_candidate before insert on pos_inventory_deductions for each row execute function qa_pause_candidate();");
   await gate.query('begin');await gate.query('select pg_advisory_xact_lock(190001)');await c.query("set qa.pause='on'");const pending=approve(db,10,r).then(value=>({value}),error=>({code:error.code,message:error.message}));await waitForBlocked(c);
   await other.query("insert into pos_inventory_deductions(receipt_id,invoice_ref_id,operation_type,status) values(10,'ref-10','preview','previewed')");await gate.query('commit');const result=await pending;assert.equal(result.value?.status,'approved',JSON.stringify(result));report.midApprovalPhantom={insertAfterContextBeforeEngine:true,insertCommitted:true,approvalSucceeded:true,extraHistoryRetained:true,doubleDeductionDemonstrated:false};
  });
  writeFileSync(out+'evidence.json',JSON.stringify(report,null,2));
 }finally{for(const c of clients){try{await c.end()}catch{}}try{await run(binaries.pg_ctl,['-D',dataDir,'-m','fast','stop'],{windowsHide:true,timeout:15000})}catch{server.kill()}}
});
