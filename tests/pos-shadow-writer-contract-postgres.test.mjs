import assert from 'node:assert/strict';
import test from 'node:test';
import {nativeInventoryPostgres} from './helpers/inventory-native-postgres.mjs';
import {initializeShadow,seedReceipt,readMigration,rows as q,register,capture,claim,operatingSnapshot} from './helpers/pos-shadow-fixture.mjs';
const migration='20261102110828_pos_shadow_writer_contract_and_order.sql';
const contract=async(db,id)=>(await q(db,"select pos_shadow_inventory_writer_contract($1,'owner') r",[id]))[0].r;
const transfer=async(db,id,c,kind,time='2026-10-12T00:00:00Z',evidence={proof:'synthetic authoritative physical event'})=>(await q(db,"select pos_shadow_register_writer_movement($1,$2,$3,$4,$5,'owner') r",[id,c.sourceLogHash,time,kind,evidence]))[0].r;
const compare=async(db,item=1)=>(await q(db,"select pos_shadow_compare_item($1,'owner') r",[item]))[0].r;
test('POS writer contracts and deterministic boundary',{timeout:120000},async t=>{
 const rt=await nativeInventoryPostgres({testContext:t});
 async function setup(){
  const db=new rt.Database();await initializeShadow(db);await db.exec(readMigration('20261102103822_pos_shadow_temporal_settlement.sql'));
  const before=await q(db,"select oid,prosrc,proacl::text from pg_proc where proname in ('guard_pos_inventory_stock_check_boundary','reprocess_modified_sales_inventory_deduction_receipt','apply_sales_inventory_deduction_batch','rollback_canceled_sales_inventory_deduction_receipt') order by oid");
  await db.exec(readMigration(migration));assert.deepEqual(await q(db,"select oid,prosrc,proacl::text from pg_proc where proname in ('guard_pos_inventory_stock_check_boundary','reprocess_modified_sales_inventory_deduction_receipt','apply_sales_inventory_deduction_batch','rollback_canceled_sales_inventory_deduction_receipt') order by oid"),before);
  return db;
 }
 const log=async(db,source,reason,quantity,extra={})=>(await q(db,"insert into inventory_logs(item_id,source,reason,change_quantity,new_quantity,created_at) values(1,$1,$2,$3,$4,'2026-10-12T00:00:00Z') returning id",[source,reason,quantity,extra.count??quantity]))[0].id;
 await t.test('same-time counts choose source log ID, independent of Shadow registration order',async()=>{
  const db=await setup();const a=await log(db,'edit_form','stock_check',0,{count:4}),b=await log(db,'edit_form','stock_check',0,{count:9});
  const before=await operatingSnapshot(db);
  // Deliberately register the larger source ID first, reversing Shadow IDs.
  for(const id of [b,a])await transfer(db,id,await contract(db,id),'count','2026-10-11T00:00:00Z',{proof:'synthetic simultaneous counts',coverageComplete:true});
  const r=await compare(db);assert.equal(r.boundaryLogId,Number(b));assert.equal(r.bookQuantity,9);
  for(let i=0;i<55;i++)assert.deepEqual(await compare(db),r);
  assert.deepEqual(await operatingSnapshot(db),before);
 });
 await t.test('all physical audit classes share one provenance/CAS interface; POS is never added twice',async()=>{
  const db=await setup();await db.exec('alter table inventory_logs add column correction_of_inventory_log_id bigint');
  const count=await log(db,'quick_save','stock_check',0,{count:10});
  const purchase=await log(db,'edit_form','purchase',2);
  const correction=await log(db,'edit_form','purchase',-1);await db.query('update inventory_logs set correction_of_inventory_log_id=$1 where id=$2',[purchase,correction]);
  const keg=await log(db,'keg_replace','sale_deduction',-1),manual=await log(db,'edit_form','service',-0.5),returned=await log(db,'quick_save','other',1);
  const before=await operatingSnapshot(db);
  for(const [id,kind,writer] of [[count,'count','stock_check'],[purchase,'purchase','purchase'],[correction,'purchase','purchase_correction'],[keg,'adjustment','keg_replace'],[manual,'adjustment','manual_adjustment']]){
   const c=await contract(db,id);assert.equal(c.writer,writer);
   const time=id===count?'2026-10-08T00:00:00Z':'2026-10-12T00:00:00Z';
   assert.equal((await transfer(db,id,c,kind,time)).result,'recorded');assert.equal((await transfer(db,id,c,kind,time)).result,'duplicate');
  }
  assert.equal((await transfer(db,returned,await contract(db,returned),'physical_return')).reason,'writer_kind_mismatch');
  assert.equal((await transfer(db,returned,await contract(db,returned),'physical_return',undefined,{proof:'synthetic real return',physicalEventRef:'return-1'})).result,'recorded');
  const pos=(await q(db,"select id from inventory_logs where source='pos_sales' limit 1"))[0];assert.equal(pos,undefined);
  assert.equal((await compare(db)).bookQuantity,10.5);assert.deepEqual(await operatingSnapshot(db),before);
  const unknown=await log(db,'unknown-source','other',1),orphan=await log(db,'quick_save','purchase',-1);
  assert.equal((await contract(db,unknown)).reason,'writer_source_unclassified');assert.equal((await contract(db,orphan)).reason,'purchase_correction_root_missing');
  const created=await log(db,'create','purchase',2);assert.equal((await contract(db,created)).writer,'inventory_create');
  assert.equal((await transfer(db,created,await contract(db,created),'purchase')).result,'recorded');
  const photo=await log(db,'photo','other',0);assert.equal((await contract(db,photo)).result,'excluded');
 });
 await t.test('stale source hash and later audit mutation fail closed without rewriting prior evidence',async()=>{
  const db=await setup();await register(db,{quantity:10,time:'2026-10-08T00:00:00Z'});
  const id=await log(db,'edit_form','purchase',2);await db.query("update inventory_logs set unit='bottle' where id=$1",[id]);const old=await contract(db,id);
  await db.query('update inventory_logs set change_quantity=3 where id=$1',[id]);
  assert.equal((await transfer(db,id,old,'purchase')).result,'stale_source');
  const current=await contract(db,id);await transfer(db,id,current,'purchase');
  const evidence=await q(db,'select to_jsonb(m) m from pos_inventory_shadow.movements m order by id');
  await db.exec("update inventory set unit='keg' where id=1");assert.equal((await compare(db)).reason,'shadow_source_audit_changed');
  await db.exec("update inventory set unit='bottle' where id=1");
  await db.query("update inventory_logs set unit='changed-unit' where id=$1",[id]);
  const before=await operatingSnapshot(db);assert.equal((await compare(db)).reason,'shadow_source_audit_changed');
  assert.deepEqual(await q(db,'select to_jsonb(m) m from pos_inventory_shadow.movements m order by id'),evidence);assert.deepEqual(await operatingSnapshot(db),before);
 });
 await t.test('quantity drift on legacy evidence is detected; missing time is not replaced by created_at',async()=>{
  const db=await setup();const count=await register(db,{quantity:10,time:'2026-10-08T00:00:00Z'});
  const id=await log(db,'edit_form','purchase',2),c=await contract(db,id);
  assert.equal((await transfer(db,id,c,'purchase',null)).reason,'physical_time_evidence_required');
  await db.query('update inventory_logs set new_quantity=99 where id=$1',[count.id]);
  assert.equal((await compare(db)).reason,'shadow_source_audit_changed');
 });
 await t.test('repairing source integrity requeues the same held version without a new quantity/log ID',async()=>{
  const db=await setup();const id=await log(db,'edit_form','stock_check',0,{count:10});
  await db.query("update inventory_logs set unit='bottle' where id=$1",[id]);
  await transfer(db,id,await contract(db,id),'count','2026-10-08T00:00:00Z',{proof:'synthetic measured count',coverageComplete:true});
  const v=await capture(db);await db.exec("update inventory set unit='keg' where id=1");
  const c=await claim(db),r=(await q(db,"select pos_shadow_settle($1,$2,'owner') r",[c.jobId,c.token]))[0].r;assert.equal(r.reason,'shadow_source_audit_changed');
  assert.equal((await q(db,"select pos_shadow_retry($1,'owner') r",[v.jobId]))[0].r.result,'waiting_for_dependency_change');
  await db.exec("update inventory set unit='bottle' where id=1");
  assert.equal((await q(db,"select pos_shadow_retry($1,'owner') r",[v.jobId]))[0].r.result,'queued');
  const next=await claim(db);assert.equal((await q(db,"select pos_shadow_settle($1,$2,'owner') r",[next.jobId,next.token]))[0].r.result,'shadow_settled');
  assert.equal((await q(db,'select count(*)::int n from pos_inventory_shadow.versions'))[0].n,1);
 });
 await t.test('Glenfiddich/55 replay and normal post-count deltas keep original audit and P0',async()=>{
  const db=await setup();await register(db,{quantity:0.2});await register(db,{kind:'purchase',quantity:1,time:'2026-10-12T00:00:00Z'});
  const before=await operatingSnapshot(db),v=await capture(db);for(let i=0;i<55;i++)assert.deepEqual(await capture(db),v);
  const c=await claim(db),r=(await q(db,"select pos_shadow_settle($1,$2,'owner') r",[c.jobId,c.token]))[0].r;
  assert.equal(r.items[0].currentStockDelta,0);assert.equal(r.items[0].bookQuantity,1.2);
  assert.deepEqual(await operatingSnapshot(db),before);
  await seedReceipt(db,11);await db.exec("update pos_sales_receipts set ref_date='2026-10-12T01:00:00Z' where id=11");
  const normalBefore=await operatingSnapshot(db);
  await capture(db,{receipt:11,key:'after-count',time:'2026-10-12T01:00:00Z',evidence:{proof:'synthetic after-count physical sale',timeBasis:'physical_event'}});
  const normalClaim=await claim(db),normal=(await q(db,"select pos_shadow_settle($1,$2,'owner') r",[normalClaim.jobId,normalClaim.token]))[0].r;
  assert.equal(normal.items[0].currentStockDelta,-1);assert.equal(normal.items[0].bookQuantity,0.2);
  assert.deepEqual(await operatingSnapshot(db),normalBefore);
 });
 await t.test('new APIs are service-only and cannot relabel a POS sale as a physical adjustment',async()=>{
  const db=await setup();await db.exec('alter table inventory_logs disable trigger inventory_logs_pos_stock_check_boundary');
  const id=await log(db,'pos_sales','sale_deduction',-1);await db.exec('alter table inventory_logs enable trigger inventory_logs_pos_stock_check_boundary');
  const before=await operatingSnapshot(db),c=await contract(db,id);assert.equal(c.result,'excluded');assert.equal(c.reason,'use_sale_version_ledger');
  assert.equal((await transfer(db,id,c,'adjustment')).result,'excluded');assert.deepEqual(await operatingSnapshot(db),before);
  const grants=await q(db,"select has_function_privilege('anon',oid,'execute') a,has_function_privilege('authenticated',oid,'execute') u,has_function_privilege('service_role',oid,'execute') s from pg_proc where proname in ('pos_shadow_inventory_writer_contract','pos_shadow_register_writer_movement')");
  assert.deepEqual(grants,[{a:false,u:false,s:true},{a:false,u:false,s:true}]);
 });
 await (await rt.connect('postgres')).query('checkpoint');t.diagnostic(rt.version);
});
