import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { initializePosCloseDatabase } from './pos-business-day-close-fixture.mjs';

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


export { database,call,seedSale,bankId,autoDeposit,legacyDeposit,confirmFee,cancelFee,counts,count,balance,outstanding,jsOutstanding,currentMonth };
