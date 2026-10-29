import assert from 'node:assert/strict';
import test from 'node:test';
import {receiptEditFixture,item,editReceipt,state} from './helpers/inventory-receipt-edit-fixture.mjs';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const net=async db=>Number((await one(db,'select sum(amount*economic_effect_sign) as n from ledger_transactions')).n);
const openPayable=async db=>one(db,"select * from ledger_payables where status='unpaid'");
const root=async db=>one(db,'select to_jsonb(l) as row from inventory_logs l where id=100');
const masterFields=row=>({purchase_price:row.purchase_price,supplier:row.supplier,supplier_partner_id:row.supplier_partner_id,note:row.note,item_name:row.item_name,unit:row.unit,category:row.category,code:row.code});

test('staff same-day increase changes only stock, links one correction and rebooks the unpaid expense',async()=>{
 const db=await receiptEditFixture();try{
  const old=await item(db),rootBefore=await root(db);
  const r=await editReceipt(db,old,{quantity:12,reason:'영수증 재확인',note:'2캔 추가 확인'});
  assert.equal(r.status,'ok');assert.equal(r.ledgerSync.status,'synced');assert.equal(r.ledgerSync.code,'REBOOKED');assert.equal(Number(r.quantityDelta),2);
  const now=await item(db);assert.equal(Number(now.quantity),12);assert.deepEqual(masterFields(now),masterFields(old));
  const log=await one(db,'select * from inventory_logs where id=$1',[r.inventoryLogId]);
  assert.equal(Number(log.correction_of_inventory_log_id),100);assert.equal(log.action,'receipt_edit');assert.equal(log.reason,'purchase');assert.equal(log.source,'edit_form');
  assert.equal(Number(log.change_quantity),2);assert.equal(Number(log.new_purchase_price),20000);assert.equal(log.new_note,'영수증 재확인 · 2캔 추가 확인');assert.equal(log.unit,'can');
  assert.deepEqual(await root(db),rootBefore);
  assert.equal(await net(db),240000);const payable=await openPayable(db);assert.equal(Number(payable.original_amount),240000);assert.equal(Number(payable.party_id),10);
  assert.equal(Number((await one(db,'select count(*) as n from inventory_price_logs')).n),0);
  const audit=await one(db,"select * from ledger_audit_logs where action='inventory_purchase_receipt_edited'");
  assert.equal(Number(audit.actor_user_id),1);assert.equal(audit.after_snapshot.editReason,'영수증 재확인');assert.equal(audit.after_snapshot.note,'2캔 추가 확인');assert.equal(Number(audit.before_snapshot.quantity),10);
  assert.equal((await one(db,"select current_setting('baba.purchase_confirmation',true) as s")).s,'');
 }finally{await db.close();}
});

test('price-only edit reprices this receipt without touching the item price or price history',async()=>{
 const db=await receiptEditFixture();try{
  const old=await item(db),r=await editReceipt(db,old,{purchase_price:21000});
  assert.equal(r.status,'ok');assert.equal(r.ledgerSync.code,'REBOOKED');assert.equal(Number(r.quantityDelta),0);
  assert.deepEqual(await item(db).then(masterFields),masterFields(old));assert.equal(Number((await item(db)).quantity),10);
  assert.equal(await net(db),210000);assert.equal(Number((await one(db,'select count(*) as n from inventory_price_logs')).n),0);
 }finally{await db.close();}
});

test('owner supplier change rebooks to the new mapped party; the item supplier stays',async()=>{
 const db=await receiptEditFixture();try{
  const old=await item(db),r=await editReceipt(db,old,{supplier:'Postpaid',supplier_partner_id:12,reason:'거래처 정정'},2);
  assert.equal(r.status,'ok');assert.equal(r.ledgerSync.code,'REBOOKED');
  const payable=await openPayable(db);assert.equal(Number(payable.party_id),12);assert.equal(Number(payable.original_amount),200000);
  assert.equal(String(payable.due_date.toISOString?.()??payable.due_date).slice(0,10),'2026-10-18');
  const now=await item(db);assert.equal(now.supplier,'Won Mart');assert.equal(Number(now.supplier_partner_id),10);
  const log=await one(db,'select * from inventory_logs where id=$1',[r.inventoryLogId]);assert.equal(log.prev_supplier,'Won Mart');assert.equal(log.new_supplier,'Postpaid');assert.equal(Number(log.purchase_supplier_partner_id),12);
 }finally{await db.close();}
});

test('staff supplier change, inactive actor and invalid input are rejected without writes',async()=>{
 const db=await receiptEditFixture();try{
  const old=await item(db),before=await state(db);
  assert.equal((await editReceipt(db,old,{supplier:'Postpaid',supplier_partner_id:12})).status,'supplier_change_forbidden');
  assert.equal((await editReceipt(db,old,{quantity:9},3)).status,'forbidden');
  for(const edit of [{quantity:-1},{quantity:'NaN'},{quantity:'abc'},{purchase_price:0},{purchase_price:'Infinity'},{reason:'  '},{reason:null},{supplier:null,supplier_partner_id:null},{extra:1},{reason:'x'.repeat(201)},{note:'x'.repeat(501)}])
   assert.equal((await editReceipt(db,old,edit)).status,'invalid_payload',JSON.stringify(edit));
  assert.equal((await editReceipt(db,old,{})).status,'no_change');
  assert.equal((await editReceipt(db,old,{quantity:9},1,'2026-10-11',999)).status,'invalid_purchase_reference');
  assert.deepEqual(await state(db),before);
 }finally{await db.close();}
});

test('repeated edits of one receipt: latest log wins, stale versions are rejected, separate receipts untouched',async()=>{
 const db=await receiptEditFixture();try{
  await db.exec("insert into inventory_logs(id,item_id,item_name,unit,change_quantity,new_purchase_price,new_supplier,business_date,source,reason,created_at) values(101,1,'Coca','can',5,20000,'Won Mart','2026-10-11','edit_form','purchase','2026-10-11T04:00:00Z')");
  const other=await one(db,'select to_jsonb(l) as row from inventory_logs l where id=101');
  const first=await item(db);assert.equal((await editReceipt(db,first,{quantity:12})).status,'ok');
  assert.equal((await editReceipt(db,first,{quantity:11})).status,'quantity_conflict');
  const second=await item(db),r=await editReceipt(db,second,{quantity:9,purchase_price:22000,reason:'2차 정정'});
  assert.equal(r.status,'ok');assert.equal(r.ledgerSync.code,'REBOOKED');assert.equal(Number(r.quantityDelta),-3);
  assert.equal(Number((await item(db)).quantity),9);assert.equal(await net(db),198000);
  assert.deepEqual((await db.query('select change_quantity::text as q from inventory_logs where correction_of_inventory_log_id=100 order by id')).rows.map(x=>x.q),['2','-3']);
  assert.deepEqual(await one(db,'select to_jsonb(l) as row from inventory_logs l where id=101'),other);
  const third=await item(db),cancel=await editReceipt(db,third,{quantity:0,purchase_price:22000,reason:'전체 취소'});
  assert.equal(cancel.status,'ok');assert.equal(await net(db),0);assert.equal((await one(db,'select status from ledger_candidates order by id desc limit 1')).status,'dismissed');
  assert.equal(Number((await item(db)).quantity),0);
 }finally{await db.close();}
});

for(const [name,setup,edit,actor,blockReason] of [
 ['paid',"update ledger_payables set status='paid'",{quantity:9},1,'payment_completed'],
 ['partially paid',"update ledger_payables set status='partially_paid'",{quantity:9},1,'payment_state'],
 ['allocated',"insert into ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount) select p.id,p.expense_transaction_id,1 from ledger_payables p",{purchase_price:21000},1,'payment_allocated'],
 ['closed source month',"insert into ledger_month_closures(month) values('2026-10-01')",{quantity:9},1,'month_closed'],
 ['closed recognition month',"update ledger_candidates set proposed_recognition_month='2026-09-01';update ledger_transactions set recognition_month='2026-09-01';insert into ledger_month_closures(month) values('2026-09-01')",{quantity:9},1,'month_closed'],
 ['manual Ledger override',"update ledger_transactions set amount=199000 where type='expense'",{quantity:9},1,'ledger_amount_changed'],
 ['unmapped new supplier',"delete from business_partner_ledger_parties where business_partner_id=12",{supplier:'Postpaid',supplier_partner_id:12},2,'supplier_mapping_required'],
 ['ambiguous current supplier mapping',"insert into business_partner_ledger_parties values(10,12)",{quantity:9},1,'supplier_mapping_required'],
 ['dismissed receipt',"update ledger_candidates set status='dismissed',resolved_transaction_id=null,dismissal_reason='QA dismissed'",{quantity:9},1,'purchase_dismissed'],
])test(name+': nothing is written and the reason is reported',async()=>{
 const db=await receiptEditFixture();try{
  await db.exec(setup);const old=await item(db),before=await state(db),r=await editReceipt(db,old,edit,actor);
  assert.equal(r.status,'purchase_correction_review_required',JSON.stringify(r));assert.equal(r.blockReason,blockReason,JSON.stringify(r));
  assert.deepEqual(await state(db),before);
 }finally{await db.close();}
});

test('a later physical count blocks quantity edits but not a price-only edit',async()=>{
 const db=await receiptEditFixture();try{
  await db.exec("insert into inventory_logs(id,item_id,item_name,unit,change_quantity,business_date,source,reason,created_at) values(150,1,'Coca','can',0,'2026-10-11','quick_save','stock_check','2026-10-11T05:00:00Z')");
  const old=await item(db),before=await state(db);
  assert.equal((await editReceipt(db,old,{quantity:9})).status,'purchase_correction_later_stock_check');assert.deepEqual(await state(db),before);
  const r=await editReceipt(db,old,{purchase_price:21000});assert.equal(r.status,'ok');assert.equal(Number((await item(db)).quantity),10);
 }finally{await db.close();}
});

test('stock may not go negative and a different stock unit is not editable',async()=>{
 const db=await receiptEditFixture();try{
  await db.exec('update inventory set quantity=1');let old=await item(db);const before=await state(db);
  assert.equal((await editReceipt(db,old,{quantity:8})).status,'inventory_quantity_negative');assert.deepEqual(await state(db),before);
  await db.exec("update inventory set unit='box'");old=await item(db);
  const r=await editReceipt(db,old,{quantity:9});assert.equal(r.status,'purchase_correction_review_required');assert.equal(r.blockReason,'purchase_details_changed');
 }finally{await db.close();}
});

test('previous-day receipt: stock changes, Ledger stays for the owner review screen',async()=>{
 const db=await receiptEditFixture();try{
  await db.exec("update inventory_logs set business_date='2026-10-10' where id=100");
  const old=await item(db),before=await state(db),r=await editReceipt(db,old,{quantity:9});
  assert.equal(r.status,'ok');assert.equal(r.ledgerSync.status,'review_required');assert.equal(Number((await item(db)).quantity),9);
  const after=await state(db);for(const table of ['ledger_transactions','ledger_payables','ledger_movements'])assert.deepEqual(after[table],before[table]);
 }finally{await db.close();}
 // A backdated request date (before the receipt day) is rejected outright.
 const db2=await receiptEditFixture();try{const old=await item(db2),before=await state(db2),r=await editReceipt(db2,old,{quantity:9},1,'2026-10-10');
  assert.equal(r.status,'purchase_correction_review_required');assert.equal(r.code,'INVALID_PURCHASE_ROOT');assert.deepEqual(await state(db2),before);}finally{await db2.close();}
});

for(const [table,condition] of [
 ['inventory_logs','true'],
 ['ledger_transactions',"new.source_type='inventory_purchase_rebook'"],
 ['ledger_payables','true'],
 ['ledger_audit_logs',"new.action='inventory_purchase_receipt_edited'"],
 ['ledger_audit_logs',"new.action='inventory_source_rebooked'"],
])test(table+' '+condition+' failure rolls back every inventory and Ledger effect',async()=>{
 const db=await receiptEditFixture();try{
  const old=await item(db),before=await state(db);
  await db.exec(`create function qa_failure() returns trigger language plpgsql as $$begin if ${condition} then raise exception 'QA_ATOMIC_FAIL';end if;return new;end$$;create trigger qa_fail before insert on ${table} for each row execute function qa_failure()`);
  const r=await editReceipt(db,old,{quantity:9,purchase_price:21000});
  assert.equal(r.status,'purchase_correction_review_required');assert.deepEqual(await state(db),before);
 }finally{await db.close();}
});

test('suppressed audit row aborts the edit',async()=>{
 const db=await receiptEditFixture();try{
  const old=await item(db),before=await state(db);
  await db.exec("create function qa_skip() returns trigger language plpgsql as $$begin if new.action='inventory_purchase_receipt_edited' then return null;end if;return new;end$$;create trigger qa_skip before insert on ledger_audit_logs for each row execute function qa_skip()");
  const r=await editReceipt(db,old,{quantity:9});assert.equal(r.code,'INVENTORY_REQUIRED_AUDIT_MISSING');assert.deepEqual(await state(db),before);
 }finally{await db.close();}
});

test('RPC is service-role only with a fixed search_path; existing correction functions are unchanged',async()=>{
 const db=await receiptEditFixture();try{
  const old=await item(db);
  for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(editReceipt(db,old,{quantity:9}),/permission denied/);await db.exec('reset role');}
  await db.exec('set role service_role');
  assert.equal((await one(db,"select has_function_privilege(current_user,'public.inventory_apply_purchase_receipt_edit_v1(bigint,bigint,numeric,jsonb,jsonb,date,bigint)','execute') as ok")).ok,true);
  await db.exec('reset role');
  const meta=await one(db,"select prosecdef,proconfig from pg_proc where proname='inventory_apply_purchase_receipt_edit_v1'");
  assert.equal(meta.prosecdef,true);assert.deepEqual(meta.proconfig,['search_path=pg_catalog, public']);
  assert.equal(Number((await one(db,"select count(*) as n from pg_proc where proname='has_function_privilege'")).n)>0,true);
 }finally{await db.close();}
});

test('concurrent edits with the same item version: exactly one commits',async()=>{
 const db=await receiptEditFixture();try{
  const old=await item(db),r=await Promise.all([editReceipt(db,old,{quantity:11}),editReceipt(db,old,{quantity:12})]);
  assert.deepEqual(r.map(x=>x.status).sort(),['ok','quantity_conflict']);
  assert.equal(Number((await one(db,'select count(*) as n from inventory_logs where correction_of_inventory_log_id=100')).n),1);
 }finally{await db.close();}
});

test('earlier-day edit: stock only until the owner repair; retries are idempotent and further edits wait',async()=>{
 const db=await receiptEditFixture();try{
  await db.exec("update inventory_logs set business_date='2026-10-10' where id=100");
  const first=await editReceipt(db,await item(db),{quantity:9,reason:'전일 정정'});
  assert.equal(first.status,'ok');assert.equal(first.ledgerSync.status,'review_required');
  assert.equal((await one(db,'select status from ledger_inventory_projection_status where inventory_log_id=$1',[first.inventoryLogId])).status,'review_required');
  assert.equal(await net(db),200000);
  // Same absolute values again (double click, retry after a timeout): nothing new is written.
  const settled=await state(db);
  assert.equal((await editReceipt(db,await item(db),{quantity:9,reason:'전일 정정'})).status,'no_change');
  // A different follow-up edit waits for the owner instead of stacking a second open review.
  const pending=await editReceipt(db,await item(db),{quantity:8,reason:'추가 정정'});
  assert.equal(pending.status,'purchase_correction_review_required');assert.equal(pending.blockReason,'ledger_review_pending');
  assert.deepEqual(await state(db),settled);
  // Owner confirms through the existing repair RPC: the Ledger now follows the stock.
  const repair=(await one(db,'select ledger_resolve_inventory_purchase_correction_v2($1,100,2,null) as r',[first.inventoryLogId])).r;
  assert.equal(repair.status,'synced',JSON.stringify(repair));assert.equal(await net(db),180000);
  assert.equal((await one(db,'select status from ledger_inventory_projection_status where inventory_log_id=$1',[first.inventoryLogId])).status,'synced');
  const next=await editReceipt(db,await item(db),{quantity:8,reason:'추가 정정'});
  assert.equal(next.status,'ok');assert.equal(Number((await item(db)).quantity),8);
 }finally{await db.close();}
});
