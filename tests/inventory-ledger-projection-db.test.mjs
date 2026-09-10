// Isolated PostgreSQL execution (PGlite); never reads production credentials.
import assert from 'node:assert/strict';
import test from 'node:test';

import { database } from './helpers/inventory-ledger-fixture.mjs';

async function project(db,id=100,actor=1) {
  const {rows}=await db.query('select ledger_project_inventory_purchase_log_v1($1,$2) as result',[id,actor]);
  return rows[0].result;
}
async function one(db,sql) { return (await db.query(sql)).rows[0]; }

test('confirmed latest purchase reprojects while an older purchase amount stays unchanged', async () => {
  const db=await database();
  try {
    await db.exec("update inventory_logs set change_quantity=3,new_purchase_price=20000,business_date='2026-08-10' where id=100");
    assert.equal((await project(db)).status,'synced');
    await db.exec(`insert into inventory_logs(id,item_id,item_name,item_name_vi,category,category_vi,unit,change_quantity,new_purchase_price,new_supplier,business_date,created_at,source,reason,actor_username,source_actor_user_id,purchase_supplier_partner_id)
      select 200,item_id,item_name,item_name_vi,category,category_vi,unit,3,23333,new_supplier,'2026-09-10','2026-09-10T10:00:00Z',source,reason,actor_username,source_actor_user_id,purchase_supplier_partner_id from inventory_logs where id=100`);
    assert.equal((await project(db,200)).status,'synced');
    assert.equal(Number((await one(db,"select sum(amount*economic_effect_sign) as amount from ledger_transactions where (source_snapshot->>'inventory_log_id')::bigint=100")).amount),60000);
    assert.equal(Number((await one(db,"select sum(amount*economic_effect_sign) as amount from ledger_transactions where (source_snapshot->>'inventory_log_id')::bigint=200")).amount),69999);

    await db.exec("update inventory_logs set new_purchase_price=19000,new_supplier='OK FOOD',purchase_supplier_partner_id=11 where id=200");
    assert.equal((await project(db,200)).code,'REBOOKED');
    assert.equal(Number((await one(db,"select sum(amount*economic_effect_sign) as amount from ledger_transactions where (source_snapshot->>'inventory_log_id')::bigint=100")).amount),60000);
    assert.equal(Number((await one(db,"select sum(amount*economic_effect_sign) as amount from ledger_transactions where (source_snapshot->>'inventory_log_id')::bigint=200")).amount),57000);
    assert.equal(Number((await one(db,'select party_id from ledger_transactions order by id desc limit 1')).party_id),11);
  } finally {await db.close();}
});

test('source-only projection, metadata, corrections, payment guards, permissions and retries', async () => {
  const db=await database();
  try {
    assert.equal((await project(db)).status,'synced');
    let tx=await one(db,'select * from ledger_transactions order by id desc limit 1');
    assert.equal(Number(tx.amount),200000);
    assert.equal(Number(tx.party_id),10,'historical supplier beats current Inventory partner');
    assert.equal(Number(tx.created_by),1,'real staff actor, no owner impersonation');
    const originalSnapshot=tx.source_snapshot;
    await project(db);
    assert.equal(Number((await one(db,'select count(*) as n from ledger_transactions')).n),1);
    await db.exec("update inventory_logs set item_name='Coca-Cola',item_name_vi='Cola moi',category='Soda',unit='bottle' where id=100");
    assert.equal((await project(db)).code,'METADATA_SYNCED');
    assert.deepEqual((await one(db,'select source_snapshot from ledger_transactions')).source_snapshot,originalSnapshot);
    assert.equal(Number((await one(db,'select category_id from ledger_transactions')).category_id),4);
    assert.equal((await one(db,'select source_drift_snapshot from ledger_candidates')).source_drift_snapshot.item_name,'Coca-Cola');
    assert.equal(Number((await one(db,'select sum(amount) as amount from ledger_movements')).amount),-200000);
    await db.exec('update inventory_logs set new_purchase_price=21000 where id=100');
    assert.equal((await project(db)).code,'REBOOKED');
    assert.equal(Number((await one(db,'select count(*) as n from ledger_transactions')).n),3);
    assert.equal(Number((await one(db,'select sum(amount*economic_effect_sign) as n from ledger_transactions')).n),210000);
    await project(db); await project(db);
    assert.equal(Number((await one(db,'select count(*) as n from ledger_transactions')).n),3);
    await db.exec("update inventory_logs set new_supplier='OK FOOD',purchase_supplier_partner_id=11 where id=100");
    assert.equal((await project(db)).code,'REBOOKED');
    tx=await one(db,'select * from ledger_transactions order by id desc limit 1');
    assert.equal(Number(tx.party_id),11);
    assert.equal(Number((await one(db,'select fund_account_id from ledger_movements order by id desc limit 1')).fund_account_id),2);
    await db.exec("update inventory_logs set new_supplier='Postpaid',purchase_supplier_partner_id=12 where id=100");
    assert.equal((await project(db)).code,'REBOOKED');
    assert.equal((await one(db,'select status from ledger_payables')).status,'unpaid');
    await db.exec("update ledger_payables set status='partially_paid'; update inventory_logs set new_purchase_price=22000 where id=100");
    assert.equal((await project(db)).code,'PAYABLE_ALREADY_PAID');
    await db.exec("update ledger_payables set status='paid'");
    assert.equal((await project(db)).status,'review_required');
    await db.exec("insert into ledger_month_closures values('2026-09-01')");
    assert.equal((await project(db)).code,'MONTH_CLOSED');
    await db.exec("update inventory_logs set new_purchase_price=21000,item_name='Latest display' where id=100");
    assert.equal((await project(db)).code,'METADATA_SYNCED','closed and paid display-only updates allowed');
    assert.equal((await project(db,100,3)).code,'FORBIDDEN');
    await db.exec('set role authenticated');
    await assert.rejects(project(db),/permission denied/);
    await db.exec('reset role; set role service_role');
    await assert.rejects(db.query("select inventory_ledger_private.resolve_candidate(1,'immediate',4,10,1,null,null,null,1)"),/permission denied/);
    await db.exec('reset role');
    const audit=await one(db,"select after_snapshot from ledger_audit_logs where action='inventory_source_projected' order by id desc limit 1");
    assert.equal(audit.after_snapshot.execution,'automatic_inventory_projection');
    assert.equal(audit.after_snapshot.sourceActorUserId,1);
  } finally {await db.close();}
});

test('legacy fingerprint compatibility, manual override protection and future date/quantity corrections', async () => {
  const db=await database();
  try {
    await project(db);
    // Simulate a pre-overlay confirmed source. Its original fingerprint remains evidence.
    await db.exec(`update ledger_candidates set source_snapshot=source_snapshot-array['item_name_vi','unit'],source_fingerprint=repeat('a',64);
      update ledger_transactions set source_snapshot=source_snapshot-array['item_name_vi','unit'],source_fingerprint=repeat('a',64);`);
    assert.equal((await project(db)).code,'METADATA_SYNCED');
    assert.equal((await one(db,'select source_fingerprint from ledger_transactions')).source_fingerprint,'a'.repeat(64));
    assert.equal(Number((await one(db,'select count(*) as n from ledger_transactions')).n),1);
    await db.exec("update inventory_logs set change_quantity=11,business_date='2026-10-01' where id=100");
    assert.equal((await project(db)).code,'REBOOKED');
    assert.equal((await one(db,'select business_date::text as date from ledger_transactions order by id desc limit 1')).date,'2026-10-01');
    assert.equal(Number((await one(db,'select amount from ledger_transactions order by id desc limit 1')).amount),220000);
    const manual = await one(db,"select ledger_rebook_inventory_transaction_v1((select max(id) from ledger_transactions),'immediate',4,1,null,230000,null,'Owner correction',2) as result");
    assert.equal(manual.result.status,'rebooked');
    await db.exec('update inventory_logs set new_purchase_price=22000 where id=100');
    assert.equal((await project(db)).code,'MANUAL_LEDGER_OVERRIDE');
    assert.equal(Number((await one(db,'select amount from ledger_transactions order by id desc limit 1')).amount),230000);
    const denied=await one(db,"select ledger_rebook_inventory_transaction_v1((select max(id) from ledger_transactions),'immediate',4,1,null,240000,null,'Staff',1) as result");
    assert.equal(denied.result.status,'forbidden');
  } finally {await db.close();}
});

test('manual month reconciliation uses single-log projection and preserves closed-month review', async () => {
  const auto=await database(), manual=await database();
  try {
    await project(auto);
    let result=await one(manual,"select ledger_reconcile_inventory_month_v1('2026-09-01',2) as result");
    assert.equal(result.result.autoConfirmedImmediateCount,1);
    const economic = "select business_date,amount,party_id,category_id,source_snapshot,source_fingerprint from ledger_transactions order by id";
    assert.deepEqual((await auto.query(economic)).rows,(await manual.query(economic)).rows);
    for (const db of [auto,manual]) await db.exec('update inventory_logs set new_purchase_price=25000 where id=100');
    await project(auto);
    result=await one(manual,"select ledger_reconcile_inventory_month_v1('2026-09-01',2) as result");
    assert.equal(result.result.rebookedCount,1);
    assert.deepEqual((await auto.query(economic)).rows,(await manual.query(economic)).rows);
    await one(manual,"select ledger_reconcile_inventory_month_v1('2026-09-01',2)");
    assert.equal(Number((await one(manual,'select count(*) as n from ledger_transactions')).n),3);
    await manual.exec("insert into ledger_month_closures(month) values('2026-09-01'); update inventory_logs set new_purchase_price=26000 where id=100");
    result=await one(manual,"select ledger_reconcile_inventory_month_v1('2026-09-01',2) as result");
    assert.equal(result.result.reviewRequiredCount,1);
    assert.equal(result.result.issues[0].code,'MONTH_CLOSED');
    assert.equal((await one(manual,"select ledger_reconcile_inventory_month_v1('2026-09-01',1) as result")).result.status,'forbidden');
  } finally {await auto.close();await manual.close();}
});

test('legacy v1/v2 callers retain owner restrictions and cannot supply projection economics', async () => {
  const db=await database();
  try {
    const supplied=[{sourceKey:'inventory-log:100',businessDate:'2026-09-01',amount:999999,snapshot:{supplier:'Forged'},fingerprint:'f'.repeat(64)}];
    const call=actor=>db.query('select ledger_sync_inventory_candidates_v1($1::jsonb,$2) as result',[JSON.stringify(supplied),actor]);
    assert.equal((await call(1)).rows[0].result.status,'forbidden');
    assert.equal((await call(2)).rows[0].result.autoConfirmedImmediateCount,1);
    assert.equal(Number((await one(db,'select amount from ledger_transactions')).amount),200000);
    assert.equal(Number((await one(db,'select party_id from ledger_transactions')).party_id),10);
    await call(2); await project(db);
    assert.equal(Number((await one(db,'select count(*) as n from ledger_transactions')).n),1);
    const grants=(await db.query(`select role_name,
      has_function_privilege(role_name,'public.ledger_project_inventory_purchase_log_v1(bigint,bigint)','EXECUTE') as project,
      has_function_privilege(role_name,'public.ledger_reconcile_inventory_month_v1(date,bigint)','EXECUTE') as reconcile
      from unnest(array['anon','authenticated','service_role','postgres']) role_name`)).rows;
    assert.deepEqual(grants.map(row=>[row.role_name,row.project,row.reconcile]),[
      ['anon',false,false],['authenticated',false,false],['service_role',true,true],['postgres',true,true],
    ]);
    assert.equal((await one(db,"select has_table_privilege('service_role','ledger_inventory_projection_status','UPDATE') as allowed")).allowed,false);
    assert.equal((await one(db,"select has_function_privilege('service_role','inventory_ledger_private.rebook_source(bigint,text,bigint,bigint,date,numeric,text,text,bigint,jsonb,text,bigint,date)','EXECUTE') as allowed")).allowed,false);
  } finally {await db.close();}
});

test('unpaid payable with allocations is protected, and pending metadata keeps accounting category', async () => {
  const db=await database();
  try {
    await db.exec("update inventory_logs set new_supplier='Unmapped' where id=100");
    await project(db);
    await db.exec("insert into ledger_inventory_category_mappings(inventory_category,ledger_category_id) values('Soda',3);update inventory_logs set category='Soda',item_name_vi='Moi' where id=100");
    assert.equal((await project(db)).status,'pending');
    const pending=await one(db,"select * from ledger_candidates where status='pending'");
    assert.equal(Number(pending.proposed_category_id),4);
    assert.equal(Number(pending.proposed_amount),200000);
    await db.exec("update inventory_logs set new_supplier='Postpaid' where id=100");
    await project(db);
    await db.exec("insert into ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount) select id,expense_transaction_id,1 from ledger_payables;update inventory_logs set new_purchase_price=22000 where id=100");
    assert.equal((await project(db)).code,'PAYABLE_ALREADY_PAID');
    assert.equal(Number((await one(db,'select count(*) as n from ledger_transactions')).n),1);
  } finally {await db.close();}
});

test('legacy dismissed sources are not reopened by the display schema/fingerprint transition', async () => {
  const db=await database();
  try {
    await db.exec("update inventory_logs set new_supplier='Unmapped' where id=100");
    await project(db);
    await db.exec(`update ledger_candidates set status='dismissed',resolved_by=2,resolved_at=now(),dismissal_reason='Not an expense',
      source_snapshot=source_snapshot-array['item_name_vi','unit'],source_fingerprint=repeat('b',64);`);
    await project(db); await project(db);
    assert.equal(Number((await one(db,'select count(*) as n from ledger_candidates')).n),1);
    assert.equal(Number((await one(db,'select count(*) as n from ledger_transactions')).n),0);
  } finally {await db.close();}
});

test('pending supersession, existing stock exclusion, independent purchases and atomic failure recovery', async () => {
  const db=await database();
  try {
    await db.exec("update inventory_logs set new_supplier='Unmapped' where id=100");
    assert.equal((await project(db)).status,'pending');
    await db.exec('update inventory_logs set new_purchase_price=18000 where id=100');
    assert.equal((await project(db)).status,'pending');
    assert.equal(Number((await one(db,"select count(*) as n from ledger_candidates where status='superseded'")).n),1);
    await db.exec("update inventory_logs set new_supplier='Won Mart' where id=100");
    assert.equal((await project(db)).status,'synced');
    await db.exec("insert into inventory_logs select 101,item_id,item_name,item_name_vi,category,category_vi,unit,5,21000,'OK FOOD','2026-09-05',created_at,source,reason,actor_username,null,1 from inventory_logs where id=100");
    assert.equal((await project(db,101)).status,'synced');
    assert.equal(Number((await one(db,'select count(*) as n from ledger_transactions')).n),2);
    await db.exec("insert into inventory_logs select 102,item_id,item_name,item_name_vi,category,category_vi,unit,5,21000,new_supplier,business_date,created_at,source,'stock_check',actor_username,null,1 from inventory_logs where id=100");
    assert.equal((await project(db,102)).code,'NOT_A_PURCHASE');
    assert.equal(Number((await one(db,'select count(*) as n from ledger_transactions')).n),2);
    await db.exec(`create function fail_projection_test() returns trigger language plpgsql as $$begin raise exception 'injected';end$$;
      create trigger fail_projection before insert on ledger_transactions for each row execute function fail_projection_test();
      update inventory_logs set new_purchase_price=19000 where id=100;`);
    assert.equal((await project(db)).status,'failed');
    assert.equal(Number((await one(db,'select new_purchase_price from inventory_logs where id=100')).new_purchase_price),19000);
    assert.equal(Number((await one(db,'select count(*) as n from ledger_transactions')).n),2);
    await db.exec('drop trigger fail_projection on ledger_transactions');
    assert.equal((await project(db)).code,'REBOOKED');
  } finally {await db.close();}
});
