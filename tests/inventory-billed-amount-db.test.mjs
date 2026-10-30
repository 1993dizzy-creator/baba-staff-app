import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {billedFixture,billedMigration} from './helpers/inventory-billed-amount-fixture.mjs';
import {receiptEditFixture,item,editReceipt,state} from './helpers/inventory-receipt-edit-fixture.mjs';
import {correct} from './helpers/inventory-safe-correction-fixture.mjs';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const net=async db=>Number((await one(db,'select coalesce(sum(amount*economic_effect_sign),0) as n from ledger_transactions')).n);
const openPayable=async db=>one(db,"select * from ledger_payables where status='unpaid'");
const candidate=async db=>one(db,"select * from ledger_candidates where source_key='inventory-log:100' order by id desc limit 1");
const orange={quantity:3.57,purchase_price:85000,reason:'영수증 금액 확인'};
// Quick save / edit-form receipt through inventory_update_with_audit_v1 (fixture store day 2026-10-11).
const save=async(db,payload,reason='purchase',source='quick_save',actor=1)=>(await one(db,
 'select inventory_update_with_audit_v1(1,$1::jsonb,$2::jsonb,$3::date,$4,$5,$6,$3::date) as result',
 [JSON.stringify(await item(db)),JSON.stringify(payload),'2026-10-11',actor,reason,source])).result;

test('orange: 3.57kg x 85,000 = 303,450 calculated, manual 303,000 booked, -450 difference, payment kept separate',async()=>{
 const db=await billedFixture();try{
  const r=await editReceipt(db,await item(db),{...orange,billed_amount_mode:'manual',billed_amount:303000});
  assert.equal(r.status,'ok');assert.equal(r.completion,'complete');assert.equal(r.ledgerSync.code,'REBOOKED');
  assert.equal(r.billedAmountMode,'manual');assert.equal(Number(r.amount),303000);assert.equal(Number(r.calculatedAmount),303450);
  assert.equal(Number(r.amount)-Number(r.calculatedAmount),-450);
  const log=await one(db,'select * from inventory_logs where id=$1',[r.inventoryLogId]);
  assert.equal(log.billed_amount_mode,'manual');assert.equal(Number(log.billed_amount),303000);assert.equal(Number(log.new_purchase_price),85000);
  // Ledger cost and payable use the billed amount; the snapshot keeps the calculated amount for display.
  assert.equal(await net(db),303000);const payable=await openPayable(db);assert.equal(Number(payable.original_amount),303000);
  const c=await candidate(db);assert.equal(c.status,'confirmed');assert.equal(Number(c.proposed_amount),303000);
  assert.equal(Number(c.source_snapshot.purchase_amount),303000);assert.equal(Number(c.source_snapshot.calculated_amount),303450);
  assert.equal(c.source_snapshot.billed_amount_mode,'manual');assert.equal(Number(c.source_snapshot.change_quantity),3.57);
  // Item master data is never derived from the billed amount.
  const now=await item(db);assert.equal(Number(now.purchase_price),20000);assert.equal(Number(now.quantity),3.57);
  assert.equal(Number((await one(db,'select count(*) as n from inventory_price_logs')).n),0);
  const audit=await one(db,"select * from ledger_audit_logs where action='inventory_purchase_receipt_edited'");
  assert.equal(audit.before_snapshot.billedAmountMode,'auto');assert.equal(Number(audit.before_snapshot.amount),200000);
  assert.equal(audit.after_snapshot.billedAmountMode,'manual');assert.equal(Number(audit.after_snapshot.billedAmount),303000);
  assert.equal(Number(audit.after_snapshot.calculatedAmount),303450);
  // The actual 300,000 cash payment is a separate Ledger allocation, never this amount. After it,
  // 3,000 stays outstanding and every further receipt edit is refused before any write.
  await db.exec('insert into ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount) select id,expense_transaction_id,300000 from ledger_payables where status=\'unpaid\'');
  assert.equal(Number((await one(db,"select original_amount-coalesce((select sum(allocated_amount) from ledger_payable_allocations a where a.payable_id=p.id),0) as rest from ledger_payables p where status='unpaid'")).rest),3000);
  const before=await state(db),blocked=await editReceipt(db,await item(db),{...orange,billed_amount_mode:'manual',billed_amount:300000});
  assert.equal(blocked.status,'purchase_correction_review_required');assert.equal(blocked.blockReason,'payment_allocated');
  assert.deepEqual(await state(db),before);
 }finally{await db.close();}
});

test('auto mode is the legacy calculation: no new snapshot keys, no drift for untouched receipts',async()=>{
 const legacy=await receiptEditFixture(),migrated=await billedFixture();try{
  const a=await editReceipt(legacy,await item(legacy),{quantity:12});
  const b=await editReceipt(migrated,await item(migrated),{quantity:12,billed_amount_mode:'auto'});
  assert.equal(a.ledgerSync.code,'REBOOKED');assert.equal(b.ledgerSync.code,'REBOOKED');
  const [ca,cb]=[await candidate(legacy),await candidate(migrated)];
  assert.deepEqual({...cb.source_snapshot,inventory_correction_log_ids:null},{...ca.source_snapshot,inventory_correction_log_ids:null});
  assert.equal(cb.source_snapshot.billed_amount_mode,undefined);assert.equal(cb.source_snapshot.calculated_amount,undefined);
  assert.equal(await net(migrated),240000);
 }finally{await legacy.close();await migrated.close();}
 // A receipt booked before the migration projects UNCHANGED afterwards: same fingerprint, no Ledger write.
 const db=await receiptEditFixture();try{
  // Settle once on the pre-migration projector (the fixture's first run records drift metadata).
  await one(db,'select ledger_project_inventory_purchase_log_v1(100,2) as r');
  const before=await candidate(db),ledger=(await state(db)).ledger_transactions;
  const fingerprint=(await one(db,'select source_fingerprint from ledger_inventory_projection_status where inventory_log_id=100')).source_fingerprint;
  await db.exec(readFileSync(billedMigration,'utf8'));
  const p=(await one(db,'select ledger_project_inventory_purchase_log_v1(100,2) as r')).r;
  assert.equal(p.status,'synced');assert.equal(p.code,'UNCHANGED');
  assert.equal((await one(db,'select source_fingerprint from ledger_inventory_projection_status where inventory_log_id=100')).source_fingerprint,fingerprint);
  assert.deepEqual(await candidate(db),before);assert.deepEqual((await state(db)).ledger_transactions,ledger);
  assert.equal(Number((await one(db,'select count(*) as n from inventory_logs where billed_amount_mode is not null')).n),0);
 }finally{await db.close();}
});

test('manual equal to the calculated amount stays manual; a mode switch at the same amount is metadata, not a rebook',async()=>{
 const db=await billedFixture();try{
  const r=await editReceipt(db,await item(db),{reason:'금액 확인',billed_amount_mode:'manual',billed_amount:200000});
  assert.equal(r.status,'ok');assert.equal(r.billedAmountMode,'manual');assert.equal(r.ledgerSync.code,'METADATA_SYNCED');
  assert.equal(Number((await one(db,"select count(*) as n from ledger_transactions where source_type='inventory_purchase_reversal'")).n),0);
  assert.equal(await net(db),200000);
  assert.equal((await one(db,'select billed_amount_mode from inventory_logs where id=$1',[r.inventoryLogId])).billed_amount_mode,'manual');
  // Same request again (retry/double click) writes nothing.
  assert.equal((await editReceipt(db,await item(db),{reason:'금액 확인',billed_amount_mode:'manual',billed_amount:200000})).status,'no_change');
 }finally{await db.close();}
});

test('manual amount survives quantity/price edits and older clients; 자동계산 복원 returns to quantity x price',async()=>{
 const db=await billedFixture();try{
  assert.equal((await editReceipt(db,await item(db),{...orange,billed_amount_mode:'manual',billed_amount:303000})).status,'ok');
  // An older client (no billed keys) changes the quantity: the manual amount is carried, not recalculated.
  let r=await editReceipt(db,await item(db),{quantity:3.6,purchase_price:85000,reason:'수량 재확인'});
  assert.equal(r.status,'ok');assert.equal(r.billedAmountMode,'manual');assert.equal(Number(r.amount),303000);
  assert.equal(r.ledgerSync.code,'REBOOKED');assert.equal(await net(db),303000);
  // Memo-only edit by an older client keeps the manual amount; the identical retry is no_change.
  r=await editReceipt(db,await item(db),{quantity:3.6,purchase_price:85000,reason:'메모',note:'영수증 사진'});
  assert.equal(r.status,'ok');assert.equal(r.billedAmountMode,'manual');
  assert.equal((await editReceipt(db,await item(db),{quantity:3.6,purchase_price:85000,reason:'메모',note:'영수증 사진'})).status,'no_change');
  // Repeated manual correction, then restore auto.
  r=await editReceipt(db,await item(db),{quantity:3.6,purchase_price:85000,reason:'재정정',billed_amount_mode:'manual',billed_amount:305000});
  assert.equal(Number(r.amount),305000);assert.equal(await net(db),305000);
  r=await editReceipt(db,await item(db),{quantity:3.6,purchase_price:85000,reason:'자동계산 복원',billed_amount_mode:'auto'});
  assert.equal(r.status,'ok');assert.equal(r.billedAmountMode,'auto');assert.equal(Number(r.amount),306000);assert.equal(await net(db),306000);
  const c=await candidate(db);assert.equal(c.source_snapshot.billed_amount_mode,undefined);assert.equal(Number(c.source_snapshot.purchase_amount),306000);
  // History: every edit log records its mode; nothing was rewritten in place.
  assert.deepEqual((await db.query('select billed_amount_mode as m,billed_amount::text as a from inventory_logs where correction_of_inventory_log_id=100 order by id')).rows,
   [{m:'manual',a:'303000.000'},{m:'manual',a:'303000.000'},{m:'manual',a:'303000.000'},{m:'manual',a:'305000.000'},{m:'auto',a:null}]);
  assert.equal((await one(db,'select billed_amount_mode from inventory_logs where id=100')).billed_amount_mode,null);
 }finally{await db.close();}
});

test('decimal quantities and full cancellation follow the projector rounding',async()=>{
 const db=await billedFixture();try{
  let r=await editReceipt(db,await item(db),{quantity:0.333,purchase_price:3001,reason:'소수 수량'});
  assert.equal(r.status,'ok');assert.equal(Number(r.calculatedAmount),999.333);assert.equal(await net(db),999.333);
  r=await editReceipt(db,await item(db),{quantity:0.333,purchase_price:3001,reason:'반올림 청구',billed_amount_mode:'manual',billed_amount:1000});
  assert.equal(await net(db),1000);
  for(const billed of [1000.0001,0,-1,'abc'])
   assert.equal((await editReceipt(db,await item(db),{quantity:0.333,purchase_price:3001,reason:'x',billed_amount_mode:'manual',billed_amount:billed})).status,'invalid_payload',String(billed));
  for(const edit of [{billed_amount_mode:'other'},{billed_amount_mode:'auto',billed_amount:5},{billed_amount:5},{quantity:0,billed_amount_mode:'manual',billed_amount:5}])
   assert.equal((await editReceipt(db,await item(db),{quantity:0.333,purchase_price:3001,reason:'x',...edit})).status,'invalid_payload',JSON.stringify(edit));
  // Cancelling a manual receipt from an older client is automatic: amount 0, candidate dismissed.
  r=await editReceipt(db,await item(db),{quantity:0,purchase_price:3001,reason:'전체 취소'});
  assert.equal(r.status,'ok');assert.equal(r.billedAmountMode,'auto');assert.equal(await net(db),0);
  assert.equal((await candidate(db)).status,'dismissed');
 }finally{await db.close();}
});

for(const [name,setup,blockReason] of [
 ['paid',"update ledger_payables set status='paid'",'payment_completed'],
 ['partially paid',"update ledger_payables set status='partially_paid'",'payment_state'],
 ['allocated',"insert into ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount) select p.id,p.expense_transaction_id,1 from ledger_payables p",'payment_allocated'],
 ['closed month',"insert into ledger_month_closures(month) values('2026-10-01')",'month_closed'],
 ['manual Ledger amount',"update ledger_transactions set amount=199000 where type='expense'",'ledger_amount_changed'],
])test(`${name}: a billed amount change is refused without any write and no adjustment is reversed`,async()=>{
 const db=await billedFixture();try{
  await db.exec(setup);const before=await state(db);
  const r=await editReceipt(db,await item(db),{reason:'청구액',billed_amount_mode:'manual',billed_amount:199500});
  assert.equal(r.status,'purchase_correction_review_required');assert.equal(r.blockReason,blockReason);
  assert.deepEqual(await state(db),before);
 }finally{await db.close();}
});

test('earlier-day billed edit stays owner review; the repair preview shows the billed amount',async()=>{
 const db=await billedFixture();try{
  await db.exec("update inventory_logs set business_date='2026-10-10' where id=100");
  const before=(await state(db)).ledger_transactions;
  const r=await editReceipt(db,await item(db),{...orange,billed_amount_mode:'manual',billed_amount:303000});
  assert.equal(r.status,'ok');assert.equal(r.completion,'ledger_review');assert.deepEqual((await state(db)).ledger_transactions,before);
  const preview=(await one(db,'select inventory_ledger_private.inspect_purchase_repair($1,100) as p',[r.inventoryLogId])).p;
  assert.equal(Number(preview.newAmount),303000);assert.equal(Number(preview.calculatedAmount),303450);
  assert.equal(preview.billedAmountMode,'manual');assert.equal(Number(preview.delta),103000);
  // One open review per receipt: the next edit waits for the owner.
  assert.equal((await editReceipt(db,await item(db),{...orange,reason:'다시'})).blockReason,'ledger_review_pending');
 }finally{await db.close();}
});

test('quick save books the stock increase x price (not the final stock) and projects in the same transaction',async()=>{
 const db=await billedFixture();try{
  const r=await save(db,{quantity:13.57,purchase_price:85000,billed_amount_mode:'manual',billed_amount:303000});
  assert.equal(r.status,'ok');assert.ok(r.ledgerSync,'projection result returned by the RPC');
  const log=await one(db,'select * from inventory_logs where id=$1',[r.inventoryLogId]);
  assert.equal(Number(log.change_quantity),3.57);assert.equal(log.billed_amount_mode,'manual');assert.equal(Number(log.billed_amount),303000);
  assert.equal(log.correction_of_inventory_log_id,null);
  const status=await one(db,'select * from ledger_inventory_projection_status where inventory_log_id=$1',[r.inventoryLogId]);
  assert.ok(status,'projection status committed with the receipt');assert.equal(status.status,r.ledgerSync.status);
  const c=await one(db,'select * from ledger_candidates where source_key=$1 order by id desc limit 1',['inventory-log:'+r.inventoryLogId]);
  assert.equal(Number(c.proposed_amount),303000);assert.equal(Number(c.source_snapshot.calculated_amount),303450);
  if(c.status==='confirmed')assert.equal(Number((await one(db,'select amount from ledger_transactions where id=$1',[c.resolved_transaction_id])).amount),303000);
  // Auto receipt: calculated from the increase (2 x 85,000), no billed snapshot keys.
  const auto=await save(db,{quantity:15.57,purchase_price:85000,billed_amount_mode:'auto'});
  const ac=await one(db,'select * from ledger_candidates where source_key=$1 order by id desc limit 1',['inventory-log:'+auto.inventoryLogId]);
  assert.equal(Number(ac.proposed_amount),170000);assert.equal(ac.source_snapshot.billed_amount_mode,undefined);
  assert.equal((await one(db,'select billed_amount_mode from inventory_logs where id=$1',[auto.inventoryLogId])).billed_amount_mode,'auto');
 }finally{await db.close();}
});

test('quick save: billed keys are only for a new receipt; invalid values write nothing; legacy callers unchanged',async()=>{
 const db=await billedFixture();try{
  const before=await state(db);
  for(const [payload,reason] of [
   [{quantity:9,billed_amount_mode:'manual',billed_amount:1},'stock_check'],
   [{quantity:12,billed_amount_mode:'manual',billed_amount:0},'purchase'],
   [{quantity:12,billed_amount_mode:'manual'},'purchase'],
   [{quantity:12,billed_amount_mode:'auto',billed_amount:1},'purchase'],
   [{quantity:12,billed_amount_mode:'manual',billed_amount:'x'},'purchase'],
   [{quantity:12,purchase_price:null,billed_amount_mode:'manual',billed_amount:5},'purchase'],
  ])assert.equal((await save(db,payload,reason)).status,'invalid_payload',JSON.stringify(payload));
  assert.deepEqual(await state(db),before);
  // auto on a stock check is ignored (no billed state on a non-receipt log, no in-RPC projection).
  const check=await save(db,{quantity:9,billed_amount_mode:'auto'},'stock_check');
  assert.equal(check.status,'ok');assert.equal(check.ledgerSync,undefined);
  assert.equal((await one(db,'select billed_amount_mode from inventory_logs where id=$1',[check.inventoryLogId])).billed_amount_mode,null);
  // Without billed keys the RPC returns exactly the previous contract (the app projects separately).
  const legacy=await save(db,{quantity:12},'purchase');assert.deepEqual(Object.keys(legacy).sort(),['inventoryLogId','status']);
 }finally{await db.close();}
});

test('history guard: billed values are immutable, a manual receipt keeps its amount fields, unmoded corrections are refused',async()=>{
 const db=await billedFixture();try{
  const r=await editReceipt(db,await item(db),{...orange,billed_amount_mode:'manual',billed_amount:303000});
  await assert.rejects(db.query('update inventory_logs set billed_amount=1 where id=$1',[r.inventoryLogId]),/PURCHASE_BILLED_AMOUNT_IMMUTABLE/);
  await assert.rejects(db.query("update inventory_logs set billed_amount_mode='auto',billed_amount=null where id=$1",[r.inventoryLogId]),/PURCHASE_BILLED_AMOUNT_IMMUTABLE/);
  await assert.rejects(db.query('update inventory_logs set new_purchase_price=90000 where id=$1',[r.inventoryLogId]),/PURCHASE_BILLED_AMOUNT_EDIT_REQUIRED/);
  await db.query("update inventory_logs set item_name='Orange' where id=$1",[r.inventoryLogId]);
  // Quick-save reduction (v3 correction, no billed mode) of a manual receipt: nothing is written.
  const before=await state(db);
  await assert.rejects(correct(db,await item(db),{quantity:3,purchase_price:85000}),/PURCHASE_BILLED_AMOUNT_EDIT_REQUIRED/);
  assert.deepEqual(await state(db),before);
  await assert.rejects(db.query("insert into inventory_logs(item_id,unit,change_quantity,new_purchase_price,new_supplier,business_date,source,reason,billed_amount_mode,billed_amount) values(1,'can',1,0,'Won Mart','2026-10-11','create','purchase','manual',5)"),/PURCHASE_BILLED_AMOUNT_INVALID/);
  await assert.rejects(db.query("insert into inventory_logs(item_id,unit,change_quantity,business_date,source,reason,billed_amount_mode) values(1,'can',1,'2026-10-11','quick_save','stock_check','auto')"),/inventory_logs_billed_amount_purchase_check/);
 }finally{await db.close();}
 // An auto receipt keeps the existing v3 same-day correction path.
 const db2=await billedFixture();try{
  const r=await correct(db2,await item(db2),{quantity:9});assert.equal(r.status,'ok');assert.equal(r.ledgerSync.code,'REBOOKED');assert.equal(await net(db2),180000);
 }finally{await db2.close();}
});

test('migration contract: re-application and an unexpected deployed body abort without partial changes; permissions stay closed',async()=>{
 const db=await billedFixture();try{
  await assert.rejects(db.exec(readFileSync(billedMigration,'utf8')),/INVENTORY_BILLED_AMOUNT_ALREADY_APPLIED/);
  await db.exec('rollback').catch(()=>{});
  const fn=s=>one(db,`select has_function_privilege('service_role',$1,'execute') as s,has_function_privilege('authenticated',$1,'execute') as a,has_function_privilege('anon',$1,'execute') as n`,[s]);
  for(const s of ['public.inventory_apply_purchase_receipt_edit_v1(bigint,bigint,numeric,jsonb,jsonb,date,bigint)','public.inventory_update_with_audit_v1(bigint,jsonb,jsonb,date,bigint,text,text,date)','public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'])
   assert.deepEqual(await fn(s),{s:true,a:false,n:false},s);
  for(const s of ['inventory_ledger_private.purchase_billed_amount_v1(bigint,bigint)','inventory_ledger_private.inspect_purchase_repair(bigint,bigint)','public.inventory_purchase_billed_amount_guard_v1()'])
   assert.deepEqual(await fn(s),{s:false,a:false,n:false},s);
  // economics() ignores only the display keys of a manual snapshot.
  const e=(await one(db,`select inventory_ledger_private.economics('{"purchase_amount":1,"billed_amount_mode":"manual","calculated_amount":2}'::jsonb) as e`)).e;
  assert.deepEqual(e,{purchase_amount:1});
 }finally{await db.close();}
 const db2=await receiptEditFixture();try{
  await db2.exec("create or replace function inventory_ledger_private.economics(p_snapshot jsonb) returns jsonb language sql immutable as $$select p_snapshot$$");
  const before=(await db2.query("select column_name from information_schema.columns where table_name='inventory_logs' order by 1")).rows;
  await assert.rejects(db2.exec(readFileSync(billedMigration,'utf8')),/INVENTORY_BILLED_AMOUNT_CONTRACT_MISMATCH/);
  await db2.exec('rollback').catch(()=>{});
  assert.deepEqual((await db2.query("select column_name from information_schema.columns where table_name='inventory_logs' order by 1")).rows,before);
 }finally{await db2.close();}
});

test('projector anchors apply to the deployed CRLF body that already carries the display-sync patch',async()=>{
 const db=await receiptEditFixture();try{
  // Reproduce the Production shape: CRLF line endings and the display-sync declaration.
  const def=(await one(db,"select pg_get_functiondef('public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'::regprocedure) as d")).d;
  assert.ok(def.includes('  v_corrections bigint[];\n'));
  const body=def.replace('  v_corrections bigint[];\n','  v_corrections bigint[];\n  v_display_sync jsonb;\n');
  const head=body.slice(0,body.indexOf('$function$')+10),rest=body.slice(body.indexOf('$function$')+10);
  await db.exec(head+rest.replace(/\n/g,'\r\n').replace(/\r\n\$function\$\r\n?$/,'\r\n$function$\n'));
  assert.ok((await one(db,"select position(chr(13) in prosrc)>0 as c from pg_proc where oid='public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'::regprocedure")).c);
  await db.exec(readFileSync(billedMigration,'utf8'));
  const after=(await one(db,"select prosrc from pg_proc where oid='public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'::regprocedure")).prosrc;
  assert.ok(after.includes('baba.billed_amount_v1'));assert.ok(after.includes('v_display_sync jsonb;'));
  assert.equal(after.replace(/\r\n/g,'').includes('\n'),false,'line endings stay CRLF');
  const r=await editReceipt(db,await item(db),{...orange,billed_amount_mode:'manual',billed_amount:303000});
  assert.equal(r.ledgerSync.code,'REBOOKED');assert.equal(await net(db),303000);
 }finally{await db.close();}
});
