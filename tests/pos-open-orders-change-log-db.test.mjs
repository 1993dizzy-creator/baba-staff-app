// P1 diagnostics: the order change log rides in the existing runs.manifest. Real migration chain
// on PGlite (no new migration) and the real collector. Synthetic ids only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import * as core from '../lib/pos/cukcuk/open-orders-core.ts';
import { ORDER_CHANGES_MANIFEST_KEY } from '../lib/pos/cukcuk/open-orders-change-log.ts';
import { calculateStoreBusinessDate } from '../lib/store-settings/business-time-core.ts';
import { buildTableOverview } from '../lib/sales/table-overview.ts';
import { babaTableCatalog } from '../lib/sales/baba-table-catalog.ts';
import { PREREQUISITES } from './helpers/pos-open-orders-native-fixture.mjs';

const dir = 'supabase/' + 'migrations/';
const sql = name => readFileSync(dir + name, 'utf8');
const CHAIN = ['20261109210000_pos_open_orders_v1.sql', '20261110170329_pos_open_orders_vanished_receipt_evidence.sql',
  '20261114161500_pos_open_orders_merged_receipt_evidence.sql', '20261119080000_pos_open_orders_vanished_quarantine.sql',
  '20261119144531_pos_open_orders_last_verified_table.sql'].map(sql);

const date = calculateStoreBusinessDate(new Date().toISOString(), '03:00');
const branchId = 'branch-fixture';
const scope = `${'a'.repeat(64)}:${branchId}`;
const input = { scope, branchId, businessDate: date, windowFrom: new Date(`${date}T03:00:00+07:00`).toISOString(), cutoff: '03:00' };
const startMs = Math.max(Date.parse(input.windowFrom) + 60_000, Date.now() - 3600_000);
const at = seconds => new Date(startMs + seconds * 1000).toISOString();

async function database() {
  const db = new PGlite();
  await db.exec(PREREQUISITES);
  for (const m of CHAIN) await db.exec(m);
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
const manifests = async db => (await db.query(`select status, manifest from pos_open_orders_private.runs order by started_at, id`)).rows;

// POS rows: { id, table, status, start }. Status 4 rows are listed without a TableName.
function transport(rows) {
  const header = r => ({ Id: r.id, No: r.id.toUpperCase(), Date: at(r.start), Status: r.status ?? 1, TotalAmount: 100000,
    TableName: (r.status ?? 1) === 4 ? null : r.table });
  return { login: async () => {}, sleep: async () => {}, send: async request => {
    if (rows instanceof Error) throw rows;
    if (request.kind === 'page') return { status: 200, json: { Success: true, Total: rows.length, Data: rows.map(header) } };
    const r = rows.find(x => x.id === request.orderId);
    return { status: 200, json: { Success: true, Data: { ...header(r), CustomerName: 'secret', CustomerTel: '+84-912-345',
      OrderDetails: [{ Id: `${r.id}-l1`, ItemId: 'item-1', ItemName: 'Synthetic', Quantity: 1, Price: 100000, Amount: 100000, Status: 2 }] } } };
  } };
}
// stripLog: the same collector, but the change-log key is removed before commit (the "before" behaviour).
const runSync = (db, rows, stripLog = false) => core.runOpenOrderSync({ uuid: randomUUID,
  rpc: (n, a) => {
    if (stripLog && n === 'pos_open_orders_commit') { const { [ORDER_CHANGES_MANIFEST_KEY]: _x, ...rest } = a.p_manifest; a = { ...a, p_manifest: rest }; }
    return rpc(db, n, a);
  }, transport: transport(rows), loadReceiptEvidence: async () => [], loadMergeReceiptEvidence: async () => [] }, input);

const SCENARIO = [
  [{ id: 'm', table: '11', start: 1 }, { id: 'k', table: '7', start: 2 }],
  [{ id: 'm', table: '11', start: 1 }, { id: 'k', table: '7', start: 2 }],
  [{ id: 'm', table: '14', start: 1 }, { id: 'k', table: '7', start: 2 }],
  [{ id: 'm', table: '14', start: 1, status: 4 }, { id: 'k', table: '7', start: 2 }],
  [{ id: 'm', table: '14', start: 1, status: 4 }, { id: 'k', table: '7', start: 2 }],
];

test('runs.manifest stores the change log only for real changes, beside every existing key', async () => {
  const db = await database();
  try {
    for (const rows of SCENARIO) assert.equal((await runSync(db, rows)).status, 'committed');
    const runs = await manifests(db);
    const logs = runs.map(r => r.manifest[ORDER_CHANGES_MANIFEST_KEY] ?? null);
    assert.deepEqual(logs.map(l => l && l.events.map(e => e.kind)), [null, null, ['table_name_changed'], ['payment_candidate'], null]);
    assert.deepEqual({ ...logs[2].events[0], fromObservedAt: typeof logs[2].events[0].fromObservedAt },
      { kind: 'table_name_changed', orderId: 'm', fromTable: '11', toTable: '14', fromObservedAt: 'string' });
    assert.deepEqual(logs[3].events[0], { kind: 'payment_candidate', orderId: 'm', fromStatus: 1, toStatus: 4, lastTable: '14' });
    // Existing keys (collector + DB audit) are all still there with their values.
    const keys = ['businessDate', 'mode', 'lastSyncDate', 'total', 'pages', 'enumeratedCount', 'selectedCount', 'previousUnfinishedCount',
      'vanishedConfirmedCount', 'detailCount', 'relogins', 'quarantinedCount', 'storedOrders', 'storedLines', 'receiptClosures',
      'retainedCancellations'];
    for (const r of runs) {
      assert.deepEqual(Object.keys(r.manifest).filter(k => k !== ORDER_CHANGES_MANIFEST_KEY).sort(), [...keys].sort());
      assert.deepEqual([r.manifest.total, r.manifest.storedOrders, r.manifest.receiptClosures, r.manifest.quarantinedCount], [2, 2, [], 0]);
    }
    assert.doesNotMatch(JSON.stringify(runs), /secret|912-345|Customer/);
    // A failed run records its code only; no change history is written for it.
    assert.equal((await runSync(db, new Error('network'))).status, 'failed');
    const failed = (await manifests(db)).at(-1);
    assert.deepEqual([failed.status, failed.manifest], ['failed', null]);
  } finally { await db.close(); }
});

test('snapshot and table board are identical with and without the change log', async () => {
  const withLog = await database(), without = await database();
  try {
    for (const rows of SCENARIO.slice(0, 4)) {
      assert.equal((await runSync(withLog, rows)).status, 'committed');
      assert.equal((await runSync(without, rows, true)).status, 'committed');
      const [a, b] = [await read(withLog), await read(without)];
      const facts = s => s.orders.map(({ providerObservedAt, lastTableObservedAt, closureConfirmedAt, ...o }) => o);
      assert.deepEqual(facts(a), facts(b));
      const board = s => buildTableOverview({ businessDate: date, now: new Date(), enabled: true, catalog: babaTableCatalog(), cutoff: '03:00',
        sync: { ...s.sync, lastSuccessAt: new Date().toISOString(), lastAttemptAt: new Date().toISOString() }, orders: s.orders, receipts: [] })
        .tables.map(t => [t.name, t.state, Boolean(t.paymentPending)]);
      assert.deepEqual(board(a), board(b));
    }
    assert.ok((await manifests(withLog)).some(r => r.manifest[ORDER_CHANGES_MANIFEST_KEY]));
    assert.ok((await manifests(without)).every(r => !r.manifest[ORDER_CHANGES_MANIFEST_KEY]));
  } finally { await withLog.close(); await without.close(); }
});

test('runs stay unreadable to app roles and keep RLS (no migration)', async () => {
  const db = await database();
  try {
    await runSync(db, SCENARIO[0]);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await db.exec('set role ' + role);
      await assert.rejects(db.query('select manifest from pos_open_orders_private.runs'), /permission denied/);
      await db.exec('reset role');
    }
    assert.equal((await db.query(`select relrowsecurity from pg_class where oid = 'pos_open_orders_private.runs'::regclass`)).rows[0].relrowsecurity, true);
  } finally { await db.close(); }
});
