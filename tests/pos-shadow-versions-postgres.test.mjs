import assert from 'node:assert/strict';
import test from 'node:test';
import {nativeInventoryPostgres} from './helpers/inventory-native-postgres.mjs';
import {initializeShadow,seedReceipt,rows as q,capture,claim,register,operatingSnapshot} from './helpers/pos-shadow-fixture.mjs';

test('POS shadow version ledger and ownership',{timeout:120000},async t=>{
 const rt=await nativeInventoryPostgres({testContext:t});
 const setup=async()=>{const db=new rt.Database();await initializeShadow(db);return db;};
 await t.test('55 duplicate observations -> one version/job; A -> B -> A -> cancel remains ordered',async()=>{
  const db=await setup(),before=await operatingSnapshot(db),first=await capture(db);
  for(let i=0;i<55;i++)assert.deepEqual(await capture(db),first);
  assert.equal((await capture(db,{key:'repeated-fetch',seq:2})).result,'duplicate');
  assert.equal((await q(db,'select count(*)::int n from pos_inventory_shadow.versions'))[0].n,1);
  const b=await capture(db,{key:'B',seq:3,quantity:2}),a=await capture(db,{key:'A-again',seq:4});
  assert.equal(b.version,2);assert.equal(a.version,3);
  assert.equal((await capture(db,{key:'old',seq:2,quantity:7})).result,'out_of_order');
  assert.equal((await capture(db,{key:'conflicting-order',seq:4,quantity:7})).reason,'source_sequence_conflict');
  assert.deepEqual(await operatingSnapshot(db),before);
  await db.exec('update pos_sales_receipts set is_canceled=true where id=10');
  const canceled=await capture(db,{key:'cancel',seq:5});
  const version=(await q(db,'select * from pos_inventory_shadow.versions where id=$1',[canceled.versionId]))[0];
  assert.equal(version.kind,'cancel');assert.deepEqual(version.economic_targets,[]);
  assert.equal((await q(db,'select physical_targets from pos_inventory_shadow.plans where version_id=$1',[version.id]))[0].physical_targets[0].quantity,1);
  await assert.rejects(db.exec('update pos_inventory_shadow.versions set kind=\'sale\''),/POS_SHADOW_IMMUTABLE/);
  await assert.rejects(db.exec('delete from pos_inventory_shadow.observations'),/POS_SHADOW_IMMUTABLE/);
 });
 await t.test('duplicate receipt identity shares stream; unknown sequence/time is explicit',async()=>{
  const db=await setup();await capture(db);await seedReceipt(db,11,'ref-10');
  assert.equal((await capture(db,{receipt:11,key:'alias',seq:2})).result,'duplicate');
  assert.equal((await q(db,'select count(*)::int n from pos_inventory_shadow.streams'))[0].n,1);
  assert.equal((await capture(db,{key:'no-order',seq:null})).reason,'source_order_unknown');
  const unknown=await capture(db,{key:'unknown-time',seq:3,quantity:2,time:null});
  assert.equal(unknown.result,'needs_review');assert.equal(unknown.reason,'physical_time_unknown');
  await assert.rejects(capture(db,{quantity:3}),/POS_SHADOW_OBSERVATION_KEY_CONFLICT/);
 });
 await t.test('two cron claims, expired token fencing, retry backoff, per-receipt ordering',async()=>{
  const db=await setup();await capture(db);await capture(db,{key:'next',seq:2,quantity:2});
  const second=await rt.connect(db.name);
  const both=await Promise.all([claim(db,'cron-a'),claim(second,'cron-b')]);
  assert.deepEqual(both.map(x=>x.result).sort(),['empty','leased']);
  const first=both.find(x=>x.result==='leased');
  await db.query('update pos_inventory_shadow.jobs set lease_until=clock_timestamp()-interval \'1 second\' where id=$1',[first.jobId]);
  const replacement=await claim(db);assert.equal(replacement.jobId,first.jobId);assert.notEqual(replacement.token,first.token);
  const fail=async(token,code)=>(await q(db,"select pos_shadow_fail($1,$2,$3,'owner') r",[first.jobId,token,code]))[0].r;
  assert.equal((await fail(first.token,'55P03')).result,'lease_lost');
  assert.equal((await fail(replacement.token,'55P03')).result,'retry_wait');
  assert.equal((await claim(db)).result,'empty');
  assert.deepEqual((await q(db,'select outcome from pos_inventory_shadow.attempt_events order by id')).map(x=>x.outcome),['lease_expired','retry_wait']);
 });
 await t.test('movement evidence references real logs; captures never create inventory or legacy previews',async()=>{
  const db=await setup();await register(db);const before=await operatingSnapshot(db);await capture(db);
  assert.deepEqual(await operatingSnapshot(db),before);
  const m=(await q(db,'select * from pos_inventory_shadow.movements'))[0];
  await assert.rejects(db.exec('delete from pos_inventory_shadow.movements'),/POS_SHADOW_IMMUTABLE/);
  await assert.rejects(q(db,"select pos_shadow_register_movement($1,'physical_return','2026-10-12T00:00:00Z','{\"proof\":\"synthetic\"}','owner')",[m.log_id]),/POS_SHADOW_LOG_KIND_MISMATCH/);
  const acl=await q(db,"select has_function_privilege('anon',oid,'execute') a,has_function_privilege('authenticated',oid,'execute') u,has_function_privilege('service_role',oid,'execute') s from pg_proc where proname like 'pos_shadow_%'");
  assert.ok(acl.length>=4);for(const x of acl)assert.deepEqual(x,{a:false,u:false,s:true});
  await assert.rejects(q(db,"select pos_shadow_claim('unauthorized','staff')"),e=>e.code==='42501');
 });
 await (await rt.connect('postgres')).query('checkpoint');
 t.diagnostic(rt.version);
});
