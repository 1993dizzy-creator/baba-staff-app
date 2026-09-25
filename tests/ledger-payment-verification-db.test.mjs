// Isolated PGlite fixture; no Production connection or migration application.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { database } from './helpers/inventory-ledger-fixture.mjs';

const migration = readFileSync('supabase/migrations/20260921170100_add_inventory_payment_verification.sql', 'utf8');
const samePartyMetadataMigration = readFileSync('supabase/migrations/202609250001_allow_same_party_inventory_supplier_metadata_enrichment.sql', 'utf8');

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
