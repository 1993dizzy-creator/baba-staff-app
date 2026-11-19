// Real migrations, isolated in-memory PostgreSQL only. No credentials/network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { database } from './helpers/inventory-ledger-fixture.mjs';
import { calculatePayableBalances, buildOldestFirstAllocations } from '../lib/ledger/payables.ts';
const read=n=>readFileSync(`supabase/migrations/${n}`,'utf8');
const migration=read('20261119071107_coca_cola_owner_payable_balance_anchor.sql');
const one=async(db,sql,args=[])=> (await db.query(sql,args)).rows[0];
const register=(db,actor=2)=>one(db,"select ledger_register_coca_owner_balance_anchor_v1('Owner instruction 2026-11-19; supplier statement unavailable','Owner basis; source unresolved; no payment correction', $1) as r",[actor]).then(x=>x.r);
const paid=[[389,811,533952,'2026-08-31'],[390,812,576000,'2026-08-31'],[506,1025,700000,'2026-09-13'],[507,1026,711936,'2026-09-13'],[508,1027,732000,'2026-09-13'],[509,1028,768000,'2026-09-13'],[594,1399,700000,'2026-09-19'],[1088,2347,750000,'2026-10-08'],[1101,2362,744000,'2026-10-08']];
const open=[[1526,3131,533952,'2026-10-24'],[1527,3132,576000,'2026-10-24'],[1528,3133,750000,'2026-10-24'],[2122,4907,558000,'2026-11-14'],[2123,4908,750000,'2026-11-14'],[2213,5024,768000,'2026-11-17'],[2214,5025,712000,'2026-11-17']];

async function receipt(db,id,tx,amount,date,party=5){
 await db.query(`insert into ledger_transactions(id,operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,party_id,source_type,created_by,confirmed_by)
 values($1,gen_random_uuid(),'expense',$2::date+time '12:00',$2,date_trunc('month',$2::date)::date,$3,4,$4,'inventory_purchase_candidate',2,2)`,[tx,date,amount,party]);
 await db.query("insert into ledger_payables(id,expense_transaction_id,party_id,original_amount) values($1,$2,$3,$4)",[id,tx,party,amount]);
}
async function setup(){
 const db=await database();
 await db.exec(read('202608210004_add_ledger_payable_payments.sql'));
 await db.exec(read('20261018105936_add_payable_payment_idempotency_v2.sql'));
 const guards=read('202608210008_add_ledger_month_close_corrections.sql');
 await db.exec(guards.slice(guards.indexOf('create or replace function public.ledger_payable_allocation_month_guard_v1'),guards.indexOf('create or replace function public.ledger_card_reconciliation_month_guard_v1')));
 await db.exec(read('20261106120000_add_supplier_prepayments.sql'));
 // Prerequisite schema for the ACTUAL current preflight (empty unrelated modules).
 await db.exec(`create table payroll_payment_batches(payroll_month date,status text);
 create table ledger_recurring_expense_plans(id bigint,is_active boolean,effective_from date,effective_to date);
 create table ledger_card_reconciliations(id bigint,status text,deposit_date date,deposit_amount numeric,matched_gross_amount numeric,difference_amount numeric,updated_at timestamptz);
 create table ledger_card_reconciliation_lines(reconciliation_id bigint,pos_card_transaction_id bigint,allocated_gross_amount numeric);
 create table ledger_card_fee_closures(id bigint,status text,fee_month date,fee_amount numeric,updated_at timestamptz);
 create table ledger_card_fee_allocation_lines(closure_id bigint,pos_card_transaction_id bigint,allocated_fee_amount numeric);
 create table ledger_reserve_plans(id bigint,is_active boolean,target_amount numeric);
 create table ledger_reserve_entries(reserve_plan_id bigint,entry_type text,amount numeric,occurred_at timestamptz);
 create function ledger_card_sale_consumed_v1(bigint) returns numeric language sql as $$select 0::numeric$$;
 insert into ledger_parties(id,name,type) values(5,'Coca-Cola','supplier');`);
 await db.exec(read('20261002062405_fix_preflight_inactive_recurring_plans.sql'));
 for(const [id,tx,amount,date] of paid)await receipt(db,id,tx,amount,date);
 for(const [id,tx,amount,date] of open)await receipt(db,id,tx,amount,date);
 for(const [id,tx,amount] of [[94,167,549000],[95,168,355968],[288,481,700000]])await receipt(db,id,tx,amount,'2026-08-08');
 await receipt(db,9000,9000,500000,'2026-11-10',10);
 await db.exec(`insert into ledger_transactions(id,operation_id,type,occurred_at,business_date,amount,party_id,created_by,confirmed_by,memo)
 values(5097,'fdee4d5d-e62f-4008-8517-00f725a87497','payable_payment','2026-11-17T22:52:00+07','2026-11-17',6215888,5,2,2,'tt 6.582.000'),
 (1493,gen_random_uuid(),'payable_payment','2026-08-24T12:00:00+07','2026-08-24',4150000,5,2,2,'legacy carryover');
 insert into ledger_movements(id,transaction_id,fund_account_id,amount) values(2854,5097,2,-6215888),(100,1493,1,-4150000);`);
 for(let i=0;i<paid.length;i++)await db.query('insert into ledger_payable_allocations(id,payable_id,payment_transaction_id,allocated_amount) values($1,$2,5097,$3)',[2191+i,paid[i][0],paid[i][2]]);
 for(const [id,amount] of [[94,549000],[95,355968],[288,700000]])await db.query('insert into ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount) values($1,1493,$2)',[id,amount]);
 await db.exec(`insert into ledger_audit_logs(id,actor_user_id,action,entity_type,entity_id,reason) values(9061,2,'payable_payment_created','transaction',5097,'tt 6.582.000');
 insert into ledger_month_closures(month,status) values('2026-08-01','closed'),('2026-09-01','closed'),('2026-10-01','closed');`);
 return db;
}
async function state(db){
 const result={};
 for(const table of ['ledger_transactions','ledger_movements','ledger_payables','ledger_payable_allocations','inventory','inventory_logs','ledger_month_closures','ledger_payable_payment_requests'])result[table]=(await db.query(`select * from ${table} order by 1`)).rows;
 return result;
}
async function inputs(db){
 const sources=(await db.query(`select to_jsonb(p)||jsonb_build_object('expense',jsonb_build_object('id',t.id,'business_date',t.business_date,'status',t.status)) as r from ledger_payables p join ledger_transactions t on t.id=p.expense_transaction_id order by p.id`)).rows.map(x=>x.r);
 const allocations=(await db.query(`select to_jsonb(a)||jsonb_build_object('payment',to_jsonb(t)) as r from ledger_payable_allocations a join ledger_transactions t on t.id=a.payment_transaction_id order by a.id`)).rows.map(x=>x.r);
 const anchors=(await db.query('select to_jsonb(a) as r from ledger_payable_balance_anchors a')).rows.map(x=>x.r);
 return {sources,allocations,anchors};
}
const warning=async(db,month)=>((await one(db,'select ledger_close_preflight_v1($1,2) as r',[month])).r.warnings.find(x=>x.code==='PAYABLE_OUTSTANDING')?.amount??0);

test('installation is inert; audited registration is unique, immutable, scoped and reconciles actual preflight',async()=>{
 const db=await setup();try{
  const before=await state(db),auditBefore=(await db.query('select * from ledger_audit_logs order by id')).rows;
  await db.exec(migration);assert.deepEqual(await state(db),before);
  assert.equal(Number((await one(db,'select count(*) n from ledger_payable_balance_anchors')).n),0);
  assert.equal((await register(db,1)).status,'forbidden');
  const registered=await register(db);assert.equal(registered.status,'registered');
  assert.equal((await register(db)).status,'already_registered');
  assert.equal(Number((await one(db,'select count(*) n from ledger_payable_balance_anchors')).n),1);
  assert.deepEqual(await state(db),before,'all original records incl. original 9 allocations and closures unchanged');
  const auditAfter=(await db.query('select * from ledger_audit_logs order by id')).rows;
  assert.deepEqual(auditAfter.filter(x=>x.id===9061),auditBefore);
  assert.equal(auditAfter.length,auditBefore.length+1);
  assert.equal(auditAfter.find(x=>x.action==='owner_payable_balance_anchor_registered').after_snapshot.source_unverified,true);
  const {sources,allocations,anchors}=await inputs(db);
  const nov=calculatePayableBalances(sources,allocations,'2026-11',anchors);
  assert.equal(nov.partySummaries.find(x=>x.partyId===5).closingOutstanding,4982000);
  assert.equal(nov.partySummaries.find(x=>x.partyId===10).closingOutstanding,500000);
  assert.equal(nov.summary.periodBalanceAdjustment,334048);
  assert.equal(await warning(db,'2026-11-01'),nov.totalOutstanding,'actual DB preflight matches APP/month-close calculator');
  assert.equal(calculatePayableBalances(sources,allocations,undefined,anchors,'2026-11-17').totalOutstanding,5482000);
  const prior=calculatePayableBalances(sources,allocations,undefined,anchors,'2026-11-16');
  assert.deepEqual(prior,calculatePayableBalances(sources,allocations,undefined,[],'2026-11-16'));
  for(const month of ['2026-08','2026-09','2026-10'])assert.deepEqual(calculatePayableBalances(sources,allocations,month,anchors),calculatePayableBalances(sources,allocations,month));
  const preview=buildOldestFirstAllocations(nov.payables.filter(p=>p.party_id===5).map(p=>({id:p.id,businessDate:p.expense.business_date,outstandingAmount:p.outstandingAmount})),4982000);
  assert.equal(preview.unallocatedAmount,334048,'anchor is not an automatically payable invoice');
  assert.equal(await db.query("select has_table_privilege('service_role','ledger_payable_balance_anchors','INSERT') as allowed").then(r=>r.rows[0].allowed),false);
  assert.equal(await db.query("select has_function_privilege('anon','ledger_register_coca_owner_balance_anchor_v1(text,text,bigint)','EXECUTE') as allowed").then(r=>r.rows[0].allowed),false);
 }finally{await db.close()}
});

test('post-anchor receipt, payment of OLD debt, split allocations and next-month carry count once',async()=>{
 const db=await setup();try{
  await db.exec(migration);await register(db);
  await receipt(db,7000,7000,1000000,'2026-11-18');
  const paidResult=(await one(db,"select ledger_pay_payables_v1(5,2,'2026-11-18T03:00:00+07',300000,$1::jsonb,'later payment',2) as r",[JSON.stringify([{payableId:1526,allocatedAmount:200000},{payableId:7000,allocatedAmount:100000}])])).r;
  assert.equal(paidResult.status,'paid');
  const {sources,allocations,anchors}=await inputs(db);
  const balance=calculatePayableBalances(sources,allocations,'2026-11',anchors);
  assert.equal(balance.partySummaries.find(x=>x.partyId===5).closingOutstanding,5682000);
  assert.equal(await warning(db,'2026-11-01'),balance.totalOutstanding);
  assert.equal(calculatePayableBalances(sources,allocations,undefined,anchors,'2026-11-17').totalOutstanding,5482000);
  const dec=calculatePayableBalances(sources,allocations,'2026-12',anchors).partySummaries.find(x=>x.partyId===5);
  assert.equal(dec.openingOutstanding,5682000);assert.equal(dec.periodPurchases,0);assert.equal(dec.periodBalanceAdjustment,undefined);
  assert.equal(Number((await one(db,'select count(*) n from ledger_movements where transaction_id=$1',[paidResult.paymentTransactionId])).n),1);
 }finally{await db.close()}
});

test('earlier prepayment applied later to old debt uses application day at 03:00 and never rewrites the anchor',async()=>{
 const db=await setup();try{
  const prepay=(await one(db,"select ledger_create_supplier_prepayment_v1(gen_random_uuid(),5,2,'2026-11-16T12:00:00+07',100000,'unused before basis',2) as r")).r;
  assert.equal(prepay.status,'created');
  await db.exec(migration);await register(db);
  const anchor=(await inputs(db)).anchors[0];
  const applied=(await one(db,'select ledger_apply_supplier_prepayment_v1(gen_random_uuid(),5,$1::jsonb,2) as r',[JSON.stringify([{prepaymentTransactionId:prepay.prepaymentTransactionId,payableId:1526,allocatedAmount:100000}])])).r;
  assert.equal(applied.status,'applied');
  // Model an application just before the December 03:00 boundary. Registration
  // took place earlier in November; only the fixture application time changes.
  await db.query("update ledger_payable_allocations set created_at='2026-12-01T02:59:59+07' where payment_transaction_id=$1",[prepay.prepaymentTransactionId]);
  let {sources,allocations,anchors}=await inputs(db);
  assert.equal(anchors[0].id,anchor.id);
  assert.equal(calculatePayableBalances(sources,allocations,undefined,anchors,'2026-11-17').totalOutstanding,5482000);
  assert.equal(calculatePayableBalances(sources,allocations,'2026-11',anchors).totalOutstanding,5382000);
  assert.equal(await warning(db,'2026-11-01'),5382000);
  await db.query("update ledger_payable_allocations set created_at='2026-12-01T03:00:00+07' where payment_transaction_id=$1",[prepay.prepaymentTransactionId]);
  ({sources,allocations,anchors}=await inputs(db));
  assert.equal(calculatePayableBalances(sources,allocations,'2026-11',anchors).totalOutstanding,5482000);
  assert.equal(await warning(db,'2026-11-01'),5482000);
  assert.equal(calculatePayableBalances(sources,allocations,'2026-12',anchors).totalOutstanding,5382000);
  assert.equal(await warning(db,'2026-12-01'),5382000);
 }finally{await db.close()}
});

test('baseline mismatch, closed month and audit failure refuse registration atomically',async()=>{
 for(const failure of ['baseline','closed','audit']){
  const db=await setup();try{
   await db.exec(migration);
   if(failure==='baseline')await db.exec('update ledger_payables set original_amount=533953 where id=1526');
   if(failure==='closed')await db.exec("insert into ledger_month_closures values('2026-11-01','closed')");
   if(failure==='audit')await db.exec("create function reject_anchor_audit() returns trigger language plpgsql as $$begin raise exception 'injected audit failure';end$$;create trigger reject_anchor_audit before insert on ledger_audit_logs for each row execute function reject_anchor_audit()");
   const before=await state(db);
   await assert.rejects(register(db),failure==='baseline'?/BASELINE_MISMATCH/:failure==='closed'?/LEDGER_MONTH_CLOSED/:/injected audit failure/);
   assert.deepEqual(await state(db),before);
   assert.equal(Number((await one(db,'select count(*) n from ledger_payable_balance_anchors')).n),0);
  }finally{await db.close()}
 }
});

test('a backdated source change after registration causes HOLD in both APP and DB',async()=>{
 const db=await setup();try{
  await db.exec(migration);await register(db);
  await db.exec('update ledger_payables set original_amount=533953 where id=1526');
  const {sources,allocations,anchors}=await inputs(db);
  assert.throws(()=>calculatePayableBalances(sources,allocations,'2026-11',anchors),/BASELINE_DRIFT/);
  await assert.rejects(warning(db,'2026-11-01'),/BASELINE_DRIFT/);
 }finally{await db.close()}
});

test('unknown deployed preflight shape aborts the entire migration without partial installation',async()=>{
 const db=await setup();try{
  await db.exec("create or replace function ledger_close_preflight_v1(p_month date,p_actor_user_id bigint) returns jsonb language sql as $$select '{}'::jsonb$$");
  const before=await state(db);
  await assert.rejects(db.exec(migration),/PREFLIGHT_SHAPE_MISMATCH/);
  await db.exec('rollback');
  assert.equal((await one(db,"select to_regclass('public.ledger_payable_balance_anchors') as table_name")).table_name,null);
  assert.deepEqual(await state(db),before);
 }finally{await db.close()}
});
