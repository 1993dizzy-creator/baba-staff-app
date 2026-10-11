import assert from 'node:assert/strict';
import test from 'node:test';
import {safeFixture,snapshot,correct} from './helpers/inventory-safe-correction-fixture.mjs';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
async function state(db){const result={};for(const table of ['inventory','inventory_logs','inventory_price_logs','ledger_transactions','ledger_payables','ledger_movements','ledger_candidates','ledger_inventory_projection_status','ledger_audit_logs'])result[table]=(await db.query(`select to_jsonb(x) as row from ${table} x order by to_jsonb(x)::text`)).rows;return result;}

test('staff same-day reduction safely rebooks unpaid expense in the inventory transaction',async()=>{
 const db=await safeFixture();try{
 const old=await snapshot(db),result=await correct(db,old,{quantity:9,purchase_price:21000});assert.equal(result.status,'ok');assert.equal(result.ledgerSync.status,'synced');assert.equal(result.ledgerSync.code,'REBOOKED');assert.equal((await snapshot(db)).quantity,9);
 assert.equal(Number((await one(db,'select sum(amount*economic_effect_sign) as total from ledger_transactions')).total),189000);
 assert.equal(Number((await one(db,"select count(*) as n from ledger_transactions where source_type='inventory_purchase_reversal'")).n),1);
 assert.equal(Number((await one(db,"select count(*) as n from ledger_transactions where source_type='inventory_purchase_rebook'")).n),1);
 assert.equal(Number((await one(db,"select count(*) as n from ledger_payables where status='cancelled'")).n),1);
 assert.equal(Number((await one(db,"select count(*) as n from ledger_payables where status='unpaid' and original_amount=189000")).n),1);
 assert.equal(Number((await one(db,'select count(*) as n from ledger_movements')).n),0);
 const audit=await one(db,"select * from ledger_audit_logs where action='inventory_purchase_auto_corrected'");assert.equal(Number(audit.actor_user_id),1);assert.equal(Number(audit.after_snapshot.purchaseLogId),100);
 const after=await state(db);assert.equal((await correct(db,old)).status,'quantity_conflict');assert.deepEqual(await state(db),after);
 assert.equal((await one(db,"select current_setting('baba.purchase_confirmation',true) as setting")).setting,'');
 }finally{await db.close();}
});
test('same-day full cancellation reverses only once and never creates a zero expense',async()=>{
 const db=await safeFixture();try{const old=await snapshot(db),r=await correct(db,old,{quantity:0});assert.equal(r.ledgerSync.status,'synced');assert.equal(Number((await one(db,'select sum(amount*economic_effect_sign) as n from ledger_transactions')).n),0);assert.equal(Number((await one(db,"select count(*) as n from ledger_transactions where source_type='inventory_purchase_rebook' or amount<=0")).n),0);assert.equal((await one(db,'select status from ledger_payables')).status,'cancelled');assert.equal((await one(db,'select status from ledger_candidates')).status,'dismissed');const after=await state(db);assert.equal((await correct(db,old,{quantity:0})).status,'quantity_conflict');assert.deepEqual(await state(db),after);}finally{await db.close();}
});
for(const [name,response,payload] of [
 ['unchanged reduction',{status:'synced',code:'UNCHANGED'},{quantity:9,purchase_price:21000}],
 ['metadata-only cancellation',{status:'synced',code:'METADATA_SYNCED'},{quantity:0}],
 ['missing rebook code',{status:'synced'},{quantity:9}],
 ['null rebook code',{status:'synced',code:null},{quantity:0}],
 ['claimed rebook without reversal',{status:'synced',code:'REBOOKED'},{quantity:9}],
])test(name+' without actual rebooking rolls back the complete mutation',async()=>{
 const db=await safeFixture();try{
  const old=await snapshot(db),before=await state(db);
  // Stub only the confirmed auto-correction call in this isolated database.
  // The initial review projection still uses the canonical implementation.
  await db.exec(`
   alter function public.ledger_project_inventory_purchase_log_v1(bigint,bigint) rename to qa_original_purchase_projector;
   create function public.ledger_project_inventory_purchase_log_v1(p_inventory_log_id bigint,p_request_actor_user_id bigint)
   returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
   begin
    if current_setting('baba.purchase_confirmation',true)=p_inventory_log_id::text then
     return '${JSON.stringify(response)}'::jsonb;
    end if;
    return public.qa_original_purchase_projector(p_inventory_log_id,p_request_actor_user_id);
   end;$$;
  `);
  await assert.rejects(correct(db,old,payload),/INVENTORY_LEDGER_ATOMIC_FAILED/);
  assert.deepEqual(await state(db),before);
  assert.equal(Number((await one(db,"select count(*) as n from ledger_transactions where source_type='inventory_purchase_reversal'")).n),0);
 }finally{await db.close();}
});
for(const [name,setup,payload] of [
 ['paid',"update ledger_payables set status='paid'",{quantity:9}],
 ['partial payment',"update ledger_payables set status='partially_paid'",{quantity:9}],
 ['allocation',"insert into ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount) select p.id,p.expense_transaction_id,1 from ledger_payables p",{quantity:9}],
 ['closed source month',"insert into ledger_month_closures(month) values('2026-10-01')",{quantity:9}],
 ['closed recognition month',"update ledger_candidates set proposed_recognition_month='2026-09-01';update ledger_transactions set recognition_month='2026-09-01';insert into ledger_month_closures(month) values('2026-09-01')",{quantity:9}],
 ['manual override',"update ledger_transactions set amount=199000 where type='expense'",{quantity:9}],
 ['supplier change','',{quantity:9,supplier:'Postpaid',supplier_partner_id:12}],
 ['ambiguous supplier mapping',"insert into business_partner_ledger_parties values(10,12)",{quantity:9}],
 ['missing supplier mapping',"delete from business_partner_ledger_parties where business_partner_id=10",{quantity:9}],
 ['previous-day receipt',"update inventory_logs set business_date='2026-10-10' where id=100",{quantity:9}],
 ])test(name+' retains review without changing accounting',async()=>{
 const db=await safeFixture();try{if(setup)await db.exec(setup);const old=await snapshot(db),before=await state(db),r=await correct(db,old,payload);assert.equal(r.status,'ok');assert.equal(r.ledgerSync.status,'review_required');const after=await state(db);for(const table of ['ledger_transactions','ledger_payables','ledger_movements'])assert.deepEqual(after[table],before[table]);assert.equal(Number((await one(db,"select count(*) as n from ledger_audit_logs where action='inventory_purchase_auto_corrected'")).n),0);}finally{await db.close();}
});
for(const [table,condition] of [
 ['inventory_logs','true'],['inventory_price_logs','true'],
 ['ledger_transactions',"new.source_type='inventory_purchase_reversal'"],
 ['ledger_transactions',"new.source_type='inventory_purchase_rebook'"],
 ['ledger_payables','true'],
 ['ledger_audit_logs',"new.action='inventory_purchase_auto_corrected'"],
 ['ledger_audit_logs',"new.action='inventory_source_rebooked'"],
 ])test(table+' '+condition+' failure rolls back all inventory and accounting effects',async()=>{
 const db=await safeFixture();try{const old=await snapshot(db),before=await state(db);await db.exec(`create function qa_failure() returns trigger language plpgsql as $$begin if ${condition} then raise exception 'QA_ATOMIC_FAIL';end if;return new;end$$;create trigger qa_fail before insert on ${table} for each row execute function qa_failure()`);await assert.rejects(correct(db,old,{quantity:9,purchase_price:21000}),/QA_ATOMIC_FAIL|INVENTORY_LEDGER_ATOMIC_FAILED/);assert.deepEqual(await state(db),before);}finally{await db.close();}
});
test('v3 is service-only; staff cannot use admin repair or execute private functions',async()=>{
 const db=await safeFixture();try{
 const expected=await snapshot(db);for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(correct(db,expected,{quantity:9}),/permission denied/);await db.exec('reset role');}
 await db.exec('set role service_role');const permissions=await one(db,"select has_function_privilege(current_user,'public.inventory_apply_purchase_correction_v3(bigint,bigint,numeric,jsonb,jsonb,date,bigint)','execute') as allowed,has_schema_privilege(current_user,'inventory_ledger_private','usage') as private_allowed");assert.equal(permissions.allowed,true);assert.equal(permissions.private_allowed,false);
 const repair=(await one(db,'select ledger_resolve_inventory_purchase_correction_v1(100,100,1) as result')).result;assert.equal(repair.code,'FORBIDDEN');await db.exec('reset role');
 const old=await snapshot(db),before=await state(db);assert.equal((await correct(db,old,{quantity:9},3)).status,'forbidden');assert.deepEqual(await state(db),before);
 }finally{await db.close();}
});
test('same quantity concurrent correction is rejected by full item version',async()=>{
 const db=await safeFixture();try{const old=await snapshot(db),r=await Promise.all([correct(db,old,{quantity:10,purchase_price:21000}),correct(db,old,{quantity:10,purchase_price:22000})]);assert.deepEqual(r.map(row=>row.status).sort(),['inventory_conflict','ok']);assert.equal(Number((await one(db,"select count(*) as n from ledger_transactions where source_type='inventory_purchase_rebook'")).n),1);}finally{await db.close();}
});
test('a backdated server date cannot enable automatic correction',async()=>{const db=await safeFixture();try{const old=await snapshot(db),before=await state(db),r=await correct(db,old,{quantity:9},1,'2026-10-10');assert.equal(r.ledgerSync.status,'review_required');assert.deepEqual((await state(db)).ledger_transactions,before.ledger_transactions);}finally{await db.close();}});
for(const action of ['inventory_source_rebooked','inventory_purchase_auto_corrected'])test('suppressed '+action+' audit aborts the complete mutation',async()=>{
 const db=await safeFixture();try{const old=await snapshot(db),before=await state(db);await db.exec(`create function qa_skip_audit() returns trigger language plpgsql as $$begin if new.action='${action}' then return null;end if;return new;end$$;create trigger qa_skip before insert on ledger_audit_logs for each row execute function qa_skip_audit()`);await assert.rejects(correct(db,old,{quantity:9}),/INVENTORY_LEDGER_ATOMIC_FAILED|INVENTORY_REQUIRED_AUDIT_MISSING/);assert.deepEqual(await state(db),before);}finally{await db.close();}
});
test('inactive #566 and distinct #477 O6 remain untouched; corrections create no inventory item',async()=>{
 const db=await safeFixture();try{await db.exec("insert into inventory(id,item_name,item_name_vi,quantity,code,is_active) values(566,'진저에일','Ginger ale',0,'OLD',false),(477,'진저에일','Ginger ale',8,'O6',true)");const before=(await db.query('select to_jsonb(i) as row from inventory i where id in (566,477) order by id')).rows;assert.equal((await correct(db,await snapshot(db),{quantity:9})).ledgerSync.status,'synced');assert.deepEqual((await db.query('select to_jsonb(i) as row from inventory i where id in (566,477) order by id')).rows,before);assert.equal(Number((await one(db,'select count(*) as n from inventory')).n),3);assert.equal((await one(db,'select is_active from inventory where id=566')).is_active,false);}finally{await db.close();}
});
test('current verification-pending semantics survive auto rebook without cash outflow',async()=>{
 const db=await safeFixture();try{await db.exec(`update ledger_transactions set source_snapshot=source_snapshot||'{"paymentVerification":"pending"}'::jsonb;update business_partners set payment_mode='immediate',default_fund_account_id=1 where id=10`);const r=await correct(db,await snapshot(db),{quantity:9});assert.equal(r.ledgerSync.status,'synced');assert.equal((await one(db,"select source_snapshot->>'paymentVerification' as state from ledger_transactions where source_type='inventory_purchase_rebook'")).state,'pending');assert.equal(Number((await one(db,'select count(*) as n from ledger_movements')).n),0);}finally{await db.close();}
});
