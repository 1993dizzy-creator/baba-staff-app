import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { initializePosCloseDatabase } from './helpers/pos-business-day-close-fixture.mjs';

const read=name=>readFileSync(`supabase/migrations/${name}`,'utf8');
const autoMigration=read('20260927144325_add_card_deposit_auto_allocation.sql');
const cardSettlements=(()=>{
  const testModule={exports:{}};
  new Function('require','module','exports',ts.transpileModule(readFileSync('lib/ledger/card-settlements.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(()=>{throw new Error('card-settlements must stay dependency free');},testModule,testModule.exports);
  return testModule.exports;
})();

// Same schema bootstrap as ledger-card-cancellation-db, optionally stopping before the new migration.
async function database({auto=true}={}){
  const db=new PGlite();
  try{
    await initializePosCloseDatabase(db);
    await db.exec(`alter table ledger_transactions add column economic_effect_sign smallint not null default 1;
      alter table ledger_transactions drop constraint ledger_transaction_recognition_policy;
      alter table ledger_transactions add constraint ledger_transaction_recognition_policy check(
        (type in('income','expense','sales','expense_recognition') and recognition_month is not null and recognition_month=date_trunc('month',recognition_month)::date and category_id is not null)
        or(type not in('income','expense','sales','expense_recognition') and recognition_month is null and category_id is null));`);
    await db.exec(read('20260915095952_add_card_reconciliation_cancellation.sql'));
    await db.exec(read('20260915103312_prevent_future_card_sale_matching.sql'));
    await db.exec(`alter table ledger_candidates add column updated_at timestamptz default now(), add column resolved_transaction_id bigint;
      create table payroll_payment_batches(payroll_month date,status text);
      create table ledger_recurring_expense_plans(id bigint primary key,effective_from date,effective_to date);
      create table ledger_payables(id bigint primary key,original_amount numeric,status text,expense_transaction_id bigint);
      create table ledger_payable_allocations(payable_id bigint,payment_transaction_id bigint,allocated_amount numeric);
      create table ledger_reserve_plans(id bigint primary key,is_active boolean,target_amount numeric);
      create table ledger_reserve_entries(reserve_plan_id bigint,entry_type text,amount numeric,occurred_at timestamptz);`);
    if(auto)await db.exec(autoMigration);
    return db;
  }catch(error){await db.close();throw error;}
}
async function call(db,name,args){
  const placeholders=args.map((_,index)=>`$${index+1}`).join(',');
  return (await db.query(`select public.${name}(${placeholders}) result`,args)).rows[0].result;
}
async function seedSale(db,amount,date){
  await db.query(`insert into ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,status,source_type,source_key,source_snapshot,source_fingerprint,source_synced_at,created_by,confirmed_by)
    values(gen_random_uuid(),'sales',$1::date,$1::date,date_trunc('month',$1::date)::date,$2,(select id from ledger_categories where kind='income' limit 1),'confirmed','pos_sales_daily_payment','pos:'||$1::date::text||':card','{}',md5($1::text),now(),1,1)`,[date,amount]);
  const id=Number((await db.query("select id from ledger_transactions where source_key='pos:'||$1::date::text||':card'",[date])).rows[0].id);
  await db.query("insert into ledger_movements(transaction_id,fund_account_id,amount) values($1,(select id from ledger_fund_accounts where code='card_clearing'),$2)",[id,amount]);
  return id;
}
const bankId=async db=>Number((await db.query("select id from ledger_fund_accounts where code='baba_corporate_bank'")).rows[0].id);
const autoDeposit=async(db,amount,date,options={})=>call(db,'ledger_create_card_deposit_auto_allocate_v1',[`${date}T12:00:00+07:00`,amount,'destination' in options?options.destination:await bankId(db),options.memo??'auto',options.actor??1]);
const legacyDeposit=async(db,amount,date)=>call(db,'ledger_create_card_deposit_v1',[`${date}T12:00:00+07:00`,amount,await bankId(db),'legacy','legacy',1]);
const count=async(db,sql)=>Number((await db.query(sql)).rows[0].n);
const counts=async db=>({
  transactions:await count(db,'select count(*) n from ledger_transactions'),
  movements:await count(db,'select count(*) n from ledger_movements'),
  reconciliations:await count(db,'select count(*) n from ledger_card_reconciliations'),
  lines:await count(db,'select count(*) n from ledger_card_reconciliation_lines'),
  audits:await count(db,'select count(*) n from ledger_audit_logs'),
});
const balance=async(db,code)=>Number((await db.query(`select coalesce(sum(m.amount),0) n from ledger_movements m join ledger_transactions t on t.id=m.transaction_id and t.status='confirmed' join ledger_fund_accounts f on f.id=m.fund_account_id where f.code=$1`,[code])).rows[0].n);
// The same outstanding the card-settlements GET computes: sale gross less non-cancelled allocations.
const outstandingSales=async db=>(await db.query(`select t.id,t.business_date::text business_date,t.amount-coalesce((select sum(l.allocated_gross_amount) from ledger_card_reconciliation_lines l join ledger_card_reconciliations r on r.id=l.reconciliation_id where l.pos_card_transaction_id=t.id and r.status<>'cancelled'),0) outstanding
  from ledger_transactions t where t.source_type='pos_sales_daily_payment' order by t.business_date,t.id`)).rows.map(row=>({id:Number(row.id),business_date:row.business_date,outstandingGrossAmount:Number(row.outstanding)}));

test('auto deposit atomically writes transaction, movements, auto_allocated reconciliation, FIFO lines and audit into the corporate bank',async()=>{
  const db=await database();
  try{
    const sale14=await seedSale(db,6_245_400,'2026-09-14'),sale15=await seedSale(db,14_606_200,'2026-09-15');
    const plan=cardSettlements.planCardDepositAutoAllocation(await outstandingSales(db),10_000_000,'2026-09-15');
    const result=await autoDeposit(db,10_000_000,'2026-09-15');
    assert.equal(result.status,'created');assert.equal(Number(result.totalAllocated),10_000_000);
    // DB FIFO matches the UI preview helper row for row.
    const dbRows=result.allocations.map(row=>({transactionId:Number(row.transactionId),businessDate:row.businessDate,outstandingBefore:Number(row.outstandingBefore),allocatedAmount:Number(row.allocatedAmount),outstandingAfter:Number(row.outstandingAfter)}));
    assert.deepEqual(dbRows,plan.rows);
    assert.deepEqual(dbRows,[
      {transactionId:sale14,businessDate:'2026-09-14',outstandingBefore:6_245_400,allocatedAmount:6_245_400,outstandingAfter:0},
      {transactionId:sale15,businessDate:'2026-09-15',outstandingBefore:14_606_200,allocatedAmount:3_754_600,outstandingAfter:10_851_600},
    ]);
    const rec=(await db.query('select * from ledger_card_reconciliations where id=$1',[result.reconciliationId])).rows[0];
    assert.equal(rec.status,'auto_allocated');assert.equal(Number(rec.deposit_amount),10_000_000);assert.equal(Number(rec.matched_gross_amount),10_000_000);
    assert.equal(Number(rec.difference_amount),0);assert.equal(rec.confirmed_at,null);assert.equal(rec.confirmed_by,null);
    assert.equal(Number(rec.destination_fund_account_id),await bankId(db));assert.equal(Number(rec.deposit_transaction_id),Number(result.transactionId));
    const tx=(await db.query('select * from ledger_transactions where id=$1',[result.transactionId])).rows[0];
    assert.equal(tx.type,'card_settlement_deposit');assert.equal(tx.source_type,'card_settlement_deposit');assert.equal(tx.source_snapshot.allocationMode,'fifo_auto');
    const movements=(await db.query('select f.code,m.amount from ledger_movements m join ledger_fund_accounts f on f.id=m.fund_account_id where m.transaction_id=$1 order by m.id',[result.transactionId])).rows;
    assert.deepEqual(movements.map(row=>[row.code,Number(row.amount)]),[['card_clearing',-10_000_000],['baba_corporate_bank',10_000_000]]);
    assert.equal(await balance(db,'card_clearing'),6_245_400+14_606_200-10_000_000);
    const lines=(await db.query('select pos_card_transaction_id,allocated_gross_amount from ledger_card_reconciliation_lines where reconciliation_id=$1 order by id',[result.reconciliationId])).rows;
    assert.deepEqual(lines.map(row=>[Number(row.pos_card_transaction_id),Number(row.allocated_gross_amount)]),[[sale14,6_245_400],[sale15,3_754_600]]);
    const audit=(await db.query("select * from ledger_audit_logs where action='card_deposit_auto_allocated'")).rows;
    assert.equal(audit.length,1);assert.equal(Number(audit[0].entity_id),Number(result.reconciliationId));assert.equal(audit[0].after_snapshot.status,'auto_allocated');assert.equal(audit[0].after_snapshot.allocations.length,2);
    assert.deepEqual((await outstandingSales(db)).map(row=>row.outstandingGrossAmount),[0,10_851_600]);
  }finally{await db.close();}
});

test('partial single-sale allocation leaves the remaining principal outstanding, not a fee',async()=>{
  const db=await database();
  try{
    const sale=await seedSale(db,6_245_400,'2026-09-14');await seedSale(db,14_606_200,'2026-09-15');
    const result=await autoDeposit(db,5_000_000,'2026-09-15');
    assert.deepEqual(result.allocations.map(row=>[Number(row.transactionId),Number(row.allocatedAmount),Number(row.outstandingAfter)]),[[sale,5_000_000,1_245_400]]);
    assert.equal(await count(db,"select count(*) n from ledger_transactions where source_type='card_settlement_difference' or type='expense_recognition'"),0);
    assert.equal(await count(db,"select count(*) n from ledger_categories c join ledger_transactions t on t.category_id=c.id where c.name='카드 정산 차액'"),0);
  }finally{await db.close();}
});

test('FIFO counts legacy partial lines, excludes sales after the deposit date and cancelled allocations',async()=>{
  const db=await database();
  try{
    const oldSale=await seedSale(db,1000,'2026-09-10'),sale14=await seedSale(db,1000,'2026-09-14');await seedSale(db,5000,'2026-09-16');
    const legacy=await legacyDeposit(db,300,'2026-09-12');
    assert.equal((await call(db,'ledger_match_card_reconciliation_v1',[legacy.reconciliationId,JSON.stringify([{transactionId:oldSale,allocatedGrossAmount:400}]),false,1])).status,'partial');
    const cancelled=await legacyDeposit(db,100,'2026-09-14');
    assert.equal((await call(db,'ledger_match_card_reconciliation_v1',[cancelled.reconciliationId,JSON.stringify([{transactionId:sale14,allocatedGrossAmount:1000}]),false,1])).status,'partial');
    assert.equal((await call(db,'ledger_cancel_card_reconciliation_v1',[cancelled.reconciliationId,'fixture',1])).status,'cancelled');
    // 09/10 has 600 left after the legacy partial line; the cancelled 09/14 line no longer counts; 09/16 is after the deposit.
    const before=await counts(db);
    const tooMuch=await autoDeposit(db,1601,'2026-09-15');
    assert.deepEqual({status:tooMuch.status,available:Number(tooMuch.availableOutstanding)},{status:'insufficient_unsettled_card_sales',available:1600});
    assert.deepEqual(await counts(db),before,'rejection writes nothing');
    const plan=cardSettlements.planCardDepositAutoAllocation(await outstandingSales(db),1600,'2026-09-15');
    const result=await autoDeposit(db,1600,'2026-09-15');
    assert.deepEqual(result.allocations.map(row=>[Number(row.transactionId),Number(row.allocatedAmount)]),[[oldSale,600],[sale14,1000]]);
    assert.deepEqual(result.allocations.map(row=>Number(row.allocatedAmount)),plan.allocations.map(row=>row.allocatedGrossAmount));
  }finally{await db.close();}
});

test('guards: actor, amount, closed month, corporate bank resolution and card clearing balance',async()=>{
  const db=await database();
  try{
    await seedSale(db,1000,'2026-07-10');await seedSale(db,1000,'2026-08-10');
    const before=await counts(db);
    assert.equal((await autoDeposit(db,100,'2026-08-15',{actor:3})).status,'forbidden');
    assert.equal((await autoDeposit(db,100,'2026-08-15',{actor:4})).status,'forbidden');
    for(const amount of[0,-1,'1.0001',null])assert.equal((await autoDeposit(db,amount,'2026-08-15')).status,'invalid_amount',String(amount));
    const cash=Number((await db.query("select id from ledger_fund_accounts where code='store_cash'")).rows[0].id);
    const clearing=Number((await db.query("select id from ledger_fund_accounts where code='card_clearing'")).rows[0].id);
    for(const destination of[cash,clearing,null])assert.equal((await autoDeposit(db,100,'2026-08-15',{destination})).status,'invalid_destination');
    await db.exec("insert into ledger_month_closures(month,status) values('2026-07-01','closed')");
    assert.equal((await autoDeposit(db,100,'2026-07-15')).status,'month_closed');
    await db.exec("update ledger_fund_accounts set is_active=false where code='baba_corporate_bank'");
    assert.equal((await autoDeposit(db,100,'2026-08-15')).status,'corporate_bank_missing');
    await db.exec("update ledger_fund_accounts set is_active=true where code='baba_corporate_bank'");
    assert.deepEqual(await counts(db),before);
    // A legacy unmatched deposit already drew the clearing balance down without allocating any sale.
    await legacyDeposit(db,1800,'2026-08-15');
    const pending=await autoDeposit(db,500,'2026-08-16');
    assert.deepEqual({status:pending.status,balance:Number(pending.pendingBalance)},{status:'insufficient_card_pending',balance:200});
  }finally{await db.close();}
});

test('a mid-transaction failure rolls back every write',async()=>{
  const db=await database();
  try{
    await seedSale(db,1000,'2026-08-10');
    const before=await counts(db);
    await db.exec(`create function fail_auto_audit() returns trigger language plpgsql as $$ begin
      if new.action='card_deposit_auto_allocated' then raise exception 'audit sink down'; end if; return new; end $$;
      create trigger fail_auto_audit before insert on ledger_audit_logs for each row execute function fail_auto_audit();`);
    await assert.rejects(autoDeposit(db,500,'2026-08-15'),/audit sink down/);
    assert.deepEqual(await counts(db),before);
    assert.equal(await balance(db,'card_clearing'),1000);
  }finally{await db.close();}
});

test('sequential deposits cannot overrun a sale and the RPC serializes on the shared card locks',async()=>{
  const db=await database();
  try{
    const sale=await seedSale(db,1000,'2026-08-10');
    await seedSale(db,5000,'2026-08-20'); // keeps card clearing ahead of the eligible (on/before 08-15) sales
    assert.equal((await autoDeposit(db,700,'2026-08-15')).status,'created');
    const second=await autoDeposit(db,400,'2026-08-15');
    assert.equal(second.status,'insufficient_unsettled_card_sales');assert.equal(Number(second.availableOutstanding),300);
    assert.equal((await autoDeposit(db,300,'2026-08-15')).status,'created');
    assert.equal(Number((await db.query("select sum(l.allocated_gross_amount) n from ledger_card_reconciliation_lines l join ledger_card_reconciliations r on r.id=l.reconciliation_id where r.status<>'cancelled' and l.pos_card_transaction_id=$1",[sale])).rows[0].n),1000);
    // PGlite has one connection, so concurrency is asserted structurally: the same month-close and
    // card-clearing advisory locks as create/match/cancel are taken before sale rows are locked and read.
    const body=autoMigration.slice(autoMigration.indexOf('create function public.ledger_create_card_deposit_auto_allocate_v1'),autoMigration.indexOf('-- Legacy manual matching'));
    const order=["hashtext('ledger_month_close:'","hashtext('ledger_card_clearing_balance')",'order by id\n  for update;','into v_available'].map(token=>body.indexOf(token));
    assert.ok(order.every(index=>index>0));assert.deepEqual([...order].sort((a,b)=>a-b),order);
    const preflight=await call(db,'ledger_close_preflight_v1',['2026-08-01',1]);
    assert.ok(!preflight.blockers.some(item=>['CARD_UNMATCHED','CARD_OVERALLOCATED'].includes(item.code)),'auto deposits never block month close');
  }finally{await db.close();}
});

test('auto_allocated rows are immutable to manual matching and cannot carry a fee difference',async()=>{
  const db=await database();
  try{
    const sale=await seedSale(db,1000,'2026-08-10');
    const result=await autoDeposit(db,980,'2026-08-15');
    assert.equal((await call(db,'ledger_match_card_reconciliation_v1',[result.reconciliationId,JSON.stringify([{transactionId:sale,allocatedGrossAmount:1000}]),true,1])).status,'immutable');
    await assert.rejects(db.query('update ledger_card_reconciliations set difference_amount=20,matched_gross_amount=1000 where id=$1',[result.reconciliationId]),/ledger_card_reconciliation_confirmation/);
    await assert.rejects(db.query('update ledger_card_reconciliations set confirmed_at=now(),confirmed_by=1 where id=$1',[result.reconciliationId]),/ledger_card_reconciliation_confirmation/);
    assert.equal(await count(db,"select count(*) n from ledger_transactions where source_type='card_settlement_difference'"),0);
  }finally{await db.close();}
});

test('cancelling an auto deposit reverses both movements, releases its allocations and records audit',async()=>{
  const db=await database();
  try{
    const sale14=await seedSale(db,6_245_400,'2026-09-14');await seedSale(db,14_606_200,'2026-09-15');
    const result=await autoDeposit(db,10_000_000,'2026-09-15');
    const cancelled=await call(db,'ledger_cancel_card_reconciliation_v1',[result.reconciliationId,'wrong amount',1]);
    assert.equal(cancelled.status,'cancelled');assert.ok(cancelled.depositReversalTransactionId);assert.equal(cancelled.differenceReversalTransactionId,null);
    assert.equal(await balance(db,'card_clearing'),6_245_400+14_606_200);
    assert.equal(await balance(db,'baba_corporate_bank'),0);
    assert.deepEqual((await outstandingSales(db)).map(row=>row.outstandingGrossAmount),[6_245_400,14_606_200]);
    const rec=(await db.query('select status,cancel_reason,cancelled_by,(select count(*) from ledger_card_reconciliation_lines l where l.reconciliation_id=r.id) line_count from ledger_card_reconciliations r where id=$1',[result.reconciliationId])).rows[0];
    assert.deepEqual([rec.status,rec.cancel_reason,Number(rec.cancelled_by),Number(rec.line_count)],['cancelled','wrong amount',1,2],'lines are preserved as history');
    const audit=(await db.query("select before_snapshot,after_snapshot from ledger_audit_logs where action='card_reconciliation_cancelled'")).rows;
    assert.equal(audit.length,1);assert.equal(audit[0].before_snapshot.reconciliation.status,'auto_allocated');assert.equal(audit[0].before_snapshot.lines.length,2);
    assert.equal((await call(db,'ledger_cancel_card_reconciliation_v1',[result.reconciliationId,'again',1])).status,'already_cancelled');
    const again=await autoDeposit(db,5_000_000,'2026-09-15');
    assert.deepEqual(again.allocations.map(row=>[Number(row.transactionId),Number(row.allocatedAmount)]),[[sale14,5_000_000]],'released principal is allocatable again');
  }finally{await db.close();}
});

test('the migration leaves existing historical reconciliations and legacy RPC contracts unchanged',async()=>{
  const db=await database({auto:false});
  try{
    const a=await seedSale(db,1000,'2026-08-10'),b=await seedSale(db,1000,'2026-08-11');
    const matched=await legacyDeposit(db,980,'2026-08-15');
    await call(db,'ledger_match_card_reconciliation_v1',[matched.reconciliationId,JSON.stringify([{transactionId:a,allocatedGrossAmount:1000}]),true,1]);
    const partial=await legacyDeposit(db,500,'2026-08-15');
    await call(db,'ledger_match_card_reconciliation_v1',[partial.reconciliationId,JSON.stringify([{transactionId:b,allocatedGrossAmount:400}]),false,1]);
    await legacyDeposit(db,100,'2026-08-16');
    const snapshot=async()=>(await db.query('select r.*,(select jsonb_agg(to_jsonb(l) order by l.id) from ledger_card_reconciliation_lines l where l.reconciliation_id=r.id) lines from ledger_card_reconciliations r order by id')).rows;
    const transactionsBefore=(await db.query('select * from ledger_transactions order by id')).rows;
    const before=await snapshot();
    await db.exec(autoMigration);
    assert.deepEqual(await snapshot(),before);
    assert.deepEqual((await db.query('select * from ledger_transactions order by id')).rows,transactionsBefore);
    assert.deepEqual(before.map(row=>[row.status,Number(row.difference_amount)]),[['matched',20],['partial',0],['unmatched',0]]);
    // Legacy partial rows can still be matched and cancelled after the migration.
    assert.equal((await call(db,'ledger_match_card_reconciliation_v1',[partial.reconciliationId,JSON.stringify([{transactionId:b,allocatedGrossAmount:500}]),true,1])).status,'matched');
    assert.equal((await call(db,'ledger_cancel_card_reconciliation_v1',[matched.reconciliationId,'fixture',1])).status,'cancelled');
    const preflight=await call(db,'ledger_close_preflight_v1',['2026-08-01',1]);
    assert.deepEqual(preflight.blockers.filter(item=>item.code==='CARD_UNMATCHED').map(item=>Number(item.count)),[1],'the untouched legacy unmatched deposit still blocks close');
  }finally{await db.close();}
});
