import assert from 'node:assert/strict';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeInventoryPostgres} from './helpers/inventory-native-postgres.mjs';
import {receiptEditFixture,item,editReceipt} from './helpers/inventory-receipt-edit-fixture.mjs';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const blocked=async(db,pid)=>{for(let i=0;i<100;i++){if((await one(db,'select cardinality(pg_blocking_pids($1)) as n',[pid])).n>0)return;await delay(20);}throw Error('Expected real PostgreSQL lock wait');};
// Real lock waits: a concurrent edit, payment, allocation or month close that commits first
// must make the waiting receipt edit re-read state and block without any partial write.
test('receipt edit serializes with edits, payment, allocation and month closing in native PostgreSQL',{skip:!process.env.QA_POSTGRES_BIN,timeout:90000},async t=>{
 const runtime=await nativeInventoryPostgres({testContext:t});console.log(runtime.version);
 try{
 for(const [mode,memoOnly] of [['edit',false],['payment',false],['allocation',false],['month-close',false],['payment',true],['allocation',true],['month-close',true]])await t.test(mode+' first blocks the waiting '+(memoOnly?'memo-only ':'')+'edit',async()=>{
  const db=await receiptEditFixture(runtime.Database),a=await runtime.connect(db.name),b=await runtime.connect(db.name);let pending;
  try{
   const old=await item(db);await a.query("set statement_timeout='5s';begin");await b.query("set statement_timeout='5s';set deadlock_timeout='100ms'");
   if(mode==='edit')assert.equal((await editReceipt(a,old,{quantity:12})).ledgerSync.code,'REBOOKED');
   if(mode==='payment')await a.query("update ledger_payables set status='paid'");
   if(mode==='allocation')await a.query('insert into ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount) select p.id,p.expense_transaction_id,1 from ledger_payables p');
   if(mode==='month-close'){await a.query("select pg_advisory_xact_lock(hashtext('ledger_month_close:2026-10'))");await a.query("insert into ledger_month_closures(month) values('2026-10-01')");}
   const pid=(await one(b,'select pg_backend_pid() as pid')).pid;pending=editReceipt(b,old,memoOnly?{reason:'메모만 정정',note:'영수증'}:{quantity:9,purchase_price:21000});pending.catch(()=>{});
   await blocked(db,pid);await a.query('commit');
   const result=await pending;
   if(mode==='edit')assert.equal(result.status,'quantity_conflict');
   else{assert.equal(result.status,'purchase_correction_review_required');assert.equal(result.blockReason,{payment:'payment_completed',allocation:'payment_allocated','month-close':'month_closed'}[mode]);}
   assert.equal(Number((await one(db,'select count(*) as n from inventory_logs where correction_of_inventory_log_id=100')).n),mode==='edit'?1:0);
   if(memoOnly)assert.equal(result.code,'CONFIRMED_RECEIPT_PROTECTED');
   assert.equal(Number((await one(db,"select count(*) as n from ledger_audit_logs where action='inventory_purchase_receipt_edited'")).n),mode==='edit'?1:0);
   assert.equal(Number((await one(db,"select count(*) as n from ledger_transactions where source_type='inventory_purchase_reversal'")).n),mode==='edit'?1:0);
   assert.equal(Number((await item(db)).quantity),mode==='edit'?12:10);
   assert.equal(Number((await one(db,'select deadlocks from pg_stat_database where datname=current_database()')).deadlocks),0);
  }finally{await a.query('rollback').catch(()=>{});await b.query('rollback').catch(()=>{});if(pending)await pending.catch(()=>{});await a.end();await b.end();await db.close();}
 });
 }finally{await runtime.stop();}
});
