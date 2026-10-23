// Native PostgreSQL only; no external database. Proves that the retire migration
// returns the schema/functions/data to the pre-V1 operating state and fails closed.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,readdirSync,realpathSync,writeFileSync} from 'node:fs';
import {mkdir,rm} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import net from 'node:net';
import pg from 'pg';
import {initializePosCloseDatabase} from './helpers/pos-business-day-close-fixture.mjs';
import {initializeResolutionSchema,initializeWork} from './helpers/payment-upgrade-fixture.mjs';
import {reproduceOperatingInventoryContract} from './helpers/payment-upgrade-inventory-fixture.mjs';

const run=promisify(execFile),wait=ms=>new Promise(r=>setTimeout(r,ms));
const read=n=>readFileSync('supabase/migrations/'+n,'utf8');
const V1=read('20261021070640_pos_pending_admin_resolutions.sql');
const V2=read('20261021081604_pos_resolution_corrections_inventory_review.sql');
const GUARD=read('20261021133856_pos_resolution_deduction_insert_guard.sql');
const RECHECK_REMOVAL=read('20261021174643_remove_pending_pos_auto_recheck.sql');
const RETIRE=read('20261021193000_retire_pos_admin_resolution_v1_v2.sql');
const PREFLIGHT=readFileSync('supabase/verification/20261021193000_retire_pos_admin_resolution_preflight.sql','utf8');
const POSTFLIGHT=readFileSync('supabase/verification/20261021193000_retire_pos_admin_resolution_postflight.sql','utf8');
const binDir=[process.env.QA_POSTGRES_BIN,'.qa-review/pos-tools/node_modules/@embedded-postgres/windows-x64/native/bin',
 '.tmp/production-preflight/node_modules/@embedded-postgres/windows-x64/native/bin'].filter(Boolean)
 .find(dir=>existsSync(resolve(dir,process.platform==='win32'?'postgres.exe':'postgres')));
const exe=name=>resolve(binDir,process.platform==='win32'?name+'.exe':name);
const q=async(db,sql,args=[])=>(await db.query(sql,args)).rows;
const lf=s=>s.replace(/\r\n?/g,'\n');
const sha=s=>createHash('sha256').update(s).digest('hex');
const RESTORED=['public.apply_sales_inventory_deduction_batch(bigint,text,jsonb)',
 'public.reprocess_modified_sales_inventory_deduction_receipt(bigint,text,timestamptz,text,text)',
 'public.rollback_canceled_sales_inventory_deduction_receipt(bigint,text,timestamptz,text)',
 'pos_sales_close_private.build_source(date)'];
// User-confirmed operating LF fingerprints of the pre-V2 engines (see payment-upgrade-inventory-fixture).
const OPERATING_LF={'public.reprocess_modified_sales_inventory_deduction_receipt(bigint,text,timestamptz,text,text)':'b10b5f8b4d51563570f05f3e30d96262738ef7490cdc71c9c49b0d882b4f19ba',
 'public.rollback_canceled_sales_inventory_deduction_receipt(bigint,text,timestamptz,text)':'63c86abd5d7e99a602db115bbf48e88b590e82cab2f538d9f448842feddd2648'};

// Everything an application could observe: schemas, columns, functions (LF body),
// owners/ACL/options, triggers, indexes, constraints and table ACLs.
async function catalog(db){
 const app="n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp%'";
 return {
  schemas:await q(db,`select nspname,nspacl::text acl from pg_namespace n where ${app} order by 1`),
  columns:await q(db,`select n.nspname,c.relname,a.attname,format_type(a.atttypid,a.atttypmod) type,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) def
   from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
   where ${app} and c.relkind in('r','p','v') and a.attnum>0 and not a.attisdropped order by 1,2,3`),
  relations:await q(db,`select n.nspname,c.relname,c.relkind,c.relacl::text acl,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where ${app} order by 1,2`),
  functions:(await q(db,`select p.oid::int oid,p.oid::regprocedure::text sig,pg_get_functiondef(p.oid) def,p.proowner::int owner,p.proacl::text acl,p.prosecdef,p.proconfig::text config
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where ${app} and p.prokind='f' order by 2`)).map(f=>({...f,def:sha(lf(f.def))})),
  triggers:await q(db,`select tgrelid::regclass::text rel,tgname,tgenabled,pg_get_triggerdef(t.oid) def from pg_trigger t where not tgisinternal order by 1,2`),
  indexes:await q(db,`select indexrelid::regclass::text idx,pg_get_indexdef(indexrelid) def from pg_index i join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace where ${app} order by 1`),
  constraints:await q(db,`select conrelid::regclass::text rel,conname,pg_get_constraintdef(oid) def from pg_constraint where conrelid<>0 order by 1,2`),
 };
}
const DATA_TABLES=['pos_sales_receipts','pos_sales_receipt_lines','pos_sales_receipt_payments','pos_sales_receipt_modifications',
 'pos_inventory_deduction_batches','pos_inventory_deduction_receipts','pos_inventory_deductions','inventory','inventory_logs',
 'pos_sales_business_day_closures','ledger_transactions','ledger_movements','users'];
async function data(db,{without=[]}={}){
 const out={};for(const t of DATA_TABLES)out[t]=(await q(db,`select to_jsonb(x)-$1::text[] r from ${t} x order by 1`,[without])).map(r=>r.r);return out;
}
const V2_COLUMNS=['admin_resolution_version','admin_resolution_financial_review_required','admin_resolution_retired','admin_resolution_content_fingerprint'];

// Teardown follows tests/helpers/native-postgres-lifecycle.mjs: stop with pg_ctl, prove the
// cluster is down, and delete only this run's identity-checked directory. Anything uncertain
// preserves the data directory and records why; no other process or directory is touched.
const OWNER_MARKER='.baba-retire-owner.json';
const bounded=(promise,ms,message)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),ms);})]).finally(()=>clearTimeout(timer));};
function noLinks(path){for(const e of readdirSync(path,{withFileTypes:true})){const f=join(path,e.name),s=lstatSync(f);if(s.isSymbolicLink())throw Error('Linked data is protected: '+f);if(s.isDirectory())noLinks(f);}}
async function liveChildren(pid){
 if(process.platform!=='win32')return 0;
 const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',
  `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid} AND Name='postgres.exe'").Count`],{windowsHide:true,timeout:20000});
 return Number(stdout.trim());
}
async function stopCluster({out,dir,identity,ownerText,server,serverClosed,serverLog,clients}){
 const steps=[];
 try{
  const ended=await bounded(Promise.allSettled(clients.map(c=>c.end())),5000,'Client closure timed out');
  if(ended.some(r=>r.status==='rejected'))throw Error('Client closure failed');
  steps.push('clients_closed');
  const pidFile=join(dir,'postmaster.pid');
  if(server.exitCode===null&&server.signalCode===null){
   // The live ChildProcess handle and the cluster's own PID file must agree before stopping.
   if(!existsSync(pidFile)||Number(readFileSync(pidFile,'utf8').split(/\r?\n/)[0])!==server.pid)throw Error('Cannot prove live server identity');
   try{await run(exe('pg_ctl'),['-D',dir,'-m','fast','-w','-t','10','stop'],{windowsHide:true,timeout:30000});}
   catch(e){server.kill();throw Error('pg_ctl stop failed: '+(e.stderr||e.message).trim());}
   steps.push('pg_ctl_stopped');
  }
  const exit=await bounded(serverClosed,10000,'Server close event missing');
  if(exit.code!==0||exit.signal)throw Error('Server did not exit normally: '+JSON.stringify(exit));
  steps.push('server_closed');
  if(existsSync(pidFile))throw Error('postmaster.pid still present');
  if(!serverLog().includes('database system is shut down'))throw Error('Normal shutdown evidence missing');
  const children=await liveChildren(server.pid);
  if(children!==0)throw Error(children+' PostgreSQL child process(es) still running');
  steps.push('no_children');
  // Only this run's directory: fixed parent, own name pattern, same inode, no links, own marker.
  const stat=lstatSync(dir,{bigint:true});
  if(dirname(dir)!==out||!/^pg-\d+$/.test(basename(dir))||stat.isSymbolicLink()||stat.ino!==identity.ino||realpathSync(dir)!==dir
   ||readFileSync(join(dir,OWNER_MARKER),'utf8')!==ownerText)throw Error('Data directory ownership not verified');
  noLinks(dir);
  await rm(dir,{recursive:true,maxRetries:5,retryDelay:200});
  steps.push('deleted');
  return {status:'deleted',dir,steps};
 }catch(e){return {status:existsSync(dir)?'preserved':'unknown',dir,steps,reason:e.message};}
}

test('POS admin-resolution V1/V2 retirement on native PostgreSQL',{skip:!binDir&&'no local PostgreSQL binaries (set QA_POSTGRES_BIN)',timeout:240000},async t=>{
 const out=resolve('.qa-review/pos-resolution-retire');await mkdir(out,{recursive:true});
 const dir=resolve(out,'pg-'+Date.now());
 await run(exe('initdb'),['-D',dir,'--encoding=UTF8','--locale=C','-U','postgres','-A','trust'],{windowsHide:true,timeout:60000});
 const ownerText=JSON.stringify({id:randomUUID(),dir,ownerPid:process.pid,createdAt:new Date().toISOString()});
 writeFileSync(join(dir,OWNER_MARKER),ownerText);const identity=lstatSync(dir,{bigint:true});
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const server=spawn(exe('postgres'),['-D',dir,'-h','127.0.0.1','-p',String(port),'-c','fsync=off'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let serverLog='';for(const stream of [server.stdout,server.stderr])stream.on('data',x=>{serverLog+=x;});
 const serverClosed=new Promise(r=>server.once('close',(code,signal)=>r({code,signal})));
 let subtestFailed=false;t.afterEach(c=>{if(!c.passed)subtestFailed=true;});
 const clients=[];let n=0;
 async function connection(database='postgres'){const c=new pg.Client({host:'127.0.0.1',port,user:'postgres',database,connectionTimeoutMillis:1000});await c.connect();clients.push(c);await c.query("set statement_timeout='20s';set lock_timeout='5s';set timezone='UTC'");return c;}
 // Pre-V1 operating state: close/ledger, receipts, the legacy stock engines (production
 // contract without processed_line_id), the updated_at trigger and a normal deduction.
 async function preV1(){
  const name='retire_'+(++n);await clients[0].query('create database '+name);const c=await connection(name);
  const db={exec:s=>c.query(s),query:(...a)=>c.query(...a)};
  await initializePosCloseDatabase({...db,exec:s=>db.exec(s.replace('create role anon; create role authenticated; create role service_role;',''))});
  await db.exec(read('20260912160056_add_pos_business_day_close_checks.sql'));
  await initializeResolutionSchema(db,{migration:'select 1'});
  await initializeWork(db,{migration:'select 1',beforeMigration:async db=>{await reproduceOperatingInventoryContract(db);
   await db.exec("create function set_pos_sales_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now();return new;end$$;create trigger trg_pos_sales_receipts_updated_at before update on pos_sales_receipts for each row execute function set_pos_sales_updated_at()");}});
  await db.exec("insert into inventory(id,quantity,item_name,unit) values(1,100,'Stock','unit');insert into pos_item_mappings values(1,'TEST','direct',true,1,1,1,false)");
  await db.exec("insert into pos_sales_receipts(id,ref_id,ref_no,business_date,ref_date,payment_status,is_canceled,final_amount,revision,updated_at) values(10,'ref-10','10','2026-10-17',now()-interval '2 hours',3,false,100000,0,now());insert into pos_sales_receipt_lines(receipt_id,receipt_ref_id,item_code,item_name,quantity,unit_price,payment_status,is_canceled,raw_json) values(10,'ref-10','TEST','Item',1,100000,3,false,'{}');insert into pos_sales_receipt_payments(id,receipt_id,business_date,payment_type,payment_name,amount) values(10,10,'2026-10-17',1,'tiền mặt',100000)");
  return {db,c,name};
 }
 // Reproduce the applied production history: V1, V2, insert guard, then (optionally) the
 // queue removal that production already reflects without a history row.
 async function applyV1V2(db,{recheckRemoved=true}={}){
  await db.exec(V1);await db.exec(V2);await db.exec(GUARD);if(recheckRemoved)await db.exec(RECHECK_REMOVAL);
 }
 async function source(db,date){return (await q(db,'select pos_sales_close_private.build_source($1) r',[date]))[0].r;}
 async function close(db,date){const s=await source(db,date);return (await q(db,"select sales_close_business_day_v1($1,$2,$3::jsonb,$4::jsonb,1,'manual',false,null) r",[date,s.sourceFingerprint,JSON.stringify(s.sourceSnapshot),JSON.stringify(s.rows)]))[0].r;}
 async function candidate(db,id){
  const r=(await q(db,'select to_jsonb(r) r from pos_sales_receipts r where id=$1',[id]))[0].r,line=(await q(db,'select id from pos_sales_receipt_lines where receipt_id=$1',[id]))[0];
  const b=(await q(db,"insert into pos_inventory_deduction_batches(flow_version,business_date_from,business_date_to,source,status,receipt_count,ready_receipt_count,created_by) values('sales_db_v1',$1,$1,'manual_preview','previewed',1,1,'owner') returning id",[r.business_date]))[0].id;
  const br=(await q(db,"insert into pos_inventory_deduction_receipts(batch_id,receipt_id,business_date,status,inventory_affecting_hash,amount_hash,previewed_receipt_updated_at,selected_for_apply,workflow_type,line_summary) values($1,$2,$3,'ready','initial-hash','amount-hash',$4,true,'initial_apply','{\"hashVersion\":2}') returning id",[b,id,r.business_date,r.updated_at]))[0].id;
  await db.query("insert into pos_inventory_deductions(receipt_id,invoice_ref_id,batch_id,batch_receipt_id,receipt_line_id,ref_detail_id,pos_item_code,pos_item_name,mapping_id,mapping_type,inventory_item_id,operation_type,status,flow_version,business_date,mapping_snapshot,inventory_affecting_hash,amount_hash,idempotency_key,quantity_sold,deduct_quantity_per_unit,deduct_quantity_total,deduct_quantity) values($1,$2,$3,$4,$5,'detail','TEST','Item',1,'direct',1,'preview','selected','sales_db_v1',$6,'{\"mappingVersion\":1}','initial-hash','amount-hash',$7,1,1,1,1)",[id,r.ref_id,b,br,line.id,r.business_date,randomUUID()]);
  return {b,validation:JSON.stringify([{receiptId:id,currentInventoryHash:'initial-hash',currentReceiptUpdatedAt:r.updated_at,applyAllowed:true}])};
 }
 // A rejected retire must leave the database exactly as it was (single transaction).
 async function rejects(db,pattern){const before={catalog:await catalog(db),data:await data(db)};await assert.rejects(db.exec(RETIRE),pattern);await db.exec('rollback');assert.deepEqual(await catalog(db),before.catalog);assert.deepEqual(await data(db),before.data);}
 const report={};let bodyError;
 try{
  for(let i=0;i<150&&!clients.length;i++){try{await connection();}catch{await wait(100);}}
  assert.ok(clients.length,'local PostgreSQL did not start');
  await clients[0].query('create role anon;create role authenticated;create role service_role');

  await t.test('schema, functions, ACL and data return to the pre-V1 operating state',async()=>{
   const {db}=await preV1();
   await db.exec("create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key,name text)");
   const beforeCatalog=await catalog(db),beforeData=await data(db),beforeSource=await source(db,'2026-08-20');
   await applyV1V2(db);
   const midData=await data(db,{without:V2_COLUMNS});
   // The read-only SQL Editor checks shipped for production, run against this schema.
   const [records,inserts,footprint,identity,counts]=(await db.query(PREFLIGHT)).map(r=>r.rows);
   assert.ok(records.length===11&&records.every(r=>Number(r.rows)===r.expected),JSON.stringify(records));
   for(const r of inserts)assert.ok(r.signature.includes('build_source')?r.source_guard===1&&r.retired_filters>=2&&r.engine_guard===0:r.engine_guard===1&&r.source_guard===0,JSON.stringify(r));
   assert.ok(footprint.every(r=>r.present===r.expected),JSON.stringify(footprint));
   await db.exec(RETIRE);
   const [gone,restored,,postCounts,closures]=(await db.query(POSTFLIGHT)).map(r=>r.rows);
   assert.ok(gone.every(r=>r.present===false),JSON.stringify(gone));
   const withoutHashes=r=>Object.fromEntries(Object.entries(r).filter(([key])=>!key.endsWith('lf_sha256')));
   assert.deepEqual(restored.map(withoutHashes),identity);
   for(const r of restored)if(!r.expected_lf_sha256.startsWith('('))assert.equal(r.lf_sha256,r.expected_lf_sha256,r.signature);
   assert.deepEqual(postCounts,counts);assert.ok(closures.every(r=>r.source_matches!==false));
   const afterCatalog=await catalog(db);
   for(const key of Object.keys(beforeCatalog))assert.deepEqual(afterCatalog[key],beforeCatalog[key],key);
   assert.deepEqual(await data(db),beforeData,'retire must not change any row');
   assert.deepEqual(await data(db),midData,'retire must not change any row');
   assert.deepEqual(await source(db,'2026-08-20'),beforeSource,'close source/fingerprint unchanged');
   for(const sig of RESTORED){const oid=(await q(db,'select to_regprocedure($1)::oid::int o',[sig]))[0].o;assert.ok(oid,sig);
    assert.equal(afterCatalog.functions.find(f=>f.oid===oid)?.def,beforeCatalog.functions.find(f=>f.oid===oid)?.def,'same OID and body: '+sig);}
   for(const [sig,expected] of Object.entries(OPERATING_LF)){const d=(await q(db,'select pg_get_functiondef($1::regprocedure) d',[sig]))[0].d;assert.equal(sha(lf(d)),expected,sig);}
   report.catalogAndData='identical to pre-V1';
  });

  await t.test('restored operating flows: close, initial deduction apply (single effect), unlinked history insert',async()=>{
   const {db,name}=await preV1();await applyV1V2(db);await db.exec(RETIRE);
   assert.equal((await close(db,'2026-08-20')).status,'closed');
   const p=await candidate(db,10),other=await connection(name);
   const invoke=c=>q(c,"select apply_sales_inventory_deduction_batch($1,'owner',$2::jsonb) r",[p.b,p.validation]);
   const results=await Promise.allSettled([invoke(db),invoke({query:(...a)=>other.query(...a)})]);
   assert.equal(results.filter(r=>r.status==='fulfilled').length>=1,true,JSON.stringify(results.map(r=>r.status==='rejected'?r.reason.message:r.value)));
   assert.equal(Number((await q(db,'select quantity from inventory where id=1'))[0].quantity),99);
   assert.equal((await q(db,'select count(*)::int n from inventory_logs'))[0].n,1);
   await db.exec("insert into pos_inventory_deductions(receipt_id,operation_type,status) values(10,'preview','selected')");
   assert.equal((await close(db,'2026-10-17')).status,'closed');
   report.operatingFlows=true;
  });

  await t.test('works when the queue removal was never applied, and never re-creates the queue',async()=>{
   const {db}=await preV1();const before=await catalog(db);await applyV1V2(db,{recheckRemoved:false});
   assert.ok((await q(db,"select to_regclass('pos_resolution_private.recheck_jobs') r"))[0].r);
   await db.exec(RETIRE);const after=await catalog(db);
   for(const key of Object.keys(before))assert.deepEqual(after[key],before[key],key);
   assert.equal((await q(db,"select to_regprocedure('sales_claim_pending_rechecks_v1()') r"))[0].r,null);
   report.withoutRecheckRemoval=true;
  });

  await t.test('fails closed without changes: recorded work, non-default columns, held receipt, tampered engine, rerun',async()=>{
   const {db}=await preV1();await applyV1V2(db);
   await db.exec("insert into pos_sales_receipt_pos_observations(receipt_id,observation_key,observed_at,origin,raw_payload,reconciliation) values(10,'qa',now(),'refresh','{}','pending')");
   await rejects(db,/RETIRE_POS_RESOLUTION_NONEMPTY/);
   await db.exec('alter table pos_sales_receipt_pos_observations disable trigger pos_resolution_observation_immutable;delete from pos_sales_receipt_pos_observations;alter table pos_sales_receipt_pos_observations enable trigger pos_resolution_observation_immutable');
   await db.exec('alter table pos_sales_receipts disable trigger pos_resolution_receipt_guard;update pos_sales_receipts set admin_resolution_version=1 where id=10');
   await rejects(db,/RETIRE_POS_RESOLUTION_NONDEFAULT_STATE/);
   await db.exec("update pos_sales_receipts set admin_resolution_version=0,inventory_deduction_processing_error='admin_resolution_inventory_review_required' where id=10");
   await rejects(db,/RETIRE_POS_RESOLUTION_NONDEFAULT_STATE/);
   await db.exec('update pos_sales_receipts set inventory_deduction_processing_error=null where id=10;alter table pos_sales_receipts enable trigger pos_resolution_receipt_guard');
   await db.exec("update pos_sales_receipt_payments set admin_resolution_retired=true where id=10");
   await rejects(db,/RETIRE_POS_RESOLUTION_NONDEFAULT_STATE/);
   await db.exec("update pos_sales_receipt_payments set admin_resolution_retired=false where id=10");
   // A live engine definition that no longer matches the V2 contract is not rewritten.
   const d=(await q(db,"select pg_get_functiondef('rollback_canceled_sales_inventory_deduction_receipt(bigint,text,timestamptz,text)'::regprocedure) d"))[0].d;
   await db.exec(d.replace("raise exception 'POS_RESOLUTION_INVENTORY_APPROVAL_REQUIRED'","raise exception 'POS_RESOLUTION_INVENTORY_APPROVAL_REQUIRED_X'"));
   await rejects(db,/RETIRE_POS_RESOLUTION_ENGINE_CONTRACT_MISMATCH/);
   await db.exec(d);
   await db.exec(RETIRE);
   await rejects(db,/RETIRE_POS_RESOLUTION_STATE_MISMATCH/);
   report.failClosed=true;
  });

  await t.test('a non-empty legacy queue is not discarded',async()=>{
   const {db}=await preV1();await applyV1V2(db,{recheckRemoved:false});
   await db.exec('insert into pos_resolution_private.recheck_jobs(receipt_id) values(10)');
   await rejects(db,/RETIRE_POS_RESOLUTION_NONEMPTY/);
  });
 }catch(e){bodyError=e;throw e;}finally{
  console.log('[POS_RESOLUTION_RETIRE_REPORT]',JSON.stringify(report));
  const cleanup=await stopCluster({out,dir,identity,ownerText,server,serverClosed,serverLog:()=>serverLog,clients:clients.reverse()});
  const logDir=join(out,'logs');await mkdir(logDir,{recursive:true});
  writeFileSync(join(logDir,basename(dir)+'.json'),JSON.stringify({...cleanup,checkedAt:new Date().toISOString(),
   testFailed:Boolean(bodyError)||subtestFailed,serverLogTail:cleanup.status==='deleted'?undefined:serverLog.slice(-4000)},null,2));
  console.log('[POS_RESOLUTION_RETIRE_CLEANUP]',JSON.stringify(cleanup));
  if(cleanup.status!=='deleted'){
   t.diagnostic('PostgreSQL data preserved: '+dir+'; '+cleanup.reason);
   // Never replace an existing test failure with a teardown failure.
   if(!bodyError&&!subtestFailed)throw Error('PostgreSQL cleanup incomplete: '+cleanup.reason+' ('+dir+')');
  }
 }
});
