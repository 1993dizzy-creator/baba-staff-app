import assert from 'node:assert/strict';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeInventoryPostgres} from './helpers/inventory-native-postgres.mjs';
import {safeFixture,snapshot,correct} from './helpers/inventory-safe-correction-fixture.mjs';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const blocked=async(db,pid)=>{for(let i=0;i<100;i++){if((await one(db,'select cardinality(pg_blocking_pids($1)) as n',[pid])).n>0)return;await delay(20);}throw Error('Expected real PostgreSQL lock wait');};
test('safe auto correction serializes source writes, payment allocation and month closing in native PostgreSQL',{skip:!process.env.QA_POSTGRES_BIN,timeout:60000},async t=>{
 const runtime=await nativeInventoryPostgres();console.log(runtime.version);
 try{
 for(const mode of ['correction','payment','month-close'])await t.test(mode+' first prevents stale automatic correction',async()=>{
  const db=await safeFixture(runtime.Database),a=await runtime.connect(db.name),b=await runtime.connect(db.name);let pending;
  try{
   const old=await snapshot(db);await a.query("set statement_timeout='5s';begin");await b.query("set statement_timeout='5s';set deadlock_timeout='100ms'");
   if(mode==='correction')assert.equal((await correct(a,old,{quantity:9})).ledgerSync.status,'synced');
   if(mode==='payment')await a.query("update ledger_payables set status='paid'");
   if(mode==='month-close'){await a.query("select pg_advisory_xact_lock(hashtext('ledger_month_close:2026-10'))");await a.query("insert into ledger_month_closures(month) values('2026-10-01')");}
   const pid=(await one(b,'select pg_backend_pid() as pid')).pid;pending=correct(b,old,{quantity:8});pending.catch(()=>{});await blocked(db,pid);await a.query('commit');
   const result=await pending;if(mode==='correction')assert.equal(result.status,'quantity_conflict');else assert.equal(result.ledgerSync.status,'review_required');
   assert.equal(Number((await one(db,"select count(*) as n from ledger_transactions where source_type='inventory_purchase_reversal'")).n),mode==='correction'?1:0);
   assert.equal(Number((await one(db,'select deadlocks from pg_stat_database where datname=current_database()')).deadlocks),0);
  }finally{await a.query('rollback').catch(()=>{});await b.query('rollback').catch(()=>{});if(pending)await pending.catch(()=>{});await a.end();await b.end();await db.close();}
 });
 }finally{await runtime.stop();}
});