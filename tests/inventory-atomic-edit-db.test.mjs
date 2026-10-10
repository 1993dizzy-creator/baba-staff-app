import assert from 'node:assert/strict';
import test from 'node:test';
import {atomicInventoryDatabase as fixture} from './helpers/inventory-atomic-fixture.mjs';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];

const snapshot=async db=>(await one(db,'select to_jsonb(i) as item from inventory i where id=1')).item;
const save=async(db,old,payload,actor=1,reason='other',source='edit_form')=>(await one(db,"select inventory_update_with_audit_v1(1,$1::jsonb,$2::jsonb,'2026-10-10',$3,$4,$5,'2026-10-10') as result",[JSON.stringify(old),JSON.stringify(payload),actor,reason,source])).result;
const correct=async(db,old,payload={quantity:9},actor=2)=>(await one(db,"select inventory_apply_purchase_correction_v2(1,100,$1,$2::jsonb,$3::jsonb,'2026-10-10',$4) as result",[old.quantity,JSON.stringify(old),JSON.stringify(payload),actor])).result;
async function state(db){const out={};for(const t of ['inventory','inventory_logs','inventory_price_logs','ledger_audit_logs','ledger_transactions','ledger_payables','ledger_movements'])out[t]=(await db.query(`select to_jsonb(x) as row from ${t} x order by to_jsonb(x)::text`)).rows;return out;}
const fail=async(db,table)=>db.exec(`create function qa_fail_write() returns trigger language plpgsql as $$begin raise exception 'QA_REQUIRED_AUDIT_FAILURE';end$$;create trigger qa_fail before insert on ${table} for each row execute function qa_fail_write()`);

test('ordinary edit commits item, required audit and changed price together',async()=>{const db=await fixture();try{
 const old=await snapshot(db),before=await state(db),r=await save(db,old,{item_name:'Renamed',purchase_price:21000,updated_by_name:'Spoof'});assert.equal(r.status,'ok');const now=await snapshot(db);
 assert.equal(now.item_name,'Renamed');assert.equal(now.purchase_price,21000);assert.equal(now.quantity,old.quantity);assert.equal(now.updated_by_name,'Session actor');assert.ok(Date.parse(now.updated_at)>Date.parse(old.updated_at));
 const log=await one(db,'select * from inventory_logs where id=$1',[r.inventoryLogId]);assert.equal(log.item_name,'Renamed');assert.equal(log.source_actor_user_id,1);assert.equal(log.reason,'other');assert.equal(Number(log.prev_purchase_price),20000);assert.equal(Number(log.new_purchase_price),21000);assert.equal(Number(log.change_quantity),0);assert.equal(Number(log.prev_quantity),10);assert.equal(Number(log.new_quantity),10);assert.equal(log.source,'edit_form');assert.equal((await db.query('select * from inventory_price_logs')).rows.length,1);
 const after=await state(db);for(const t of ['ledger_transactions','ledger_payables','ledger_movements'])assert.deepEqual(after[t],before[t]);
}finally{await db.close();}});
for(const table of ['inventory_logs','inventory_price_logs'])test('ordinary '+table+' failure rolls back all; retry commits once',async()=>{const db=await fixture();try{
 const old=await snapshot(db),before=await state(db);await fail(db,table);await assert.rejects(save(db,old,{item_name:'Rollback',quantity:11,purchase_price:22000}),/QA_REQUIRED_AUDIT_FAILURE/);assert.deepEqual(await state(db),before);await db.exec(`drop trigger qa_fail on ${table}`);
 assert.equal((await save(db,old,{item_name:'Retry',purchase_price:22000})).status,'ok');assert.equal((await save(db,old,{item_name:'Duplicate'})).status,'inventory_conflict');assert.equal((await db.query('select * from inventory_logs where id<>100')).rows.length,1);
}finally{await db.close();}});
test('overlapping ordinary requests commit exactly one source audit',async()=>{const db=await fixture();try{
 const old=await snapshot(db),r=await Promise.all([save(db,old,{item_name:'Admin A'}),save(db,old,{item_name:'Admin B'})]);assert.deepEqual(r.map(x=>x.status).sort(),['inventory_conflict','ok']);assert.equal((await snapshot(db)).item_name,'Admin A');assert.equal((await db.query('select * from inventory_logs where id<>100')).rows.length,1);
}finally{await db.close();}});
test('same quantity changed fields without timestamp change, plus timestamp-only changes, conflict inside DB',async()=>{const db=await fixture();try{
 for(const change of ["item_name='Other admin'","purchase_price=23000","supplier='Other supplier'","is_active=false","updated_at=updated_at+interval '1 second'"]){const old=await snapshot(db);await db.exec('update inventory set '+change+' where id=1');const other=await state(db);assert.equal((await save(db,old,{item_name:'Stale'},2)).status,'inventory_conflict');assert.equal((await correct(db,old,{quantity:old.quantity})).status,'inventory_conflict');assert.deepEqual(await state(db),other);}
}finally{await db.close();}});
test('correction preserves source linkage, required audits and canonical Ledger projection contract',async()=>{const db=await fixture();try{
 const old=await snapshot(db),before=await state(db),r=await correct(db,old,{quantity:9,purchase_price:21000,item_name:'Corrected'});assert.equal(r.status,'ok');const now=await snapshot(db);assert.equal(now.quantity,9);assert.ok(Date.parse(now.updated_at)>Date.parse(old.updated_at));const log=await one(db,'select * from inventory_logs where id=$1',[r.inventoryLogId]);assert.equal(log.correction_of_inventory_log_id,100);assert.equal(Number(log.change_quantity),-1);assert.equal(log.source_actor_user_id,2);assert.equal((await db.query('select * from inventory_price_logs')).rows.length,1);assert.equal((await db.query("select * from ledger_audit_logs where action='inventory_purchase_correction_linked'")).rows.length,1);
 const projected=(await one(db,'select ledger_project_inventory_purchase_log_v1($1,2) as result',[r.inventoryLogId])).result;assert.equal(projected.code,'PURCHASE_AMOUNT_CONFIRMATION_REQUIRED');
 const repaired=(await one(db,'select ledger_resolve_inventory_purchase_correction_v1($1,100,2) as result',[r.inventoryLogId])).result;assert.equal(repaired.status,'synced');
 assert.equal(Number((await one(db,'select sum(amount*economic_effect_sign) as total from ledger_transactions')).total),189000);
 assert.equal((await db.query("select * from ledger_transactions where source_type='inventory_purchase_reversal'")).rows.length,1);assert.equal((await db.query("select * from ledger_transactions where source_type='inventory_purchase_rebook'")).rows.length,1);
 assert.deepEqual((await state(db)).ledger_movements,before.ledger_movements);
}finally{await db.close();}});
for(const table of ['inventory_logs','inventory_price_logs','ledger_audit_logs'])test('correction '+table+' failure rolls back source, linkage, prices and audits',async()=>{const db=await fixture();try{
 const old=await snapshot(db),before=await state(db);await fail(db,table);await assert.rejects(correct(db,old,{quantity:9,purchase_price:21000}),/QA_REQUIRED_AUDIT_FAILURE/);assert.deepEqual(await state(db),before);
}finally{await db.close();}});
test('overlapping metadata-only corrections with unchanged quantity commit once',async()=>{const db=await fixture();try{
 const old=await snapshot(db),r=await Promise.all([correct(db,old,{quantity:10,item_name:'Admin A'}),correct(db,old,{quantity:10,item_name:'Admin B'})]);assert.deepEqual(r.map(x=>x.status).sort(),['inventory_conflict','ok']);assert.equal((await snapshot(db)).item_name,'Admin A');assert.equal((await db.query('select * from inventory_logs where id<>100')).rows.length,1);assert.equal((await db.query("select * from ledger_audit_logs where action='inventory_purchase_correction_linked'")).rows.length,1);
}finally{await db.close();}});
test('quantity conflict preserves other administrator changes and accounting',async()=>{const db=await fixture();try{
 const old=await snapshot(db);await db.exec('update inventory set quantity=12 where id=1');const before=await state(db);assert.equal((await correct(db,old)).status,'quantity_conflict');assert.equal((await save(db,old,{quantity:9})).status,'inventory_conflict');assert.deepEqual(await state(db),before);
}finally{await db.close();}});
test('future version advances, untouched fractional price stays exact and quick-save source is numeric',async()=>{const db=await fixture();try{
 await db.exec("update inventory set updated_at='2030-01-01',purchase_price=20000.5 where id=1");const old=await snapshot(db),r=await save(db,old,{quantity:11,purchase_price:20000.5},1,'purchase','quick_save');assert.equal(r.status,'ok');const now=await snapshot(db);assert.ok(Date.parse(now.updated_at)>Date.parse(old.updated_at));assert.equal(now.purchase_price,20000.5);assert.equal((await db.query('select * from inventory_price_logs')).rows.length,0);
}finally{await db.close();}});
test('service-only RPC grants, legacy rollout access retained, inactive actor denied, automatic staff correction allowed',async()=>{const db=await fixture();try{
 const old=await snapshot(db),before=await state(db);for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(save(db,old,{item_name:'Forbidden'}),/permission denied/);await assert.rejects(correct(db,old),/permission denied/);await db.exec('reset role');}
 await db.exec('set role service_role');assert.equal((await one(db,"select has_function_privilege(current_user,'public.inventory_apply_purchase_correction_v1(bigint,bigint,numeric,jsonb,date,bigint)','EXECUTE') as allowed")).allowed,true);assert.equal((await save(db,old,{item_name:'Forbidden'},3)).status,'forbidden');assert.equal((await correct(db,old,{quantity:9},3)).status,'forbidden');await db.exec('reset role');assert.deepEqual(await state(db),before);
 await db.exec('set role service_role');assert.equal((await save(db,old,{item_name:'Authorized'})).status,'ok');await db.exec('reset role');assert.equal((await snapshot(db)).item_name,'Authorized');
 const fresh=await snapshot(db);await db.exec('set role service_role');assert.equal((await correct(db,fresh,{quantity:10,item_name:'Staff metadata'},1)).status,'ok');await db.exec('reset role');
}finally{await db.close();}});

test('suppressed required audit insert is a hard error and rolls back the master',async()=>{const db=await fixture();try{
 const old=await snapshot(db),before=await state(db);await db.exec(`create function qa_skip_audit() returns trigger language plpgsql as $$begin return null;end$$;create trigger qa_skip before insert on inventory_logs for each row execute function qa_skip_audit()`);await assert.rejects(save(db,old,{item_name:'Must rollback'}),/INVENTORY_REQUIRED_AUDIT_MISSING/);await assert.rejects(correct(db,old,{quantity:9}),/INVENTORY_REQUIRED_AUDIT_MISSING/);assert.deepEqual(await state(db),before);
}finally{await db.close();}});
test('ordinary edit and unchanged-quantity correction competing for one version do not overwrite',async()=>{const db=await fixture();try{
 const old=await snapshot(db),r=await Promise.all([save(db,old,{item_name:'Admin A'}),correct(db,old,{quantity:10,item_name:'Admin B'})]);assert.deepEqual(r.map(x=>x.status).sort(),['inventory_conflict','ok']);assert.equal((await snapshot(db)).item_name,'Admin A');assert.equal((await db.query('select * from inventory_logs where id<>100')).rows.length,1);
}finally{await db.close();}});
for(const [name,sql,code] of [
 ['closed month',"insert into ledger_month_closures(month) values('2026-09-01')",'MONTH_CLOSED'],
 ['paid payable',"update ledger_payables set status='paid'",'PAYABLE_ALREADY_PAID'],
 ['manual Ledger amount',"update ledger_transactions set amount=199000 where type='expense'",'MANUAL_LEDGER_OVERRIDE']
])test('versioned correction preserves '+name+' protection against rebook',async()=>{const db=await fixture();try{
 await db.exec(sql);const old=await snapshot(db),before=await state(db),r=await correct(db,old,{quantity:9,purchase_price:21000});assert.equal(r.status,'ok');await one(db,'select ledger_project_inventory_purchase_log_v1($1,2) as result',[r.inventoryLogId]);
 const confirm=(await one(db,'select ledger_resolve_inventory_purchase_correction_v1($1,100,2) as result',[r.inventoryLogId])).result;assert.equal(confirm.code,code);const after=await state(db);for(const t of ['ledger_transactions','ledger_payables','ledger_movements'])assert.deepEqual(after[t],before[t]);
}finally{await db.close();}});

test('ordinary purchase reductions cannot bypass correction for either source, including null quantity',async()=>{const db=await fixture();try{
 const old=await snapshot(db),before=await state(db);
 for(const source of ['edit_form','quick_save'])for(const quantity of [9,0,null]){
  assert.equal((await save(db,old,{quantity,item_name:'Must not commit'},2,'purchase',source)).status,'purchase_correction_required');assert.deepEqual(await state(db),before);
 }
}finally{await db.close();}});
test('normal nonpurchase decreases, purchase increases, and metadata-only purchase edits stay allowed',async()=>{const db=await fixture();try{
 for(const reason of ['stock_check','service','other','sale_deduction','unclassified']){const old=await snapshot(db),r=await save(db,old,{quantity:old.quantity-1},2,reason);assert.equal(r.status,'ok');const log=await one(db,'select * from inventory_logs where id=$1',[r.inventoryLogId]);assert.equal(Number(log.change_quantity),-1);assert.equal(log.reason,reason);assert.equal(log.correction_of_inventory_log_id,null);}
 for(const source of ['edit_form','quick_save']){const old=await snapshot(db),r=await save(db,old,{quantity:old.quantity+2},2,'purchase',source);assert.equal(r.status,'ok');const log=await one(db,'select * from inventory_logs where id=$1',[r.inventoryLogId]);assert.equal(Number(log.change_quantity),2);assert.equal(log.reason,'purchase');assert.equal(log.correction_of_inventory_log_id,null);}
 const old=await snapshot(db);assert.equal((await save(db,old,{item_name:'Metadata only'},2,'purchase')).status,'ok');assert.equal((await snapshot(db)).quantity,old.quantity);
}finally{await db.close();}});
test('legacy v1 still executes for service_role during rollout; v2 remains available',async()=>{const db=await fixture();try{
 await db.exec('set role service_role');const legacy=(await one(db,"select inventory_apply_purchase_correction_v1(1,100,10,'{\"quantity\":9}','2026-10-10',2) as result")).result;assert.equal(legacy.status,'ok');await db.exec('reset role');assert.equal((await snapshot(db)).quantity,9);
 const fresh=await snapshot(db);await db.exec('set role service_role');assert.equal((await correct(db,fresh,{quantity:9,item_name:'V2 rollout'})).status,'ok');await db.exec('reset role');assert.equal((await snapshot(db)).item_name,'V2 rollout');
}finally{await db.close();}});
test('version matcher is STABLE and prepared execution respects session TimeZone',async()=>{const db=await fixture();try{
 const meta=await one(db,"select provolatile from pg_proc where oid='inventory_ledger_private.item_matches_expected_v1(jsonb,jsonb)'::regprocedure");assert.equal(meta.provolatile,'s');
 await db.exec(`prepare qa_expected as select inventory_ledger_private.item_matches_expected_v1('{"quantity":10,"is_active":true,"updated_at":"2026-10-10T03:00:00Z"}'::jsonb,'{"quantity":10,"is_active":true,"updated_at":"2026-10-10T03:00:00"}'::jsonb) as matched`);
 await db.exec("set timezone='UTC'");assert.equal((await one(db,'execute qa_expected')).matched,true);await db.exec("set timezone='Asia/Bangkok'");assert.equal((await one(db,'execute qa_expected')).matched,false);
}finally{await db.close();}});
