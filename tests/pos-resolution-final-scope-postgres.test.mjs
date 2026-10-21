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
const out='.qa-review/pos-resolution/final-scope/';
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

const production={
 apply_sales_inventory_deduction_batch:['cabe66f234065fa9d43a585f9666d928b59b8e9b15a49c416bcdf319b5c6c939','078f0cea37da56fbe9ef968a1f6a5d485f259821d3bd542a4018d53c59a0e3ad'],
 reprocess_modified_sales_inventory_deduction_receipt:['bc64a77bd748c7ca0a29050c0a9c69f914977b6fda2a7da83ec7c6b196f26b29','b10b5f8b4d51563570f05f3e30d96262738ef7490cdc71c9c49b0d882b4f19ba'],
 rollback_canceled_sales_inventory_deduction_receipt:['21262e86b1d5b893c70145ee2aa83536f871a04cf7c5057ec88def46aac9dc97','63c86abd5d7e99a602db115bbf48e88b590e82cab2f538d9f448842feddd2648'],
 admin_update_paid_sales_receipt:['ead803920e480861e1b9a4d6c03957a3ab4f1bafb786ef4925d768efa2940f6c','ead803920e480861e1b9a4d6c03957a3ab4f1bafb786ef4925d768efa2940f6c'],
 sales_close_business_day_v1:['f2752f3edf63d74b3eadd2aba1697b6090af03e73388076cfe462690ed13f6da','f2752f3edf63d74b3eadd2aba1697b6090af03e73388076cfe462690ed13f6da'],
 build_source:['09934b9ef415ab7aee52c52cb99d8e1412c04e8dbd1e45dd4e69480f7d9cf2fd','09934b9ef415ab7aee52c52cb99d8e1412c04e8dbd1e45dd4e69480f7d9cf2fd'],
 set_pos_sales_updated_at:['88b4d9dc9e0c19de94e2fac922514c0f6bcedd7583e6fa08cd3116f6f41414c6','0a27989ddc5620e0dfe8244f0d6571d7d121daec9103e4a4ea8a040c1cf6bc1b']
};
const evidence={productionBaselinesSource:'User supplied SELECT-only 2026-10-21',hashes:[],scenarios:[],deadlocks:0};
const phase1=readFileSync('supabase/migrations/20261021070640_pos_pending_admin_resolutions.sql','utf8');
const guard=readFileSync('supabase/migrations/20261021133856_pos_resolution_deduction_insert_guard.sql','utf8');
async function capture(db,sigs){
 return query(db,"select p.proname name,p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition from pg_proc p where oid=any($1::regprocedure[]) order by proname",[sigs.map(s=>s.startsWith('pos_sales_')?s:'public.'+s)]);
}
async function scale(db,kegItem=3){
 await stock(db);await kegSeed(db,kegItem);
 await db.exec(`insert into inventory(id,quantity,item_name,unit) select n,100,'Synthetic inventory '||n,'unit' from generate_series(3,555)n on conflict do nothing;
 insert into pos_products(id,pos_item_id,item_id,item_code,item_name,is_active) select n,'other-'||n,'other-'||n,'OTHER-'||n,'Other',true from generate_series(1,351)n on conflict do nothing;
 insert into pos_item_mappings select n,'OTHER-'||n,'direct',true,1,n,1,false from generate_series(2,225)n;
 insert into pos_item_mapping_recipes select n,n+1,n+1,true,1,1 from generate_series(1,6)n;`);
 await seed(db,900000,'2026-10-16');
 const b=(await query(db,"insert into pos_inventory_deduction_batches(flow_version,source,status) values('sales_db_v1','manual_preview','applied') returning id"))[0].id;
 const br=(await query(db,"insert into pos_inventory_deduction_receipts(batch_id,receipt_id,status,inventory_affecting_hash,amount_hash) values($1,900000,'applied','background','background') returning id",[b]))[0].id;
 await db.query("insert into pos_inventory_deductions(receipt_id,invoice_ref_id,batch_id,batch_receipt_id,operation_type,status,inventory_item_id,mapping_id,deduct_quantity_total) select 900000,'ref-900000',$1,$2,'deduction','applied',2,2,1 from generate_series(1,1721)",[b,br]);
 await db.exec('analyze');
 const counts=(await query(db,"select (select count(*)::int from inventory) inventory,(select count(*)::int from pos_products) products,(select count(*)::int from pos_item_mappings) mappings,(select count(*)::int from pos_item_mapping_recipes) recipes,(select count(*)::int from pos_inventory_deductions) deductions"))[0];
 assert.deepEqual(counts,{inventory:555,products:351,mappings:225,recipes:6,deductions:1721});await db.exec(guard);return counts;
}
async function normalSeed(db,id){await seed(db,id);await db.query('update pos_sales_receipts set payment_status=3 where id=$1',[id]);await db.query('update pos_sales_receipt_lines set payment_status=3 where receipt_id=$1',[id]);}
async function initial(db,p){return (await query(db,"select apply_sales_inventory_deduction_batch($1,'owner',$2::jsonb) r",[p.batch,JSON.stringify([{receiptId:p.r.id,currentInventoryHash:p.hash,currentReceiptUpdatedAt:p.r.updated_at,applyAllowed:true}])]))[0].r;}
const wrapped=c=>({query:(...a)=>c.query(...a)});
const outcome=p=>p.then(value=>({value}),error=>({code:error.code,message:error.message}));
test('final bounded verification: supplied function fingerprints and production-count POS/admin/keg contention',{skip:!existsSync('.qa-review/pos-tools/node_modules/@embedded-postgres/windows-x64/dist/index.js')},async t=>{
 const binaries=await import('../.qa-review/pos-tools/node_modules/@embedded-postgres/windows-x64/dist/index.js');
 await mkdir(out,{recursive:true});const dataDir=pathResolve('.qa-review/pos-resolution/pg17-final-scope-'+Date.now());await mkdir(dataDir,{recursive:true});evidence.dataDir=dataDir;
 await run(binaries.initdb,['-D',dataDir,'--encoding=UTF8','--locale=C','-U','postgres','-A','trust'],{windowsHide:true,timeout:30000});
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const server=spawn(binaries.postgres,['-D',dataDir,'-h','127.0.0.1','-p',String(port),'-c','fsync=off','-c','full_page_writes=off','-c','synchronous_commit=off'],{windowsHide:true,stdio:['ignore','pipe','pipe']});let logs='';server.stdout.on('data',v=>logs+=v);server.stderr.on('data',v=>logs+=v);
 const clients=[];let index=0;const base={host:'127.0.0.1',port,user:'postgres',database:'postgres',connectionTimeoutMillis:1000};
 async function connect(database='postgres'){const c=new pg.Client({...base,database});await c.connect();clients.push(c);await c.query("set statement_timeout='12s';set lock_timeout='5s';set deadlock_timeout='100ms';set timezone='UTC'");return c;}
 async function fresh(hashes=false){const name='final_'+(++index);await clients[0].query('create database '+name);const c=await connect(name),db={exec:s=>c.query(s),query:(...a)=>c.query(...a)};
  await initializePosCloseDatabase({...db,exec:s=>db.exec(s.replace('create role anon; create role authenticated; create role service_role;',''))});await initializeResolutionSchema(db,{migration:''});
  let before=await capture(db,['sales_close_business_day_v1(date,text,jsonb,jsonb,bigint,text,boolean,bigint)','pos_sales_close_private.build_source(date)']);
  await db.exec(phase1);await initializeWork(db,{beforeMigration:async db=>{await operationalContracts(db);before.push(...await capture(db,[...engineSignatures,'admin_update_paid_sales_receipt(bigint,bigint,uuid,text,text,text,numeric,text,numeric,jsonb,numeric)','set_pos_sales_updated_at()']));}});
  if(hashes){evidence.hashes=before.map(d=>{const baseline=production[d.name];return {...d,localRaw:digest(d.definition),localLF:digest(d.definition.replace(/\r\n?/g,'\n')),productionRaw:baseline[0],productionLF:baseline[1],rawMatch:digest(d.definition)===baseline[0],lfMatch:digest(d.definition.replace(/\r\n?/g,'\n'))===baseline[1],fixtureOnly:d.name==='set_pos_sales_updated_at'};});writeFileSync(out+'function-fingerprints.json',JSON.stringify(evidence.hashes,null,2));}
  await installKeg(db);
  await db.exec('alter table pos_inventory_deductions add constraint final_mapping_fk foreign key(mapping_id) references pos_item_mappings(id) on delete set null;alter table pos_inventory_deductions add constraint final_log_fk foreign key(inventory_log_id) references inventory_logs(id) on delete set null;');
  return {db,c,name};
 }
 async function blocked(c){for(let i=0;i<150;i++){if(Number((await clients[0].query('select count(*) n from pg_locks where pid=$1 and not granted',[c.processID])).rows[0].n)>0)return;await delay(5);}assert.fail('expected real lock wait');}
 try{
  let ready=false;for(let i=0;i<100;i++){try{await connect();ready=true;break}catch{await delay(100)}}assert.ok(ready,logs.slice(-1000));await clients[0].query('create role anon;create role authenticated;create role service_role;');
  await t.test('fingerprints captured against seven supplied operating baselines; mismatches are evidence, never silently accepted',async()=>{await fresh(true);assert.equal(evidence.hashes.length,7);assert.equal(evidence.hashes.find(h=>h.name==='apply_sales_inventory_deduction_batch').lfMatch,true);assert.equal(evidence.hashes.find(h=>h.name==='build_source').lfMatch,true);});
  await t.test('five production-count rounds: normal POS apply, duplicate admin approval, sync DML and unrelated actual keg replacement',async()=>{
   const {db,c,name}=await fresh();const counts=await scale(db),pos=await connect(name),dup=await connect(name),sync=await connect(name),keg=await connect(name);const timings=[];
   for(let i=0;i<5;i++){
    const aid=100+i,nid=200+i;await seed(db,aid);await resolve2(db,aid);await normalSeed(db,nid);const p=await candidate(db,nid,1,'mixed-'+i),review=await plan(db,aid,'initial_apply'),kp=await kegPreview(db,3,i),requestId=randomUUID();
    await c.query('begin');assert.equal((await approve(db,aid,review,{requestId})).status,'approved');const start=performance.now();
    const np=outcome(initial(wrapped(pos),p)),dp=outcome(approve(wrapped(dup),aid,review,{requestId})),sp=outcome(sync.query('update pos_sales_receipts set synced_at=clock_timestamp() where id=$1',[nid]));await blocked(pos);
    const ks=performance.now();assert.equal((await kegApply(wrapped(keg),kp,3)).ok,true);const kegMs=performance.now()-ks;await delay(40);await c.query('commit');
    const [normal,duplicate,synced]=await Promise.all([np,dp,sp]);assert.ok(normal.value,JSON.stringify(normal));assert.equal(normal.value.status,'applied');assert.ok(duplicate.value,JSON.stringify(duplicate));assert.ok(synced.value,JSON.stringify(synced));
    await assert.rejects(initial(db,p),/Batch cannot be applied from status applied/);assert.equal(Number((await query(db,"select count(*) n from pos_inventory_deductions where receipt_id=$1 and status='applied' and operation_type<>'revert'",[aid]))[0].n),1);assert.equal(Number((await query(db,"select count(*) n from pos_inventory_deductions where receipt_id=$1 and status='applied' and operation_type<>'revert'",[nid]))[0].n),1);
    timings.push({totalMs:performance.now()-start,kegMs,duplicateStatus:duplicate.value.status});
   }
   assert.equal(Number((await query(db,'select quantity from inventory where id=1'))[0].quantity),90);assert.equal(Number((await query(db,'select quantity from inventory where id=3'))[0].quantity),95);evidence.scenarios.push({name:'POS/admin/sync/keg',rounds:5,counts,timings,stock:90,kegStock:95,duplicateDeductions:0});
  });
  await t.test('five production-count rounds: same inventory keg wins, approval is stale, fresh approval and identical-request retry succeed',async()=>{
   const {db,c,name}=await fresh();await scale(db,1);const keg=await connect(name),timings=[];
   for(let i=0;i<5;i++){const id=300+i;await seed(db,id);await resolve2(db,id);const r=await plan(db,id,'initial_apply'),kp=await kegPreview(db,1,i);await keg.query('begin');assert.equal((await kegApply(wrapped(keg),kp,1)).ok,true);const start=performance.now(),pending=outcome(approve(db,id,r));await blocked(c);await delay(40);await keg.query('commit');const first=await pending;assert.match(first.message||'',/STALE_PREVIEW/);assert.notEqual(first.code,'40P01');const next=await plan(db,id,'initial_apply'),requestId=randomUUID();assert.equal((await approve(db,id,next,{requestId})).status,'approved');await approve(db,id,next,{requestId});assert.equal(Number((await query(db,"select count(*) n from pos_inventory_deductions where receipt_id=$1 and status='applied' and operation_type<>'revert'",[id]))[0].n),1);timings.push(performance.now()-start);}
   assert.equal(Number((await query(db,'select quantity from inventory where id=1'))[0].quantity),90);evidence.scenarios.push({name:'shared keg then approval',rounds:5,staleThenFreshSuccess:5,ms:timings,duplicateDeductions:0});
  });
  await t.test('production-count 55P03 candidate collision: failed INSERT rolls back, new batch succeeds exactly once',async()=>{
   const {db,name}=await fresh();await scale(db);await normalSeed(db,400);const other=await connect(name);await other.query('begin');await other.query('select 1 from pos_item_mappings where id=1 for update');
   const before=Number((await query(db,'select count(*) n from pos_inventory_deductions'))[0].n);await assert.rejects(candidate(db,400,1,'busy'),e=>e.code==='55P03');assert.equal(Number((await query(db,'select count(*) n from pos_inventory_deductions'))[0].n),before);assert.equal(Number((await query(db,'select count(*) n from inventory_logs'))[0].n),0);await other.query('rollback');const p=await candidate(db,400,1,'fresh');assert.equal((await initial(db,p)).status,'applied');await assert.rejects(initial(db,p),/Batch cannot be applied from status applied/);assert.equal(Number((await query(db,'select quantity from inventory where id=1'))[0].quantity),99);assert.equal(Number((await query(db,'select count(*) n from inventory_logs'))[0].n),1);evidence.scenarios.push({name:'55P03 fresh batch',retrySucceeded:true,duplicateDeductions:0});
  });
 }finally{
  evidence.observedDeadlocks=(logs.match(/deadlock detected/g)||[]).length;writeFileSync(out+'evidence.json',JSON.stringify(evidence,null,2));for(const c of clients){try{await c.end()}catch{}}try{await run(binaries.pg_ctl,['-D',dataDir,'-m','fast','stop'],{windowsHide:true,timeout:15000})}catch{server.kill()}
 }
});
