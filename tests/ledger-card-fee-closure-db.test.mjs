import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { initializePosCloseDatabase } from './helpers/pos-business-day-close-fixture.mjs';

const read=name=>readFileSync(`supabase/migrations/${name}`,'utf8');
const autoMigration=read('20260927144325_add_card_deposit_auto_allocation.sql');
const feeMigration=read('20260927173019_add_card_fee_month_closures.sql');
const cardSettlements=(()=>{
  const testModule={exports:{}};
  new Function('require','module','exports',ts.transpileModule(readFileSync('lib/ledger/card-settlements.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(()=>{throw new Error('card-settlements must stay dependency free');},testModule,testModule.exports);
  return testModule.exports;
})();
const currentMonth=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit'}).format(new Date()).slice(0,7);

// The live preflight is 20260916080015's definition patched in place by 20260921170100
// (payment verification). Install exactly that chain; the rest of 20260921170100 patches
// inventory functions this fixture does not have.
const preflightDefinition=(()=>{const text=read('20260916080015_preserve_cancelled_recurring_expenses.sql');const start=text.indexOf('create or replace function public.ledger_close_preflight_v1(');return text.slice(start,text.indexOf('\nend$$;',start)+'\nend$$;'.length);})();
const paymentVerificationPreflightPatch=(()=>{
  const text=read('20260921170100_add_inventory_payment_verification.sql');
  const start=text.indexOf("  v_oid := 'public.ledger_close_preflight_v1(date,bigint)'::regprocedure;");
  const end=text.indexOf('  execute v_definition;\nend;\n$payment_verification$;',start);
  assert.ok(start>0&&end>start,'payment verification preflight patch not found');
  return `do $pv$\ndeclare v_oid regprocedure; v_definition text;\nbegin\n${text.slice(start,end)}  execute v_definition;\nend;\n$pv$;`;
})();
async function installLatestPreflight(db){
  await db.exec(preflightDefinition);
  await db.exec(paymentVerificationPreflightPatch);
}
async function database({fee=true,latestPreflight=true}={}){
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
    if(latestPreflight)await installLatestPreflight(db);
    await db.exec(autoMigration);
    if(fee)await db.exec(feeMigration);
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
const autoDeposit=async(db,amount,date)=>call(db,'ledger_create_card_deposit_auto_allocate_v1',[`${date}T12:00:00+07:00`,amount,await bankId(db),'auto',1]);
const legacyDeposit=async(db,amount,date)=>call(db,'ledger_create_card_deposit_v1',[`${date}T12:00:00+07:00`,amount,await bankId(db),'legacy','legacy',1]);
const confirmFee=(db,month,actor=1,memo='fixture')=>call(db,'ledger_confirm_card_fee_month_v1',[month,memo,actor]);
const cancelFee=(db,id,reason='wrong',actor=1)=>call(db,'ledger_cancel_card_fee_month_v1',[id,reason,actor]);
const count=async(db,sql,args=[])=>Number((await db.query(sql,args)).rows[0].n);
const counts=async db=>({
  transactions:await count(db,'select count(*) n from ledger_transactions'),
  movements:await count(db,'select count(*) n from ledger_movements'),
  closures:await count(db,'select count(*) n from ledger_card_fee_closures'),
  lines:await count(db,'select count(*) n from ledger_card_fee_allocation_lines'),
  audits:await count(db,'select count(*) n from ledger_audit_logs'),
});
const balance=async(db,code)=>Number((await db.query(`select coalesce(sum(m.amount),0) n from ledger_movements m join ledger_transactions t on t.id=m.transaction_id and t.status='confirmed' join ledger_fund_accounts f on f.id=m.fund_account_id where f.code=$1`,[code])).rows[0].n);
const outstanding=async db=>(await db.query(`select t.id,t.business_date::text business_date,t.amount,t.amount-public.ledger_card_sale_consumed_v1(t.id) outstanding from ledger_transactions t where t.source_type='pos_sales_daily_payment' order by t.business_date,t.id`)).rows.map(row=>({id:Number(row.id),business_date:row.business_date,amount:Number(row.amount),outstandingGrossAmount:Number(row.outstanding)}));
// The TS contract: deposit lines + active fee lines (as card_fee lines) give the same outstanding as SQL.
async function jsOutstanding(db){
  const sales=(await outstanding(db)).map(({id,business_date,amount})=>({id,business_date,amount}));
  const recon=(await db.query(`select l.reconciliation_id,l.pos_card_transaction_id,l.allocated_gross_amount,r.status,r.deposit_date::text deposit_date from ledger_card_reconciliation_lines l join ledger_card_reconciliations r on r.id=l.reconciliation_id`)).rows
    .map(row=>({reconciliation_id:Number(row.reconciliation_id),pos_card_transaction_id:Number(row.pos_card_transaction_id),allocated_gross_amount:Number(row.allocated_gross_amount),reconciliation:{status:row.status,deposit_date:row.deposit_date}}));
  const fee=(await db.query(`select f.id,f.closure_id,f.pos_card_transaction_id,f.allocated_fee_amount,c.status,c.fee_month::text fee_month from ledger_card_fee_allocation_lines f join ledger_card_fee_closures c on c.id=f.closure_id`)).rows
    .map(row=>({id:Number(row.id),closure_id:Number(row.closure_id),pos_card_transaction_id:Number(row.pos_card_transaction_id),allocated_fee_amount:Number(row.allocated_fee_amount),closure:{status:row.status,fee_month:row.fee_month}}));
  return cardSettlements.calculateCardGross(sales,[...recon,...cardSettlements.cardFeeRowsAsAllocationLines(fee)],'1900-01-01','2999-01-01').sales.map(sale=>sale.outstandingGrossAmount);
}

test('confirming a month books its remaining card gross once as fee, consumes it FIFO and reaches card clearing only',async()=>{
  const db=await database();
  try{
    const sale10=await seedSale(db,1000,'2026-08-10'),sale20=await seedSale(db,2000,'2026-08-20'),septSale=await seedSale(db,500,'2026-09-02');
    assert.equal((await autoDeposit(db,1500,'2026-08-25')).status,'created');
    // A September deposit still pays August first (FIFO) and lowers August's outstanding.
    assert.equal((await autoDeposit(db,1200,'2026-09-03')).status,'created');
    assert.deepEqual((await outstanding(db)).map(row=>row.outstandingGrossAmount),[0,300,500]);
    const before=await balance(db,'card_clearing');
    const result=await confirmFee(db,'2026-08-01');
    assert.equal(result.status,'confirmed');assert.equal(Number(result.feeAmount),300);
    assert.deepEqual(result.lines.map(row=>[Number(row.transactionId),Number(row.allocatedFeeAmount)]),[[sale20,300]]);
    const closure=(await db.query('select * from ledger_card_fee_closures where id=$1',[result.closureId])).rows[0];
    assert.deepEqual([closure.status,Number(closure.fee_amount),closure.fee_month.toISOString().slice(0,10),Number(closure.confirmed_by),closure.memo],['confirmed',300,'2026-08-01',1,'fixture']);
    const tx=(await db.query('select t.*,c.name category from ledger_transactions t join ledger_categories c on c.id=t.category_id where t.id=$1',[result.expenseTransactionId])).rows[0];
    assert.deepEqual([tx.type,tx.source_type,tx.source_key,Number(tx.amount),tx.category,tx.status],['expense_recognition','card_fee_month_close',`card-fee-closure:${result.closureId}`,300,'카드 정산 차액','confirmed']);
    assert.equal(tx.recognition_month.toISOString().slice(0,10),'2026-08-01');assert.equal(tx.business_date.toISOString().slice(0,10),'2026-08-31');
    const movements=(await db.query('select f.code,m.amount from ledger_movements m join ledger_fund_accounts f on f.id=m.fund_account_id where m.transaction_id=$1',[result.expenseTransactionId])).rows;
    assert.deepEqual(movements.map(row=>[row.code,Number(row.amount)]),[['card_clearing',-300]],'no bank or cash movement');
    assert.equal(await balance(db,'card_clearing'),before-300);
    assert.equal(await count(db,"select count(*) n from ledger_transactions where source_type='card_fee_month_close'"),1);
    assert.equal(await count(db,"select count(*) n from ledger_transactions where source_type='card_settlement_difference'"),0,'historical difference path untouched');
    assert.equal((await db.query("select after_snapshot from ledger_audit_logs where action='card_fee_month_confirmed'")).rows[0].after_snapshot.feeAmount,300);
    assert.deepEqual((await outstanding(db)).map(row=>row.outstandingGrossAmount),[0,0,500]);
    assert.deepEqual(await jsOutstanding(db),[0,0,500],'TS lines contract matches SQL consumption');
    // Fee-consumed gross is never re-paid by later FIFO deposits.
    const later=await autoDeposit(db,100,'2026-09-05');
    assert.deepEqual(later.allocations.map(row=>Number(row.transactionId)),[septSale]);
    await seedSale(db,5000,'2026-09-20'); // keeps card clearing ahead of the eligible (on/before 09-06) gross
    assert.deepEqual(await autoDeposit(db,401,'2026-09-06').then(row=>[row.status,Number(row.availableOutstanding)]),['insufficient_unsettled_card_sales',400]);
    // Nor by legacy manual matching.
    const legacy=await legacyDeposit(db,1,'2026-09-06');
    assert.equal((await call(db,'ledger_match_card_reconciliation_v1',[legacy.reconciliationId,JSON.stringify([{transactionId:sale20,allocatedGrossAmount:1}]),false,1])).status,'gross_overallocated');
    assert.equal(sale10>0,true);
  }finally{await db.close();}
});

test('a fully deposited month confirms a zero fee with no transaction, movement or line',async()=>{
  const db=await database();
  try{
    await seedSale(db,1000,'2026-08-10');
    await autoDeposit(db,1000,'2026-08-15');
    const before=await counts(db);
    const result=await confirmFee(db,'2026-08-01');
    assert.deepEqual([result.status,Number(result.feeAmount),result.expenseTransactionId,result.lines.length],['confirmed',0,null,0]);
    const after=await counts(db);
    assert.deepEqual(after,{...before,closures:before.closures+1,audits:before.audits+1});
    const preflight=await call(db,'ledger_close_preflight_v1',['2026-08-01',1]);
    assert.ok(!preflight.blockers.some(item=>item.code==='CARD_FEE_NOT_CONFIRMED'),'a zero-fee closure still counts as confirmed');
    const cancelled=await cancelFee(db,result.closureId,'recheck');
    assert.deepEqual([cancelled.status,cancelled.reversalTransactionId],['cancelled',null]);
    assert.equal((await counts(db)).transactions,before.transactions);
  }finally{await db.close();}
});

test('confirmation guards: actor, month shape, current/future/closed months, duplicates, legacy deposits, earlier months, no sales, clearing balance',async()=>{
  const db=await database();
  try{
    await seedSale(db,1000,'2026-07-10');await seedSale(db,1000,'2026-08-10');
    const before=await counts(db);
    assert.equal((await confirmFee(db,'2026-08-01',3)).status,'forbidden');
    assert.equal((await confirmFee(db,'2026-08-01',4)).status,'forbidden');
    assert.equal((await confirmFee(db,'2026-08-15')).status,'invalid_month');
    assert.equal((await confirmFee(db,`${currentMonth}-01`)).status,'current_month');
    const next=new Date(`${currentMonth}-01T00:00:00Z`);next.setUTCMonth(next.getUTCMonth()+1);
    assert.equal((await confirmFee(db,next.toISOString().slice(0,10))).status,'future_month');
    // July is open with outstanding gross and no closure, so August must wait (FIFO order).
    assert.deepEqual(await confirmFee(db,'2026-08-01'),{status:'earlier_month_unconfirmed',month:'2026-07-01'});
    assert.equal((await confirmFee(db,'2026-06-01')).status,'no_card_sales');
    assert.deepEqual(await counts(db),before,'rejections write nothing');
    const july=await confirmFee(db,'2026-07-01');assert.equal(Number(july.feeAmount),1000);
    assert.equal((await confirmFee(db,'2026-07-01')).status,'already_confirmed');
    // A legacy deposit that could still pay August sales blocks August; one dated before August does not.
    const legacy=await legacyDeposit(db,100,'2026-08-20');
    assert.deepEqual(await confirmFee(db,'2026-08-01'),{status:'legacy_unallocated_deposits',count:1,amount:100});
    await call(db,'ledger_cancel_card_reconciliation_v1',[legacy.reconciliationId,'fixture',1]);
    await db.exec("insert into ledger_month_closures(month,status) values('2026-08-01','closed')");
    assert.equal((await confirmFee(db,'2026-08-01')).status,'month_closed');
  }finally{await db.close();}
});

test('closed earlier months never block, and card clearing must cover the fee',async()=>{
  const db=await database();
  try{
    await seedSale(db,1000,'2026-06-10');await seedSale(db,1000,'2026-08-10');
    await db.exec("insert into ledger_month_closures(month,status) values('2026-06-01','closed')");
    // A legacy deposit dated before August drew clearing down without allocating August sales.
    await legacyDeposit(db,1900,'2026-07-31');
    const result=await confirmFee(db,'2026-08-01');
    assert.deepEqual({status:result.status,balance:Number(result.pendingBalance),fee:Number(result.feeAmount)},{status:'insufficient_card_pending',balance:100,fee:1000});
  }finally{await db.close();}
});

test('a mid-transaction failure rolls back the whole confirmation',async()=>{
  const db=await database();
  try{
    await seedSale(db,1000,'2026-08-10');
    const before=await counts(db);
    await db.exec(`create function fail_fee_audit() returns trigger language plpgsql as $$ begin
      if new.action='card_fee_month_confirmed' then raise exception 'audit sink down'; end if; return new; end $$;
      create trigger fail_fee_audit before insert on ledger_audit_logs for each row execute function fail_fee_audit();`);
    await assert.rejects(confirmFee(db,'2026-08-01'),/audit sink down/);
    assert.deepEqual(await counts(db),before);
    assert.equal(await balance(db,'card_clearing'),1000);
  }finally{await db.close();}
});

test('fee allocation consumes only the target month, oldest first, and totals the fee',async()=>{
  const db=await database();
  try{
    const a=await seedSale(db,700,'2026-08-03'),b=await seedSale(db,500,'2026-08-01'),c=await seedSale(db,300,'2026-08-31');await seedSale(db,900,'2026-09-01');
    await autoDeposit(db,200,'2026-08-05');
    const result=await confirmFee(db,'2026-08-01');
    assert.deepEqual(result.lines.map(row=>[Number(row.transactionId),Number(row.allocatedFeeAmount)]),[[b,300],[a,700],[c,300]]);
    assert.equal(Number(result.feeAmount),1300);
    assert.equal(await count(db,'select sum(allocated_fee_amount) n from ledger_card_fee_allocation_lines where closure_id=$1',[result.closureId]),1300);
    assert.deepEqual((await outstanding(db)).map(row=>row.outstandingGrossAmount),[0,0,0,900],'September untouched');
    const preflight=await call(db,'ledger_close_preflight_v1',['2026-08-01',1]);
    assert.ok(!preflight.blockers.some(item=>item.code==='CARD_OVERALLOCATED'));
  }finally{await db.close();}
});

test('cancelling a fee reverses the expense, restores card clearing and outstanding, and keeps history',async()=>{
  const db=await database();
  try{
    const sale=await seedSale(db,1000,'2026-08-10');
    await autoDeposit(db,700,'2026-08-20');
    const confirmed=await confirmFee(db,'2026-08-01');
    const clearingAfterFee=await balance(db,'card_clearing');
    assert.equal((await cancelFee(db,confirmed.closureId,'   ')).status,'reason_required');
    assert.equal((await cancelFee(db,confirmed.closureId,'x',3)).status,'forbidden');
    const cancelled=await cancelFee(db,confirmed.closureId,'more deposits arrived');
    assert.equal(cancelled.status,'cancelled');
    const reversal=(await db.query('select * from ledger_transactions where id=$1',[cancelled.reversalTransactionId])).rows[0];
    assert.deepEqual([reversal.source_type,Number(reversal.economic_effect_sign),Number(reversal.correction_of_id),Number(reversal.amount),reversal.recognition_month.toISOString().slice(0,10)],['card_fee_month_close_reversal',-1,Number(confirmed.expenseTransactionId),300,'2026-08-01']);
    assert.equal(await balance(db,'card_clearing'),clearingAfterFee+300);
    assert.equal(await count(db,"select coalesce(sum(amount*economic_effect_sign),0) n from ledger_transactions where source_type in('card_fee_month_close','card_fee_month_close_reversal')"),0,'net expense is zero');
    assert.deepEqual((await outstanding(db)).map(row=>row.outstandingGrossAmount),[300]);
    const closure=(await db.query('select status,cancel_reason,cancelled_by,(select count(*) from ledger_card_fee_allocation_lines where closure_id=c.id) line_count from ledger_card_fee_closures c where id=$1',[confirmed.closureId])).rows[0];
    assert.deepEqual([closure.status,closure.cancel_reason,Number(closure.cancelled_by),Number(closure.line_count)],['cancelled','more deposits arrived',1,1]);
    assert.equal((await db.query("select before_snapshot from ledger_audit_logs where action='card_fee_month_cancelled'")).rows[0].before_snapshot.lines.length,1);
    assert.equal((await cancelFee(db,confirmed.closureId,'again')).status,'already_cancelled');
    // Re-confirm after more deposits: the released gross is consumed afresh.
    await autoDeposit(db,100,'2026-09-02');
    const again=await confirmFee(db,'2026-08-01');
    assert.deepEqual([again.status,Number(again.feeAmount),again.lines.map(row=>Number(row.transactionId))],['confirmed',200,[sale]]);
    await db.exec("insert into ledger_month_closures(month,status) values('2026-08-01','closed')");
    assert.equal((await cancelFee(db,again.closureId,'too late')).status,'month_closed');
  }finally{await db.close();}
});

test('month-close preflight requires a confirmed fee for months with card sales and hashes fee state',async()=>{
  const db=await database();
  try{
    await seedSale(db,1000,'2026-08-10');
    await autoDeposit(db,800,'2026-08-20');
    let preflight=await call(db,'ledger_close_preflight_v1',['2026-08-01',1]);
    assert.deepEqual(preflight.blockers.filter(item=>item.code==='CARD_FEE_NOT_CONFIRMED'),[{code:'CARD_FEE_NOT_CONFIRMED',amount:200}]);
    const unconfirmedHash=preflight.preflightHash;
    const confirmed=await confirmFee(db,'2026-08-01');
    preflight=await call(db,'ledger_close_preflight_v1',['2026-08-01',1]);
    assert.ok(!preflight.blockers.some(item=>item.code==='CARD_FEE_NOT_CONFIRMED'));
    const confirmedHash=preflight.preflightHash;assert.notEqual(confirmedHash,unconfirmedHash);
    await cancelFee(db,confirmed.closureId,'recheck');
    preflight=await call(db,'ledger_close_preflight_v1',['2026-08-01',1]);
    assert.deepEqual(preflight.blockers.filter(item=>item.code==='CARD_FEE_NOT_CONFIRMED'),[{code:'CARD_FEE_NOT_CONFIRMED',amount:200}]);
    assert.notEqual(preflight.preflightHash,confirmedHash);assert.notEqual(preflight.preflightHash,unconfirmedHash,'cancelled history changes the hash');
    // A month with no card gross needs no fee closure (sale rows are always positive).
    assert.ok(!(await call(db,'ledger_close_preflight_v1',['2026-07-01',1])).blockers.some(item=>item.code==='CARD_FEE_NOT_CONFIRMED'));
  }finally{await db.close();}
});

test('POS card sales cannot shrink below consumption or change inside a fee-confirmed month',async()=>{
  const db=await database();
  try{
    const sale=await seedSale(db,1000,'2026-08-10');const open=await seedSale(db,1000,'2026-09-10');
    await autoDeposit(db,600,'2026-09-12');
    await assert.rejects(db.query('update ledger_transactions set amount=500 where id=$1',[sale]),/CARD_SALE_BELOW_ALLOCATED/);
    await db.query('update ledger_transactions set amount=1200 where id=$1',[open]);
    await confirmFee(db,'2026-08-01');
    await assert.rejects(db.query('update ledger_transactions set amount=1500 where id=$1',[sale]),/CARD_FEE_MONTH_CONFIRMED/);
    await assert.rejects(seedSale(db,50,'2026-08-11'),/CARD_FEE_MONTH_CONFIRMED/);
    const lock=feeMigration.slice(feeMigration.indexOf('create or replace function public.sales_close_business_day_v1('));
    assert.match(lock,/from public\.ledger_card_fee_allocation_lines f[\s\S]*c\.status <> 'cancelled'[\s\S]*c\.fee_month = date_trunc\('month', p_business_date\)::date[\s\S]*'card_settlement_locked'/);
  }finally{await db.close();}
});

test('the migration leaves existing card data unchanged and creates no closures',async()=>{
  const db=await database({fee:false});
  try{
    const a=await seedSale(db,1000,'2026-08-10');await seedSale(db,1000,'2026-08-11');
    const matched=await legacyDeposit(db,980,'2026-08-15');
    await call(db,'ledger_match_card_reconciliation_v1',[matched.reconciliationId,JSON.stringify([{transactionId:a,allocatedGrossAmount:1000}]),true,1]);
    await autoDeposit(db,500,'2026-08-20');
    const snapshot=async()=>({recs:(await db.query('select * from ledger_card_reconciliations order by id')).rows,lines:(await db.query('select * from ledger_card_reconciliation_lines order by id')).rows,txs:(await db.query('select * from ledger_transactions order by id')).rows});
    const before=await snapshot();
    await db.exec(feeMigration);
    assert.deepEqual(await snapshot(),before);
    assert.equal(await count(db,'select count(*) n from ledger_card_fee_closures'),0);
    // Historical matched difference stays; the new fee only takes what is still outstanding.
    const fee=await confirmFee(db,'2026-08-01');
    assert.equal(Number(fee.feeAmount),500);
    assert.equal(await count(db,"select count(*) n from ledger_transactions where source_type='card_settlement_difference'"),1);
    assert.deepEqual(await outstanding(db).then(rows=>rows.map(row=>row.outstandingGrossAmount)),[0,0]);
  }finally{await db.close();}
});

// Payables for the preflight regression tests: an expense (optionally verification-pending)
// with a payable, optionally paid by a payable_payment on a given date.
async function seedPayable(db,{id,amount,date,pending=false,paidOn=null}){
  const expense=Number((await db.query(`insert into ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,status,source_type,source_key,source_snapshot,source_fingerprint,source_synced_at,created_by,confirmed_by)
    values(gen_random_uuid(),'expense',$1::date,$1::date,date_trunc('month',$1::date)::date,$2,(select id from ledger_categories where kind='expense' limit 1),'confirmed','fixture_purchase','fixture:'||$3,$4::jsonb,md5($3::text),now(),1,1) returning id`,
    [date,amount,String(id),JSON.stringify(pending?{paymentVerification:'pending'}:{})])).rows[0].id);
  await db.query("insert into ledger_payables(id,original_amount,status,expense_transaction_id) values($1,$2,'open',$3)",[id,amount,expense]);
  if(paidOn){
    const payment=Number((await db.query(`insert into ledger_transactions(operation_id,type,occurred_at,business_date,amount,status,source_type,source_key,source_snapshot,source_fingerprint,source_synced_at,created_by,confirmed_by)
      values(gen_random_uuid(),'payable_payment',$1::date,$1::date,$2,'confirmed','fixture_payment','fixture-payment:'||$3,'{}',md5('p'||$3::text),now(),1,1) returning id`,[paidOn,amount,String(id)])).rows[0].id);
    await db.query('insert into ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount) values($1,$2,$3)',[id,payment,amount]);
  }
}
const codes=items=>items.map(item=>item.code).sort();

test('card fee preflight patch keeps payment-verification blockers and warnings alongside CARD_FEE_NOT_CONFIRMED',async()=>{
  const db=await database();
  try{
    await seedSale(db,1000,'2026-08-10');await autoDeposit(db,800,'2026-08-20');
    await seedPayable(db,{id:1,amount:5000,date:'2026-08-12',pending:true});
    await seedPayable(db,{id:2,amount:7000,date:'2026-08-13',pending:true,paidOn:'2026-09-03'});
    await seedPayable(db,{id:3,amount:900,date:'2026-08-14'});
    const preflight=await call(db,'ledger_close_preflight_v1',['2026-08-01',1]);
    const blocker=code=>preflight.blockers.find(item=>item.code===code);
    const warning=code=>preflight.warnings.find(item=>item.code===code);
    assert.deepEqual(blocker('PAYMENT_VERIFICATION_UNRESOLVED'),{code:'PAYMENT_VERIFICATION_UNRESOLVED',count:1,amount:5000});
    assert.deepEqual(warning('PAYMENT_VERIFICATION_LATER_PAID'),{code:'PAYMENT_VERIFICATION_LATER_PAID',count:1,amount:7000});
    // Ordinary outstanding excludes both verification payables (no double counting).
    assert.deepEqual(warning('PAYABLE_OUTSTANDING'),{code:'PAYABLE_OUTSTANDING',amount:900});
    assert.deepEqual(blocker('CARD_FEE_NOT_CONFIRMED'),{code:'CARD_FEE_NOT_CONFIRMED',amount:200});
    // Confirming and cancelling the fee change only the card fee part and the hash.
    const confirmed=await confirmFee(db,'2026-08-01');
    const afterConfirm=await call(db,'ledger_close_preflight_v1',['2026-08-01',1]);
    assert.ok(!afterConfirm.blockers.some(item=>item.code==='CARD_FEE_NOT_CONFIRMED'));
    assert.deepEqual(codes(afterConfirm.blockers),codes(preflight.blockers).filter(code=>code!=='CARD_FEE_NOT_CONFIRMED'));
    assert.deepEqual(afterConfirm.warnings,preflight.warnings);
    assert.notEqual(afterConfirm.preflightHash,preflight.preflightHash);
    await cancelFee(db,confirmed.closureId,'recheck');
    const afterCancel=await call(db,'ledger_close_preflight_v1',['2026-08-01',1]);
    assert.deepEqual(codes(afterCancel.blockers),codes(preflight.blockers));
    assert.notEqual(afterCancel.preflightHash,afterConfirm.preflightHash);
    assert.notEqual(afterCancel.preflightHash,preflight.preflightHash,'cancelled fee history is part of the hash');
  }finally{await db.close();}
});

test('the patched preflight keeps every earlier blocker/warning contract and refuses a stale baseline',async()=>{
  const db=await database();
  try{
    const definition=(await db.query("select pg_get_functiondef('public.ledger_close_preflight_v1(date,bigint)'::regprocedure) d")).rows[0].d;
    for(const code of['CURRENT_MONTH','FUTURE_MONTH','ALREADY_CLOSED','PENDING_CANDIDATES','PAYROLL_NOT_COMPLETED','RECURRING_NOT_SYNCED','CANDIDATE_LINK_BROKEN','TRANSFER_UNBALANCED','REQUIRED_MOVEMENT_MISSING','PAYABLE_OVERALLOCATED','CARD_OVERALLOCATED','DUPLICATE_ACTIVE_SOURCE','CARD_UNMATCHED','CARD_FEE_NOT_CONFIRMED','PAYABLE_OUTSTANDING','BALANCE_ADJUSTMENT','RESERVE_SHORTFALL','CONFIRMED_SOURCE_DRIFT','PAYMENT_VERIFICATION_UNRESOLVED','PAYMENT_VERIFICATION_LATER_PAID'])assert.ok(definition.includes(`'${code}'`),code);
    assert.match(definition,/coalesce\(t\.source_snapshot->>'paymentVerification',''\)<>'pending'/);
    assert.match(definition,/t\.status in\('confirmed','cancelled'\)/,'cancelled recurring expenses still count as synced (20260916080015)');
    assert.match(definition,/'cardFeeState'/);assert.match(definition,/public\.ledger_card_sale_consumed_v1\(t\.id\)>t\.amount/);
    assert.equal((definition.match(/CARD_FEE_NOT_CONFIRMED/g)||[]).length,1);
  }finally{await db.close();}
  // Without the payment-verification baseline the migration aborts instead of dropping that contract.
  const stale=await database({fee:false,latestPreflight:false});
  try{
    await assert.rejects(stale.exec(feeMigration),/CARD_FEE_PREFLIGHT_BASELINE_MISSING_PAYMENT_VERIFICATION/);
    assert.equal(Number((await stale.query("select count(*) n from pg_class where relname='ledger_card_fee_closures'")).rows[0].n),0,'nothing from the migration is left behind');
  }finally{await stale.close();}
});
