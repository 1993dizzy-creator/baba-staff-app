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
const out='.qa-review/pos-resolution/guard-followup/';
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

import {loadTs,nextMock} from './helpers/pos-resolution-auth-harness.mjs';
const guardPath='supabase/migrations/20261021133856_pos_resolution_deduction_insert_guard.sql';
const guardSQL=readFileSync(guardPath,'utf8');
const lockHelper=loadTs('lib/sales/inventory-deduction-lock.ts');
const findings={operationalParity:false,deadlocks:0,retry:{}};
// Minimal PostgREST transport over real local PostgreSQL. No insert/error is
// simulated: SQLSTATE comes from real FK/trigger locks in another connection.
function bridge(db){
 return {from(table){let op='select',body,cols='*',conditions=[],single=false,ordering='',limit='';const q={
  insert(v){op='insert';body=Array.isArray(v)?v:[v];return q},update(v){op='update';body=v;return q},
  select(v='*'){cols=v;return q},eq(k,v){conditions.push([k,v]);return q},order(k,o={}){ordering=' order by '+k+(o.ascending===false?' desc':' asc');return q},limit(n){limit=' limit '+n;return q},single(){single=true;return q},maybeSingle(){single=true;return q},
  async then(done){try{let sql,values=[];if(op==='insert'){const keys=[...new Set(body.flatMap(r=>Object.keys(r)))].filter(k=>body.some(r=>r[k]!==undefined));const tuples=body.map(r=>'('+keys.map(k=>{values.push(typeof r[k]==='object'&&r[k]!==null?JSON.stringify(r[k]):r[k]??null);return '$'+values.length}).join(',')+')');sql='insert into '+table+'('+keys.join(',')+') values '+tuples.join(',')+' returning *';}
   else{const where=conditions.map(([k,v])=>{values.push(v);return k+'=$'+values.length});if(op==='update'){const set=Object.keys(body).map(k=>{values.push(body[k]);return k+'=$'+values.length});sql='update '+table+' set '+set.join(',')+(where.length?' where '+where.join(' and '):'')+' returning *';}else sql='select to_jsonb(t) row from '+table+' t'+(where.length?' where '+where.join(' and '):'')+ordering+limit;}
   const rows=await query(db,sql,values);const data=op==='select'?rows.map(r=>r.row):rows;return done({data:single?data[0]||null:data,error:null});}catch(e){return done({data:null,error:{message:e.message,code:e.code}})}}};return q;},
 async rpc(name,args){try{const vals=Object.values(args).map(v=>typeof v==='object'&&v!==null?JSON.stringify(v):v);return {data:(await query(db,'select '+name+'('+vals.map((_,i)=>'$'+(i+1)).join(',')+') r',vals))[0].r,error:null};}catch(e){return{data:null,error:{message:e.message,code:e.code}}}}};
}
async function previewFixture(db,receiptId=10){
 const r=(await query(db,'select to_jsonb(r) r from pos_sales_receipts r where id=$1',[receiptId]))[0].r;const l=(await query(db,'select to_jsonb(l) l from pos_sales_receipt_lines l where receipt_id=$1 order by id limit 1',[receiptId]))[0].l;
 const n=Number((await query(db,'select quantity from inventory where id=1'))[0].quantity);const qty=Number(l.quantity);
 return {businessDateFrom:'2026-10-17',businessDateTo:'2026-10-17',generatedAt:new Date().toISOString(),validationSummary:{},inventoryTotals:[],summary:{totalReceiptCount:1,readyCount:1,blockedCount:0,skippedCount:0,alreadyAppliedCount:0,missingMappingCount:0,manualReviewCount:0,invalidMappingCount:0,incompleteRecipeCount:0,insufficientStockCount:0,reviewRequiredCount:0},
 receipts:[{receiptId,refId:r.ref_id,refNo:r.ref_no,refDate:r.ref_date,businessDate:'2026-10-17',status:'ready',inventoryAffectingHash:'i-'+qty,amountHash:'a-'+qty,hashVersion:2,previewedReceiptUpdatedAt:r.updated_at,blockedReasons:[],lines:[{receiptLineId:l.id,refDetailId:l.ref_detail_id,posItemCode:'TEST',itemName:'Item',quantitySold:qty,mappingType:'direct',mappingId:1,mappingSnapshot:{mappingVersion:1},status:'ready',blockedReason:null,deductions:[{inventoryItemId:1,recipeId:null,recipeVersion:null,deductQuantity:qty,deductQuantityPerUnit:1,currentQuantity:n,afterQuantity:n-qty}]}]}]};
}
test('guard followup PostgreSQL: nonidentifier writes, remaining FK locks and fresh-preview retry contracts',{skip:!existsSync('.qa-review/pos-tools/node_modules/@embedded-postgres/windows-x64/dist/index.js')},async t=>{
 const binaries=await import('../.qa-review/pos-tools/node_modules/@embedded-postgres/windows-x64/dist/index.js');
 const dataDir=pathResolve('.qa-review/pos-resolution/pg17-guard-followup-'+Date.now());await mkdir(dataDir,{recursive:true});await run(binaries.initdb,['-D',dataDir,'--encoding=UTF8','--locale=C','-U','postgres','-A','trust'],{windowsHide:true,timeout:30000});
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const server=spawn(binaries.postgres,['-D',dataDir,'-h','127.0.0.1','-p',String(port),'-c','fsync=off','-c','full_page_writes=off','-c','synchronous_commit=off'],{windowsHide:true,stdio:['ignore','pipe','pipe']});let logs='';server.stdout.on('data',v=>logs+=v);server.stderr.on('data',v=>logs+=v);
 const clients=[],base={host:'127.0.0.1',port,user:'postgres',database:'postgres',connectionTimeoutMillis:1000};let index=0;
 async function connect(database='postgres'){const c=new pg.Client({...base,database});await c.connect();clients.push(c);await c.query("set statement_timeout='8s';set lock_timeout='1s';set deadlock_timeout='100ms';set timezone='UTC'");return c;}
 async function fresh(sql=guardSQL,keg=false){const name='followup_'+(++index);await clients[0].query('create database '+name);const c=await connect(name),db={exec:sql=>c.query(sql),query:(...a)=>c.query(...a)};await initializePosCloseDatabase({...db,exec:s=>db.exec(s.replace('create role anon; create role authenticated; create role service_role;',''))});await initializeResolutionSchema(db);await initializeWork(db);await db.exec(sql);
  await db.exec("alter table pos_inventory_deductions add constraint test_mapping_fk foreign key(mapping_id) references pos_item_mappings(id) on delete set null;alter table pos_inventory_deductions add constraint test_log_fk foreign key(inventory_log_id) references inventory_logs(id) on delete set null;");if(keg)await installKeg(db);return {db,c,name};}
 async function normal(db){await stock(db);await seed(db);await db.exec('update pos_sales_receipts set payment_status=3 where id=10;update pos_sales_receipt_lines set payment_status=3 where receipt_id=10');}
 async function protectedApplied(db){await stock(db);await seed(db);await resolve2(db,10);await approve(db,10,await plan(db,10,'initial_apply'));return (await query(db,"select id,inventory_log_id from pos_inventory_deductions where receipt_id=10 order by id limit 1"))[0];}
 async function waitForBlocked(c){for(let n=0;n<100;n++){if(Number((await clients[0].query('select count(*) n from pg_locks where pid=$1 and not granted',[c.processID])).rows[0].n)>0)return;await delay(5);}assert.fail('expected real lock wait');}
 try{
  let ready=false;for(let n=0;n<100;n++){try{await connect();ready=true;break}catch{await delay(100)}}assert.ok(ready,logs.slice(-500));await clients[0].query('create role anon;create role authenticated;create role service_role;');
  await t.test('previous SQL permits status/quantity/inventory reassignment and DELETE; corrected guard rejects each with no data drift',async()=>{
   const old=await fresh(readFileSync('.qa-review/pos-resolution/guard-followup/migration-before.sql','utf8'));let row=await protectedApplied(old.db);await old.db.query("update pos_inventory_deductions set status='previewed',deduct_quantity_total=99,inventory_item_id=2 where id=$1",[row.id]);await old.db.query('delete from pos_inventory_deductions where id=$1',[row.id]);
   const {db}=await fresh();row=await protectedApplied(db);const before=await allStock(db);for(const set of ["status='previewed'",'deduct_quantity_total=99','deduct_quantity=99','inventory_item_id=2','mapping_id=null','inventory_log_id=null'])await assert.rejects(db.query('update pos_inventory_deductions set '+set+' where id=$1',[row.id]),e=>e.code==='42501');await assert.rejects(db.query('delete from pos_inventory_deductions where id=$1',[row.id]),e=>e.code==='42501');assert.deepEqual(await allStock(db),before);
   await assert.rejects(db.query('delete from inventory_logs where id=$1',[row.inventory_log_id]),e=>e.code==='42501');assert.deepEqual(await allStock(db),before);findings.nonIdentifierGapBlocked=true;
  });
  await t.test('protected engine bookkeeping still works; DELETE even inside engine capability rolls back the entire approval',async()=>{
   const {db}=await fresh();await protectedApplied(db);let w=await work(db,10);await correct(db,correction(w,{requestId:randomUUID(),lines:w.state.lines.map(l=>({...l,quantity:2,unit_price:45000,discount_amount:0,tax_rate:0}))}));await approve(db,10,await plan(db,10,'reprocess_modified'));w=await work(db,10);await correct(db,correction(w,{requestId:randomUUID(),decision:'canceled',refundConfirmed:true,refundEvidence:'fixture refund'}));await approve(db,10,await plan(db,10,'rollback_canceled'));assert.equal(Number((await query(db,'select quantity from inventory where id=1'))[0].quantity),100);
   const f=await fresh();await stock(f.db);await seed(f.db);await resolve2(f.db,10);const before=await allStock(f.db);await f.db.exec("create function qa_try_delete() returns trigger language plpgsql as $$begin delete from pos_inventory_deductions where receipt_id=new.receipt_id;return new;end$$;create trigger qa_try_delete before insert on pos_sales_receipt_inventory_approvals for each row execute function qa_try_delete();");await assert.rejects(approve(f.db,10,await plan(f.db,10,'initial_apply')),e=>e.code==='42501');assert.deepEqual(await allStock(f.db),before);
  });
  await t.test('mapping/log FK parent locks fail NOWAIT before receipt lock; both directions and ordinary non-key edits stay compatible',async()=>{
   const {db,name}=await fresh();await normal(db);const other=await connect(name);const logId=(await query(db,"insert into inventory_logs(item_id,action) values(1,'test') returning id"))[0].id;const timings=[];
   for(const [table,id,field] of [['pos_item_mappings',1,'mapping_id'],['inventory_logs',logId,'inventory_log_id']])for(let n=0;n<5;n++){
    await other.query('begin');await other.query('select 1 from '+table+' where id=$1 for update',[id]);const start=performance.now();await assert.rejects(db.query('insert into pos_inventory_deductions(receipt_id,operation_type,status,'+field+") values(10,'preview','selected',$1)",[id]),e=>e.code==='55P03');timings.push(performance.now()-start);await other.query('select 1 from pos_sales_receipts where id=10 for update nowait');await other.query('rollback');
   }
   await other.query('begin');await other.query("update pos_item_mappings set quantity_multiplier=quantity_multiplier where id=1");await db.query("insert into pos_inventory_deductions(receipt_id,mapping_id,operation_type,status) values(10,1,'preview','selected')");await other.query('commit');findings.fkNowaitMs=timings;
  });
  await t.test('catalog writer -> approval -> protected INSERT inversion rejects quickly without deadlock',async()=>{
   const {db,c,name}=await fresh();await stock(db);await seed(db);await resolve2(db,10);const r=await plan(db,10,'initial_apply'),other=await connect(name);await other.query('begin');await other.query('select 1 from pos_item_mappings where id=1 for update');await other.query('update pos_item_mappings set mapping_version=mapping_version where id=1');const pending=approve(db,10,r).then(value=>({value}),error=>({error}));await waitForBlocked(c);await assert.rejects(other.query("insert into pos_inventory_deductions(receipt_id,mapping_id,operation_type,status) values(10,1,'preview','selected')"),e=>e.code==='55P03');await other.query('rollback');const done=await pending;assert.equal(done.value?.status,'approved',done.error?.message);
  });
  await t.test('real initial batch saver preserves 55P03; failed attempt does not poison receipt, fresh preview applies exactly once',async()=>{
   const {db,name}=await fresh();await normal(db);const transport=bridge(db);const batches=loadTs('lib/sales/inventory-deduction-batches.ts',{'@/lib/supabase/server':{supabaseServer:transport},'@/lib/sales/inventory-deduction-lock':lockHelper});const other=await connect(name);await other.query('begin');await other.query('select 1 from pos_item_mappings where id=1 for update');
   await assert.rejects(batches.saveInventoryDeductionPreviewBatch({preview:await previewFixture(db),actorUsername:'owner',workflowType:'initial_apply'}),e=>e.code==='55P03');assert.equal((await query(db,'select status from pos_inventory_deduction_batches order by id desc limit 1'))[0].status,'failed');assert.equal(Number((await query(db,'select count(*) n from inventory_logs'))[0].n),0);await other.query('rollback');
   const preview=await previewFixture(db);const saved=await batches.saveInventoryDeductionPreviewBatch({preview,actorUsername:'owner',workflowType:'initial_apply'});const pr=preview.receipts[0];const args=[saved.batchId,'owner',JSON.stringify([{receiptId:10,currentInventoryHash:pr.inventoryAffectingHash,currentReceiptUpdatedAt:pr.previewedReceiptUpdatedAt,applyAllowed:true}])];await query(db,'select apply_sales_inventory_deduction_batch($1,$2,$3) r',args);assert.equal(Number((await query(db,'select quantity from inventory where id=1'))[0].quantity),99);assert.equal(Number((await query(db,'select count(*) n from inventory_logs'))[0].n),1);findings.retry.initialFreshSucceeded=true;
  });
  await t.test('real reprocess service refreshes after 55P03; failed saved candidates do not become successful history',async()=>{
   const {db,name}=await fresh();await normal(db);const transport=bridge(db);const batches=loadTs('lib/sales/inventory-deduction-batches.ts',{'@/lib/supabase/server':{supabaseServer:transport},'@/lib/sales/inventory-deduction-lock':lockHelper});let p=await previewFixture(db),s=await batches.saveInventoryDeductionPreviewBatch({preview:p,actorUsername:'owner',workflowType:'initial_apply'});await transport.rpc('apply_sales_inventory_deduction_batch',{p_batch_id:s.batchId,p_actor_username:'owner',p_validation_receipts:[{receiptId:10,currentInventoryHash:p.receipts[0].inventoryAffectingHash,currentReceiptUpdatedAt:p.receipts[0].previewedReceiptUpdatedAt,applyAllowed:true}]});await db.exec('update pos_sales_receipt_lines set quantity=2 where receipt_id=10');
   let builds=0;const unified=async()=>{builds++;return {receipts:[{receiptId:10,currentFingerprint:'content-2',operationType:'reprocess_modified',activeDeductionCount:1,lastProcessedFingerprint:'content-1'}]};};const service=loadTs('lib/sales/inventory-deduction-reprocess.ts',{'@/lib/supabase/server':{supabaseServer:transport},'@/lib/sales/inventory-deduction-lock':lockHelper,'@/lib/sales/inventory-deduction-preview':{buildInventoryDeductionPreview:()=>previewFixture(db)},'@/lib/sales/inventory-deduction-unified-preview':{buildUnifiedInventoryDeductionPreview:unified}});
   const other=await connect(name);await other.query('begin');await other.query('select 1 from pos_item_mappings where id=1 for update');await assert.rejects(service.prepareAndApplyReprocessInventoryDeduction({receiptId:10,actorUsername:'owner'}),e=>e.code==='55P03');await other.query('rollback');const realRpc=transport.rpc;let inject=true;transport.rpc=async(name,args)=>{if(name==='reprocess_modified_sales_inventory_deduction_receipt'&&inject){inject=false;await other.query('begin');await other.query('select 1 from pos_item_mappings where id=1 for update');const value=await realRpc(name,args);await other.query('rollback');return value;}return realRpc(name,args);};const busy=await service.prepareAndApplyReprocessInventoryDeduction({receiptId:10,actorUsername:'owner'});assert.equal(busy.result,'stale_preview');assert.equal(busy.appliedDeductionCount,0);assert.equal(Number((await query(db,'select quantity from inventory where id=1'))[0].quantity),99);assert.equal(Number((await query(db,'select count(*) n from inventory_logs'))[0].n),1);const result=await service.prepareAndApplyReprocessInventoryDeduction({receiptId:10,actorUsername:'owner'});assert.equal(result.result,'applied',JSON.stringify(result));assert.ok(builds>=2);assert.equal(Number((await query(db,'select quantity from inventory where id=1'))[0].quantity),98);assert.equal(Number((await query(db,'select count(*) n from inventory_logs'))[0].n),3);findings.retry.reprocessFreshSucceeded=true;
  });
  await t.test('direct API and unified execution return refreshable contention, not permanent failure; existing UI refresh path remains',async()=>{
   for(const kind of ['apply','reprocess']){
    const deps={'next/server':nextMock,'@/lib/auth/server-auth':{requireRole:async()=>({ok:true,actor:{username:'owner',role:'owner'}})},'@/lib/sales/inventory-deduction-lock':lockHelper,'@/lib/sales/inventory-deduction-preview':{buildInventoryDeductionPreview:async()=>({receipts:[{receiptId:10,status:'ready',lines:[{deductions:[{}]}]}]})},'@/lib/sales/inventory-deduction-batches':{saveInventoryDeductionPreviewBatch:async()=>{throw Object.assign(new Error('busy'),{code:'55P03'})}},'@/lib/sales/inventory-deduction-reprocess':{prepareAndApplyReprocessInventoryDeduction:async()=>{throw Object.assign(new Error('busy'),{code:'55P03'})}}};
    const route=loadTs('app/api/admin/sales/inventory-deductions/'+kind+'/route.ts',deps);const response=await route.POST(new Request('http://local',{method:'POST',body:JSON.stringify({receiptId:10,receiptIds:[10]})}));assert.equal(response.status,409);const body=await response.json();assert.equal(body.retryable,true);assert.equal(body.requiresRefresh,true);assert.equal(response.headers.get('retry-after'),'1');
   }
   const current={receiptId:10,operationType:'initial_apply',currentFingerprint:'f',canExecute:true,blockingReasons:[],actionableLineCount:1};const service=loadTs('lib/sales/inventory-deduction-unified-execute.ts',{'@/lib/sales/inventory-deduction-lock':lockHelper,'@/lib/sales/inventory-deduction-unified-preview':{buildUnifiedInventoryDeductionPreview:async()=>({receipts:[current]})},'@/lib/sales/inventory-deduction-preview':{buildInventoryDeductionPreview:async()=>({receipts:[{receiptId:10,status:'ready',lines:[{deductions:[{}]}]}]})},'@/lib/sales/inventory-deduction-batches':{saveInventoryDeductionPreviewBatch:async()=>{throw Object.assign(new Error('busy'),{code:'55P03'})}}});const response=await service.executeUnifiedInventoryDeductions({actorUsername:'owner',items:[{receiptId:10,expectedOperationType:'initial_apply'}]});assert.equal(response.results[0].result,'stale_preview');assert.equal(response.results[0].appliedDeductionCount,0);assert.equal(response.shouldRefreshPreview,true);
  });
  await t.test('actual keg replacement remains unaffected with mapping/log FKs and broader guard installed',async()=>{const {db}=await fresh(guardSQL,true);await stock(db);await kegSeed(db);const result=await kegApply(db,await kegPreview(db,3),3);assert.equal(result.ok,true);assert.equal(Number((await query(db,'select quantity from inventory where id=3'))[0].quantity),99);});
  writeFileSync(out+'followup-evidence.json',JSON.stringify(findings,null,2));
 }finally{for(const c of clients){try{await c.end()}catch{}}try{await run(binaries.pg_ctl,['-D',dataDir,'-m','fast','stop'],{windowsHide:true,timeout:15000})}catch{server.kill()}}
});
