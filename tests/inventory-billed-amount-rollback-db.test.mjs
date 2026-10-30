import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {receiptEditFixture,item,editReceipt} from './helpers/inventory-receipt-edit-fixture.mjs';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const migrations=['supabase/migrations/20261030150000_inventory_purchase_billed_amount.sql','supabase/migrations/20261030170000_inventory_create_with_receipt.sql'];
const rollback='docs/reports/20261030-inventory-billed-amount-rollback.sql';
const functions=['public.inventory_apply_purchase_receipt_edit_v1(bigint,bigint,numeric,jsonb,jsonb,date,bigint)',
 'public.inventory_update_with_audit_v1(bigint,jsonb,jsonb,date,bigint,text,text,date)',
 'inventory_ledger_private.inspect_purchase_repair(bigint,bigint)','inventory_ledger_private.economics(jsonb)',
 'public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'];
// Exact bodies (line endings included), privileges, columns, triggers and new objects.
const shape=async db=>({
 bodies:Object.fromEntries(await Promise.all(functions.map(async f=>[f,(await one(db,'select md5(prosrc) as m from pg_proc where oid=$1::regprocedure',[f])).m]))),
 acl:Object.fromEntries(await Promise.all(functions.map(async f=>[f,(await one(db,'select proacl::text as a from pg_proc where oid=$1::regprocedure',[f])).a]))),
 columns:(await db.query("select column_name from information_schema.columns where table_name='inventory_logs' order by 1")).rows.map(r=>r.column_name),
 triggers:(await db.query("select tgname from pg_trigger where tgrelid='inventory_logs'::regclass and not tgisinternal order by 1")).rows.map(r=>r.tgname),
 extra:(await one(db,`select to_regprocedure('public.inventory_create_with_receipt_v1(jsonb,text,date,bigint)')::text as a,
  to_regprocedure('inventory_ledger_private.purchase_billed_amount_v1(bigint,bigint)')::text as b,
  to_regprocedure('inventory_ledger_private.inventory_name_key_v1(text)')::text as c,
  to_regprocedure('public.inventory_purchase_billed_amount_guard_v1()')::text as d`)),
});

for(const eol of ['LF','CRLF'])test(`rollback restores the exact pre-migration state (${eol} projector, as deployed)`,async()=>{
 const db=await receiptEditFixture();try{
  if(eol==='CRLF'){
   // Production shape: CRLF body that already carries the display-sync declaration.
   const def=(await one(db,"select pg_get_functiondef('public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'::regprocedure) as d")).d
    .replace('  v_corrections bigint[];\n','  v_corrections bigint[];\n  v_display_sync jsonb;\n');
   const cut=def.indexOf('$function$')+10;
   await db.exec(def.slice(0,cut)+def.slice(cut).replace(/\n/g,'\r\n').replace(/\r\n\$function\$\r\n?$/,'\r\n$function$\n'));
  }
  const before=await shape(db);
  for(const file of migrations)await db.exec(readFileSync(file,'utf8'));
  // Activity before the rollback: an automatic receipt edit (no manual amount).
  assert.equal((await editReceipt(db,await item(db),{quantity:12,billed_amount_mode:'auto'})).status,'ok');
  assert.notDeepEqual(await shape(db),before);
  await db.exec(readFileSync(rollback,'utf8'));
  assert.deepEqual(await shape(db),before);
  // The restored functions work as before the migration.
  const r=await editReceipt(db,await item(db),{quantity:11});assert.equal(r.status,'ok');assert.equal(r.ledgerSync.code,'REBOOKED');
  // Running it twice is refused without changes.
  await assert.rejects(db.exec(readFileSync(rollback,'utf8')),/BILLED_AMOUNT_ROLLBACK_NOT_APPLIED/);await db.exec('rollback').catch(()=>{});
  assert.deepEqual((await shape(db)).bodies,before.bodies);
 }finally{await db.close();}
});

test('rollback is refused once a manual 실청구금액 exists; nothing changes',async()=>{
 const db=await receiptEditFixture();try{
  for(const file of migrations)await db.exec(readFileSync(file,'utf8'));
  assert.equal((await editReceipt(db,await item(db),{quantity:3.57,purchase_price:85000,billed_amount_mode:'manual',billed_amount:303000})).status,'ok');
  const applied=await shape(db);
  await assert.rejects(db.exec(readFileSync(rollback,'utf8')),/BILLED_AMOUNT_ROLLBACK_BLOCKED_MANUAL_AMOUNTS_EXIST/);await db.exec('rollback').catch(()=>{});
  assert.deepEqual(await shape(db),applied);
 }finally{await db.close();}
});

test('migration order: 170000 alone is refused; each migration is one transaction and refuses re-application',async()=>{
 const db=await receiptEditFixture();try{
  const before=await shape(db);
  await assert.rejects(db.exec(readFileSync(migrations[1],'utf8')),/INVENTORY_CREATE_REQUIRES_BILLED_AMOUNT_MIGRATION/);await db.exec('rollback').catch(()=>{});
  assert.deepEqual(await shape(db),before,'nothing left behind');
  for(const file of migrations)await db.exec(readFileSync(file,'utf8'));
  for(const [file,error] of [[migrations[0],/INVENTORY_BILLED_AMOUNT_ALREADY_APPLIED/],[migrations[1],/INVENTORY_CREATE_WITH_RECEIPT_ALREADY_APPLIED/]]){
   const applied=await shape(db);
   await assert.rejects(db.exec(readFileSync(file,'utf8')),error);await db.exec('rollback').catch(()=>{});
   assert.deepEqual(await shape(db),applied);
  }
 }finally{await db.close();}
});

test('the currently deployed app keeps working on the migrated DB (DB first, app later)',async()=>{
 const db=await receiptEditFixture();try{
  for(const file of migrations)await db.exec(readFileSync(file,'utf8'));
  // Old POST: item and receipt log written directly (no billed columns), projected separately.
  await db.exec(`insert into inventory_logs(id,item_id,item_name,unit,change_quantity,new_purchase_price,new_supplier,purchase_supplier_partner_id,business_date,source,reason,created_at)
   values(400,1,'Coca','can',3,20000,'Won Mart',10,'2026-10-11','create','purchase','2026-10-11T06:00:00Z')`);
  const p=(await one(db,'select ledger_project_inventory_purchase_log_v1(400,1) as r')).r;assert.notEqual(p.status,'failed');
  const c=await one(db,"select * from ledger_candidates where source_key='inventory-log:400' order by id desc limit 1");
  assert.equal(Number(c.proposed_amount),60000);assert.equal(c.source_snapshot.billed_amount_mode,undefined);
  // Old quick save (no billed keys) and old 입고 수정 (no billed keys) keep their contracts.
  const old=await item(db);
  const saved=(await one(db,'select inventory_update_with_audit_v1(1,$1::jsonb,$2::jsonb,$3::date,1,$4,$5,$3::date) as r',[JSON.stringify(old),JSON.stringify({quantity:Number(old.quantity)+2}),'2026-10-11','purchase','quick_save'])).r;
  assert.deepEqual(Object.keys(saved).sort(),['inventoryLogId','status']);
  assert.equal((await one(db,'select billed_amount_mode from inventory_logs where id=$1',[saved.inventoryLogId])).billed_amount_mode,null);
  const edited=await editReceipt(db,await item(db),{quantity:12});assert.equal(edited.status,'ok');assert.equal(edited.billedAmountMode,'auto');
  // Old daily sync rewrites a legacy receipt's price row in place: still allowed.
  await db.query('update inventory_logs set new_purchase_price=21000 where id=400');
 }finally{await db.close();}
});
