import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdirSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeInventoryPostgres} from './helpers/inventory-native-postgres.mjs';
import {installCleaningFixture,context,confirm,addOrder,scope} from './helpers/tables-cleaning-fixture.mjs';
const settle=p=>p.then(value=>({value}),error=>({error}));
async function waitLock(observer,pid){
 for(let i=0;i<300;i++){
  if((await observer.query("select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock'",[pid])).rows.length)return;
  await delay(10);
 }throw Error('Expected lock wait was not observed');
}
test('native cleaning transactions: duplicate clicks and races with receipt/order/employee writers',{skip:!process.env.QA_POSTGRES_BIN&&'QA_POSTGRES_BIN not set',timeout:180000},async t=>{
 const cwd=process.cwd(),qa=path.join(cwd,'.local/tables-phase2-qa');mkdirSync(qa,{recursive:true});process.chdir(qa);
 const runtime=await nativeInventoryPostgres({testContext:t});t.diagnostic(runtime.version);
 try{
  for(const kind of ['duplicate','receipt','order','employee','menu'])await t.test(kind,{timeout:30000},async()=>{
   const db=new runtime.Database();await db.ready;const day=await installCleaningFixture(db);
   await db.exec('update table_operations_private.config set enabled=true');
   if(kind==='menu')await db.exec("insert into pos_sales_receipt_lines values(1,100,'cukcuk','Synthetic',1,100000,false)");
   const ctx=await context(db,day),a=await runtime.connect(db.name),b=await runtime.connect(db.name);
   try{
    if(kind==='duplicate'){
     const both=await Promise.all([confirm(a,day,ctx),confirm(b,day,ctx,{actorId:2,requestId:'00000000-0000-4000-8000-000000000002'})]);
     assert.equal(both[0].eventId,both[1].eventId);assert.equal(Number((await db.query('select count(*) n from table_operations_private.cleaning_events')).rows[0].n),1);
    }else{
     const pid=(await a.query('select pg_backend_pid() p')).rows[0].p;await b.query('begin');
     if(kind==='receipt')await b.query("insert into pos_sales_receipts select 101,source,branch_id,business_date,payment_status,is_canceled,total_amount,discount_amount,raw_json,ref_no,ref_date,final_amount,status_changed_at from pos_sales_receipts where id=100");
     if(kind==='order'){await b.query("select pg_advisory_xact_lock(hashtextextended('pos_open_orders:'||$1,0))",[scope]);await addOrder({query:(...args)=>b.query(...args)},day);}
     if(kind==='employee')await b.query('update users set app_login_enabled=false where id=1');
     if(kind==='menu')await b.query('update pos_sales_receipt_lines set final_amount=200000 where id=1');
     const pending=settle(confirm(a,day,ctx));await waitLock(db.client,pid);await b.query('commit');
     const result=await pending;assert.ok(result.error);assert.match(result.error.message,kind==='employee'?/forbidden/:/stale/);
     assert.equal(Number((await db.query('select count(*) n from table_operations_private.cleaning_events')).rows[0].n),0);
    }
    assert.equal(Number((await db.query('select deadlocks from pg_stat_database where datname=current_database()')).rows[0].deadlocks),0);
   }finally{await a.query('rollback');await b.query('rollback');await a.end();await b.end();await db.close();}
  });
 }finally{process.chdir(cwd);}
});
