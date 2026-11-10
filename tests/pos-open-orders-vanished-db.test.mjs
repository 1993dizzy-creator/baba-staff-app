// Real migration + public RPC wrappers on local in-memory PostgreSQL only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import * as core from '../lib/pos/cukcuk/open-orders-core.ts';
import { calculateStoreBusinessDate } from '../lib/store-settings/business-time-core.ts';

const base = readFileSync('supabase/migrations/20261109210000_pos_open_orders_v1.sql', 'utf8');
const migration = readFileSync('supabase/migrations/20261110170329_pos_open_orders_vanished_receipt_evidence.sql', 'utf8');
const date = calculateStoreBusinessDate(new Date().toISOString(), '03:00');
const scope = `${'a'.repeat(64)}:branch-fixture`;
const input = { scope, branchId: 'branch-fixture', businessDate: date, windowFrom: new Date(`${date}T03:00:00+07:00`).toISOString(), cutoff: '03:00' };
const order = (status = 3) => ({ orderId: 'order-18', orderNo: '1.18', status, statusClass: status === 5 ? 'canceled' : 'open',
  orderDate: new Date(`${date}T22:00:00+07:00`).toISOString(), businessDate: date, totalAmount: 2410000, tableName: 'T18',
  lines: [{ detailId: 'line-18', parentDetailId: null, additionId: null, itemId: 'menu-18', itemName: 'Menu', unitName: null,
    quantity: 1, amount: 2410000, price: 2410000, lineStatus: 1, isCanceled: false, isOption: false, isOrphanOption: false }] });
async function database(apply = true) {
  const db = new PGlite();
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create table public.pos_sales_receipts(id bigint primary key, source text, business_date date, payment_status integer, is_canceled boolean, raw_json jsonb);`);
  await db.exec(base);
  if (apply) await db.exec(migration);
  return db;
}
async function rpc(db, name, args) {
  const names = { pos_open_orders_claim: ['p_run_id','p_owner_token','p_scope','p_branch_id','p_business_date'],
    pos_open_orders_commit: ['p_run_id','p_owner_token','p_manifest','p_orders'], pos_open_orders_read: ['p_scope','p_business_date'],
    pos_open_orders_fail: ['p_run_id','p_owner_token','p_code'] }[name];
  const values = names.map(key => typeof args[key] === 'object' ? JSON.stringify(args[key]) : args[key]);
  if (name === 'pos_open_orders_claim') values.push(0);
  await db.exec('set role service_role');
  try { return (await db.query(`select public.${name}(${values.map((_, i) => '$'+(i+1)).join(',')}) as result`, values)).rows[0].result; }
  finally { await db.exec('reset role'); }
}
const read = db => rpc(db, 'pos_open_orders_read', { p_scope: scope, p_business_date: date });
async function commit(db, rows) {
  const p_run_id = randomUUID(), p_owner_token = randomUUID();
  await rpc(db, 'pos_open_orders_claim', { p_run_id, p_owner_token, p_scope: scope, p_branch_id: input.branchId, p_business_date: date });
  return rpc(db, 'pos_open_orders_commit', { p_run_id, p_owner_token, p_manifest: {}, p_orders: rows });
}
async function receipt(db, id = 18, status = 3, canceled = false, businessDate = date, orderId = 'order-18') {
  await db.query('insert into public.pos_sales_receipts values($1,$2,$3,$4,$5,$6)', [id, 'cukcuk', businessDate, status, canceled, JSON.stringify({ OrderId: orderId })]);
}
function transport() {
  const calls = [];
  return { calls, login: async () => {}, send: async request => {
    calls.push(request.kind);
    return { status: 200, json: request.kind === 'page' ? { Success: true, Total: 0, Data: [] }
      : { Success: true, Data: { Status: 4 } } }; // No Id: must not become a provider Status 4.
  } };
}
const evidence = () => [{ orderId: 'order-18', receiptId: 18, paymentStatus: 3, isCanceled: false, businessDate: date }];

test('missing-Id recovery via a paid receipt commits only preserved provider facts and independent DB proof', async () => {
  const db = await database();
  try {
    await commit(db, [order()]);
    const before = await read(db);
    await receipt(db);
    const t = transport();
    const result = await core.runOpenOrderSync({ rpc: (name,args) => rpc(db,name,args), transport: t, uuid: randomUUID, loadReceiptEvidence: async () => evidence() }, input);
    assert.equal(result.status, 'committed');
    assert.deepEqual(t.calls, ['page','detail']);
    const after = await read(db);
    assert.equal(after.orders[0].status, 3);
    assert.equal(after.orders[0].orderId, 'order-18');
    assert.equal(Number(after.orders[0].closureReceiptId), 18);
    assert.equal(after.orders[0].providerObservedAt, before.orders[0].providerObservedAt);
    assert.deepEqual(after.orders[0].lines, before.orders[0].lines);
    const audit = (await db.query('select manifest from pos_open_orders_private.runs where id=$1', [result.runId])).rows[0].manifest;
    assert.equal(audit.receiptClosures[0].previousOrder.status, 3);
    assert.equal(audit.receiptClosures[0].receiptId, 18);
    assert.equal(core.classifyOrdersForBusinessDate(after.orders, evidence(), date).converted, 1);
    assert.equal((await db.query('select count(*)::int n from public.pos_sales_receipts')).rows[0].n, 1);
  } finally { await db.close(); }
});

test('DB rejects stale/forged closure proof atomically, keeping prior snapshot and previous successful run', async () => {
  for (const variant of ['pending','canceled','duplicate','wrong_order','wrong_day','absent']) {
    const db = await database();
    try {
      await commit(db, [order()]);
      const before = await read(db);
      if (variant !== 'absent') await receipt(db, 18, variant === 'pending' ? 1 : 3, variant === 'canceled',
        variant === 'wrong_day' ? '2000-01-01' : date, variant === 'wrong_order' ? 'order-other' : 'order-18');
      if (variant === 'duplicate') await receipt(db, 19);
      // App read was valid, DB state now differs. DB must independently refuse it.
      const result = await core.runOpenOrderSync({ rpc: async (name,args) => {
        try { return await rpc(db,name,args); }
        catch (error) { throw new Error(core.openOrdersRpcErrorCode(error)); }
      }, transport: transport(), uuid: randomUUID, loadReceiptEvidence: async () => evidence() }, input);
      assert.equal(result.status, 'failed', variant);
      const after = await read(db);
      assert.deepEqual(after.orders, before.orders, variant);
      assert.equal(after.sync.lastSuccessAt, before.sync.lastSuccessAt);
      assert.equal(after.sync.lastErrorCode, 'open_orders_vanished');
    } finally { await db.close(); }
  }
});

test('no evidence keeps the old vanished guard and does not fabricate a completed snapshot', async () => {
  const db = await database();
  try {
    await commit(db, [order()]);
    const before = await read(db);
    const result = await core.runOpenOrderSync({ rpc: (name,args) => rpc(db,name,args), transport: transport(), uuid: randomUUID, loadReceiptEvidence: async () => [] }, input);
    assert.equal(result.code, 'orders_vanished_unconfirmed');
    assert.deepEqual((await read(db)).orders, before.orders);
    await assert.rejects(commit(db, []), /open_orders_vanished/);
  } finally { await db.close(); }
});

test('old Status 5 unknown row: original DB guard rejects omission, migration retains cancellation without requery', async () => {
  const db = await database(false);
  try {
    await commit(db, [{ ...order(5), statusClass: 'unknown' }]);
    await assert.rejects(commit(db, []), /open_orders_vanished/);
    await db.exec("update pos_open_orders_private.runs set status='failed' where status='collecting'");
    const before = await read(db);
    await db.exec(migration);
    const t = transport();
    const result = await core.runOpenOrderSync({ rpc: (name,args) => rpc(db,name,args), transport: t, uuid: randomUUID }, input);
    assert.equal(result.status, 'committed');
    assert.deepEqual(t.calls, ['page']);
    const after = await read(db);
    assert.equal(after.orders[0].status, 5);
    assert.equal(after.orders[0].statusClass, 'canceled');
    assert.deepEqual(after.orders[0].lines, before.orders[0].lines);
    await assert.rejects(commit(db, [{ ...order(1), statusClass: 'canceled' }]), /orders_canceled_status_check/);
  } finally { await db.close(); }
});

test('migration rollback and private helper permissions preserve the original access boundary', async () => {
  const db = await database(false);
  try {
    await commit(db, [order()]);
    await db.exec('begin');
    await db.exec(migration);
    await db.exec('rollback');
    assert.equal((await db.query("select count(*)::int n from information_schema.columns where table_schema='pos_open_orders_private' and table_name='orders' and column_name='closure_receipt_id'")).rows[0].n, 0);
    await db.exec(migration);
    for (const role of ['anon','authenticated','service_role']) {
      await db.exec('set role '+role);
      try { await assert.rejects(db.query('select pos_open_orders_private.commit_snapshot_v1($1,$2,$3,$4)', [randomUUID(),randomUUID(),{},[]]), /permission denied/); }
      finally { await db.exec('reset role'); }
    }
    await commit(db, [order()]);
  } finally { await db.close(); }
});

test('reissued/next-business-day paid receipt is accepted, and forged payload provider facts are ignored', async () => {
  const db = await database();
  try {
    await commit(db, [order()]);
    await receipt(db, 17, 4, true);
    const nextDate = new Date(Date.parse(date+'T00:00:00Z') + 86400000).toISOString().slice(0,10);
    await receipt(db, 18, 3, false, nextDate);
    await commit(db, [{ ...order(4), totalAmount: 0, lines: [], closureReceiptId: 18 }]);
    const after = await read(db);
    assert.equal(after.recoveryContractVersion, 2);
    assert.deepEqual([after.orders[0].status, Number(after.orders[0].totalAmount), after.orders[0].lines.length], [3,2410000,1]);
    assert.equal(Number(after.orders[0].closureReceiptId), 18);
  } finally { await db.close(); }
});

test('failure after snapshot deletion/insertion rolls back preserved rows, proof columns, audit and success state together', async () => {
  const db = await database();
  try {
    await commit(db, [order()]);
    const before = await read(db);
    const priorRuns = (await db.query("select id,manifest from pos_open_orders_private.runs where status='committed'")).rows;
    await receipt(db);
    const malformed = { ...order(), orderId: 'order-other', lines: [order().lines[0], order().lines[0]] };
    await assert.rejects(commit(db, [{ ...order(), closureReceiptId: 18 }, malformed]), /duplicate key/);
    const after = await read(db);
    assert.deepEqual(after.orders, before.orders);
    assert.equal(after.sync.lastSuccessAt, before.sync.lastSuccessAt);
    assert.deepEqual((await db.query("select id,manifest from pos_open_orders_private.runs where status='committed'")).rows, priorRuns);
    assert.equal((await db.query('select count(*)::int n from public.pos_sales_receipts')).rows[0].n, 1);
  } finally { await db.close(); }
});

test('new wrapper retains lease fencing, ownership and committed-run replay without new evidence writes', async () => {
  const db = await database();
  try {
    await commit(db, [order()]);
    await receipt(db);
    const p_run_id = randomUUID(), p_owner_token = randomUUID();
    await rpc(db, 'pos_open_orders_claim', { p_run_id, p_owner_token, p_scope: scope, p_branch_id: input.branchId, p_business_date: date });
    const args = { p_run_id, p_owner_token, p_manifest: {}, p_orders: [{ ...order(), closureReceiptId: 18 }] };
    await assert.rejects(rpc(db, 'pos_open_orders_commit', { ...args, p_owner_token: randomUUID() }), /open_orders_run_conflict/);
    await rpc(db, 'pos_open_orders_commit', args);
    const closed = await read(db);
    assert.equal((await rpc(db, 'pos_open_orders_commit', args)).replay, true);
    assert.deepEqual(await read(db), closed);
    const next = { p_run_id: randomUUID(), p_owner_token: randomUUID(), p_scope: scope, p_branch_id: input.branchId, p_business_date: date };
    await rpc(db, 'pos_open_orders_claim', next);
    await db.query("update pos_open_orders_private.runs set lease_until=clock_timestamp()-interval '1 second' where id=$1", [next.p_run_id]);
    await assert.rejects(rpc(db, 'pos_open_orders_commit', { ...args, p_run_id: next.p_run_id, p_owner_token: next.p_owner_token }), /open_orders_lease_lost/);
    assert.deepEqual((await read(db)).orders, closed.orders);
  } finally { await db.close(); }
});
