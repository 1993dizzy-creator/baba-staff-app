// Isolated PGlite only. Reproduces the 2026-11-08 /inventory/snapshots receipt-edit failure
// (#15182 Táo 1.26kg -> 1.16kg x 60,000, confirmed + unpaid + open month) in operating migration
// order: P1-2E writer fence (20261102120303) + successor resolver (20261102142849), then the
// 20261104170000 body patch that was never registered as a successor. Every quantity edit then hit
// INVENTORY_WRITER_REGISTERED_REQUEST_REQUIRED and was shown as receipt_edit_review.
// 20261108170000 registers the reviewed successor body and classifies rolled-back errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {billedFixture} from './helpers/inventory-billed-amount-fixture.mjs';
import {installStandaloneJournal} from './helpers/inventory-writer-integration-fixture.mjs';

const m=n=>readFileSync('supabase/migrations/'+n,'utf8');
const fix='20261108170000_inventory_receipt_edit_writer_successor.sql';
const one=async(db,sql,a=[])=>(await db.query(sql,a)).rows[0];
const num=v=>v==null?null:Number(v);

async function chain({applyFix=true,laterCount=false}={}){
 const db=await billedFixture();
 await db.exec(m('20261030180000_inventory_receipt_supplier_all_staff.sql'));
 // Same structure as #15182: kg item at 2.86, receipt 1.26 x 60,000 = 75,600 from a postpaid
 // mapped supplier, booked by the owner (confirmed expense + unpaid payable), no edits yet.
 await db.exec(`insert into inventory(id,quantity,purchase_price,item_name,item_name_vi,supplier,unit,category,updated_at,supplier_partner_id)
   values(315,2.86,60000,'Táo','Táo','Won Mart','kg','Drinks','2026-10-11T09:26:27Z',10);
  insert into inventory_logs(id,item_id,item_name,item_name_vi,category,category_vi,unit,change_quantity,new_purchase_price,new_supplier,
    purchase_supplier_partner_id,business_date,source,reason,actor_username,source_actor_user_id,created_at,action,prev_quantity,new_quantity)
   values(15182,315,'Táo','Táo','Drinks','Nuoc','kg',1.26,60000,'Won Mart',10,'2026-10-11','edit_form','purchase','nhon',1,'2026-10-11T09:26:27Z','update',1.60,2.86);
  select ledger_project_inventory_purchase_log_v1(15182,2);`);
 if(laterCount)await db.exec(`insert into inventory_logs(item_id,item_name,unit,change_quantity,business_date,source,reason,created_at,prev_quantity,new_quantity)
   values(315,'Táo','kg',0,'2026-10-11','edit_form','stock_check','2026-10-11T10:00:00Z',2.86,2.86)`);
 await installStandaloneJournal(db);
 const signed=m('20261102142849_pos_signed_projection_epochs_and_handoff.sql');
 await db.exec('create schema pos_signed_private');
 await db.exec(signed.slice(signed.indexOf('create table pos_signed_private.rpc_successors'),signed.indexOf("do $$ declare n text;begin\n foreach n in array array['epochs'")));
 await db.exec(signed.slice(signed.indexOf('-- Update only the contract resolver'),signed.indexOf('create function public.pos_signed_compare')));
 await db.exec(m('20261104170000_inventory_receipt_edit_month_and_paid_billed.sql'));
 await db.exec(m('20261105120000_inventory_paid_receipt_billed_increase.sql'));
 if(applyFix)await db.exec(m(fix));
 return db;
}
const item=async db=>(await one(db,'select to_jsonb(i) i from inventory i where id=315')).i;
const edit=async(db,{snapshot,quantity=1.16,reason='Sai số lượng nhập'}={})=>{
 const it=snapshot??await item(db);
 return (await one(db,"select inventory_apply_purchase_receipt_edit_v1(315,15182,$1,$2::jsonb,$3::jsonb,'2026-10-11',1) r",
  [it.quantity,JSON.stringify(it),JSON.stringify({quantity,purchase_price:60000,supplier:'Won Mart',supplier_partner_id:10,reason})])).r;
};
async function state(db){
 const r={};
 for(const t of ['inventory','inventory_logs','ledger_transactions','ledger_payables','ledger_candidates','ledger_audit_logs','inventory_writer_private.changes'])
  r[t]=(await db.query(`select to_jsonb(x) as row from ${t} x order by to_jsonb(x)::text`)).rows;
 return r;
}
// Net booked cost / open payable of receipt #15182 (original party 10, category of the fixture).
const receiptLedger=async db=>({
 expense:num((await one(db,"select coalesce(sum(amount*economic_effect_sign),0) s from ledger_transactions where status='confirmed' and type='expense' and id<>1")).s),
 unpaid:(await db.query("select original_amount from ledger_payables where status='unpaid' and id<>1 order by id")).rows.map(r=>num(r.original_amount)),
 candidate:num((await one(db,"select proposed_amount from ledger_candidates where source_key='inventory-log:15182' order by id desc limit 1")).proposed_amount),
});

test('operating order before the fix: a normal quantity decrease is rolled back as receipt_edit_review (reported failure)',async()=>{
 const db=await chain({applyFix:false});try{
  const before=await state(db);
  const r=await edit(db);
  assert.deepEqual(r,{status:'purchase_correction_review_required',code:'INVENTORY_WRITER_REGISTERED_REQUEST_REQUIRED',blockReason:'receipt_edit_review'});
  assert.deepEqual(await state(db),before,'nothing written');
 }finally{await db.close();}
});

test('fix: 1.26kg -> 1.16kg x 60,000 saves stock and rebooks the ledger atomically (75,600 -> 69,600, -6,000)',async()=>{
 const db=await chain();try{
  const seeded=await receiptLedger(db);
  assert.deepEqual(seeded,{expense:75600,unpaid:[75600],candidate:75600});
  const r=await edit(db);
  assert.equal(r.status,'ok');assert.equal(r.completion,'complete');assert.equal(r.ledgerSync.code,'REBOOKED');
  assert.equal(num(r.amount),69600);assert.equal(num(r.quantityDelta),-0.1);
  assert.equal(num((await item(db)).quantity),2.76);
  const after=await receiptLedger(db);
  assert.deepEqual(after,{expense:69600,unpaid:[69600],candidate:69600});
  assert.equal(seeded.expense-after.expense,6000);
  // Reversal of the original 75,600, original payable cancelled, new booking 69,600 unpaid at the same party.
  const tx=(await db.query("select amount,source_type,economic_effect_sign,party_id from ledger_transactions where id<>1 order by id")).rows;
  assert.deepEqual(tx.map(t=>[t.source_type,num(t.amount),num(t.economic_effect_sign)]),
   [['inventory_purchase_candidate',75600,1],['inventory_purchase_reversal',75600,-1],['inventory_purchase_rebook',69600,1]]);
  assert.equal(new Set(tx.map(t=>num(t.party_id))).size,1);
  assert.deepEqual((await db.query("select status,original_amount from ledger_payables where id<>1 order by id")).rows.map(p=>[p.status,num(p.original_amount)]),
   [['cancelled',75600],['unpaid',69600]]);
  // Edit log + receipt-edit audit + writer journal entry in the same transaction.
  const log=await one(db,"select * from inventory_logs where correction_of_inventory_log_id=15182");
  assert.equal(num(log.change_quantity),-0.1);assert.equal(log.action,'receipt_edit');assert.match(log.new_note,/^Sai số lượng nhập/);
  assert.equal(num((await one(db,"select count(*) c from ledger_audit_logs where action='inventory_purchase_receipt_edited'")).c),1);
  const change=await one(db,'select * from inventory_writer_private.changes where item_id=315');
  assert.equal(num(change.previous_quantity),2.86);assert.equal(num(change.new_quantity),2.76);
  // The reviewed successor is registered; no registered writer remains drifted.
  assert.equal(num((await one(db,"select count(*) c from inventory_writer_private.rpc_contracts c join pg_proc p on p.oid=c.function_oid where p.prosrc is distinct from pos_signed_private.current_rpc_body(c.function_oid)")).c),0);
 }finally{await db.close();}
});

test('fix: double click / retry never applies the correction twice',async()=>{
 const db=await chain();try{
  const stale=await item(db);
  assert.equal((await edit(db,{snapshot:stale})).status,'ok');
  const once=await state(db);
  // Second click with the screen's old snapshot: the quantity guard refuses it.
  assert.equal((await edit(db,{snapshot:stale})).status,'quantity_conflict');
  // Retry after reload with the same request: nothing left to change.
  assert.equal((await edit(db)).status,'no_change');
  assert.deepEqual(await state(db),once);
 }finally{await db.close();}
});

for(const [name,setup,blockReason] of [
 ['paid',"update ledger_payables set status='paid' where id=2",'payment_completed'],
 ['allocated',"insert into ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount) values(2,2,1)",'payment_allocated'],
 ['closed month',"insert into ledger_month_closures(month) values('2026-10-01')",'month_closed'],
 ['manual ledger amount',"update ledger_transactions set amount=75000 where id=2",'ledger_amount_changed'],
])test('fix keeps the '+name+' block with nothing written',async()=>{
 const db=await chain();try{
  await db.exec(setup);
  const before=await state(db);
  const r=await edit(db);
  assert.equal(r.status,'purchase_correction_review_required');assert.equal(r.blockReason,blockReason);
  assert.deepEqual(await state(db),before);
 }finally{await db.close();}
});

test('fix keeps the later stock-check block for a quantity edit',async()=>{
 const db=await chain({laterCount:true});try{
  const before=await state(db);
  assert.equal((await edit(db)).status,'purchase_correction_later_stock_check');
  assert.deepEqual(await state(db),before);
 }finally{await db.close();}
});

// A failure after the stock update (here: the final receipt audit insert) rolls back stock, edit
// log, ledger rebook and writer journal together, and is classified with a diagnostic code.
for(const [name,raise,expected] of [
 ['unexpected DB error',"perform 1/0",{code:'RECEIPT_EDIT_FAILED',blockReason:'receipt_edit_unexpected',sqlState:'22012'}],
 ['concurrent lock conflict',"raise exception 'could not serialize' using errcode='40001'",{code:'RECEIPT_EDIT_FAILED',blockReason:'inventory_busy_retry',sqlState:'40001'}],
 ['writer contract',"raise exception 'INVENTORY_WRITER_REGISTERED_REQUEST_REQUIRED' using errcode='42501'",{code:'INVENTORY_WRITER_REGISTERED_REQUEST_REQUIRED',blockReason:'inventory_writer_contract',sqlState:'42501'}],
 ['ledger verification code',"raise exception 'INVENTORY_LEDGER_ATOMIC_FAILED'",{code:'INVENTORY_LEDGER_ATOMIC_FAILED',blockReason:'receipt_edit_review',sqlState:'P0001'}],
])test('fix: '+name+' after the stock write rolls back everything and is classified',async()=>{
 const db=await chain();try{
  await db.exec(`create function fail_receipt_audit() returns trigger language plpgsql as $$begin
   if new.action='inventory_purchase_receipt_edited' then ${raise}; end if; return new; end$$;
   create trigger fail_receipt_audit before insert on ledger_audit_logs for each row execute function fail_receipt_audit();`);
  const before=await state(db);
  const r=await edit(db);
  assert.deepEqual(r,{status:'purchase_correction_review_required',...expected});
  assert.deepEqual(await state(db),before,'stock, logs, ledger and writer journal unchanged');
 }finally{await db.close();}
});

test('the fix refuses to run on an unreviewed body and cannot be applied twice',async()=>{
 const db=await chain();try{
  await assert.rejects(db.exec(m(fix)),/RECEIPT_EDIT_WRITER_SUCCESSOR_ALREADY_REGISTERED/);
 }finally{await db.close();}
 const drifted=await chain({applyFix:false});try{
  await drifted.exec(`do $$declare d text;begin
   d:=pg_get_functiondef('public.inventory_apply_purchase_receipt_edit_v1(bigint,bigint,numeric,jsonb,jsonb,date,bigint)'::regprocedure);
   execute replace(d,'v_note_text:=v_reason','v_note_text:=v_reason||''''');end$$;`);
  await assert.rejects(drifted.exec(m(fix)),/RECEIPT_EDIT_WRITER_DRIFT_UNREVIEWED/);
 }finally{await drifted.close();}
});
