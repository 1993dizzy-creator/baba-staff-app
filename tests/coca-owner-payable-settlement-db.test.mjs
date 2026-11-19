// Real formal migrations and existing V2 payment RPC. In-memory DB, no credentials.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {createCocaAnchorFixture,protectedState,anchorInputs,receipt,register,warning} from './helpers/coca-owner-balance-fixture.mjs';
import {calculatePayableBalances,buildOldestFirstAllocations} from '../lib/ledger/payables.ts';
import {buildLedgerEntries} from '../lib/ledger/entries.ts';
const oldPath='supabase/migrations/20261119071107_coca_cola_owner_payable_balance_anchor.sql';
const migration=readFileSync('supabase/migrations/20261119085058_coca_owner_balance_payable_settlement.sql','utf8');
const one=async(db,sql,args=[])=> (await db.query(sql,args)).rows[0];
const convert=(db,actor=2)=>one(db,"select ledger_convert_coca_owner_balance_anchor_v1('Owner confirmed payable settlement; origin unresolved; no expense/inventory/cash', $1) as r",[actor]).then(x=>x.r);
async function setup(install=true){const db=await createCocaAnchorFixture();await db.exec(readFileSync(oldPath,'utf8'));assert.equal((await register(db)).status,'registered');if(install)await db.exec(migration);return db;}
async function view(db,month='2026-11',asOf){
 const {sources,allocations,anchors}=await anchorInputs(db);
 const links=(await db.query('select to_jsonb(s) r from ledger_payable_anchor_settlements s')).rows.map(x=>x.r);
 for(const a of anchors){const link=links.find(s=>s.anchor_id===a.id);if(link)a.settlement={payable_id:link.payable_id,transaction_id:link.transaction_id};}
 return calculatePayableBalances(sources,allocations,month,anchors,asOf);
}
const coca=v=>v.partySummaries.find(p=>p.partyId===5);
const plan=(v,amount)=>buildOldestFirstAllocations(v.payables.filter(p=>p.party_id===5).map(p=>({id:p.id,businessDate:p.expense.business_date,outstandingAmount:p.outstandingAmount})),amount);
async function pay(db,amount,key=randomUUID(),allocations=null){return (await one(db,'select ledger_pay_payables_v2($1,5,2,$2,$3,$4::jsonb,$5,2) r',[key,'2026-11-19T12:00:00+07',amount,allocations===null?null:JSON.stringify(allocations),'actual isolated payment'])).r;}
const cash=async db=>Number((await one(db,'select coalesce(sum(amount),0) n from ledger_movements where fund_account_id=2')).n);
const profit=async db=> (await one(db,"select coalesce(sum(amount*economic_effect_sign),0) n from ledger_transactions where status='confirmed' and type in('income','sales','expense','expense_recognition')")).n;
async function assertOldRowsProtected(db,before,conversion){
 const after=await protectedState(db);
 for(const [table,rows] of Object.entries(before)){
  const scoped=table==='ledger_transactions'?after[table].filter(x=>Number(x.id)!==conversion.transactionId)
   :table==='ledger_payables'?after[table].filter(x=>Number(x.id)!==conversion.payableId):after[table];
  assert.deepEqual(scoped,rows,table+' original rows changed');
 }
}

test('conversion creates one noncash payable, preserves anchor/originals, and keeps global 101667900 once',async()=>{
 assert.equal(createHash('sha256').update(readFileSync(oldPath)).digest('hex'),'22f9a873ad1164f5158760a0348d3e081440af6b2bb064d85ba91f29bd0e82c6');
 const db=await setup(false);try{
  const before=await protectedState(db),anchorBefore=(await one(db,'select to_jsonb(a) r from ledger_payable_balance_anchors a')).r;
  const auditBefore=(await db.query('select * from ledger_audit_logs order by id')).rows;
  const cost=await profit(db),funds=await cash(db),past=await Promise.all(['2026-08','2026-09','2026-10'].map(m=>warning(db,m+'-01')));
  await db.exec(migration);assert.deepEqual(await protectedState(db),before,'installation is data-inert');
  assert.equal((await convert(db,1)).status,'forbidden');
  const converted=await convert(db);assert.equal(converted.status,'converted');
  assert.equal((await convert(db)).status,'already_converted');
  assert.equal(Number((await one(db,'select count(*) n from ledger_payable_anchor_settlements')).n),1);
  await assertOldRowsProtected(db,before,converted);
  assert.deepEqual((await one(db,'select to_jsonb(a) r from ledger_payable_balance_anchors a')).r,anchorBefore);
  const audit=(await db.query('select * from ledger_audit_logs order by id')).rows;
  assert.deepEqual(audit.filter(r=>auditBefore.some(b=>b.id===r.id)),auditBefore);assert.equal(audit.length,auditBefore.length+1);
  assert.equal(await profit(db),cost);assert.equal(await cash(db),funds);
  const v=await view(db);assert.equal(v.totalOutstanding,101667900);assert.equal(coca(v).closingOutstanding,4982000);
  assert.equal(v.payables.filter(p=>p.party_id===5).reduce((s,p)=>s+p.outstandingAmount,0),4982000);
  assert.equal(plan(v,4982000).unallocatedAmount,0);assert.equal(plan(v,4982000).allocations.length,8);
  assert.equal(coca(v).periodPurchases,2788000);assert.equal(coca(v).periodBalanceAdjustment,334048);
  assert.equal(await warning(db,'2026-11-01'),v.totalOutstanding);
  assert.deepEqual(await Promise.all(['2026-08','2026-09','2026-10'].map(m=>warning(db,m+'-01'))),past);
  const tx=(await one(db,'select to_jsonb(t) r from ledger_transactions t where id=$1',[converted.transactionId])).r;
  assert.equal(tx.type,'owner_payable_settlement');assert.equal(tx.recognition_month,null);assert.equal(tx.category_id,null);
  assert.equal(tx.source_snapshot.sourceUnverified,true);assert.equal(tx.source_snapshot.item_name,'기준잔액 정산분');
  assert.equal(buildLedgerEntries([{...tx,movements:[]}],[],new Map(),[],'2026-11').length,0,'no new journal purchase/cash card');
  const day=await view(db,'2026-11','2026-11-17');assert.equal(coca(day).closingOutstanding,4982000);
  const prior=await view(db,'2026-11','2026-11-16');assert.equal(prior.balanceAnchors,undefined);
  assert.equal(v.partySummaries.find(p=>p.partyId===10).closingOutstanding,96685900);
  assert.equal((await one(db,"select has_table_privilege('service_role','ledger_payable_anchor_settlements','UPDATE') allowed")).allowed,false);
  assert.equal((await one(db,"select has_function_privilege('anon','ledger_convert_coca_owner_balance_anchor_v1(text,bigint)','EXECUTE') allowed")).allowed,false);
 }finally{await db.close()}
});

test('V2 partial 2000000, duplicate click/retry, remainder and extra-payment block use one outflow each',async()=>{
 const db=await setup();try{
  await convert(db);const before=await cash(db),cost=await profit(db),key=randomUUID();
  const allocation=plan(await view(db),2000000).allocations;
  const [first,duplicate]=await Promise.all([pay(db,2000000,key,allocation),pay(db,2000000,key,allocation)]);
  assert.equal(first.status,'paid');assert.equal(duplicate.paymentTransactionId,first.paymentTransactionId);
  assert.equal((await pay(db,2000000,key,allocation)).paymentTransactionId,first.paymentTransactionId);
  assert.equal(coca(await view(db)).closingOutstanding,2982000);assert.equal(await cash(db),before-2000000);
  assert.equal(Number((await one(db,'select count(*) n from ledger_movements where transaction_id=$1',[first.paymentTransactionId])).n),1);
  assert.equal(await warning(db,'2026-11-01'),99667900);
  assert.equal((await pay(db,2982000)).status,'paid');assert.equal(coca(await view(db)).closingOutstanding,0);
  const funds=await cash(db);assert.equal((await pay(db,1)).status,'amount_exceeds_outstanding');assert.equal(await cash(db),funds);
  assert.equal(await profit(db),cost);assert.equal((await convert(db)).status,'already_converted');
  assert.equal(coca(await view(db)).closingOutstanding,0,'anchor never added again');
 }finally{await db.close()}
});

test('full 4982000 selected-date allocations settle to zero; later real receipt adds exactly 1000000',async()=>{
 const db=await setup();try{
  const converted=await convert(db),before=await cash(db),cost=await profit(db);
  const p=plan(await view(db),4982000);assert.equal(p.unallocatedAmount,0);
  const paid=await pay(db,4982000,randomUUID(),p.allocations);assert.equal(paid.status,'paid');
  assert.equal(await cash(db),before-4982000);assert.equal(coca(await view(db)).closingOutstanding,0);
  assert.equal((await one(db,'select status from ledger_payables where id=$1',[converted.payableId])).status,'paid');
  assert.equal(await warning(db,'2026-11-01'),96685900);assert.equal(await profit(db),cost);
  await receipt(db,7000,7000,1000000,'2026-11-20');
  assert.equal(coca(await view(db)).closingOutstanding,1000000);assert.equal(await warning(db,'2026-11-01'),97685900);
  assert.equal(coca(await view(db,'2026-12')).openingOutstanding,1000000);
  assert.equal(coca(await view(db,'2026-11','2026-11-17')).closingOutstanding,4982000);
  assert.equal(Number((await one(db,'select count(*) n from ledger_movements where transaction_id=$1',[paid.paymentTransactionId])).n),1);
 }finally{await db.close()}
});

test('conversion rejects baseline/payment drift, closed month and audit failure with no partial row or old-data mutation',async()=>{
 for(const failure of ['baseline','payment','closed','audit']){
  const db=await setup();try{
   if(failure==='baseline')await db.exec('update ledger_payables set original_amount=533953 where id=1526');
   if(failure==='payment')await db.exec('update ledger_movements set amount=-6215887 where id=2854');
   if(failure==='closed')await db.exec("insert into ledger_month_closures values('2026-11-01','closed')");
   if(failure==='audit')await db.exec("create function reject_conversion_audit() returns trigger language plpgsql as $$begin if new.action='owner_payable_balance_anchor_converted' then raise exception 'injected conversion audit failure';end if;return new;end$$;create trigger reject_conversion_audit before insert on ledger_audit_logs for each row execute function reject_conversion_audit()");
   const before=await protectedState(db);
   await assert.rejects(convert(db),failure==='baseline'?/BASELINE_DRIFT/:failure==='payment'?/PAYMENT_DRIFT/:failure==='closed'?/LEDGER_MONTH_CLOSED/:/injected conversion audit failure/);
   assert.deepEqual(await protectedState(db),before);assert.equal(Number((await one(db,'select count(*) n from ledger_payable_anchor_settlements')).n),0);
  }finally{await db.close()}
 }
});

test('corrupt conversion mapping/source is HOLD, never a second anchor addition',async()=>{
 const db=await setup();try{
  await convert(db);await db.exec("update ledger_payables set status='cancelled' where id=(select payable_id from ledger_payable_anchor_settlements)");
  await assert.rejects(view(db),/OWNER_PAYABLE_SETTLEMENT_INVALID/);
  await assert.rejects(warning(db,'2026-11-01'),/OWNER_PAYABLE_SETTLEMENT_INVALID/);
 }finally{await db.close()}
});

test('old prepayment applied to the new settlement reduces payable once on application day, with no new cash',async()=>{
 const db=await setup();try{
  const prepay=(await one(db,"select ledger_create_supplier_prepayment_v1(gen_random_uuid(),5,2,'2026-11-16T12:00:00+07',100000,'unused prepayment',2) r")).r;
  assert.equal(prepay.status,'created');const converted=await convert(db),funds=await cash(db),cost=await profit(db);
  const applied=(await one(db,'select ledger_apply_supplier_prepayment_v1(gen_random_uuid(),5,$1::jsonb,2) r',[JSON.stringify([{prepaymentTransactionId:prepay.prepaymentTransactionId,payableId:converted.payableId,allocatedAmount:100000}])])).r;
  assert.equal(applied.status,'applied');
  await db.query("update ledger_payable_allocations set created_at='2026-11-20T12:00:00+07' where payment_transaction_id=$1",[prepay.prepaymentTransactionId]);
  assert.equal(coca(await view(db)).closingOutstanding,4882000);
  assert.equal(coca(await view(db,'2026-11','2026-11-17')).closingOutstanding,4982000);
  assert.equal(await warning(db,'2026-11-01'),101567900);assert.equal(await cash(db),funds);assert.equal(await profit(db),cost);
 }finally{await db.close()}
});

test('settlement transaction type cannot be used for another party or nullable scope',async()=>{
 const db=await setup();try{
  for(const party of [10,null])await assert.rejects(db.query(`insert into ledger_transactions(operation_id,type,occurred_at,business_date,amount,party_id,source_type,source_key,source_snapshot,created_by,confirmed_by)
   values(gen_random_uuid(),'owner_payable_settlement','2026-11-17T12:00:00+07','2026-11-17',334048,$1,'owner_payable_balance_settlement','owner-payable-anchor:1:settlement','{"ownerBalanceAnchorId":1,"nonCash":true,"sourceUnverified":true}',2,2)`,[party]),/owner_payable_settlement_scope/);
  assert.equal((await convert(db)).status,'converted');
 }finally{await db.close()}
});
