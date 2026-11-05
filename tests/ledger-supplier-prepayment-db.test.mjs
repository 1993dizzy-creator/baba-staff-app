// In-memory PGlite only (no credentials, no network). Loads the real payable payment
// migrations, the allocation month guard and the new supplier prepayment migration.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { database } from './helpers/inventory-ledger-fixture.mjs';

const read = name => readFileSync(`supabase/migrations/${name}`, 'utf8');
const migration = read('20261106120000_add_supplier_prepayments.sql');

async function setup() {
  const db = await database();
  await db.exec(read('202608210004_add_ledger_payable_payments.sql'));
  await db.exec(read('20261018105936_add_payable_payment_idempotency_v2.sql'));
  // Real allocation month guard (function + trigger) from the month-close migration.
  const month = read('202608210008_add_ledger_month_close_corrections.sql');
  const guard = month.slice(month.indexOf('create or replace function public.ledger_payable_allocation_month_guard_v1'), month.indexOf('create or replace function public.ledger_card_reconciliation_month_guard_v1'));
  const hasTrigger = (await db.query("select 1 from pg_trigger where tgname='ledger_payable_allocations_month_guard'")).rows.length > 0;
  await db.exec(hasTrigger ? guard.slice(0, guard.indexOf('create trigger')) : guard);
  await db.exec(migration);
  await db.exec("insert into ledger_parties(id,name,type) values(20,'Aloko','supplier') on conflict do nothing");
  return db;
}
const one = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
const create = (db, { key = randomUUID(), party = 20, account = 1, at = '2026-11-04T12:00:00+07:00', amount = 6_402_000, memo = '오징어 선결제', actor = 2 } = {}) =>
  one(db, 'select ledger_create_supplier_prepayment_v1($1,$2,$3,$4,$5,$6,$7) as r', [key, party, account, at, amount, memo, actor]).then(row => row.r);
const apply = (db, allocations, { key = randomUUID(), party = 20, actor = 2 } = {}) =>
  one(db, 'select ledger_apply_supplier_prepayment_v1($1,$2,$3::jsonb,$4) as r', [key, party, JSON.stringify(allocations), actor]).then(row => row.r);
// A received purchase: confirmed expense + unpaid payable (same shape as the inventory projection).
async function receipt(db, amount, date = '2026-11-05', party = 20) {
  const tx = await one(db, `insert into ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,party_id,status,source_type,source_snapshot,source_fingerprint,source_synced_at,created_by,confirmed_by)
    values(gen_random_uuid(),'expense',$1::date+time '12:00',$1::date,date_trunc('month',$1::date)::date,$2,4,$3,'confirmed','inventory_purchase_candidate','{"paymentVerification":"pending"}','fp',now(),2,2) returning id`, [date, amount, party]);
  return Number((await one(db, "insert into ledger_payables(expense_transaction_id,party_id,original_amount,status) values($1,$2,$3,'unpaid') returning id", [tx.id, party, amount])).id);
}
const totals = async db => one(db, `select (select count(*) from ledger_transactions)::int tx,(select count(*) from ledger_movements)::int mv,
  (select coalesce(sum(amount),0) from ledger_movements)::numeric cash,(select count(*) from ledger_payable_allocations)::int alloc,
  (select coalesce(sum(amount),0) from ledger_transactions where status='confirmed' and type in('expense','income','sales','expense_recognition') and type='expense')::numeric expense`);
const payable = async (db, id) => one(db, `select p.status,p.original_amount-coalesce(sum(a.allocated_amount),0) as outstanding from ledger_payables p left join ledger_payable_allocations a on a.payable_id=p.id where p.id=$1 group by p.id`, [id]);
const unused = async (db, id) => Number((await one(db, 'select t.amount-coalesce((select sum(allocated_amount) from ledger_payable_allocations where payment_transaction_id=t.id),0) as r from ledger_transactions t where t.id=$1', [id])).r);

test('prepayment: one outflow, no expense before receipt; linking adds no outflow', async () => {
  const db = await setup();
  const before = await totals(db);
  const created = await create(db);
  assert.equal(created.status, 'created');
  const id = created.prepaymentTransactionId;
  const row = await one(db, 'select type,business_date::text,source_snapshot,party_id from ledger_transactions where id=$1', [id]);
  assert.deepEqual([row.type, row.business_date, row.source_snapshot.prepayment, Number(row.party_id)], ['payable_payment', '2026-11-04', true, 20]);
  let now = await totals(db);
  assert.equal(now.mv - before.mv, 1); assert.equal(Number(now.cash) - Number(before.cash), -6_402_000);
  assert.equal(Number(now.expense), Number(before.expense), 'no expense recognized by the prepayment');
  assert.equal(await unused(db, id), 6_402_000);
  // receipt arrives 11/5, then the prepayment is linked
  const p = await receipt(db, 6_402_000);
  const cashBeforeLink = Number((await totals(db)).cash), movementsBeforeLink = (await totals(db)).mv;
  const applied = await apply(db, [{ prepaymentTransactionId: id, payableId: p, allocatedAmount: 6_402_000 }]);
  assert.equal(applied.status, 'applied');
  now = await totals(db);
  assert.equal(now.mv, movementsBeforeLink, 'linking creates no movement'); assert.equal(Number(now.cash), cashBeforeLink);
  assert.deepEqual(await payable(db, p), { status: 'paid', outstanding: '0.000' });
  assert.equal(await unused(db, id), 0);
  assert.equal(Number(now.expense) - Number(before.expense), 6_402_000, 'expense recognized once, by the receipt');
});

test('partial prepayment and several receipts; overuse and duplicate links are refused', async () => {
  const db = await setup();
  const { prepaymentTransactionId: id } = await create(db, { amount: 5_000_000 });
  const a = await receipt(db, 3_000_000), b = await receipt(db, 4_000_000, '2026-11-06');
  // a fully + 2,000,000 of b
  assert.equal((await apply(db, [{ prepaymentTransactionId: id, payableId: a, allocatedAmount: 3_000_000 }, { prepaymentTransactionId: id, payableId: b, allocatedAmount: 2_000_000 }])).status, 'applied');
  assert.deepEqual(await payable(db, a), { status: 'paid', outstanding: '0.000' });
  assert.deepEqual(await payable(db, b), { status: 'partially_paid', outstanding: '2000000.000' });
  assert.equal(await unused(db, id), 0);
  const snapshot = await totals(db);
  // no balance left
  assert.equal((await apply(db, [{ prepaymentTransactionId: id, payableId: b, allocatedAmount: 1 }])).status, 'prepayment_insufficient');
  // a second prepayment cannot exceed the payable outstanding, nor link the same pair twice
  const { prepaymentTransactionId: id2 } = await create(db, { amount: 3_000_000, at: '2026-11-06T09:00:00+07:00' });
  assert.equal((await apply(db, [{ prepaymentTransactionId: id2, payableId: b, allocatedAmount: 2_500_000 }])).status, 'amount_exceeds_outstanding');
  assert.equal((await apply(db, [{ prepaymentTransactionId: id2, payableId: b, allocatedAmount: 1_000 }, { prepaymentTransactionId: id2, payableId: b, allocatedAmount: 1_000 }])).status, 'duplicate_allocation');
  assert.equal((await apply(db, [{ prepaymentTransactionId: id2, payableId: b, allocatedAmount: 2_000_000 }])).status, 'applied');
  assert.equal((await apply(db, [{ prepaymentTransactionId: id2, payableId: b, allocatedAmount: 1 }])).status, 'amount_exceeds_outstanding');
  assert.equal(await unused(db, id2), 1_000_000);
  // remaining remainder still payable later by another receipt; totals moved only by the applied rows
  assert.equal((await totals(db)).mv, snapshot.mv + 1);
});

test('wrong party, ordinary payment or cancelled prepayment cannot be used; retries replay once', async () => {
  const db = await setup();
  await db.exec("insert into ledger_parties(id,name,type) values(21,'Other','supplier') on conflict do nothing");
  const { prepaymentTransactionId: id } = await create(db, { amount: 1_000_000 });
  const p = await receipt(db, 1_000_000), other = await receipt(db, 1_000_000, '2026-11-05', 21);
  assert.equal((await apply(db, [{ prepaymentTransactionId: id, payableId: other, allocatedAmount: 1_000 }], { party: 21 })).status, 'invalid_prepayment');
  assert.equal((await apply(db, [{ prepaymentTransactionId: id, payableId: other, allocatedAmount: 1_000 }])).status, 'payable_party_mismatch');
  // an ordinary payable payment is not a prepayment
  const q = await receipt(db, 500_000);
  const paid = (await one(db, "select ledger_pay_payables_v2($1,20,1,'2026-11-05T12:00:00+07:00',500000,$2::jsonb,null,2) as r", [randomUUID(), JSON.stringify([{ payableId: q, allocatedAmount: 500000 }])])).r;
  assert.equal(paid.status, 'paid');
  assert.equal((await apply(db, [{ prepaymentTransactionId: paid.paymentTransactionId, payableId: p, allocatedAmount: 1_000 }])).status, 'invalid_prepayment');
  // idempotent create / apply
  const key = randomUUID(), first = await create(db, { key, amount: 2_000 });
  const before = await totals(db);
  assert.deepEqual(await create(db, { key, amount: 2_000 }), first);
  assert.equal((await create(db, { key, amount: 3_000 })).status, 'idempotency_conflict');
  const applyKey = randomUUID(), applied = await apply(db, [{ prepaymentTransactionId: id, payableId: p, allocatedAmount: 400_000 }], { key: applyKey });
  assert.deepEqual(await apply(db, [{ prepaymentTransactionId: id, payableId: p, allocatedAmount: 400_000 }], { key: applyKey }), applied);
  assert.equal((await totals(db)).alloc, before.alloc + 1);
  // cancelled prepayment is unusable
  await db.query("update ledger_transactions set status='cancelled' where id=$1", [id]);
  assert.equal((await apply(db, [{ prepaymentTransactionId: id, payableId: p, allocatedAmount: 1_000 }])).status, 'invalid_prepayment');
  // role / input validation
  assert.equal((await create(db, { actor: 1 })).status, 'forbidden');
  for (const amount of [0, -1, 0.0001]) assert.equal((await create(db, { amount })).status, 'invalid_amount');
  assert.equal((await create(db, { party: 999 })).status, 'invalid_party');
  for (const bad of [[], [{ prepaymentTransactionId: id, payableId: p }], [{ prepaymentTransactionId: id, payableId: p, allocatedAmount: 0 }], [{ prepaymentTransactionId: id, payableId: p, allocatedAmount: 1, extra: 1 }]])
    assert.equal((await apply(db, bad)).status, 'invalid_allocations');
});

test('closed months: no prepayment in a closed month; a closed-month prepayment cannot be applied', async () => {
  const db = await setup();
  const { prepaymentTransactionId: id } = await create(db, { amount: 1_000_000, at: '2026-10-31T12:00:00+07:00' });
  const p = await receipt(db, 1_000_000, '2026-11-02');
  await db.exec("insert into ledger_month_closures(month,status) values('2026-10-01','closed')");
  await assert.rejects(() => create(db, { at: '2026-10-20T12:00:00+07:00' }), /LEDGER_MONTH_CLOSED/);
  await assert.rejects(() => apply(db, [{ prepaymentTransactionId: id, payableId: p, allocatedAmount: 1_000_000 }]), /LEDGER_MONTH_CLOSED/);
  assert.deepEqual(await payable(db, p), { status: 'unpaid', outstanding: '1000000.000' });
});

test('grants: service_role only; existing payment RPC definitions are untouched', () => {
  assert.match(migration, /revoke all on function public\.ledger_create_supplier_prepayment_v1\([^)]*\) from public,anon,authenticated;/);
  assert.match(migration, /grant execute on function public\.ledger_apply_supplier_prepayment_v1\([^)]*\) to service_role;/);
  assert.doesNotMatch(migration, /ledger_pay_payables_v[12]\s*\(/i);
  assert.doesNotMatch(migration, /alter table|drop |create table|update public\.ledger_transactions|delete from/i);
});
