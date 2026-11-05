// Isolated PGlite fixture; no Production connection or migration application.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { database } from './helpers/inventory-ledger-fixture.mjs';

const migration = readFileSync('supabase/migrations/20260921170100_add_inventory_payment_verification.sql', 'utf8');
const samePartyMetadataMigration = readFileSync('supabase/migrations/202609250001_allow_same_party_inventory_supplier_metadata_enrichment.sql', 'utf8');
const milanCorrection = readFileSync('scripts/ledger/milan-food-3239-confirm-unpaid-20261105-ONE-OFF.sql', 'utf8');
const milanBaseline = JSON.parse(readFileSync('scripts/ledger/evidence/20261105-milan-food-3239-before-READONLY.json', 'utf8').replace(/^\uFEFF/, ''));

for (const scenario of ['apply_and_retry', 'baseline_mismatch', 'audit_failure', 'closed_month']) test(`Milan Food one-off SQL: ${scenario}, metadata only and atomic audit`, async () => {
  const db = await verificationDatabase();
  try {
    await db.exec(`insert into users values(8,'staff',true,true);
      insert into ledger_parties(id,name,type) values(4,'Milan Food','supplier');
      insert into ledger_categories(id,name,kind) values(42,'육류','expense');
      insert into inventory(id,supplier_partner_id) values(293,4);
      update inventory_logs set id=14240,item_id=293,business_date='2026-10-27',new_supplier='Milan Food';
      insert into ledger_month_closures(month,status) values('2026-08-01','reopened'),('2026-09-01','reopened');`);
    const columns = (await db.query("select column_name from information_schema.columns where table_schema='public' and table_name='ledger_transactions'")).rows.map(r => r.column_name);
    const original = Object.fromEntries(Object.entries(milanBaseline.transaction).filter(([name]) => columns.includes(name)));
    const insert = async transaction => {
      const names = Object.keys(transaction);
      await db.query(`insert into ledger_transactions(${names.join(',')}) values(${names.map((_,i)=>`$${i+1}`).join(',')})`,
        names.map(name => typeof transaction[name] === 'object' && transaction[name] !== null ? JSON.stringify(transaction[name]) : transaction[name]));
    };
    await insert(original);
    await insert({ ...original, id:3307, business_date:'2026-10-28', amount:1_101_600, source_key:'candidate:late-paid-fixture' });
    await db.exec(`insert into ledger_payables(id,expense_transaction_id,party_id,original_amount,status)
      values(1614,3239,4,1410000,'unpaid'),(1631,3307,4,1101600,'unpaid');`);
    const payment = (await db.query("select ledger_pay_payables_v1(4,2,'2026-11-03T12:00:00+07:00',1101600,$1::jsonb,'existing later payment',2) as result",
      [JSON.stringify([{ payableId:1631, allocatedAmount:1_101_600 }])])).rows[0].result;
    assert.equal(payment.status,'paid');
    const preflight = async () => (await db.query("select ledger_close_preflight_v1('2026-10-01',2) as result")).rows[0].result;
    const protectedState = async () => {
      const state = {};
      for (const table of ['ledger_movements','ledger_payables','ledger_payable_allocations','inventory','inventory_logs','ledger_candidates','ledger_month_closures'])
        state[table]=(await db.query(`select * from ${table} order by 1`)).rows;
      state.otherTransactions=(await db.query('select * from ledger_transactions where id<>3239 order by id')).rows;
      return JSON.stringify(state);
    };
    if (scenario === 'baseline_mismatch') await db.exec('update ledger_payables set original_amount=1410001 where id=1614');
    if (scenario === 'closed_month') await db.exec("insert into ledger_month_closures(month,status) values('2026-10-01','closed')");
    if (scenario === 'audit_failure') await db.exec(`create function reject_correction_audit() returns trigger language plpgsql as $$begin raise exception 'injected audit failure';end$$;
      create trigger reject_correction_audit before insert on ledger_audit_logs for each row execute function reject_correction_audit();`);
    const beforeProtected=await protectedState();
    const before=(await db.query('select * from ledger_transactions where id=3239')).rows[0];
    const beforeAudit=(await db.query('select * from ledger_audit_logs order by id')).rows;
    const sql=milanCorrection.replaceAll('__ACTOR_USER_ID__','2');
    if (scenario !== 'apply_and_retry') {
      await assert.rejects(db.exec(sql), scenario === 'baseline_mismatch' ? /baseline mismatch/ : scenario === 'closed_month' ? /LEDGER_MONTH_CLOSED/ : /injected audit failure/);
      await db.exec('ROLLBACK');
      assert.deepEqual((await db.query('select * from ledger_transactions where id=3239')).rows[0],before);
      assert.deepEqual((await db.query('select * from ledger_audit_logs order by id')).rows,beforeAudit);
    } else {
      const pending=await preflight();
      assert.deepEqual(pending.blockers,[{code:'PAYMENT_VERIFICATION_UNRESOLVED',count:1,amount:1_410_000}]);
      await db.exec(sql);
      const after=(await db.query('select * from ledger_transactions where id=3239')).rows[0];
      const {paymentVerification,...expectedSnapshot}=before.source_snapshot;
      assert.equal(paymentVerification,'pending');
      assert.deepEqual(after,{...before,source_snapshot:expectedSnapshot});
      const result=await preflight();
      assert.deepEqual(result.blockers,[]);
      assert.deepEqual(result.warnings,[{code:'PAYABLE_OUTSTANDING',amount:1_410_000},{code:'PAYMENT_VERIFICATION_LATER_PAID',count:1,amount:1_101_600}]);
      const audit=(await db.query("select * from ledger_audit_logs where action='payment_verification_confirmed_unpaid'")).rows;
      assert.equal(audit.length,1);
      assert.equal(audit[0].before_snapshot.transaction.source_snapshot.paymentVerification,'pending');
      assert.equal(audit[0].after_snapshot.transaction.source_snapshot.paymentVerification,undefined);
      assert.deepEqual(audit[0].before_snapshot.payable,audit[0].after_snapshot.payable);
      await db.exec(sql);
      assert.deepEqual((await db.query('select * from ledger_transactions where id=3239')).rows[0],after);
      assert.deepEqual((await db.query("select * from ledger_audit_logs where action='payment_verification_confirmed_unpaid'")).rows,audit);
    }
    assert.equal(await protectedState(),beforeProtected,'all payment, allocation, inventory and month states stay intact');
  } finally { await db.close(); }
});

async function verificationDatabase({ legacyImmediate = false, initialPostpaid = false } = {}) {
  const db = await database(undefined, true, false);
  try {
    if (initialPostpaid) await db.exec("update inventory_logs set new_supplier='Postpaid',purchase_supplier_partner_id=12 where id=100");
    if (legacyImmediate) {
      const result = (await db.query('select ledger_project_inventory_purchase_log_v1(100,1) as result')).rows[0].result;
      assert.equal(result.status, 'synced');
    }
    // The fixture does not load the month-close schema, so install the current
    // function body separately from the local migration being tested.
    await db.exec(`create or replace function public.ledger_close_preflight_v1(p_month date,p_actor_user_id bigint)
      returns jsonb language plpgsql as $$
      declare v_amount numeric;v_count bigint;v_warnings jsonb:='[]';v_blockers jsonb:='[]';v_token text;
      begin
       select coalesce(sum(p.original_amount),0) into v_amount from public.ledger_payables p
       join public.ledger_transactions t on t.id=p.expense_transaction_id
       where t.business_date<(p_month+interval'1 month')::date and p.status<>'cancelled';if v_amount>0 then v_warnings:=v_warnings||jsonb_build_array(jsonb_build_object('code','PAYABLE_OUTSTANDING','amount',v_amount));end if;
       v_token:=md5('fixture');
       return jsonb_build_object('blockers',v_blockers,'warnings',v_warnings,'preflightHash',v_token);
      end $$`);
    await db.exec(readFileSync('supabase/migrations/202608210004_add_ledger_payable_payments.sql', 'utf8'));
    await db.exec(migration);
    // Match production ordering: the same-party metadata projection patch is
    // applied after the payment-verification migration has amended the RPC.
    await db.exec(samePartyMetadataMigration);
    return db;
  } catch (error) { await db.close(); throw error; }
}

const project = async db => (await db.query('select ledger_project_inventory_purchase_log_v1(100,1) as result')).rows[0].result;
async function replacement(db, { marker, outgoing, payable, partyId }) {
  const transaction = (await db.query("select id,party_id,source_snapshot from ledger_transactions where source_type='inventory_purchase_rebook' order by id desc limit 1")).rows[0];
  assert.ok(transaction, 'source correction must create a replacement expense');
  assert.equal(transaction.source_snapshot.paymentVerification ?? null, marker);
  assert.equal(Number(transaction.party_id), partyId);
  const movements = (await db.query('select amount from ledger_movements where transaction_id=$1', [transaction.id])).rows;
  assert.equal(movements.length, outgoing);
  if (outgoing) assert.ok(Number(movements[0].amount) < 0);
  const payables = (await db.query("select id from ledger_payables where expense_transaction_id=$1 and status<>'cancelled'", [transaction.id])).rows;
  assert.equal(payables.length, payable);
  const bad = (await db.query("select count(*) as count from ledger_transactions t join ledger_movements m on m.transaction_id=t.id where t.source_snapshot->>'paymentVerification'='pending' and m.amount<0")).rows[0];
  assert.equal(Number(bad.count), 0, 'pending verification must never carry outgoing fund movement');
}

test('automatic immediate partner receipt records expense and verification payable without cash movement', async () => {
  const db = await verificationDatabase();
  try {
    await db.exec("update business_partners set default_fund_account_id=null where id=10");
    const result = (await db.query('select ledger_project_inventory_purchase_log_v1(100,1) as result')).rows[0].result;
    assert.equal(result.status, 'synced');
    const expense = (await db.query("select amount,source_snapshot from ledger_transactions where type='expense'")).rows[0];
    assert.equal(Number(expense.amount), 200000);
    assert.equal(expense.source_snapshot.paymentVerification, 'pending');
    assert.equal(Number((await db.query('select count(*) as count from ledger_movements')).rows[0].count), 0);
    assert.equal(Number((await db.query('select sum(original_amount) as amount from ledger_payables')).rows[0].amount), 200000);
    const preflight = (await db.query("select ledger_close_preflight_v1('2026-09-01',2) as result")).rows[0].result;
    assert.equal(preflight.blockers[0].code, 'PAYMENT_VERIFICATION_UNRESOLVED');
    assert.deepEqual(preflight.warnings, [], 'verification payable is excluded from ordinary PAYABLE_OUTSTANDING');
    const payableId = (await db.query('select id from ledger_payables')).rows[0].id;
    const paid = (await db.query("select ledger_pay_payables_v1(10,1,'2026-10-04T12:00:00+07:00',200000,$1::jsonb,'verified',2) as result", [JSON.stringify([{ payableId, allocatedAmount: 200000 }])])).rows[0].result;
    assert.equal(paid.status, 'paid');
    assert.equal(Number((await db.query("select sum(amount) as amount from ledger_movements where transaction_id=(select id from ledger_transactions where type='payable_payment')")).rows[0].amount), -200000);
    const settledPreflight = (await db.query("select ledger_close_preflight_v1('2026-09-01',2) as result")).rows[0].result;
    assert.equal(settledPreflight.blockers.length, 0);
    assert.deepEqual(settledPreflight.warnings.map(item => item.code), ['PAYMENT_VERIFICATION_LATER_PAID']);
  } finally { await db.close(); }
});

test('A: same-supplier source correction retains verification payable without movement', async () => {
  const db = await verificationDatabase();
  try {
    assert.equal((await project(db)).status, 'synced');
    await db.exec('update inventory_logs set new_purchase_price=21000 where id=100');
    assert.equal((await project(db)).code, 'REBOOKED');
    await replacement(db, { marker: 'pending', outgoing: 0, payable: 1, partyId: 10 });
    assert.equal(Number((await db.query("select count(*) as count from ledger_audit_logs where action='candidate_confirmed_verification_pending'")).rows[0].count), 1);
  } finally { await db.close(); }
});

test('B: changing to another immediate supplier stays verification pending', async () => {
  const db = await verificationDatabase();
  try {
    assert.equal((await project(db)).status, 'synced');
    await db.exec("update inventory_logs set new_supplier='OK FOOD',purchase_supplier_partner_id=11,new_purchase_price=21000 where id=100");
    assert.equal((await project(db)).code, 'REBOOKED');
    await replacement(db, { marker: 'pending', outgoing: 0, payable: 1, partyId: 11 });
  } finally { await db.close(); }
});

test('C: changing to a postpaid supplier creates ordinary payable without pending marker', async () => {
  const db = await verificationDatabase();
  try {
    assert.equal((await project(db)).status, 'synced');
    await db.exec("update inventory_logs set new_supplier='Postpaid',purchase_supplier_partner_id=12,new_purchase_price=21000 where id=100");
    assert.equal((await project(db)).code, 'REBOOKED');
    await replacement(db, { marker: null, outgoing: 0, payable: 1, partyId: 12 });
  } finally { await db.close(); }
});

test('D: ordinary payable remains ordinary after same-supplier correction', async () => {
  const db = await verificationDatabase({ initialPostpaid: true });
  try {
    assert.equal((await project(db)).status, 'synced');
    await db.exec('update inventory_logs set new_purchase_price=21000 where id=100');
    assert.equal((await project(db)).code, 'REBOOKED');
    await replacement(db, { marker: null, outgoing: 0, payable: 1, partyId: 12 });
    assert.equal(Number((await db.query("select count(*) as count from ledger_audit_logs where action='candidate_confirmed_payable'")).rows[0].count), 1);
    const preflight = (await db.query("select ledger_close_preflight_v1('2026-09-01',2) as result")).rows[0].result;
    assert.equal(preflight.blockers.length, 0);
    assert.deepEqual(preflight.warnings.map(item => item.code), ['PAYABLE_OUTSTANDING']);
  } finally { await db.close(); }
});

test('E: existing immediate expense remains immediate with one outgoing replacement movement', async () => {
  const db = await verificationDatabase({ legacyImmediate: true });
  try {
    const original = (await db.query("select id,source_snapshot from ledger_transactions where source_type='inventory_purchase_candidate'")).rows[0];
    assert.equal(original.source_snapshot.paymentVerification, undefined, 'migration does not rewrite existing rows');
    await db.exec('update inventory_logs set new_purchase_price=21000 where id=100');
    assert.equal((await project(db)).code, 'REBOOKED');
    await replacement(db, { marker: null, outgoing: 1, payable: 0, partyId: 10 });
    assert.equal(Number((await db.query("select count(*) as count from ledger_audit_logs where action='candidate_confirmed_immediate'")).rows[0].count), 1);
  } finally { await db.close(); }
});

test('F: final immediate mode strips even an incoming pending marker before creating an outgoing movement', async () => {
  const db = await verificationDatabase();
  try {
    assert.equal((await project(db)).status, 'synced');
    const original = (await db.query("select id,source_snapshot from ledger_transactions where source_type='inventory_purchase_candidate'")).rows[0];
    const result = (await db.query("select inventory_ledger_private.rebook_source($1,'immediate',4,1,null,210000,null,'Verified immediate payment',2,$2::jsonb,$3,10,'2026-09-01') as result", [original.id, JSON.stringify(original.source_snapshot), 'f'.repeat(64)])).rows[0].result;
    assert.equal(result.status, 'rebooked');
    await replacement(db, { marker: null, outgoing: 1, payable: 0, partyId: 10 });
  } finally { await db.close(); }
});

for (const resolution of ['immediate', 'payable', 'verification_pending']) test(`unspecified regular partner stays pending until explicit ${resolution} resolution`, async () => {
  const db = await verificationDatabase();
  try {
    await db.exec("update business_partners set payment_mode='unspecified' where id=10");
    await project(db);
    assert.equal(Number((await db.query('select count(*) as n from ledger_transactions')).rows[0].n), 0, 'no automatic confirmation');
    const candidate = (await db.query("select id,proposed_category_id,proposed_party_id from ledger_candidates where status='pending'")).rows[0];
    assert.ok(candidate);assert.equal(Number(candidate.proposed_party_id),10);
    const result = (await db.query('select ledger_resolve_inventory_candidate_v1($1,$2,$3,$4,$5,null,null,null,2) as result', [candidate.id,resolution,candidate.proposed_category_id,10,resolution==='immediate'?1:null])).rows[0].result;
    assert.equal(result.status,'confirmed');
    const expense=(await db.query("select party_id,amount,source_snapshot from ledger_transactions where type='expense' and status='confirmed'")).rows[0];
    assert.equal(Number(expense.party_id),10);assert.equal(Number(expense.amount),200000);
    assert.equal(expense.source_snapshot.paymentVerification,resolution==='verification_pending'?'pending':undefined);
    assert.equal(Number((await db.query('select count(*) as n from ledger_payables')).rows[0].n),resolution==='immediate'?0:1);
    assert.equal(Number((await db.query('select count(*) as n from ledger_movements')).rows[0].n),resolution==='immediate'?1:0);
  } finally { await db.close(); }
});
