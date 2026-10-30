import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {receiptEditFixture,item,editReceipt,state} from './helpers/inventory-receipt-edit-fixture.mjs';
import {billedFixture} from './helpers/inventory-billed-amount-fixture.mjs';

const migration='supabase/migrations/20261030180000_inventory_receipt_supplier_all_staff.sql';
const sql=readFileSync(migration,'utf8');
const signature='public.inventory_apply_purchase_receipt_edit_v1(bigint,bigint,numeric,jsonb,jsonb,date,bigint)';
const guard="  if v_supplier_changed and v_role <> all(array['owner','master']) then\n    return jsonb_build_object('status','supplier_change_forbidden');\n  end if;\n";
const roles=['staff','leader','manager','owner','master'];
const supplierEdit={supplier:'Postpaid',supplier_partner_id:12,reason:'Receipt supplier correction'};
const one=async(db,query,args=[])=>(await db.query(query,args)).rows[0];
const metadata=db=>one(db,'select prosrc,prosecdef,proconfig,proowner from pg_proc where oid=$1::regprocedure',[signature]);
const itemMaster=record=>Object.fromEntries(Object.entries(record).filter(([key])=>!['updated_at','updated_by_name','updated_by_username'].includes(key)));
const functions=db=>db.query("select oid::text,prosrc from pg_proc where pronamespace in ('public'::regnamespace,'inventory_ledger_private'::regnamespace) and oid<>$1::regprocedure order by oid",[signature]).then(r=>r.rows);
async function isolated(db,action){
 await db.exec('begin');
 try{return await action();}finally{await db.exec('rollback');}
}

// Exercise both deployed RPC shapes: receipt editing before and after billed-amount v1.
for(const [version,fixture] of [['receipt-v1',receiptEditFixture],['billed-v1',billedFixture]]){
 test(version+': migration changes only the supplier role guard and keeps RPC privileges closed',async()=>{
  const db=await fixture();try{
   const before=await metadata(db),rows=await state(db),others=await functions(db);
   assert.equal((await editReceipt(db,await item(db),supplierEdit)).status,'supplier_change_forbidden','reproduce the old staff restriction');
   await db.exec(sql);
   const expectedGuard=before.prosrc.includes(guard)?guard:guard.replaceAll('\n','\r\n');
   assert.equal(before.prosrc.split(expectedGuard).length,2);
   assert.deepEqual(await metadata(db),{...before,prosrc:before.prosrc.replace(expectedGuard,'')});
   assert.deepEqual(await state(db),rows,'migration rewrites no operating data');
   assert.deepEqual(await functions(db),others,'no other RPC is changed');
   const privileges=await one(db,"select has_function_privilege('service_role',$1,'execute') as service,has_function_privilege('anon',$1,'execute') as anon,has_function_privilege('authenticated',$1,'execute') as authenticated,exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=$1::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE') as public",[signature]);
   assert.deepEqual(privileges,{service:true,anon:false,authenticated:false,public:false});
   const callerItem=await item(db);
   for(const role of ['anon','authenticated']){
    await db.exec('set role '+role);await assert.rejects(editReceipt(db,callerItem,supplierEdit),/permission denied/);await db.exec('reset role');
   }
   const current=await item(db);await db.exec('set role service_role');
   const changed=await editReceipt(db,current,supplierEdit);await db.exec('reset role');assert.equal(changed.status,'ok');
   const settled=await state(db),body=await metadata(db);
   await assert.rejects(db.exec(sql),/INVENTORY_RECEIPT_SUPPLIER_GUARD_MISMATCH/);await db.exec('rollback');
   assert.deepEqual(await state(db),settled);assert.deepEqual(await metadata(db),body);
  }finally{await db.close();}
 });

 test(version+': every active app role changes a same-day unpaid receipt once, with audit and one effective payable',async t=>{
  const db=await fixture();try{
   await db.exec(sql);
   for(const role of roles)await t.test(role,()=>isolated(db,async()=>{
    await db.query('update users set role=$1 where id=1',[role]);
    const old=await item(db),root=await one(db,'select to_jsonb(l) as row from inventory_logs l where id=100');
    const result=await editReceipt(db,old,supplierEdit);
    assert.equal(result.status,'ok');assert.equal(result.completion,'complete');assert.equal(result.ledgerSync.code,'REBOOKED');
    assert.deepEqual(itemMaster(await item(db)),itemMaster(old));
    assert.deepEqual(await one(db,'select to_jsonb(l) as row from inventory_logs l where id=100'),root);
    const log=await one(db,'select * from inventory_logs where id=$1',[result.inventoryLogId]);
    assert.equal(Number(log.change_quantity),0);assert.equal(log.prev_supplier,'Won Mart');assert.equal(log.new_supplier,'Postpaid');assert.equal(Number(log.purchase_supplier_partner_id),12);
    const audit=await one(db,"select * from ledger_audit_logs where action='inventory_purchase_receipt_edited'");
    assert.equal(Number(audit.actor_user_id),1);assert.equal(audit.before_snapshot.supplier,'Won Mart');assert.equal(audit.after_snapshot.supplier,'Postpaid');assert.equal(Number(audit.after_snapshot.supplierPartnerId),12);
    const counts=await one(db,"select (select count(*) from inventory_logs where correction_of_inventory_log_id=100) as edits,(select count(*) from inventory_logs where correction_of_inventory_log_id is null and reason='purchase') as roots,(select count(*) from ledger_candidates where source_key='inventory-log:100') as candidates,(select count(*) from ledger_transactions where source_type='inventory_purchase_rebook') as rebooks,(select count(*) from ledger_payables where status='unpaid') as unpaid,(select sum(amount*economic_effect_sign) from ledger_transactions) as net");
    assert.deepEqual(Object.fromEntries(Object.entries(counts).map(([k,v])=>[k,Number(v)])),{edits:1,roots:1,candidates:1,rebooks:1,unpaid:1,net:200000});
    const payable=await one(db,"select * from ledger_payables where status='unpaid'");assert.equal(Number(payable.party_id),12);assert.equal(Number(payable.original_amount),200000);
    assert.equal(Number((await one(db,'select count(*) as n from ledger_transactions where id=$1 and party_id=12',[payable.expense_transaction_id])).n),1);
    const settled=await state(db);
    assert.equal((await editReceipt(db,old,supplierEdit)).status,'inventory_conflict','stale retry cannot duplicate');
    assert.equal((await editReceipt(db,await item(db),supplierEdit)).status,'no_change');assert.deepEqual(await state(db),settled);
   }));
  }finally{await db.close();}
 });

 test(version+': previous-day supplier edit stays in manager review with no duplicate Ledger writes',async t=>{
  const db=await fixture();try{
   await db.exec(sql);
   for(const role of roles)await t.test(role,()=>isolated(db,async()=>{
    await db.query('update users set role=$1 where id=1',[role]);await db.exec("update inventory_logs set business_date='2026-10-10' where id=100");
    const before=await state(db),result=await editReceipt(db,await item(db),supplierEdit);
    assert.equal(result.status,'ok');assert.equal(result.completion,'ledger_review');assert.equal(result.ledgerSync.status,'review_required');
    const after=await state(db);for(const table of ['ledger_transactions','ledger_payables','ledger_movements'])assert.deepEqual(after[table],before[table]);
    const master=await item(db);assert.equal(master.supplier,'Won Mart');assert.equal(Number(master.supplier_partner_id),10);assert.equal(Number(master.quantity),10);
    const settled=await state(db);assert.equal((await editReceipt(db,master,supplierEdit)).status,'no_change');assert.deepEqual(await state(db),settled);
   }));
  }finally{await db.close();}
 });

 test(version+': paid, allocated, month-closed and manually edited receipts remain blocked for every role',async t=>{
  const db=await fixture();try{
   await db.exec(sql);
   for(const [name,setup,block] of [
    ['paid',"update ledger_payables set status='paid'",'payment_completed'],
    ['allocated','insert into ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount) select id,expense_transaction_id,1 from ledger_payables','payment_allocated'],
    ['month-closed',"insert into ledger_month_closures(month) values('2026-10-01')",'month_closed'],
    ['manual Ledger amount',"update ledger_transactions set amount=199000 where type='expense'",'ledger_amount_changed'],
   ])for(const role of roles)await t.test(name+' / '+role,()=>isolated(db,async()=>{
    await db.query('update users set role=$1 where id=1',[role]);await db.exec(setup);
    const before=await state(db),result=await editReceipt(db,await item(db),supplierEdit);
    assert.equal(result.status,'purchase_correction_review_required');assert.equal(result.blockReason,block);assert.deepEqual(await state(db),before);
   }));
  }finally{await db.close();}
 });

 test(version+': inactive, login-disabled and missing actors cannot change suppliers',async()=>{
  const db=await fixture();try{
   await db.exec(sql);
   for(const [setup,actor] of [['update users set is_active=false where id=1',1],['update users set app_login_enabled=false where id=1',1],['select 1',999]])await isolated(db,async()=>{
    await db.exec(setup);const before=await state(db);assert.equal((await editReceipt(db,await item(db),supplierEdit,actor)).status,'forbidden');assert.deepEqual(await state(db),before);
   });
  }finally{await db.close();}
 });
}
