import assert from 'node:assert/strict';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {atomicInventoryDatabase} from './helpers/inventory-atomic-fixture.mjs';
import {nativeInventoryPostgres} from './helpers/inventory-native-postgres.mjs';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const snapshot=async db=>(await one(db,'select to_jsonb(i) as item from inventory i where id=1')).item;
const save=async(c,old,name)=>(await one(c,"select inventory_update_with_audit_v1(1,$1::jsonb,$2::jsonb,'2026-10-10',2,'other','edit_form','2026-10-10') as result",[JSON.stringify(old),JSON.stringify({item_name:name})])).result;
const correct=async(c,old,name,root=100)=>(await one(c,"select inventory_apply_purchase_correction_v2(1,$1,$2,$3::jsonb,$4::jsonb,'2026-10-10',2) as result",[root,old.quantity,JSON.stringify(old),JSON.stringify({quantity:old.quantity,item_name:name})])).result;
const legacy=async(c,old,name)=>(await one(c,"select inventory_apply_purchase_correction_v1(1,100,$1,$2::jsonb,'2026-10-10',2) as result",[old.quantity,JSON.stringify({quantity:old.quantity,item_name:name})])).result;
async function waitForLock(db,blocker,waiting){
 for(let i=0;i<100;i++){const state=await one(db,'select wait_event_type,wait_event,pg_blocking_pids(pid) as blockers from pg_stat_activity where pid=$1',[waiting]);
  if(state?.wait_event_type==='Lock'&&state.blockers.includes(blocker))return state;await delay(20);
 }throw Error('Second PostgreSQL session did not wait for the first session lock');
}
test('native PostgreSQL two-session inventory lock/concurrency regressions',{skip:!process.env.QA_POSTGRES_BIN,timeout:60000},async t=>{
 const runtime=await nativeInventoryPostgres();console.log(runtime.version);
 try{
  for(const [name,first,second] of [
   ['ordinary / ordinary',save,save],['correction v2 / correction v2',correct,correct],
   ['ordinary / correction v2',save,correct],['correction v2 / ordinary',correct,save],
   ['legacy v1 / correction v2',legacy,correct],
   ['different purchase roots, same item',correct,(c,old,name)=>correct(c,old,name,101)]
  ])await t.test(name+' waits then rejects stale edit without a deadlock',async()=>{
   const db=await atomicInventoryDatabase(runtime.Database);const a=await runtime.connect(db.name),b=await runtime.connect(db.name);
   let pending;try{
    if(name.startsWith('different'))await db.exec("insert into inventory_logs(id,item_id,item_name,unit,change_quantity,new_purchase_price,new_supplier,purchase_supplier_partner_id,business_date,source,reason,source_actor_user_id) values(101,1,'Second purchase','can',10,20000,'Won Mart',10,'2026-09-02','create','purchase',2)");
    await a.query("set statement_timeout='5s';set deadlock_timeout='100ms';begin");await b.query("set statement_timeout='5s';set deadlock_timeout='100ms'");
    const old=await snapshot(db);const pidA=(await one(a,'select pg_backend_pid() as pid')).pid,pidB=(await one(b,'select pg_backend_pid() as pid')).pid;assert.notEqual(pidA,pidB);
    assert.equal((await first(a,old,'Admin A')).status,'ok');let done=false;pending=second(b,old,'Admin B');pending.then(()=>{done=true;},()=>{done=true;});
    const lock=await waitForLock(db,pidA,pidB);assert.equal(done,false);console.log(name+' lock='+lock.wait_event);
    await a.query('commit');assert.equal((await pending).status,'inventory_conflict');
    assert.equal((await snapshot(db)).item_name,'Admin A');assert.equal(Number((await one(db,'select count(*) as n from inventory_logs where id>=1000')).n),1);
    assert.equal(Number((await one(db,'select deadlocks from pg_stat_database where datname=current_database()')).deadlocks),0);
   }finally{await a.query('rollback').catch(()=>{});await b.query('rollback').catch(()=>{});if(pending)await pending.catch(()=>{});await a.end();await b.end();await db.close();}
  });
  await t.test('native DB keeps v1 grant and stable matcher, blocks purchase reduction only',async()=>{
   const db=await atomicInventoryDatabase(runtime.Database);try{
    const meta=await one(db,"select has_function_privilege('service_role','public.inventory_apply_purchase_correction_v1(bigint,bigint,numeric,jsonb,date,bigint)','EXECUTE') as legacy_allowed,(select provolatile from pg_proc where oid='inventory_ledger_private.item_matches_expected_v1(jsonb,jsonb)'::regprocedure) as volatility");assert.equal(meta.legacy_allowed,true);assert.equal(meta.volatility,'s');
    const invoke=async(payload,reason)=>{const old=await snapshot(db);return (await one(db,"select inventory_update_with_audit_v1(1,$1::jsonb,$2::jsonb,'2026-10-10',2,$3,'edit_form','2026-10-10') as result",[JSON.stringify(old),JSON.stringify(payload),reason])).result;};
    const before=await snapshot(db);for(const quantity of [9,0,null])assert.equal((await invoke({quantity},'purchase')).status,'purchase_correction_required');assert.deepEqual(await snapshot(db),before);
    assert.equal((await invoke({quantity:9},'stock_check')).status,'ok');assert.equal((await invoke({quantity:11},'purchase')).status,'ok');assert.equal((await snapshot(db)).quantity,11);
   }finally{await db.close();}
  });
  await t.test('blocked second session succeeds after first session audit failure rolls back',async()=>{
   const db=await atomicInventoryDatabase(runtime.Database),a=await runtime.connect(db.name),b=await runtime.connect(db.name);let pending;
   try{
    await db.exec("create function qa_fail_audit() returns trigger language plpgsql as $$begin if current_setting('qa.fail_audit',true)='on' then raise exception 'QA_REQUIRED_AUDIT_FAILURE';end if;return new;end$$;create trigger qa_fail before insert on inventory_logs for each row execute function qa_fail_audit()");
    const old=await snapshot(db);await a.query("set statement_timeout='5s';begin;set local qa.fail_audit='on'");await b.query("set statement_timeout='5s'");
    await a.query('select id from inventory where id=1 for update');const pidA=(await one(a,'select pg_backend_pid() as pid')).pid,pidB=(await one(b,'select pg_backend_pid() as pid')).pid;
    pending=save(b,old,'Admin B');pending.catch(()=>{});await waitForLock(db,pidA,pidB);
    await assert.rejects(save(a,old,'Failed Admin A'),/QA_REQUIRED_AUDIT_FAILURE/);await a.query('rollback');assert.equal((await pending).status,'ok');
    assert.equal((await snapshot(db)).item_name,'Admin B');assert.equal(Number((await one(db,'select count(*) as n from inventory_logs where id>=1000')).n),1);
   }finally{await a.query('rollback').catch(()=>{});await b.query('rollback').catch(()=>{});if(pending)await pending.catch(()=>{});await a.end();await b.end();await db.close();}
  });
  await t.test('metadata changed without timestamp advancement is rejected after real row lock wait',async()=>{
   const db=await atomicInventoryDatabase(runtime.Database),a=await runtime.connect(db.name),b=await runtime.connect(db.name);let pending;
   try{
    const old=await snapshot(db);await a.query("set statement_timeout='5s';begin;update inventory set item_name='Other administrator' where id=1");await b.query("set statement_timeout='5s'");
    const pidA=(await one(a,'select pg_backend_pid() as pid')).pid,pidB=(await one(b,'select pg_backend_pid() as pid')).pid;
    pending=correct(b,old,'Stale administrator');pending.catch(()=>{});await waitForLock(db,pidA,pidB);await a.query('commit');assert.equal((await pending).status,'inventory_conflict');
    assert.equal((await snapshot(db)).item_name,'Other administrator');assert.equal(Number((await one(db,'select count(*) as n from inventory_logs where id>=1000')).n),0);
   }finally{await a.query('rollback').catch(()=>{});await b.query('rollback').catch(()=>{});if(pending)await pending.catch(()=>{});await a.end();await b.end();await db.close();}
  });
 }finally{await runtime.stop();}
});
