// Isolated PGlite: executes the actual canonical projection, guard and repair SQL.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { database } from './helpers/inventory-ledger-fixture.mjs';
const one=async(db,sql)=>(await db.query(sql)).rows[0];
const repair=async(db,actor=2,root=12581)=>(await db.query('select ledger_resolve_inventory_purchase_correction_v1(12655,$1,$2) as result',[root,actor])).rows[0].result;
const preview=async db=>(await one(db,'select ledger_inventory_purchase_repair_preview_v1(12655,2) as result')).result;
async function pear(){
 const db=await database();
 await db.exec(readFileSync('supabase/migrations/20261007182027_resolve_inventory_purchase_projection.sql','utf8'));
 await db.exec(`update business_partners set name='Chợ',payment_mode='postpaid',default_fund_account_id=null where id=10;
 update inventory_logs set id=12581,item_id=314,item_name='배',item_name_vi='Lê',unit='kg',change_quantity=1.42,new_purchase_price=35000,new_supplier='Chợ',purchase_supplier_partner_id=10,business_date='2026-10-05',created_at='2026-10-05T10:00:00Z' where id=100;
 update inventory set quantity=1.32;
 select setval(pg_get_serial_sequence('ledger_candidates','id'),1524,true);
 select setval(pg_get_serial_sequence('ledger_transactions','id'),2268,true);
 select setval(pg_get_serial_sequence('ledger_payables','id'),1025,true);
 select ledger_project_inventory_purchase_log_v1(12581,2);
 insert into inventory_logs(id,item_id,item_name,unit,change_quantity,new_purchase_price,new_supplier,purchase_supplier_partner_id,business_date,created_at,source,reason,source_actor_user_id)
 values(12655,314,'배','kg',-0.10,35000,'Chợ',10,'2026-10-06','2026-10-06T10:00:00Z','edit_form','purchase',1);
 select ledger_project_inventory_purchase_log_v1(12655,2);`);
 return db;
}
async function unchanged(db){
 assert.equal((await one(db,'select correction_of_inventory_log_id as root from inventory_logs where id=12655')).root,null);
 assert.equal(Number((await one(db,'select count(*) as n from ledger_transactions')).n),1);
 assert.equal((await one(db,'select status from ledger_inventory_projection_status where inventory_log_id=12655')).status,'review_required');
}
test('reported pear: 49700 -> 46200, reversal/rebook/audit, original preserved, no cash movement, banner gone',async()=>{
 const db=await pear();try{
 const before=await preview(db);assert.equal(before.recommended,true);
 assert.equal(Number(before.candidates[0].oldAmount),49700);assert.equal(Number(before.candidates[0].newAmount),46200);assert.equal(Number(before.candidates[0].delta),-3500);
 assert.equal((await repair(db)).status,'synced');
 assert.equal(Number((await one(db,'select correction_of_inventory_log_id as root from inventory_logs where id=12655')).root),12581);
 assert.equal(Number((await one(db,'select amount from ledger_transactions where id=2269')).amount),49700);
 assert.equal(Number((await one(db,"select amount from ledger_transactions where source_type='inventory_purchase_reversal'")).amount),49700);
 const replacement=await one(db,"select id,amount from ledger_transactions where source_type='inventory_purchase_rebook'");assert.equal(Number(replacement.amount),46200);
 assert.equal((await one(db,'select status from ledger_payables where id=1026')).status,'cancelled');
 const payable=await one(db,`select original_amount,status from ledger_payables where expense_transaction_id=${replacement.id}`);
 assert.equal(Number(payable.original_amount),46200);assert.equal(payable.status,'unpaid');
 assert.equal(Number((await one(db,'select resolved_transaction_id as id from ledger_candidates where id=1525')).id),Number(replacement.id));
 for(const table of ['ledger_movements','ledger_payable_allocations'])assert.equal(Number((await one(db,`select count(*) as n from ${table}`)).n),0);
 assert.equal(Number((await one(db,'select sum(amount*economic_effect_sign) as expense from ledger_transactions')).expense),46200);
 assert.equal(Number((await one(db,"select count(*) as n from ledger_inventory_projection_status where status in ('review_required','failed')")).n),0);
 for(const action of ['inventory_purchase_correction_linked','inventory_source_rebooked'])assert.equal(Number((await one(db,`select count(*) as n from ledger_audit_logs where action='${action}'`)).n),1);
 assert.equal(Number((await one(db,'select quantity from inventory')).quantity),1.32);
 assert.equal((await repair(db)).code,'ISSUE_ALREADY_LINKED');
 assert.equal(Number((await one(db,'select count(*) as n from ledger_transactions')).n),3);
 }finally{await db.close();}
});
for(const [name,setup,code] of [
 ['partially paid',"update ledger_payables set status='partially_paid'",'PAYABLE_ALREADY_PAID'],
 ['paid',"update ledger_payables set status='paid'",'PAYABLE_ALREADY_PAID'],
 ['closed root month',"insert into ledger_month_closures(month) values('2026-10-01')",'MONTH_CLOSED'],
 ['closed recognition month',"update ledger_candidates set proposed_recognition_month='2026-09-01';update ledger_transactions set recognition_month='2026-09-01';insert into ledger_month_closures(month) values('2026-09-01')",'MONTH_CLOSED'],
 ['different item',"update inventory_logs set item_id=315 where id=12655",'ITEM_MISMATCH'],
 ['different supplier',"update inventory_logs set purchase_supplier_partner_id=11 where id=12655",'SUPPLIER_MISMATCH'],
 ['different unit',"update inventory_logs set unit='can' where id=12655",'UNIT_MISMATCH'],
 ['exceeds root',"update inventory_logs set change_quantity=-1.43 where id=12655",'PURCHASE_CORRECTION_EXCEEDS_PURCHASE'],
 ['manual override',"update ledger_transactions set amount=49000",'MANUAL_LEDGER_OVERRIDE'],
 ['not purchase',"update inventory_logs set reason='stock_check' where id=12655",'INVALID_ISSUE'],
 ['not review required',"update ledger_inventory_projection_status set status='failed' where inventory_log_id=12655",'ISSUE_NOT_RESOLVABLE'],
])test('repair blocks '+name,async()=>{const db=await pear();try{
 await db.exec(setup);assert.equal((await repair(db)).code,code);
 assert.equal((await one(db,'select correction_of_inventory_log_id as root from inventory_logs where id=12655')).root,null);
 assert.equal(Number((await one(db,'select count(*) as n from ledger_transactions')).n),1);
}finally{await db.close();}});
test('multiple candidates need selection; none is not recommended',async()=>{
 const db=await pear();try{
 await db.exec(`insert into inventory_logs(id,item_id,category,unit,change_quantity,new_purchase_price,new_supplier,purchase_supplier_partner_id,business_date,created_at,source,reason,source_actor_user_id)
 values(12580,314,'Drinks','kg',1.5,35000,'Chợ',10,'2026-10-04','2026-10-04T10:00:00Z','create','purchase',1);select ledger_project_inventory_purchase_log_v1(12580,2);`);
 const multiple=await preview(db);assert.equal(multiple.candidates.length,2);assert.equal(multiple.recommended,false);
 await db.exec('update inventory_logs set item_id=315 where id=12655');assert.equal((await preview(db)).candidates.length,0);
 }finally{await db.close();}
});
test('canonical failure rolls back link, payable and audit together',async()=>{
 const db=await pear();try{
 const count=Number((await one(db,'select count(*) as n from ledger_audit_logs')).n);
 await db.exec(`create or replace function ledger_project_inventory_purchase_log_v1(p_inventory_log_id bigint,p_request_actor_user_id bigint) returns jsonb language plpgsql as $$begin update ledger_payables set status='cancelled'; return '{"status":"review_required","code":"TEST_PROJECTION_BLOCKED"}'::jsonb;end$$`);
 assert.equal((await repair(db)).code,'TEST_PROJECTION_BLOCKED');await unchanged(db);
 assert.equal((await one(db,'select status from ledger_payables where id=1026')).status,'unpaid');
 assert.equal(Number((await one(db,'select count(*) as n from ledger_audit_logs')).n),count);
 }finally{await db.close();}
});
test('active owner/master only; authenticated role has no RPC access',async()=>{
 const db=await pear();try{
 assert.equal((await repair(db,1)).code,'FORBIDDEN');await unchanged(db);
 await db.exec('set role authenticated');await assert.rejects(repair(db),/permission denied/);await db.exec('reset role');
 await db.exec("update users set role='master' where id=2");assert.equal((await repair(db)).status,'synced');
 }finally{await db.close();}
});
test('normalized supplier fallback and price changes follow existing correction identity',async()=>{
 const db=await pear();try{
 await db.exec("update inventory_logs set purchase_supplier_partner_id=null,new_supplier='  CHỢ  ',new_purchase_price=36000 where id=12655");
 assert.equal((await repair(db)).status,'synced');
 assert.equal(Number((await one(db,'select sum(amount*economic_effect_sign) as amount from ledger_transactions')).amount),47520);
 }finally{await db.close();}
});

test('nonzero allocation blocks repair even when payable still says unpaid',async()=>{
 const db=await pear();try{
 await db.exec("insert into ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount) values(1026,2269,1000)");
 assert.equal((await repair(db)).code,'PAYABLE_ALREADY_PAID');await unchanged(db);
 assert.equal((await preview(db)).recommended,false);
 }finally{await db.close();}
});
test('existing corrections are included in quantity and latest-price preview',async()=>{
 const db=await pear();try{
 await db.exec("insert into inventory_logs(id,item_id,unit,change_quantity,new_purchase_price,new_supplier,purchase_supplier_partner_id,business_date,created_at,source,reason,source_actor_user_id,correction_of_inventory_log_id) values(12600,314,'kg',-0.20,35000,'Chợ',10,'2026-10-05','2026-10-05T12:00:00Z','edit_form','purchase',1,12581);select ledger_project_inventory_purchase_log_v1(12600,2);");
 const row=(await preview(db)).candidates[0];assert.equal(Number(row.oldAmount),42700);assert.equal(Number(row.newAmount),39200);
 assert.equal((await repair(db)).status,'synced');assert.equal(Number((await one(db,'select sum(amount*economic_effect_sign) as amount from ledger_transactions')).amount),39200);
 }finally{await db.close();}
});
