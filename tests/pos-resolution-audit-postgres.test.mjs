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

test('audit P0 PostgreSQL17: CRLF, updated_at trigger, closed-day staging and inventory contention',{skip:!existsSync('.qa-review/pos-tools/node_modules/@embedded-postgres/windows-x64/dist/index.js')},async t=>{
 const binaries=await import('../.qa-review/pos-tools/node_modules/@embedded-postgres/windows-x64/dist/index.js');
 const dataDir=pathResolve('.qa-review/pos-resolution/pg17-audit-'+Date.now());await mkdir(dataDir,{recursive:true});
 await run(binaries.initdb,['-D',dataDir,'--encoding=UTF8','--locale=C','-U','postgres','-A','trust'],{windowsHide:true,timeout:30000});
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const server=spawn(binaries.postgres,['-D',dataDir,'-h','127.0.0.1','-p',String(port),'-c','fsync=off','-c','full_page_writes=off','-c','synchronous_commit=off'],{windowsHide:true,stdio:['ignore','pipe','pipe']});let logs='';server.stdout.on('data',v=>logs+=v);server.stderr.on('data',v=>logs+=v);
 const clients=[],base={host:'127.0.0.1',port,user:'postgres',database:'postgres',connectionTimeoutMillis:1000};
 async function connect(database='postgres'){const c=new pg.Client({...base,database});await c.connect();clients.push(c);await c.query("set statement_timeout='15s';set timezone='UTC'");return c;}
 let dbNumber=0;
 async function fresh(options={}){
  const name='audit_'+(++dbNumber);await clients[0].query('create database '+name);const c=await connect(name);
  const db={exec:sql=>c.query(sql),query:(...args)=>c.query(...args)};
  // Roles are cluster-wide; the first fixture already created them.
  const initDb={...db,exec:sql=>db.exec(sql.replace('create role anon; create role authenticated; create role service_role;',''))};
  await initializePosCloseDatabase(initDb);await initializeResolutionSchema(db);await initializeWork(db,{beforeMigration:operationalContracts,...options});return {db,c,name};
 }
 try{
  let ready=false;for(let i=0;i<100;i++){try{await connect();ready=true;break}catch{await delay(100)}}assert.ok(ready,logs.slice(-1000));
  await clients[0].query('create role anon;create role authenticated;create role service_role;');
  await t.test('old phase2 fails on CRLF and leaves no partial DDL or row changes',async()=>{
   const old=readFileSync('tests/fixtures/pos-resolution-phase2-before-audit.sql','utf8');
   let failedDb,before;
   await assert.rejects(fresh({migration:old,beforeMigration:async db=>{await operationalContracts(db);failedDb=db;before=await query(db,"select oid,md5(pg_get_functiondef(oid)) hash from pg_proc where oid=any($1::regprocedure[]) order by oid",[engineSignatures.map(s=>'public.'+s)]);}}),/ENGINE_CONTRACT_MISMATCH/);
   await failedDb.exec('rollback');
   assert.equal((await query(failedDb,"select to_regclass('public.pos_sales_receipt_resolution_versions') x"))[0].x,null);
   assert.equal((await query(failedDb,"select count(*) n from information_schema.columns where table_name='pos_sales_receipts' and column_name='admin_resolution_version'"))[0].n,'0');
   assert.deepEqual(await query(failedDb,"select oid,md5(pg_get_functiondef(oid)) hash from pg_proc where oid=any($1::regprocedure[]) order by oid",[engineSignatures.map(s=>'public.'+s)]),before);
  });
  await t.test('new full migration accepts CRLF; exactly one guard before original locks; ambiguous anchor fails atomically',async()=>{
   const {db}=await fresh();
   for(const signature of engineSignatures){const d=(await query(db,'select pg_get_functiondef($1::regprocedure) d',['public.'+signature]))[0].d;assert.equal(d.split('POS_RESOLUTION_INVENTORY_APPROVAL_REQUIRED').length-1,1);assert.ok(d.indexOf('POS_RESOLUTION_INVENTORY_APPROVAL_REQUIRED')<d.indexOf('for update'));const original=readFileSync('.qa-review/pos-resolution/p0-audit/repository-crlf-'+signature.split('(')[0]+'.sql','utf8').replace(/\r\n?/g,'\n');assert.equal(d.replace(/^ if exists\(select[^\n]*POS_RESOLUTION_INVENTORY_APPROVAL_REQUIRED[^\n]*\n/m,''),original);}
   const migration=readFileSync('supabase/migrations/20261021081604_pos_resolution_corrections_inventory_review.sql','utf8');let failedDb;
   await assert.rejects(fresh({migration,beforeMigration:async db=>{await operationalContracts(db);failedDb=db;const signature=engineSignatures[0];let d=(await query(db,'select pg_get_functiondef($1::regprocedure) d',['public.'+signature]))[0].d;d=d.replace('begin\r\n','begin\r\n--\r\nbegin\r\nend;\r\n');await db.exec(d);}}),/ANCHOR_CONTRACT_MISMATCH/);
   await failedDb.exec('rollback');assert.equal((await query(failedDb,"select to_regclass('public.pos_sales_receipt_inventory_approvals') x"))[0].x,null);
   await assert.rejects(fresh({beforeMigration:async db=>{await operationalContracts(db);failedDb=db;await db.exec('alter function public.'+engineSignatures[0]+' security invoker');}}),/ENGINE_CONTRACT_MISMATCH/);await failedDb.exec('rollback');assert.equal((await query(failedDb,"select to_regclass('public.pos_sales_receipt_resolution_versions') x"))[0].x,null);
  });
  await t.test('first migration explicit transaction rolls back objects after a late failure',async()=>{
   const name='audit_'+(++dbNumber);await clients[0].query('create database '+name);const c=await connect(name);const db={exec:sql=>c.query(sql),query:(...args)=>c.query(...args)};
   await initializePosCloseDatabase({...db,exec:sql=>db.exec(sql.replace('create role anon; create role authenticated; create role service_role;',''))});
   const first=readFileSync('supabase/migrations/20261021070640_pos_pending_admin_resolutions.sql','utf8');assert.match(first,/\nbegin;\n/);assert.match(first,/commit;\s*$/);
   await assert.rejects(initializeResolutionSchema(db,{migration:first.replace(/commit;\s*$/,'select 1/0;\ncommit;')}),/division by zero/);
   await db.exec('rollback');assert.equal((await query(db,"select to_regclass('public.pos_sales_receipt_admin_resolutions') x"))[0].x,null);
   assert.equal((await query(db,"select to_regnamespace('pos_resolution_private') x"))[0].x,null);
   assert.equal((await query(db,'select count(*) n from pos_sales_receipts'))[0].n,'3');
  });
  await t.test('closed 6982/7063/7064: pending staging -> exact correction -> official reclose -> initial inventory approval',async()=>{
   for(const [id,original,actual,date] of [[6982,1910800,1100800,'2026-10-17'],[7063,955000,220000,'2026-10-20'],[7064,3222000,2682000,'2026-10-20']]){
    const {db}=await fresh();await stock(db);await seed(db,id,date,original);
    if(id===6982){await db.query('update pos_sales_receipt_lines set unit_price=1100800,amount=1100800,final_amount=1100800 where receipt_id=$1',[id]);await db.query(`insert into pos_sales_receipt_lines(source,receipt_id,receipt_ref_id,ref_detail_id,item_code,item_name,quantity,unit_price,amount,final_amount,discount_amount,tax_rate,tax_amount,is_excluded,is_canceled,payment_status,raw_json) values('cukcuk',$1,'ref-6982','cb3-original','CB3','CB3',1,750000,750000,750000,0,8,60000,false,false,1,'{"OrderDetailID":"CB3-original","TaxRate":8}')`,[id]);}
    await closeDay(db,await daySource(db,date));const before=await ledgerState(db),r=await review(db,id);
    const result=await resolve2(db,id,{amount:actual,payments:[{method:'cash',amount:actual}],allowReclose:true,closureFingerprint:r.closure.fingerprint});assert.equal(result.status,'resolved');assert.equal(result.reclose.status,'financial_correction_staged');
    let w=await work(db,id);assert.equal(w.state.receipt.payment_status,1);assert.equal(w.state.receipt.admin_resolution_financial_review_required,true);assert.equal(w.policy.daySourceDrift,false);assert.deepEqual(await ledgerState(db),before);assert.equal((await daySource(db,date)).receiptTotal,0);
    const held=await plan(db,id,'initial_apply');assert.ok(held.blockers.includes('financial_correction_required'));await assert.rejects(approve(db,id,held,{approveReclose:true,closureFingerprint:r.closure.fingerprint}),/BLOCKED/);
    const body=correction(w,{requestId:randomUUID(),amount:actual,payments:[{method:'cash',amount:actual}],approveReclose:true,closureFingerprint:r.closure.fingerprint,lines:[{id:w.state.lines[0].id,quantity:1,unit_price:actual,discount_amount:0,tax_rate:0}]});
    await assert.rejects(correct(db,{...body,amount:actual+1},id),/MISMATCH/);assert.deepEqual((await work(db,id)).state,w.state);
    const done=await correct(db,body,id);assert.equal(done.reclose.status,'reclosed');assert.deepEqual(await correct(db,body,id),done);w=await work(db,id);assert.equal(w.state.receipt.payment_status,3);assert.equal(w.state.receipt.admin_resolution_financial_review_required,false);assert.equal(w.state.receipt.inventory_deduction_processing_paused,true);assert.equal((await daySource(db,date)).receiptTotal,actual);
    const preview=await plan(db,id,'initial_apply');await approve(db,id,preview,{approveReclose:true,closureFingerprint:w.policy.closure.fingerprint});assert.equal(Number((await query(db,'select quantity from inventory where id=1'))[0].quantity),99);
    if(id===6982){const cb3=(await work(db,id)).state.lines.find(l=>l.item_code==='CB3');assert.equal(cb3.is_excluded,true);assert.equal(Number(cb3.tax_amount),60000);assert.deepEqual(cb3.raw_json,{OrderDetailID:'CB3-original',TaxRate:8});}
   }
  });
  await t.test('closed-day staged correction with settled card fails and restores staging, payments, audits and ledger',async()=>{
   const {db}=await fresh();await seed(db,900);await resolve2(db,900,{payments:[{method:'card',amount:100000}]});await seed(db,6982,'2026-10-17',1910800);await closeDay(db,await daySource(db,'2026-10-17'));await addCardSettlement(db,'partial','2026-10-17');const r=await review(db,6982);
   await resolve2(db,6982,{amount:1100800,payments:[{method:'cash',amount:1100800}],allowReclose:true,closureFingerprint:r.closure.fingerprint});const w=await work(db,6982),ledger=await ledgerState(db);
   await assert.rejects(correct(db,correction(w,{requestId:randomUUID(),amount:1100800,payments:[{method:'card',amount:1100800}],lines:[{id:w.state.lines[0].id,quantity:1,unit_price:1100800,discount_amount:0,tax_rate:0}],approveReclose:true,closureFingerprint:r.closure.fingerprint}),6982),/RECLOSE_FAILED/);
   assert.deepEqual((await work(db,6982)).state,w.state);assert.deepEqual(await ledgerState(db),ledger);assert.equal((await query(db,'select count(*) n from pos_sales_receipt_resolution_versions'))[0].n,'0');
  });
  await t.test('five rounds: initial/reprocess/canceled rollback with now() trigger, late failure rollback, cron guard and exact-once replay',async()=>{
   const {db,c,name}=await fresh();await stock(db);const other=await connect(name);
   await db.exec("create function audit_fail_approval() returns trigger language plpgsql as $$begin raise exception 'audit_late_failure';end$$;");
   for(let round=0;round<5;round++){
    const id=100+round;await seed(db,id);await resolve2(db,id);
    for(const workflow of ['initial_apply','reprocess_modified','rollback_canceled']){
     if(workflow!=='initial_apply'){const w=await work(db,id);await correct(db,correction(w,{requestId:randomUUID(),...(workflow==='reprocess_modified'?{lines:[{id:w.state.lines[0].id,quantity:2,unit_price:45000,discount_amount:0,tax_rate:0}]}:{decision:'canceled',refundConfirmed:true,refundEvidence:'fixture refund'})}),id);}
     const r=await plan(db,id,workflow),before=await allStock(db);
     await db.exec('create trigger audit_fail_approval before insert on pos_sales_receipt_inventory_approvals for each row execute function audit_fail_approval();');
     await assert.rejects(approve(db,id,r),/audit_late_failure/);assert.deepEqual(await allStock(db),before);await db.exec('drop trigger audit_fail_approval on pos_sales_receipt_inventory_approvals');
     const requestId=randomUUID();await c.query('begin');const approved=await approve(db,id,r,{requestId});assert.equal(approved.workflow,workflow);
     assert.equal((await other.query('select inventory_deduction_processing_paused held from pos_sales_receipts where id=$1',[id])).rows[0].held,true);
     await assert.rejects(other.query("select rollback_canceled_sales_inventory_deduction_receipt($1,'owner',now(),'cron')",[id]),/APPROVAL_REQUIRED/);
     const replay=approve({query:(...args)=>other.query(...args)},id,r,{requestId});await delay(30);await c.query('commit');assert.deepEqual(await replay,approved);
     assert.equal(Number((await query(db,'select quantity from inventory where id=1'))[0].quantity),workflow==='initial_apply'?99:workflow==='reprocess_modified'?98:100);
    }
   }
   assert.equal((await query(db,'select count(*) n from inventory_logs'))[0].n,'20');assert.equal((await query(db,'select count(*) n from pos_sales_receipt_inventory_approvals'))[0].n,'15');
  });
  await t.test('scoped fingerprint ignores unrelated inventory/catalog but detects matching mapping and relevant stock changes',async()=>{
   const {db}=await fresh();await stock(db);await seed(db);await resolve2(db,10);const initial=await work(db,10);
   await db.exec("update inventory set quantity=quantity-1 where id=2;insert into pos_item_mappings values(2,'OTHER','direct',true,1,2,1,false);insert into pos_products values(2,'OTHER','OTHER','OTHER','Other','unit',1,0,true)");assert.equal((await work(db,10)).contextFingerprint,initial.contextFingerprint);
   await db.exec("insert into pos_item_mappings values(3,'TEST','direct',true,1,2,1,false)");assert.notEqual((await work(db,10)).contextFingerprint,initial.contextFingerprint);await db.exec('delete from pos_item_mappings where id=3');assert.equal((await work(db,10)).contextFingerprint,initial.contextFingerprint);
   await db.exec('update inventory set quantity=quantity-1 where id=1');assert.notEqual((await work(db,10)).contextFingerprint,initial.contextFingerprint);
  });
  await t.test('scoped context benchmark at audited row counts; full cloned definitions exported for review',async()=>{
   const {db}=await fresh();await stock(db);await seed(db);await resolve2(db,10);
   await db.exec(`insert into inventory(id,quantity,item_name,unit) select n,100,'Unrelated','unit' from generate_series(3,555) n;
    insert into pos_products(id,pos_item_id,item_id,item_code,item_name,is_active) select n,'other-'||n,'other-'||n,'OTHER-'||n,'Other',true from generate_series(1,351) n;
    insert into pos_item_mappings select n,'OTHER-'||n,'direct',true,1,n,1,false from generate_series(2,225) n;
    insert into pos_item_mapping_recipes select n,n+1,n+1,true,1,1 from generate_series(1,6) n;
    insert into pos_inventory_deductions(receipt_id,invoice_ref_id,operation_type,status,inventory_item_id) select 99999,'unrelated','preview','previewed',2 from generate_series(1,1717);`);
   const times=[];for(let n=0;n<30;n++){const start=performance.now();await query(db,'select pos_resolution_private.inventory_context(10)');times.push(performance.now()-start);}times.sort((a,b)=>a-b);
   const ids=(await query(db,'select pos_resolution_private.inventory_ids(10) ids,pos_resolution_private.mapping_ids(10) mappings'))[0];assert.deepEqual(ids.ids,['1']);assert.deepEqual(ids.mappings,['1']);
   const explain=await query(db,'explain (analyze,buffers,format json) select pos_resolution_private.inventory_context(10)');
   const definitions=await query(db,`select n.nspname,p.proname,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='pos_resolution_private' and p.proname in('edit_paid_held','resolve_pending_with_history')) or (n.nspname='public' and p.proname in('apply_sales_inventory_deduction_batch','reprocess_modified_sales_inventory_deduction_receipt','rollback_canceled_sales_inventory_deduction_receipt','sales_confirm_admin_resolution_inventory_v2')) order by n.nspname,p.proname`);
   writeFileSync('.qa-review/pos-resolution/p0-audit/generated-functions.sql',definitions.map(d=>d.definition).join('\n'));writeFileSync('.qa-review/pos-resolution/p0-audit/context-benchmark.json',JSON.stringify({runs:30,p50Ms:times[14],p95Ms:times[28],maxMs:times[29],rows:{inventory:555,products:351,mappings:225,recipes:6,deductions:1717},scopedInventoryIds:ids.ids,scopedMappingIds:ids.mappings,explain,synthetic:true,productionEquivalent:false},null,2));
  });
  await t.test('target stock row blocks; unrelated keg inventory update and deduction insert proceed during approval transaction',async()=>{
   const {db,c,name}=await fresh();await stock(db);await seed(db);await resolve2(db,10);const r=await plan(db,10,'initial_apply');const other=await connect(name);await other.query("set lock_timeout='500ms'");
   await c.query('begin');await approve(db,10,r);
   assert.equal((await query(db,"select count(*) n from pg_locks where pid=pg_backend_pid() and relation='public.inventory'::regclass and mode in('ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')"))[0].n,'0');
   const started=performance.now();await other.query('update inventory set quantity=quantity-1 where id=2');await other.query("insert into pos_inventory_deductions(receipt_id,operation_type,status) values(99999,'preview','previewed')");const elapsed=performance.now()-started;assert.ok(elapsed<1000,'unrelated stock update blocked '+elapsed);
   await assert.rejects(other.query('update inventory set quantity=quantity-1 where id=1'),/lock timeout/);
   await assert.rejects(other.query("insert into pos_item_mappings values(9,'TEST','direct',true,1,2,1,false)"),/lock timeout/);
   // Remaining receipt barrier is deliberately measured, not hidden.
   await assert.rejects(other.query("update pos_sales_receipts set final_amount=final_amount where id=1"),/lock timeout/);
   await c.query('commit');writeFileSync('.qa-review/pos-resolution/p0-audit/contention.json',JSON.stringify({unrelatedInventoryAndDeductionMs:elapsed,lockTimeoutMs:500,remainingBarriers:['receipt/line/payment tables','catalog mapping/recipe/product tables'],productionScale:false},null,2));
  });
 }finally{
  for(const c of clients){try{await c.end()}catch{}}
  try{await run(binaries.pg_ctl,['-D',dataDir,'-m','fast','stop'],{windowsHide:true,timeout:15000})}catch{server.kill()}
 }
});
