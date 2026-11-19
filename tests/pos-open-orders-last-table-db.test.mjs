// 2026-11-19 P0: the DB keeps the table the provider last listed for a Status 4 order whose
// TableName the POS dropped, across snapshot replacements. Real migration chain on PGlite
// (v1 -> receipt -> merge -> v4 quarantine -> last table) and the real collector. Synthetic ids.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import * as core from '../lib/pos/cukcuk/open-orders-core.ts';
import { calculateStoreBusinessDate } from '../lib/store-settings/business-time-core.ts';
import { buildTableOverview } from '../lib/sales/table-overview.ts';
import { babaTableCatalog } from '../lib/sales/baba-table-catalog.ts';
import { PREREQUISITES } from './helpers/pos-open-orders-native-fixture.mjs';
import { installCleaningFixture, context, confirm, scope as cleaningScope, tableId } from './helpers/tables-cleaning-fixture.mjs';
import { AUTO_NORMAL, enableAuto, autoContext, observe } from './helpers/tables-auto-normal-fixture.mjs';

const dir = 'supabase/' + 'migrations/';
const sql = name => readFileSync(dir + name, 'utf8');
const base = sql('20261109210000_pos_open_orders_v1.sql');
const PRODUCTION = [sql('20261110170329_pos_open_orders_vanished_receipt_evidence.sql'),
  sql('20261114161500_pos_open_orders_merged_receipt_evidence.sql'), sql('20261119080000_pos_open_orders_vanished_quarantine.sql')];
const SUCCESSOR = sql('20261119123459_tables_quarantine_successor_evidence.sql');
const LAST = sql('20261119144531_pos_open_orders_last_verified_table.sql');

const date = calculateStoreBusinessDate(new Date().toISOString(), '03:00');
const branchId = 'branch-fixture';
const scope = `${'a'.repeat(64)}:${branchId}`;
const input = { scope, branchId, businessDate: date, windowFrom: new Date(`${date}T03:00:00+07:00`).toISOString(), cutoff: '03:00' };
const startMs = Math.max(Date.parse(input.windowFrom) + 60_000, Date.now() - 3600_000);
const at = seconds => new Date(startMs + seconds * 1000).toISOString();
const line = id => ({ detailId: `${id}-l1`, parentDetailId: null, additionId: null, itemId: 'item-1', itemName: 'Synthetic menu', unitName: null,
  quantity: 1, price: 100000, amount: 100000, lineStatus: 2, isOption: false, isOrphanOption: false, isCanceled: false });
const row = (orderId, tableName, start, extra = {}) => ({ orderId, orderNo: orderId.toUpperCase(), status: 1, statusClass: 'open',
  orderDate: at(start), businessDate: date, tableName, totalAmount: 100000, lines: [line(orderId)], ...extra });
const paid = (orderId, start, extra = {}) => row(orderId, null, start, { status: 4, statusClass: 'paid_candidate', lines: null, ...extra });

async function database(migrations = [...PRODUCTION, LAST]) {
  const db = new PGlite();
  await db.exec(PREREQUISITES);
  await db.exec(base);
  for (const m of migrations) await db.exec(m);
  return db;
}
async function rpc(db, name, args) {
  const names = { pos_open_orders_claim: ['p_run_id','p_owner_token','p_scope','p_branch_id','p_business_date'],
    pos_open_orders_commit: ['p_run_id','p_owner_token','p_manifest','p_orders'], pos_open_orders_read: ['p_scope','p_business_date'],
    pos_open_orders_fail: ['p_run_id','p_owner_token','p_code'] }[name];
  const values = names.map(key => typeof args[key] === 'object' ? JSON.stringify(args[key]) : args[key]);
  if (name === 'pos_open_orders_claim') values.push(0);
  await db.exec('set role service_role');
  try { return (await db.query(`select public.${name}(${values.map((_, i) => '$' + (i + 1)).join(',')}) as result`, values)).rows[0].result; }
  catch (error) { throw new Error(core.openOrdersRpcErrorCode(error)); }
  finally { await db.exec('reset role'); }
}
const read = db => rpc(db, 'pos_open_orders_read', { p_scope: scope, p_business_date: date });
async function claimed(db) {
  const p_run_id = randomUUID(), p_owner_token = randomUUID();
  await rpc(db, 'pos_open_orders_claim', { p_run_id, p_owner_token, p_scope: scope, p_branch_id: branchId, p_business_date: date });
  return { p_run_id, p_owner_token };
}
const commitWith = async (db, run, rows) => rpc(db, 'pos_open_orders_commit', { ...run, p_manifest: {}, p_orders: rows });
const commit = async (db, rows) => commitWith(db, await claimed(db), rows);
const byId = (snapshot, id) => snapshot.orders.find(o => o.orderId === id);
const lastOf = async (db, id) => { const o = byId(await read(db), id); return [o.tableName, o.lastTableName, o.lastTableObservedAt]; };

test('Status 4 keeps the last provider-listed table and its observation time across snapshots', async () => {
  const db = await database();
  try {
    await commit(db, [row('t11', '11', 1), row('t7', '7', 2)]);
    assert.deepEqual((await lastOf(db, 't11')).slice(1), [null, null]);
    const listedAt = byId(await read(db), 't11').providerObservedAt;
    await commit(db, [paid('t11', 1), row('t7', '7', 2)]);
    assert.deepEqual(await lastOf(db, 't11'), [null, '11', listedAt]);
    // Carried while still Status 4 without a name; the current TableName stays null.
    await commit(db, [paid('t11', 1), row('t7', '7', 2)]);
    assert.deepEqual(await lastOf(db, 't11'), [null, '11', listedAt]);
    assert.deepEqual((await lastOf(db, 't7')).slice(1), [null, null]);
  } finally { await db.close(); }
});

test('move, reopen, reused id and named Status 4 never carry a stale location', async () => {
  const db = await database();
  try {
    await commit(db, [row('m', '11', 1), row('r', '5', 2), row('n', '6', 3)]);
    await commit(db, [row('m', '12', 1), row('r', '5', 2), row('n', '6', 3)]);
    const movedAt = byId(await read(db), 'm').providerObservedAt;
    // m moved to 12 then paid; r is a different order reusing the id (new order_date); n keeps its name.
    await commit(db, [paid('m', 1), paid('r', 30), paid('n', 3, { tableName: '6' })]);
    assert.deepEqual(await lastOf(db, 'm'), [null, '12', movedAt]);
    assert.deepEqual(await lastOf(db, 'r'), [null, null, null]);
    assert.deepEqual(await lastOf(db, 'n'), ['6', null, null]);
    // Reopened and listed again: the evidence is cleared and current TableName rules.
    await commit(db, [row('m', '12', 1)]);
    assert.deepEqual(await lastOf(db, 'm'), ['12', null, null]);
  } finally { await db.close(); }
});

test('replay of the same run is idempotent; anon/authenticated cannot call the private functions', async () => {
  const db = await database();
  try {
    await commit(db, [row('t11', '11', 1)]);
    const run = await claimed(db);
    const first = await commitWith(db, run, [paid('t11', 1)]);
    const before = await read(db);
    assert.equal(first.status, 'committed');
    assert.deepEqual(await commitWith(db, run, [paid('t11', 1)]), { runId: first.runId, replay: true, status: 'committed' });
    assert.deepEqual(await read(db), before);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await db.exec('set role ' + role);
      await assert.rejects(db.query(`select pos_open_orders_private.commit_quarantine_v1(null,null,null,null)`), /permission denied/);
      if (role !== 'service_role') await assert.rejects(db.query(`select pos_open_orders_private.commit_v1(null,null,null,null)`), /permission denied/);
      await db.exec('reset role');
    }
  } finally { await db.close(); }
});

test('only read_v1 and commit_v1 change; commit_quarantine_v1 is the previous commit byte-for-byte', async () => {
  const db = await database(PRODUCTION);
  try {
    const fns = `select p.oid::regprocedure::text f, pg_get_functiondef(p.oid) d, p.prosecdef, p.provolatile, p.proacl::text acl from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'pos_open_orders_private') order by 1`;
    const before = (await db.query(fns)).rows;
    await db.exec(LAST);
    const after = (await db.query(fns)).rows;
    const added = after.filter(r => !before.some(b => b.f === r.f)).map(r => r.f);
    assert.deepEqual(added, ['pos_open_orders_private.commit_quarantine_v1(uuid,uuid,jsonb,jsonb)']);
    const changed = after.filter(r => before.some(b => b.f === r.f && b.d !== r.d)).map(r => r.f);
    assert.deepEqual(changed, ['pos_open_orders_private.commit_v1(uuid,uuid,jsonb,jsonb)', 'pos_open_orders_private.read_v1(text,date)']);
    const old = before.find(r => r.f === 'pos_open_orders_private.commit_v1(uuid,uuid,jsonb,jsonb)');
    const renamed = after.find(r => r.f === added[0]);
    assert.equal(renamed.d.replace('commit_quarantine_v1', 'commit_v1'), old.d);
    for (const f of ['pos_open_orders_private.commit_v1(uuid,uuid,jsonb,jsonb)', 'pos_open_orders_private.read_v1(text,date)']) {
      const a = after.find(r => r.f === f), b = before.find(r => r.f === f);
      assert.deepEqual([a.prosecdef, a.provolatile, a.acl], [b.prosecdef, b.provolatile, b.acl], f);
    }
    assert.equal((await read(db)).recoveryContractVersion, 4);
  } finally { await db.close(); }
});

// Real collector: the POS lists 11 open, then Status 4 without TableName; no receipt yet.
function transport(listed, paidRows) {
  const header = (o, extra = {}) => ({ Id: o.orderId, No: o.orderNo, Date: o.orderDate, Status: o.status, TotalAmount: o.totalAmount, TableName: o.tableName, ...extra });
  const all = [...listed, ...paidRows];
  return { login: async () => {}, sleep: async () => {}, send: async request => {
    if (request.kind === 'page') return { status: 200, json: { Success: true, Total: all.length,
      Data: [...listed.map(o => header(o)), ...paidRows.map(o => header(o, { Status: 4, TableName: null }))] } };
    const o = all.find(x => x.orderId === request.orderId);
    const paidRow = paidRows.includes(o);
    return { status: 200, json: { Success: true, Data: { ...header(o, paidRow ? { Status: 4, TableName: null } : {}),
      OrderDetails: o.lines.map(l => ({ Id: l.detailId, ItemId: l.itemId, ItemName: l.itemName, Quantity: l.quantity, Price: l.price, Amount: l.amount, Status: 2 })) } } };
  } };
}
const runSync = (db, t) => core.runOpenOrderSync({ rpc: (n, a) => rpc(db, n, a), transport: t, uuid: randomUUID,
  loadReceiptEvidence: async () => [], loadMergeReceiptEvidence: async () => [] }, input);
const overviewOf = snapshot => buildTableOverview({ businessDate: date, now: new Date(), enabled: true, catalog: babaTableCatalog(), cutoff: '03:00',
  sync: snapshot.sync, orders: snapshot.orders, receipts: [] });

test('collector end to end: only table 11 is confirming payment; without the migration the old store-wide rule stays', async () => {
  const t11 = row('t11', '11', 1), t7 = row('t7', '7', 2);
  for (const [migrations, expected] of [[[...PRODUCTION, LAST], 'located'], [PRODUCTION, 'store-wide']]) {
    const db = await database(migrations);
    try {
      assert.equal((await runSync(db, transport([t11, t7], []))).status, 'committed');
      assert.equal((await runSync(db, transport([t7], [t11]))).status, 'committed');
      const snapshot = await read(db);
      assert.equal(byId(snapshot, 't11').tableName, null);
      const view = overviewOf(snapshot);
      const state = name => view.tables.find(t => t.name === name).state;
      assert.equal(state('7'), 'occupied', expected);
      assert.equal(state('11'), 'unknown', expected);
      if (expected === 'located') {
        assert.equal(view.tables.find(t => t.name === '11').paymentPending, true);
        assert.equal(state('12'), 'idle');
        assert.equal(view.unlinked.length, 0);
      } else {
        assert.equal(byId(snapshot, 't11').lastTableName, undefined);
        assert.equal(state('12'), 'unknown');
      }
    } finally { await db.close(); }
  }
});

test('cleaning and auto-normal: keys, events and observations are unchanged by the migration and by the update', async () => {
  const db = new PGlite();
  const day = await installCleaningFixture(db, { afterCleaning: async d => { await d.exec(AUTO_NORMAL); await d.exec(PRODUCTION[2]); await d.exec(SUCCESSOR); } });
  try {
    await db.exec('update table_operations_private.config set enabled=true');
    await db.query(`insert into pos_open_orders_private.orders(scope,business_date,order_id,order_no,status,status_class,order_date,total_amount,table_name,has_lines,run_id,observed_at)
      values($1,$2,'paid-order','1',4,'paid_candidate',clock_timestamp()-interval '20 minutes',100000,null,false,'00000000-0000-4000-8000-000000000001',clock_timestamp())`, [cleaningScope, day]);
    const activation = await enableAuto(db);
    const ctx = await context(db, day);
    await db.exec('set role service_role'); assert.equal((await confirm(db, day, ctx)).saved, true); await db.exec('reset role');
    await observe(db, day, activation);
    const manual = await context(db, day), auto = await autoContext(db, day, activation);
    const counts = async () => (await db.query(`select (select count(*) from table_operations_private.invalidations)::int i,
      (select count(*) from table_operations_private.auto_invalidations)::int a`)).rows[0];
    const invalidations = await counts();
    await db.exec(LAST);
    await db.query(`update pos_open_orders_private.orders set last_table_name='BAR4', last_table_observed_at=clock_timestamp()-interval '10 minutes'
      where order_id='paid-order'`);
    assert.deepEqual(await counts(), invalidations);
    const after = await context(db, day), autoAfter = await autoContext(db, day, activation);
    assert.deepEqual(after.keys, manual.keys);
    assert.deepEqual(after.cleanedTableIds, manual.cleanedTableIds);
    assert.ok(after.cleanedTableIds.includes(tableId));
    assert.deepEqual(autoAfter.keys, auto.keys);
    assert.deepEqual(autoAfter.observations, auto.observations);
  } finally { await db.close(); }
});
