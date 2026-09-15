import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { initializePosCloseDatabase } from './helpers/pos-business-day-close-fixture.mjs';

const cancellationMigration=readFileSync('supabase/migrations/20260915093246_add_card_reconciliation_cancellation.sql','utf8');

async function database(){
  const db=new PGlite();
  try{
    await initializePosCloseDatabase(db);
    await db.exec(`alter table ledger_transactions add column economic_effect_sign smallint not null default 1;
      alter table ledger_transactions drop constraint ledger_transaction_recognition_policy;
      alter table ledger_transactions add constraint ledger_transaction_recognition_policy check(
        (type in('income','expense','sales','expense_recognition') and recognition_month is not null and recognition_month=date_trunc('month',recognition_month)::date and category_id is not null)
        or(type not in('income','expense','sales','expense_recognition') and recognition_month is null and category_id is null));`);
    await db.exec(cancellationMigration);
    await db.exec(`alter table ledger_candidates add column updated_at timestamptz default now(), add column resolved_transaction_id bigint;
      create table payroll_payment_batches(payroll_month date,status text);
      create table ledger_recurring_expense_plans(id bigint primary key,effective_from date,effective_to date);
      create table ledger_payables(id bigint primary key,original_amount numeric,status text,expense_transaction_id bigint);
      create table ledger_payable_allocations(payable_id bigint,payment_transaction_id bigint,allocated_amount numeric);
      create table ledger_reserve_plans(id bigint primary key,is_active boolean,target_amount numeric);
      create table ledger_reserve_entries(reserve_plan_id bigint,entry_type text,amount numeric,occurred_at timestamptz);`);
    return db;
  }catch(error){await db.close();throw error;}
}

async function call(db,name,args){
  const placeholders=args.map((_,index)=>`$${index+1}`).join(',');
  return (await db.query(`select public.${name}(${placeholders}) result`,args)).rows[0].result;
}

async function seedSale(db,id,amount,date='2026-08-10'){
  await db.query(`insert into ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,status,source_type,source_key,source_snapshot,source_fingerprint,source_synced_at,created_by,confirmed_by)
    values(gen_random_uuid(),'sales',$1::date,$1::date,date_trunc('month',$1::date)::date,$2,(select id from ledger_categories where kind='income' limit 1),'confirmed','pos_sales_daily_payment','pos:'||$1::date::text||':card','{}',md5($3::text),now(),1,1)`,[date,amount,id]);
  const transaction=(await db.query("select id from ledger_transactions where source_key='pos:'||$1::date::text||':card'",[date])).rows[0].id;
  await db.query("insert into ledger_movements(transaction_id,fund_account_id,amount) values($1,(select id from ledger_fund_accounts where code='card_clearing'),$2)",[transaction,amount]);
  return Number(transaction);
}

async function createDeposit(db,amount,date='2026-08-15'){
  const bank=Number((await db.query("select id from ledger_fund_accounts where type='bank' order by id limit 1")).rows[0].id);
  return call(db,'ledger_create_card_deposit_v1',[`${date}T12:00:00+07:00`,amount,bank,'fixture','fixture',1]);
}

test('unmatched, partial, and matched cancellation append exact reversals while retaining history',async()=>{
  const db=await database();
  try{
    const saleIds=[];
    for(const [id,amount,date] of [[1,500,'2026-08-10'],[2,600,'2026-08-11'],[3,1000,'2026-08-12'],[4,500,'2026-08-13']])saleIds.push(await seedSale(db,id,amount,date));

    const unmatched=await createDeposit(db,500);
    const unmatchedCancel=await call(db,'ledger_cancel_card_reconciliation_v1',[unmatched.reconciliationId,'duplicate unmatched',1]);
    assert.equal(unmatchedCancel.status,'cancelled');

    const partial=await createDeposit(db,500);
    assert.equal((await call(db,'ledger_match_card_reconciliation_v1',[partial.reconciliationId,JSON.stringify([{transactionId:saleIds[1],allocatedGrossAmount:600}]),false,1])).status,'partial');
    assert.equal((await call(db,'ledger_cancel_card_reconciliation_v1',[partial.reconciliationId,'duplicate partial',1])).status,'cancelled');

    const withDifference=await createDeposit(db,980);
    const matchDifference=await call(db,'ledger_match_card_reconciliation_v1',[withDifference.reconciliationId,JSON.stringify([{transactionId:saleIds[2],allocatedGrossAmount:1000}]),true,1]);
    assert.equal(matchDifference.status,'matched');assert.equal(Number(matchDifference.differenceAmount),20);
    const cancelledDifference=await call(db,'ledger_cancel_card_reconciliation_v1',[withDifference.reconciliationId,'duplicate matched',1]);
    assert.equal(cancelledDifference.status,'cancelled');assert.ok(cancelledDifference.depositReversalTransactionId);assert.ok(cancelledDifference.differenceReversalTransactionId);

    const exact=await createDeposit(db,500);
    assert.equal((await call(db,'ledger_match_card_reconciliation_v1',[exact.reconciliationId,JSON.stringify([{transactionId:saleIds[3],allocatedGrossAmount:500}]),true,1])).status,'matched');
    const cancelledExact=await call(db,'ledger_cancel_card_reconciliation_v1',[exact.reconciliationId,'duplicate exact',1]);
    assert.equal(cancelledExact.status,'cancelled');assert.equal(cancelledExact.differenceReversalTransactionId,null);

    const duplicate=await call(db,'ledger_cancel_card_reconciliation_v1',[withDifference.reconciliationId,'again',1]);
    assert.equal(duplicate.status,'already_cancelled');
    const reversalCount=Number((await db.query("select count(*) n from ledger_transactions where source_type like 'card_settlement_%_reversal'")).rows[0].n);
    assert.equal(reversalCount,5);

    const recs=(await db.query(`select status,cancel_reason,cancelled_by,cancelled_at,confirmed_at,confirmed_by,difference_amount,
      (select count(*) from ledger_card_reconciliation_lines l where l.reconciliation_id=r.id) line_count
      from ledger_card_reconciliations r order by id`)).rows;
    assert.deepEqual(recs.map(row=>row.status),['cancelled','cancelled','cancelled','cancelled']);
    assert.ok(recs.every(row=>row.cancelled_at&&Number(row.cancelled_by)===1&&row.cancel_reason));
    assert.equal(Number(recs[1].line_count),1);assert.equal(Number(recs[2].line_count),1);
    assert.ok(recs[2].confirmed_at);assert.equal(Number(recs[2].confirmed_by),1);assert.equal(Number(recs[2].difference_amount),20);

    const activeAllocated=Number((await db.query(`select coalesce(sum(l.allocated_gross_amount),0) amount from ledger_card_reconciliation_lines l join ledger_card_reconciliations r on r.id=l.reconciliation_id where r.status<>'cancelled'`)).rows[0].amount);
    assert.equal(activeAllocated,0);
    const balances=(await db.query(`select f.code,coalesce(sum(m.amount),0) balance from ledger_fund_accounts f left join ledger_movements m on m.fund_account_id=f.id left join ledger_transactions t on t.id=m.transaction_id and t.status='confirmed' where f.code in('card_clearing','baba_corporate_bank') group by f.code order by f.code`)).rows;
    assert.equal(Number(balances.find(row=>row.code==='card_clearing').balance),2600);
    assert.equal(Number(balances.find(row=>row.code==='baba_corporate_bank').balance),0);
    const expenseNet=Number((await db.query("select coalesce(sum(amount*economic_effect_sign),0) amount from ledger_transactions where source_type in('card_settlement_difference','card_settlement_difference_reversal')")).rows[0].amount);
    assert.equal(expenseNet,0);
    const corrections=(await db.query("select source_type,correction_of_id,economic_effect_sign from ledger_transactions where source_type like 'card_settlement_%_reversal' order by id")).rows;
    assert.ok(corrections.every(row=>row.correction_of_id&&Number(row.economic_effect_sign)===-1));
    assert.equal(Number((await db.query("select count(*) n from ledger_audit_logs where action='card_reconciliation_cancelled'")).rows[0].n),4);
  }finally{await db.close();}
});

test('closed deposit month blocks create, match, and cancel before any reversal',async()=>{
  const db=await database();
  try{
    await seedSale(db,1,3000,'2026-07-10');
    const juneSale=await seedSale(db,2,1000,'2026-06-10');
    const juneDeposit=await createDeposit(db,900,'2026-06-15');
    await db.exec("insert into ledger_month_closures(month,status) values('2026-06-01','closed'),('2026-07-01','closed')");
    assert.equal((await createDeposit(db,500,'2026-07-15')).status,'month_closed');
    assert.equal((await call(db,'ledger_match_card_reconciliation_v1',[juneDeposit.reconciliationId,JSON.stringify([{transactionId:juneSale,allocatedGrossAmount:1000}]),true,1])).status,'month_closed');
    assert.equal((await call(db,'ledger_cancel_card_reconciliation_v1',[juneDeposit.reconciliationId,'closed',1])).status,'month_closed');
    assert.equal(Number((await db.query("select count(*) n from ledger_transactions where source_type like 'card_settlement_%_reversal'")).rows[0].n),0);
  }finally{await db.close();}
});

test('preflight blocks incomplete real deposits and excludes cancelled allocation lines',async()=>{
  const db=await database();
  try{
    const sale=await seedSale(db,1,600,'2026-08-10');
    const first=await createDeposit(db,500);
    assert.equal((await call(db,'ledger_match_card_reconciliation_v1',[first.reconciliationId,JSON.stringify([{transactionId:sale,allocatedGrossAmount:600}]),false,1])).status,'partial');
    let preflight=await call(db,'ledger_close_preflight_v1',['2026-08-01',1]);
    let incomplete=preflight.blockers.find(item=>item.code==='CARD_UNMATCHED');
    assert.equal(Number(incomplete.count),1);assert.equal(Number(incomplete.amount),500);
    assert.equal(await call(db,'ledger_cancel_card_reconciliation_v1',[first.reconciliationId,'replace allocation',1]).then(result=>result.status),'cancelled');

    const replacement=await createDeposit(db,500);
    assert.equal((await call(db,'ledger_match_card_reconciliation_v1',[replacement.reconciliationId,JSON.stringify([{transactionId:sale,allocatedGrossAmount:600}]),false,1])).status,'partial');
    preflight=await call(db,'ledger_close_preflight_v1',['2026-08-01',1]);
    assert.ok(preflight.blockers.some(item=>item.code==='CARD_UNMATCHED'));
    assert.ok(!preflight.blockers.some(item=>item.code==='CARD_OVERALLOCATED'));

    assert.equal((await call(db,'ledger_cancel_card_reconciliation_v1',[replacement.reconciliationId,'remove replacement',1])).status,'cancelled');
    preflight=await call(db,'ledger_close_preflight_v1',['2026-08-01',1]);
    assert.ok(!preflight.blockers.some(item=>item.code==='CARD_UNMATCHED'));
    assert.ok(!preflight.blockers.some(item=>item.code==='CARD_OVERALLOCATED'));
  }finally{await db.close();}
});
