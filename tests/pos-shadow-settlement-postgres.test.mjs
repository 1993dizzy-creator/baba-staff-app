import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import {readFileSync} from 'node:fs';
import {nativeInventoryPostgres} from './helpers/inventory-native-postgres.mjs';
import {initializeShadow,seedReceipt,rows as q,readMigration,capture,claim,register,operatingSnapshot} from './helpers/pos-shadow-fixture.mjs';
const engine='20261102103822_pos_shadow_temporal_settlement.sql';
const baseTime='2026-10-08T00:00:00Z';
const settle=async(db,c)=>(await q(db,"select pos_shadow_settle($1,$2,'owner') r",[c.jobId,c.token]))[0].r;
const drain=async db=>settle(db,await claim(db));
const compare=async(db,item=1)=>(await q(db,"select pos_shadow_compare_item($1,'owner') r",[item]))[0].r;
async function legacyInitial(db,quantity=0.0714){
 await db.exec('update inventory set quantity=0.10 where id=1');
 const r=(await q(db,'select to_jsonb(r) r from pos_sales_receipts r where id=10'))[0].r;
 const line=(await q(db,'select id from pos_sales_receipt_lines where receipt_id=10'))[0].id;
 const b=(await q(db,"insert into pos_inventory_deduction_batches(flow_version,source,status,receipt_count,ready_receipt_count) values('sales_db_v1','manual_preview','previewed',1,1) returning id"))[0].id;
 const br=(await q(db,"insert into pos_inventory_deduction_receipts(batch_id,receipt_id,status,inventory_affecting_hash,amount_hash,previewed_receipt_updated_at,selected_for_apply,workflow_type,receipt_content_fingerprint,line_summary) values($1,10,'ready','old-hash','amount',$2,true,'initial_apply','old','{\"hashVersion\":2}') returning id",[b,r.updated_at]))[0].id;
 await db.query("insert into pos_inventory_deductions(receipt_id,invoice_ref_id,batch_id,batch_receipt_id,receipt_line_id,pos_item_code,pos_item_name,mapping_id,mapping_type,inventory_item_id,operation_type,status,flow_version,business_date,mapping_snapshot,inventory_affecting_hash,amount_hash,idempotency_key,quantity_sold,deduct_quantity_per_unit,deduct_quantity_total,deduct_quantity) values(10,'ref-10',$1,$2,$3,'TEST','Synthetic Glenfiddich 15',1,'direct',1,'preview','selected','sales_db_v1','2026-10-09','{\"mappingVersion\":1}','old-hash','amount','synthetic-old',1,$4,$4,$4)",[b,br,line,quantity]);
 const result=(await q(db,"select apply_sales_inventory_deduction_batch($1,'owner',$2) r",[b,JSON.stringify([{receiptId:10,currentInventoryHash:'old-hash',currentReceiptUpdatedAt:r.updated_at,applyAllowed:true}])]))[0].r;
 assert.equal(result.ok,true);return {r,line};
}

test('POS temporal shadow settlement',{timeout:120000},async t=>{
 const rt=await nativeInventoryPostgres({testContext:t});
 const setup=async()=>{
  const db=new rt.Database();await initializeShadow(db);
  const catalog=()=>q(db,"select oid::int,proowner::int,proacl::text,proconfig::text,prosrc from pg_proc where proname in ('apply_sales_inventory_deduction_batch','reprocess_modified_sales_inventory_deduction_receipt','rollback_canceled_sales_inventory_deduction_receipt','guard_pos_inventory_stock_check_boundary') order by oid");
  const before=await catalog();await db.exec(readMigration(engine));assert.deepEqual(await catalog(),before);
  return db;
 };
 await t.test('Glenfiddich Oct 9 correction -> Oct 11 count -> Oct 12 delivery -> delayed settlement',async()=>{
  const db=await setup(),old=await legacyInitial(db);
  await db.exec('update inventory set quantity=0.20 where id=1');await register(db,{quantity:0.20});
  await db.exec('update inventory set quantity=quantity+1 where id=1');await register(db,{kind:'purchase',quantity:1,time:'2026-10-12T12:00:00Z'});
  const before=await operatingSnapshot(db),observation=await capture(db),job=await claim(db),result=await settle(db,job);
  assert.equal(result.result,'shadow_settled');assert.equal(result.kind,'correction');assert.equal(result.legacyDecision,'stock_check_boundary_requires_review');
  assert.equal(result.items[0].economicDelta,-0.9286);assert.equal(result.items[0].currentStockDelta,0);
  assert.equal(result.items[0].bookQuantity,1.2);assert.equal(result.items[0].shortage,0);
  assert.equal(result.items[0].legacyRawAfter,0.2714);
  for(let i=0;i<55;i++){assert.deepEqual(await capture(db),observation);assert.deepEqual(await settle(db,job),result);}
  assert.equal((await q(db,'select count(*)::int n from pos_inventory_shadow.settlements'))[0].n,1);
  assert.equal((await q(db,'select count(*)::int n from pos_inventory_shadow.attempts'))[0].n,1);
  assert.deepEqual(await operatingSnapshot(db),before);
  // Compare against the actual existing P1 engine, inside an explicit rollback.
  await db.exec('begin');
  const actual=(await q(db,"select prepare_and_apply_sales_inventory_reprocess(10,'owner',$1,'new-version','new-hash',$2,$3) r",[old.r.updated_at,{amount_hash:'amount',line_summary:{hashVersion:2}},JSON.stringify([{invoice_ref_id:'ref-10',receipt_line_id:old.line,pos_item_code:'TEST',pos_item_name:'Synthetic Glenfiddich',mapping_id:1,mapping_type:'direct',inventory_item_id:1,deduct_quantity:1,deduct_quantity_total:1,deduct_quantity_per_unit:1,quantity_sold:1,mapping_snapshot:{mappingVersion:1}}])]))[0].r;
  assert.equal(actual.failureReason,result.legacyDecision);await db.exec('rollback');
  assert.deepEqual(await operatingSnapshot(db),before);
  t.diagnostic('Glenfiddich: legacy raw -0.9286, raw stock 0.2714, P0 review; shadow current delta 0, book 1.20, economic -0.9286, audit diff 0');
 });
 await t.test('after-count correction uses delta; cancel is financial only; physical return is separate',async()=>{
  const db=await setup();await register(db,{quantity:5,time:baseTime});
  await capture(db);let r=await drain(db);assert.equal(r.items[0].currentStockDelta,-1);assert.equal(r.items[0].bookQuantity,4);
  await capture(db,{key:'edit',seq:2,quantity:2});r=await drain(db);assert.equal(r.items[0].currentStockDelta,-1);assert.equal(r.items[0].bookQuantity,3);
  await db.exec('update pos_sales_receipts set is_canceled=true where id=10');
  await capture(db,{key:'cancel',seq:3,quantity:2});r=await drain(db);
  assert.equal(r.kind,'cancel');assert.equal(r.items[0].economicDelta,2);assert.equal(r.items[0].currentStockDelta,0);assert.equal(r.items[0].bookQuantity,3);
  await register(db,{kind:'physical_return',quantity:2,time:'2026-10-12T00:00:00Z'});
  const before=await operatingSnapshot(db);r=await compare(db);assert.equal(r.bookQuantity,5);assert.equal(r.consumption,2);assert.equal(r.physicalMovement,2);
  assert.deepEqual(await operatingSnapshot(db),before);
 });
 await t.test('negative book settles immediately, later purchase resolves shortage without replaying sale',async()=>{
  const db=await setup();await register(db,{quantity:0.03,time:baseTime});await capture(db);
  const c=await claim(db),r=await settle(db,c);assert.equal(r.result,'shadow_settled');assert.equal(r.items[0].bookQuantity,-0.97);assert.equal(r.items[0].shortage,0.97);
  assert.equal(r.items[0].available,0);assert.equal((await claim(db)).result,'empty');
  await register(db,{kind:'purchase',quantity:2,time:'2026-10-12T00:00:00Z'});
  const before=await operatingSnapshot(db),after=await compare(db);assert.equal(after.bookQuantity,1.03);assert.equal(after.shortage,0);
  assert.deepEqual(await settle(db,c),r);assert.equal((await q(db,'select count(*)::int n from pos_inventory_shadow.settlements'))[0].n,1);
  assert.deepEqual(await operatingSnapshot(db),before);
 });
 await t.test('late recorded purchase before count and exact-boundary sales are absorbed',async()=>{
  const db=await setup();await register(db,{quantity:8});
  await register(db,{kind:'purchase',quantity:3,time:'2026-10-10T00:00:00Z',recordedAt:'2026-10-12T00:00:00Z'});
  await capture(db,{time:'2026-10-11T04:12:18Z'});const before=await operatingSnapshot(db),r=await drain(db);
  assert.equal(r.items[0].currentStockDelta,0);assert.equal(r.items[0].bookQuantity,8);assert.equal(r.items[0].physicalMovement,0);
  assert.deepEqual(await operatingSnapshot(db),before);
 });
 await t.test('unknown timing is preserved, new evidence retries the same version',async()=>{
  const db=await setup();await register(db,{quantity:5,time:baseTime});
  const v=await capture(db,{time:null});assert.equal(v.reason,'physical_time_unknown');assert.equal((await claim(db)).result,'empty');
  const before=await q(db,'select to_jsonb(v) v from pos_inventory_shadow.versions v');
  await q(db,"select pos_shadow_resolve_timing($1,$2,$3,'owner')",[v.versionId,{'line-1':'2026-10-09T13:01:00Z'},{proof:'synthetic source recovered',timeBasis:'physical_event'}]);
  assert.equal((await q(db,"select pos_shadow_retry($1,'owner') r",[v.jobId]))[0].r.result,'queued');
  assert.equal((await drain(db)).result,'shadow_settled');
  assert.deepEqual(await q(db,'select to_jsonb(v) v from pos_inventory_shadow.versions v'),before);
  assert.equal((await q(db,'select count(*)::int n from pos_inventory_shadow.plans'))[0].n,2);
 });
 await t.test('item change uses each item boundary, and pending versions do not claim full coverage',async()=>{
  const db=await setup();await register(db,{quantity:10});await register(db,{item:2,quantity:20,time:baseTime});
  await capture(db,{saleSnapshot:{sku:'A',quantity:1}});
  await capture(db,{key:'item-change',seq:2,saleSnapshot:{sku:'B',quantity:1},effects:[{effectKey:'line-1',itemId:2,quantity:1,effectiveAt:'2026-10-09T13:01:00Z'}]});
  const a=await drain(db);assert.equal(a.items[0].projectionComplete,false);
  const b=await drain(db);assert.equal(b.items.find(x=>x.itemId===1).currentStockDelta,0);
  assert.equal(b.items.find(x=>x.itemId===2).currentStockDelta,-1);
  assert.equal((await compare(db,1)).bookQuantity,10);assert.equal((await compare(db,2)).bookQuantity,19);
 });
 await t.test('unverified count blocks guessing; dependency evidence recovers without new sale version',async()=>{
  const db=await setup();await register(db,{quantity:10,time:baseTime});
  const id=(await q(db,"insert into inventory_logs(item_id,reason,source,new_quantity,change_quantity,created_at) values(1,'stock_check','edit_form',7,0,'2026-10-11T00:00:00Z') returning id"))[0].id;
  const v=await capture(db),first=await drain(db);assert.equal(first.reason,'unverified_stock_check');
  for(let i=0;i<3;i++)assert.equal((await q(db,"select pos_shadow_retry($1,'owner') r",[v.jobId]))[0].r.result,'waiting_for_dependency_change');
  await seedReceipt(db,11);await register(db,{item:2,quantity:20,time:baseTime});
  await capture(db,{receipt:11,key:'unrelated',effects:[{effectKey:'other',itemId:2,quantity:1,effectiveAt:'2026-10-09T13:01:00Z'}]});
  await drain(db);assert.equal((await q(db,"select pos_shadow_retry($1,'owner') r",[v.jobId]))[0].r.result,'waiting_for_dependency_change');
  await q(db,"select pos_shadow_register_movement($1,'count','2026-10-11T00:00:00Z',$2,'owner')",[id,{proof:'synthetic measured count',coverageComplete:true}]);
  assert.equal((await q(db,"select pos_shadow_retry($1,'owner') r",[v.jobId]))[0].r.result,'queued');
  const healed=await drain(db);assert.equal(healed.result,'shadow_settled');assert.equal(healed.items[0].bookQuantity,7);
  assert.deepEqual((await q(db,'select e.outcome from pos_inventory_shadow.attempt_events e join pos_inventory_shadow.attempts a on a.id=e.attempt_id where a.job_id=$1 order by e.id',[v.jobId])).map(x=>x.outcome),['needs_review','completed']);
  assert.equal((await q(db,'select count(*)::int n from pos_inventory_shadow.versions v join pos_inventory_shadow.streams s on s.id=v.stream_id where s.receipt_id=10'))[0].n,1);
 });
 async function waiting(observer,pid){
  for(let i=0;i<100;i++){
   if((await q(observer,'select wait_event_type from pg_stat_activity where pid=$1',[pid]))[0]?.wait_event_type==='Lock')return;
   await new Promise(r=>setTimeout(r,20));
  }assert.fail('Expected a real inventory row lock wait');
 }
 await t.test('count commits before waiting worker: worker reads new boundary after lock',async()=>{
  const db=await setup();await register(db,{quantity:10,time:baseTime});await capture(db);const c=await claim(db);
  const worker=await rt.connect(db.name),observer=await rt.connect(db.name),pid=(await q(worker,'select pg_backend_pid() pid'))[0].pid;
  await db.exec('begin');await db.exec('update inventory set quantity=7 where id=1');await register(db,{quantity:7});
  const pending=settle(worker,c);await waiting(observer,pid);await db.exec('commit');const r=await pending;
  assert.equal(r.items[0].currentStockDelta,0);assert.equal(r.items[0].bookQuantity,7);
 });
 await t.test('worker commits before count: refreshed book supersedes earlier shadow delta',async()=>{
  const db=await setup();await register(db,{quantity:10,time:baseTime});await capture(db);const c=await claim(db);
  const counter=await rt.connect(db.name),observer=await rt.connect(db.name),pid=(await q(counter,'select pg_backend_pid() pid'))[0].pid;
  await db.exec('begin');assert.equal((await settle(db,c)).items[0].currentStockDelta,-1);
  const pending=(async()=>{await counter.query('begin');await counter.query('update inventory set quantity=7 where id=1');await register(counter,{quantity:7});await counter.query('commit');})();
  await waiting(observer,pid);await db.exec('commit');await pending;
  assert.equal((await compare(db)).bookQuantity,7);
 });
 await t.test('SQL rollback plus backoff retries, expired worker cannot finish, immutable final audit',async()=>{
  const db=await setup();await register(db,{quantity:10,time:baseTime});await capture(db);const first=await claim(db);
  await db.query('update pos_inventory_shadow.jobs set lease_until=clock_timestamp()-interval \'1 second\' where id=$1',[first.jobId]);
  const c=await claim(db);assert.equal((await settle(db,first)).result,'lease_lost');
  await db.exec("create function synthetic_shadow_error() returns trigger language plpgsql as $$begin raise exception using errcode='55P03',message='synthetic retryable fault';end;$$;create trigger synthetic_shadow_error before insert on pos_inventory_shadow.item_effects for each row execute function synthetic_shadow_error()");
  const before=await operatingSnapshot(db);await assert.rejects(settle(db,c),e=>e.code==='55P03');
  assert.equal((await q(db,'select count(*)::int n from pos_inventory_shadow.settlements'))[0].n,0);
  assert.deepEqual(await operatingSnapshot(db),before);
  assert.equal((await q(db,"select pos_shadow_fail($1,$2,'55P03','owner') r",[c.jobId,c.token]))[0].r.result,'retry_wait');
  assert.equal((await claim(db)).result,'empty');
  await db.exec('drop trigger synthetic_shadow_error on pos_inventory_shadow.item_effects;update pos_inventory_shadow.jobs set next_run_at=clock_timestamp()');
  const next=await claim(db),r=await settle(db,next);assert.equal(r.result,'shadow_settled');assert.deepEqual(await settle(db,next),r);
  await assert.rejects(db.exec('update pos_inventory_shadow.settlements set result=\'{}\''),/POS_SHADOW_IMMUTABLE/);
  assert.deepEqual((await q(db,'select outcome from pos_inventory_shadow.attempt_events order by id')).map(x=>x.outcome),['lease_expired','retry_wait','completed']);
 });
 await t.test('strong isolation is rejected; snapshot comparisons are deduplicated; source coverage is explicit',async()=>{
  const db=await setup();const anchor=await register(db,{quantity:10,time:baseTime,coverage:false});await capture(db);await drain(db);
  let r=await compare(db);assert.equal(r.projectionComplete,false);assert.equal(r.coverageReason,'coverage_not_attested');
  await q(db,"select pos_shadow_confirm_coverage($1,$2,'owner')",[anchor.id,{proof:'synthetic feed completeness checked'}]);
  r=await compare(db);assert.equal(r.projectionComplete,true);for(let i=0;i<10;i++)assert.deepEqual(await compare(db),r);
  assert.equal((await q(db,'select count(*)::int n from pos_inventory_shadow.comparisons'))[0].n,2);
  await db.exec('begin isolation level repeatable read');await assert.rejects(compare(db),/POS_SHADOW_REQUIRES_READ_COMMITTED/);await db.exec('rollback');
 });
 await t.test('a physical addition spanning the count requires split events, not retiming the whole line',async()=>{
  const db=await setup();await register(db,{quantity:10});await capture(db);await drain(db);
  const v=await capture(db,{key:'physical-addition',seq:2,quantity:2,time:'2026-10-12T00:00:00Z',evidence:{timeBasis:'physical_event',proof:'synthetic new serving'}});
  assert.equal(v.reason,'physical_change_needs_split_events');assert.equal((await claim(db)).result,'empty');
  const targets=[{effectKey:'old-serving',itemId:1,quantity:1,effectiveAt:'2026-10-09T13:01:00Z'},
   {effectKey:'new-serving',itemId:1,quantity:1,effectiveAt:'2026-10-12T00:00:00Z'}];
  await assert.rejects(q(db,"select pos_shadow_resolve_physical_plan($1,$2,$3,'owner')",[v.versionId,JSON.stringify([targets[0]]),{proof:'synthetic'}]),/POS_SHADOW_INVALID_PHYSICAL_PLAN/);
  await q(db,"select pos_shadow_resolve_physical_plan($1,$2,$3,'owner')",[v.versionId,JSON.stringify(targets),{proof:'synthetic separate old and new serving records'}]);
  await q(db,"select pos_shadow_retry($1,'owner')",[v.jobId]);const r=await drain(db);
  assert.equal(r.items[0].currentStockDelta,-1);assert.equal(r.items[0].bookQuantity,9);
 });
 await t.test('server adapter + two workers -> DB: 55 captures, one settlement, stale line fence',async()=>{
  const db=await setup();await db.exec("update pos_sales_receipt_lines set ref_detail_id='detail-1' where receipt_id=10");
  await register(db,{quantity:0.03,time:baseTime});const before=await operatingSnapshot(db);let mutatePreview=false;
  const m={exports:{}};
  const deps={
   'server-only':{},'node:crypto':{randomUUID:()=> 'synthetic-worker'},
   '@/lib/supabase/server':{supabaseServer:{rpc:async(name,args)=>{
    const keys=Object.keys(args),params=keys.map((k,i)=>k+' => $'+(i+1)).join(',');
    const values=keys.map(k=>args[k]!==null&&typeof args[k]==='object'?JSON.stringify(args[k]):args[k]);
    try{return {data:(await q(db,'select public.'+name+'('+params+') r',values))[0].r,error:null};}
    catch(e){return {data:null,error:{code:e.code,message:'synthetic sanitized failure'}};}
   }}},
   '@/lib/sales/inventory-deduction-preview':{buildInventoryDeductionPreview:async()=>{
    const r=(await q(db,'select to_jsonb(r) r from pos_sales_receipts r where id=10'))[0].r;
    if(mutatePreview)await db.exec('update pos_sales_receipt_lines set quantity=2 where receipt_id=10');
    return {receipts:[{receiptId:10,previewedReceiptUpdatedAt:r.updated_at,lines:[{refDetailId:'detail-1',lineType:'direct',blocksReceipt:false,mappingSnapshot:{mappingVersion:1},deductions:[{inventoryItemId:1,recipeId:null,recipeVersion:null,deductQuantity:1,deductQuantityPerUnit:1}]}]}]};
   }},
  };
  const compiled=ts.transpileModule(readFileSync('lib/sales/inventory-shadow.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},reportDiagnostics:true});assert.deepEqual(compiled.diagnostics,[]);
  new Function('require','module','exports',compiled.outputText)(name=>{assert.ok(name in deps,name);return deps[name];},m,m.exports);
  const input={receiptId:10,observationKey:'upstream-1',sourceSequence:1,sourceComplete:true,effectiveAt:'2026-10-09T13:01:00Z',timeBasis:'historical_correction',proof:'synthetic closed source observation'};
  for(let i=0;i<55;i++)assert.equal((await m.exports.captureInventoryShadow(input,'owner')).result,'queued');
  const outputs=await Promise.all([m.exports.runInventoryShadow('owner',5,'cron-a'),m.exports.runInventoryShadow('owner',5,'cron-b')]);
  assert.equal(outputs.flatMap(x=>x.results).length,1);
  assert.equal(outputs.flatMap(x=>x.results)[0].items[0].bookQuantity,-0.97);
  const jobId=(await q(db,'select id from pos_inventory_shadow.jobs'))[0].id;
  const status=await m.exports.inventoryShadowAction('status',{jobId},'owner');assert.equal(status.state,'completed');
  assert.equal(status.attempts[0].outcome,'completed');assert.equal(status.result.result,'shadow_settled');assert.doesNotMatch(JSON.stringify(status),/lease_token/);
  assert.deepEqual(await operatingSnapshot(db),before);
  assert.equal((await q(db,'select count(*)::int n from pos_inventory_shadow.versions'))[0].n,1);
  mutatePreview=true;assert.equal((await m.exports.captureInventoryShadow({...input,observationKey:'changed',sourceSequence:2},'owner')).result,'stale_observation');
  const stale=(await q(db,"select pos_shadow_read_receipt(10,'owner') r"))[0].r;
  await db.exec('update pos_sales_receipt_lines set quantity=3 where receipt_id=10');
  const fenced=(await q(db,"select pos_shadow_capture_version(10,$1,'stale-lines',3,$2,$3,$4,'owner') r",[stale.updatedAt,stale.snapshot,JSON.stringify([{effectKey:'detail',itemId:1,quantity:2,effectiveAt:'2026-10-09T13:01:00Z'}]),{snapshotKey:stale.snapshotKey,proof:'synthetic',timeBasis:'historical_correction'}]))[0].r;
  assert.equal(fenced.result,'stale_observation');assert.equal(fenced.reason,'sale_lines_changed');
 });
 await t.test('high precision A -> B -> A versions settle independently of legacy success fingerprint',async()=>{
  const db=await setup();await register(db,{quantity:5,time:baseTime});
  for(const [key,seq,quantity] of [['A',1,0.0714],['B',2,0.1428],['A-again',3,0.0714]]){
   await capture(db,{key,seq,quantity});assert.equal((await drain(db)).result,'shadow_settled');
  }
  const r=await compare(db);assert.equal(r.bookQuantity,4.9286);
  assert.deepEqual((await q(db,'select current_stock_delta::text d from pos_inventory_shadow.item_effects order by id')).map(x=>Number(x.d)),[-0.0714,-0.0714,0.0714]);
  assert.equal((await q(db,'select count(*)::int n from pos_inventory_shadow.settlements'))[0].n,3);
 });
 await t.test('all shadow tables have RLS and service-only RPCs, private audit is inaccessible',async()=>{
  const db=await setup();
  const acl=await q(db,"select has_function_privilege('anon',oid,'execute') a,has_function_privilege('authenticated',oid,'execute') u,has_function_privilege('service_role',oid,'execute') s from pg_proc where proname like 'pos_shadow_%'");
  for(const x of acl)assert.deepEqual(x,{a:false,u:false,s:true});
  const tables=await q(db,"select relrowsecurity r from pg_class where relnamespace='pos_inventory_shadow'::regnamespace and relkind='r'");
  assert.ok(tables.length>=12);assert.ok(tables.every(x=>x.r));
  await db.exec('set role service_role');await assert.rejects(q(db,'select * from pos_inventory_shadow.versions'),e=>e.code==='42501');await db.exec('reset role');
 });
 await t.test('lease expiring while waiting for count lock cannot commit a stale completion',async()=>{
  const db=await setup();await register(db,{quantity:10,time:baseTime});await capture(db);const c=await claim(db);
  const worker=await rt.connect(db.name),observer=await rt.connect(db.name),pid=(await q(worker,'select pg_backend_pid() pid'))[0].pid;
  await db.query('update pos_inventory_shadow.jobs set lease_until=clock_timestamp()+interval \'300 milliseconds\' where id=$1',[c.jobId]);
  await db.exec('begin');await db.exec('select id from inventory where id=1 for update');
  const pending=settle(worker,c);await waiting(observer,pid);await new Promise(r=>setTimeout(r,350));await db.exec('commit');
  assert.equal((await pending).result,'lease_lost');assert.equal((await q(db,'select count(*)::int n from pos_inventory_shadow.settlements'))[0].n,0);
  const next=await claim(db);assert.notEqual(next.token,c.token);assert.equal((await settle(db,next)).result,'shadow_settled');
 });
 await (await rt.connect('postgres')).query('checkpoint');t.diagnostic(rt.version);
});
