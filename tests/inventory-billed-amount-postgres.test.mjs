import assert from 'node:assert/strict';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeInventoryPostgres} from './helpers/inventory-native-postgres.mjs';
import {billedFixture} from './helpers/inventory-billed-amount-fixture.mjs';
import {item,editReceipt} from './helpers/inventory-receipt-edit-fixture.mjs';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const blocked=async(db,pid)=>{for(let i=0;i<100;i++){if((await one(db,'select cardinality(pg_blocking_pids($1)) as n',[pid])).n>0)return;await delay(20);}throw Error('Expected real PostgreSQL lock wait');};
const orange={quantity:3.57,purchase_price:85000,reason:'영수증 금액',billed_amount_mode:'manual',billed_amount:303000};
const quickSave=(db,old,billed)=>one(db,'select inventory_update_with_audit_v1(1,$1::jsonb,$2::jsonb,$3::date,1,$4,$5,$3::date) as result',
 [JSON.stringify(old),JSON.stringify({quantity:13.57,purchase_price:85000,billed_amount_mode:'manual',billed_amount:billed}),'2026-10-11','purchase','quick_save']).then(r=>r.result);

// Real lock waits: whatever commits first (another billed edit, a payment, an allocation, a month
// close, or another quick-save receipt) makes the waiting save re-read state and write nothing.
test('billed amount saves serialize with edits, payments, allocations, month close and quick saves in native PostgreSQL',{skip:!process.env.QA_POSTGRES_BIN,timeout:120000},async t=>{
 const runtime=await nativeInventoryPostgres({testContext:t});console.log(runtime.version);
 try{
 for(const mode of ['billed-edit','payment','allocation','month-close'])await t.test(mode+' first blocks the waiting billed edit',async()=>{
  const db=await billedFixture(runtime.Database),a=await runtime.connect(db.name),b=await runtime.connect(db.name);let pending;
  try{
   const old=await item(db);await a.query("set statement_timeout='5s';begin");await b.query("set statement_timeout='5s';set deadlock_timeout='100ms'");
   if(mode==='billed-edit')assert.equal((await editReceipt(a,old,orange)).ledgerSync.code,'REBOOKED');
   if(mode==='payment')await a.query("update ledger_payables set status='paid'");
   if(mode==='allocation')await a.query('insert into ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount) select p.id,p.expense_transaction_id,1 from ledger_payables p');
   if(mode==='month-close'){await a.query("select pg_advisory_xact_lock(hashtext('ledger_month_close:2026-10'))");await a.query("insert into ledger_month_closures(month) values('2026-10-01')");}
   const pid=(await one(b,'select pg_backend_pid() as pid')).pid;
   pending=editReceipt(b,old,{...orange,billed_amount:302000});pending.catch(()=>{});
   await blocked(db,pid);await a.query('commit');
   const result=await pending;
   if(mode==='billed-edit')assert.equal(result.status,'quantity_conflict');
   else{assert.equal(result.status,'purchase_correction_review_required');assert.equal(result.blockReason,{payment:'payment_completed',allocation:'payment_allocated','month-close':'month_closed'}[mode]);}
   const edits=mode==='billed-edit'?1:0;
   assert.equal(Number((await one(db,'select count(*) as n from inventory_logs where correction_of_inventory_log_id=100')).n),edits);
   assert.equal(Number((await one(db,"select count(*) as n from ledger_transactions where source_type='inventory_purchase_reversal'")).n),edits);
   assert.equal(Number((await one(db,"select coalesce(sum(amount*economic_effect_sign),0) as n from ledger_transactions")).n),edits?303000:200000);
   assert.equal(Number((await one(db,'select deadlocks from pg_stat_database where datname=current_database()')).deadlocks),0);
  }finally{await a.query('rollback').catch(()=>{});await b.query('rollback').catch(()=>{});if(pending)await pending.catch(()=>{});await a.end();await b.end();await db.close();}
 });
 await t.test('two quick saves of one item: one receipt, one booking, the stale save writes nothing',async()=>{
  const db=await billedFixture(runtime.Database),a=await runtime.connect(db.name),b=await runtime.connect(db.name);let pending;
  try{
   const old=await item(db);await a.query("set statement_timeout='5s';begin");await b.query("set statement_timeout='5s';set deadlock_timeout='100ms'");
   assert.equal((await quickSave(a,old,303000)).status,'ok');
   const pid=(await one(b,'select pg_backend_pid() as pid')).pid;pending=quickSave(b,old,303000);pending.catch(()=>{});
   await blocked(db,pid);await a.query('commit');
   assert.equal((await pending).status,'inventory_conflict');
   assert.equal(Number((await one(db,"select count(*) as n from inventory_logs where billed_amount_mode='manual'")).n),1);
   assert.equal(Number((await one(db,"select count(*) as n from ledger_candidates where source_key<>'inventory-log:100'")).n),1);
   assert.equal(Number((await item(db)).quantity),13.57);
  }finally{await a.query('rollback').catch(()=>{});await b.query('rollback').catch(()=>{});if(pending)await pending.catch(()=>{});await a.end();await b.end();await db.close();}
 });
 }finally{await runtime.stop();}
});
