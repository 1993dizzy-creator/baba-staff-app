import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {billedFixture} from './helpers/inventory-billed-amount-fixture.mjs';
import {item,editReceipt,state} from './helpers/inventory-receipt-edit-fixture.mjs';

// Isolated PGlite only (store day 2026-10-11, receipt #100 10 cans x 20,000 Won Mart, booked expense #1).
const supplierMigration='supabase/migrations/20261030180000_inventory_receipt_supplier_all_staff.sql';
const migration='supabase/migrations/20261104170000_inventory_receipt_edit_month_and_paid_billed.sql';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const n=async(db,sql,args=[])=>Number(Object.values(await one(db,sql,args))[0]);
const expense=db=>n(db,"select coalesce(sum(amount*economic_effect_sign),0) from ledger_transactions where type='expense' and status='confirmed'");
const fund=(db,account)=>n(db,'select coalesce(sum(amount),0) from ledger_movements where fund_account_id=$1',[account]);
const billed=(amount,extra={})=>({billed_amount_mode:'manual',billed_amount:amount,reason:'실청구 영수증',...extra});
async function fixture({paid=true,account=1,paymentDate='2026-10-11'}={}){
 const db=await billedFixture();
 await db.exec(readFileSync(supplierMigration,'utf8'));
 await db.exec(readFileSync(migration,'utf8'));
 // Fixture-only: the receipt-edit fixture predates payable payments and the Vượng account.
 await db.exec(`alter table ledger_transactions drop constraint if exists ledger_transactions_type_check;
  insert into ledger_fund_accounts(id,code,type,display_name,holder_name,is_active,is_business_fund,sort_order,active_from)
   values(5,'vuong_personal_custody','personal_custody','개인(Vương)','Vương',true,true,50,'2026-08-01');`);
 if(paid)await pay(db,{account,date:paymentDate});
 return db;
}
async function pay(db,{account=1,date='2026-10-11',amount=200000}={}){
 await db.exec(`insert into ledger_transactions(id,operation_id,type,occurred_at,business_date,amount,party_id,status,source_type,created_by,confirmed_by)
   values(50,gen_random_uuid(),'payable_payment','${date} 08:00+00','${date}',${amount},10,'confirmed','manual',1,1);
  insert into ledger_movements(transaction_id,fund_account_id,amount) values(50,${account},-${amount});
  insert into ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount) values(1,50,200000);
  update ledger_payables set status='paid';`);
}

test('paid receipt: billed-only decrease keeps payment/allocation and books -150 cost / +150 store cash once',async()=>{
 const db=await fixture();try{
  const before=await state(db);
  const r=await editReceipt(db,await item(db),billed(199850));
  assert.equal(r.status,'ok');assert.equal(r.completion,'complete');assert.equal(r.ledgerSync.code,'PAID_BILLED_CORRECTED');
  assert.equal(Number(r.amount),199850);assert.equal(Number(r.calculatedAmount),200000);
  assert.equal(await expense(db),199850);assert.equal(await fund(db,1),-199850);
  // Original expense, payable, allocation, payment and its movement are byte-identical.
  const after=await state(db);
  for(const table of ['ledger_payables'])assert.deepEqual(after[table],before[table]);
  assert.deepEqual(after.ledger_transactions.filter(r=>[1,50].includes(Number(r.row.id))),before.ledger_transactions);
  assert.deepEqual((await db.query('select * from ledger_payable_allocations')).rows.map(r=>Number(r.allocated_amount)),[200000]);
  const c=await one(db,"select * from ledger_transactions where source_type='inventory_purchase_billed_correction'");
  assert.equal(c.type,'expense');assert.equal(Number(c.economic_effect_sign),-1);assert.equal(Number(c.amount),150);
  assert.equal(Number(c.correction_of_id),1);assert.equal(c.business_date.toISOString().slice(0,10),'2026-10-11');
  assert.equal(Number(c.party_id),10);assert.equal(Number(c.category_id),4);
  assert.deepEqual((await db.query('select fund_account_id,amount from ledger_movements where transaction_id=$1',[c.id])).rows.map(r=>[Number(r.fund_account_id),Number(r.amount)]),[[1,150]]);
  // Stock, price and supplier untouched; the candidate source follows the billed amount and the projector agrees.
  const now=await item(db);assert.equal(Number(now.quantity),10);assert.equal(Number(now.purchase_price),20000);
  const cand=await one(db,"select * from ledger_candidates where source_key='inventory-log:100'");
  assert.equal(Number(cand.proposed_amount),200000);assert.equal(Number(cand.source_snapshot.purchase_amount),199850);
  assert.equal(cand.source_snapshot.billed_amount_mode,'manual');
  // The projector may keep a display-only drift snapshot (names); its economics equal the booked source.
  if(cand.source_drift_snapshot)assert.equal((await one(db,'select inventory_ledger_private.economics($1::jsonb)=inventory_ledger_private.economics($2::jsonb) as x',
   [JSON.stringify(cand.source_drift_snapshot),JSON.stringify(cand.source_snapshot)])).x,true);
  const status=await one(db,'select * from ledger_inventory_projection_status where inventory_log_id=$1',[r.inventoryLogId]);
  assert.equal(status.status,'synced');
  const reproject=(await one(db,'select ledger_project_inventory_purchase_log_v1($1,1) as p',[r.inventoryLogId])).p;
  assert.equal(reproject.status,'synced');assert.ok(['UNCHANGED','METADATA_SYNCED'].includes(reproject.code));
  const audit=await one(db,"select * from ledger_audit_logs where action='inventory_paid_receipt_billed_corrected'");
  assert.equal(Number(audit.entity_id),Number(c.id));assert.equal(Number(audit.after_snapshot.fundDelta),150);
  assert.equal(Number(audit.before_snapshot.amount),200000);assert.ok(audit.before_snapshot.paymentMovement);
  assert.ok(await one(db,"select 1 as x from ledger_audit_logs where action='inventory_purchase_receipt_edited'"));
  // Retry / double click: no change, no second correction.
  const settled=await state(db);
  assert.equal((await editReceipt(db,await item(db),billed(199850))).status,'no_change');
  assert.deepEqual(await state(db),settled);
  // A further decrease books only the new difference.
  const again=await editReceipt(db,await item(db),billed(199800,{reason:'추가 할인'}));
  assert.equal(again.ledgerSync.code,'PAID_BILLED_CORRECTED');
  assert.equal(await expense(db),199800);assert.equal(await fund(db,1),-199800);
  assert.equal(await n(db,"select count(*) from ledger_transactions where source_type='inventory_purchase_billed_correction'"),2);
 }finally{await db.close();}
});

test('the correction returns to the paying account: Vượng +100',async()=>{
 const db=await fixture({account:5});try{
  const r=await editReceipt(db,await item(db),billed(199900));
  assert.equal(r.ledgerSync.code,'PAID_BILLED_CORRECTED');assert.equal(Number(r.ledgerSync.fundAccountId),5);
  assert.equal(await fund(db,5),-199900);assert.equal(await fund(db,1),0);
 }finally{await db.close();}
});

for(const [name,setup,edit] of [
 ['billed increase',null,billed(200100)],
 ['quantity change',null,billed(180000,{quantity:9})],
 ['unit price change',null,billed(199000,{purchase_price:19999})],
 ['auto mode',null,{billed_amount_mode:'auto',purchase_price:19990,reason:'단가'}],
 ['split allocation',"update ledger_payable_allocations set allocated_amount=150000; insert into ledger_transactions(id,operation_id,type,occurred_at,business_date,amount,party_id,status,source_type,created_by,confirmed_by) values(51,gen_random_uuid(),'payable_payment',now(),'2026-10-11',50000,10,'confirmed','manual',1,1); insert into ledger_movements(transaction_id,fund_account_id,amount) values(51,1,-50000); insert into ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount) values(1,51,50000)",billed(199850)],
 ['card payment',"update ledger_movements set fund_account_id=4 where transaction_id=50",billed(199850)],
 ['manual Ledger amount',"update ledger_transactions set amount=199000 where id=1; update ledger_payables set original_amount=199000; update ledger_payable_allocations set allocated_amount=199000",billed(198000)],
])test(`paid receipt stays protected for ${name}: payment_completed, no write`,async()=>{
 const db=await fixture();try{
  if(setup)await db.exec(setup);
  const before=await state(db);
  const r=await editReceipt(db,await item(db),edit);
  assert.equal(r.status,'purchase_correction_review_required');
  assert.ok(['payment_completed','ledger_amount_changed'].includes(r.blockReason),r.blockReason);
  assert.deepEqual(await state(db),before);
 }finally{await db.close();}
});

test('closed or previous-month payment, and previous-month receipts, are never corrected',async()=>{
 for(const [label,options,setup,expected] of [
  ['closed month',{},"insert into ledger_month_closures(month) values('2026-10-01')",'month_closed'],
  ['payment in September',{paymentDate:'2026-09-30'},null,'payment_completed'],
 ]){
  const db=await fixture(options);try{
   if(setup)await db.exec(setup);
   const before=await state(db);
   const r=await editReceipt(db,await item(db),billed(199850));
   assert.equal(r.blockReason,expected,label);assert.deepEqual(await state(db),before,label);
  }finally{await db.close();}
 }
});

test('a projector disagreement rolls the whole paid correction back',async()=>{
 const db=await fixture();try{
  // Source snapshot no longer matches the receipt (e.g. legacy shape): the in-transaction projector check fails.
  await db.exec(`update ledger_candidates set source_snapshot=source_snapshot||'{"unit_extra":1}'::jsonb`);
  const before=await state(db);
  const r=await editReceipt(db,await item(db),billed(199850));
  assert.equal(r.status,'purchase_correction_review_required');assert.equal(r.code,'PAID_BILLED_PROJECTION_MISMATCH');
  assert.deepEqual(await state(db),before);
 }finally{await db.close();}
});

test('unpaid receipts: same business month rebooks automatically, an earlier month stays owner review',async()=>{
 const db=await fixture({paid:false});try{
  await db.exec("update inventory_logs set business_date='2026-10-02' where id=100");
  const r=await editReceipt(db,await item(db),billed(199000));
  assert.equal(r.status,'ok');assert.equal(r.completion,'complete');assert.equal(r.ledgerSync.code,'REBOOKED');
  assert.equal(await expense(db),199000);
  assert.equal(Number((await one(db,"select original_amount from ledger_payables where status='unpaid'")).original_amount),199000);
 }finally{await db.close();}
 const old=await fixture({paid:false});try{
  await old.exec("update inventory_logs set business_date='2026-09-30' where id=100");
  const before=(await state(old)).ledger_transactions;
  const r=await editReceipt(old,await item(old),billed(199000));
  assert.equal(r.status,'ok');assert.equal(r.completion,'ledger_review');assert.deepEqual((await state(old)).ledger_transactions,before);
 }finally{await old.close();}
});

test('migration contract: anchors on a CRLF deployed body, refuses re-application or an unexpected body, keeps privileges closed',async()=>{
 const db=await billedFixture();try{
  await db.exec(readFileSync(supplierMigration,'utf8'));
  // Production stores the body with CRLF line endings.
  await db.exec(`do $$ declare d text:=pg_get_functiondef('public.inventory_apply_purchase_receipt_edit_v1(bigint,bigint,numeric,jsonb,jsonb,date,bigint)'::regprocedure);
   begin execute replace(d,E'\\n',E'\\r\\n'); end $$;`);
  await db.exec(readFileSync(migration,'utf8'));
  const body=(await one(db,"select pg_get_functiondef('public.inventory_apply_purchase_receipt_edit_v1(bigint,bigint,numeric,jsonb,jsonb,date,bigint)'::regprocedure) as d")).d;
  assert.match(body,/correct_paid_receipt_billed_v1/);assert.match(body,/v_same_day:=date_trunc\('month',v_root\.business_date\)=date_trunc\('month',p_business_date\)/);
  await assert.rejects(db.exec(readFileSync(migration,'utf8')),/INVENTORY_RECEIPT_EDIT_PAID_BILLED_ALREADY_APPLIED/);
  await db.exec('rollback');
  for(const fn of ['inventory_ledger_private.paid_receipt_billed_correction_ready_v1(bigint,numeric,numeric,date)',
    'inventory_ledger_private.correct_paid_receipt_billed_v1(bigint,bigint,bigint,numeric,numeric,date,bigint)'])
   assert.equal((await one(db,`select has_function_privilege('service_role','${fn}','execute') as x`)).x,false,fn);
 }finally{await db.close();}
 const other=await billedFixture();try{
  // Without the supplier patch the body still carries its role guard, but a different body (anchor gone) must abort.
  await other.exec(`do $$ declare d text:=pg_get_functiondef('public.inventory_apply_purchase_receipt_edit_v1(bigint,bigint,numeric,jsonb,jsonb,date,bigint)'::regprocedure);
   begin execute replace(d,'v_same_day:=v_root.business_date=p_business_date','v_same_day:=v_root.business_date = p_business_date'); end $$;`);
  await assert.rejects(other.exec(readFileSync(migration,'utf8')),/INVENTORY_RECEIPT_EDIT_PAID_BILLED_CONTRACT_MISMATCH \(anchor 4\)/);
  await other.exec('rollback');
  assert.doesNotMatch((await one(other,"select pg_get_functiondef('public.inventory_apply_purchase_receipt_edit_v1(bigint,bigint,numeric,jsonb,jsonb,date,bigint)'::regprocedure) as d")).d,/correct_paid_receipt_billed_v1/);
 }finally{await other.close();}
});

test('snapshots page offers receipt edits only for the current business month',()=>{
 const page=readFileSync('app/(protected)/inventory/snapshots/page.tsx','utf8');
 // The month comes from the server-resolved current business date (store-settings cutoff), not a client clock.
 assert.doesNotMatch(page,/from "@\/lib\/common\/business-time"/);
 assert.match(page,/currentBusinessDateRef\.current = json\.currentBusinessDate;/);
 assert.match(page,/&& !!currentBusinessMonth && \(entry\.root\.business_date \?\? ""\)\.slice\(0, 7\) === currentBusinessMonth;/);
});
