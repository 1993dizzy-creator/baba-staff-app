import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {nativeInventoryPostgres} from './helpers/inventory-native-postgres.mjs';
import {writerFixture,save,item,rows as q,definition} from './helpers/inventory-writer-integration-fixture.mjs';
import {readMigration} from './helpers/pos-shadow-fixture.mjs';
const f='20261102142849_pos_signed_projection_epochs_and_handoff.sql',permissions='20261102144000_pos_writer_least_privilege_and_day_reconciliation.sql';
const rpc=async(db,name,args)=>(await q(db,`select ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) r`,args))[0].r;
test('P1-2F least privilege and independent day closure',{timeout:120000},async t=>{
 const rt=await nativeInventoryPostgres({testContext:t}),db=new rt.Database();
 try{
  await writerFixture(db);await db.exec(readMigration(f));
  const d=readMigration('20261102113150_pos_reliable_cukcuk_ingestion.sql');
  await db.exec(d.slice(0,d.indexOf('alter table pos_ingest_private.runs')));
  await db.exec(definition(d,'pos_ingest_private.canonical_hash'));
  // Reproduce operating broad table AND column grants to verify both are revoked.
  await db.exec('grant select,insert,update,delete,truncate on inventory,inventory_logs to service_role,anon,authenticated;grant update(quantity),insert(quantity) on inventory to service_role;grant usage,select on all sequences in schema public to service_role');
  await db.exec(readMigration(permissions));
  await t.test('direct quantity/package/row creation and truncation denied, photo metadata retained',async()=>{
   await db.exec('set role service_role');try{
    for(const sql of ['update inventory set quantity=99 where id=1',"update inventory set package_content_quantity=20000 where id=1",'insert into inventory(item_name,quantity) values(\'forged\',5)','delete from inventory where id=1','truncate inventory_logs'])await assert.rejects(db.exec(sql),e=>e.code==='42501');
    await db.exec("update inventory set image_path='synthetic/photo.jpg' where id=1");
    assert.equal((await item(db)).image_path,'synthetic/photo.jpg');
    assert.equal((await save(db,3)).status,'ok'); // postgres-owned real RPC retains normal behavior
    const value=(await item(db)).quantity;
    await q(db,"insert into inventory_logs(item_id,action,reason,source,prev_quantity,new_quantity,change_quantity) values(1,'update','other','photo',$1,$1,0)",[value]);
    await assert.rejects(q(db,"insert into inventory_logs(item_id,action,reason,source,prev_quantity,new_quantity,change_quantity) values(1,'update','stock_check','photo',$1,$1,0)",[value]),e=>e.code==='42501');
    await assert.rejects(db.exec('update inventory_logs set new_quantity=999'),e=>e.code==='42501');
   }finally{await db.exec('reset role');}
   const g=await q(db,"select has_function_privilege('anon',function_oid,'execute') a,has_function_privilege('authenticated',function_oid,'execute') u,has_function_privilege('service_role',function_oid,'execute') s from inventory_writer_private.rpc_contracts");
   assert.ok(g.every(r=>!r.a&&!r.u&&r.s));
  });
  const run=randomUUID(),scope='a'.repeat(64)+':synthetic',hash='b'.repeat(64),from='2026-10-09T09:00:00Z',to='2026-10-10T03:00:00Z';
  let snap;
  const external={scope,branchId:'synthetic',businessDate:'2026-10-09',windowFrom:from,windowTo:to,cutoff:to,source:'fiscal_export',documentSha256:'c'.repeat(64),closed:true,proof:'Synthetic independent signed fiscal closure',entries:[{refId:'ref-10',hash,amount:'100.00',canceled:false}]};
  const reconcile=(e=external,id=randomUUID())=>rpc(db,'pos_signed_reconcile_day',[run,e,id,'owner']);
  await t.test('full ID/hash/amount/cancel closure matches provisionally, never fabricates source guarantees',async()=>{
   await q(db,"insert into pos_ingest_private.runs(id,scope,branch_id,business_date,window_from,window_to,owner_token,status,started_at,lease_until,manifest) values($1,$2,'synthetic','2026-10-09',$3,$4,$5,'committed','2026-10-10T04:00:00Z','2026-10-10T04:10:00Z',$6)",[run,scope,from,to,randomUUID(),{collectionComplete:true,selectedCount:1,entries:[{refId:'ref-10',hash,amount:100}]}]);
   snap=(await q(db,"insert into pos_ingest_private.snapshots(scope,ref_id,content_hash,payload,first_run) values($1,'ref-10',$2,$3,$4) returning id",[scope,hash,{receipt:{is_canceled:false}},run]))[0].id;
   await q(db,"insert into pos_ingest_private.observations(run_id,snapshot_id,outcome) values($1,$2,'accepted')",[run,snap]);
   await q(db,"insert into pos_ingest_private.heads(ref_id,scope,receipt_id,accepted_snapshot,canonical_hash) values('ref-10',$1,10,$2,pos_ingest_private.canonical_hash(10))",[scope,snap]);
   const id=randomUUID(),r=await reconcile(external,id);assert.equal(r.status,'matched_provisional');assert.equal(r.sourceComplete,false);assert.equal(r.automaticConfirmation,false);
   assert.deepEqual(await reconcile(external,id),r);
   await assert.rejects(reconcile({...external,entries:[]},id),/SIGNED_IDEMPOTENCY_CONFLICT/);
  });
  await t.test('missing receipt, extra receipt, equal-total content change and cancel inversion remain held with recoverable IDs',async()=>{
   const missing=await reconcile({...external,entries:[...external.entries,{refId:'missing',hash,amount:0,canceled:false}]});assert.equal(missing.status,'held');assert.deepEqual(missing.missingRefIds,['missing']);assert.equal(missing.recoveryBusinessDate,'2026-10-09');
   assert.deepEqual((await reconcile({...external,entries:[]})).extraRefIds,['ref-10']);
   for(const change of [{hash:'d'.repeat(64)},{amount:101},{canceled:true}]){
    const r=await reconcile({...external,entries:[{...external.entries[0],...change}]});assert.equal(r.status,'held');assert.deepEqual(r.changedRefIds,['ref-10']);
   }
  });
  await t.test('reconciliation follows ingestion scope-before-run lock order under concurrency',async()=>{
   const other=await rt.connect(db.name);let pending;
   try{
    const pid=(await q(db,'select pg_backend_pid() pid'))[0].pid;
    await other.query('begin');await other.query("select pg_advisory_xact_lock(hashtextextended('pos_ingest:'||$1,0))",[scope]);
    pending=reconcile();
    let waiting=false;
    for(let i=0;i<50;i++){
     const state=(await other.query('select wait_event_type from pg_stat_activity where pid=$1',[pid])).rows[0];
     if(state.wait_event_type==='Lock'){waiting=true;break;}
     await new Promise(resolve=>setTimeout(resolve,10));
     await other.query('select pg_stat_clear_snapshot()');
    }
    assert.equal(waiting,true);
    await other.query("set local lock_timeout='500ms'");
    await other.query('update pos_ingest_private.runs set lease_until=lease_until where id=$1',[run]);
    await other.query('commit');assert.equal((await pending).status,'matched_provisional');
   }finally{await other.query('rollback');await other.end();if(pending)await pending;}
  });
  await t.test('incomplete source, duplicates, invalid scope and undocumented independent proof cannot close',async()=>{
   for(const e of [{...external,source:null},{...external,documentSha256:''},{...external,branchId:'other'},{...external,entries:[...external.entries,...external.entries]}])await assert.rejects(reconcile(e),e=>e.code==='22023');
   await q(db,"update pos_ingest_private.runs set status='failed' where id=$1",[run]);await assert.rejects(reconcile(),/SIGNED_CLOSURE_SCOPE_OR_COLLECTION_UNPROVEN/);
   await q(db,"update pos_ingest_private.runs set status='committed' where id=$1",[run]);
   await q(db,"update pos_ingest_private.observations set outcome='uncertain' where run_id=$1",[run]);assert.equal((await reconcile()).uncertainCount,1);
   await q(db,"update pos_ingest_private.observations set outcome='accepted' where run_id=$1",[run]);
   await db.exec('update pos_sales_receipts set is_canceled=true where id=10');assert.equal((await reconcile()).status,'held');
   await assert.rejects(db.exec("update pos_signed_private.day_reconciliations set result='{}'"),/IMMUTABLE/);
  });
 }finally{await db.close();const c=await rt.connect('postgres');await c.query('checkpoint');await c.end();}
});
