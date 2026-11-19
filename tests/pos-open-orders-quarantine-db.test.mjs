// 2026-11-18 incident (de-identified): table 14 was merged in POS into BAR1 between two runs.
// Its detail then answered with the empty GUID, and the later receipt (TableName "BAR1, 14")
// carried an option line, a custom item and 560,000 less food than the two orders, so no
// merge proof was possible and every run failed until the business day ended (62 times).
// Real migrations + public RPC wrappers on in-memory PostgreSQL (PGlite). Synthetic ids;
// amounts and line shapes mirror the incident. No customer data.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import * as core from '../lib/pos/cukcuk/open-orders-core.ts';
import { mapOpenOrdersSyncResult } from '../lib/pos/cukcuk/open-orders-cron-policy.ts';
import { calculateStoreBusinessDate, addStoreDays } from '../lib/store-settings/business-time-core.ts';
import { buildTableOverview } from '../lib/sales/table-overview.ts';
import { babaTableCatalog } from '../lib/sales/baba-table-catalog.ts';
import { PREREQUISITES } from './helpers/pos-open-orders-native-fixture.mjs';

const dir = 'supabase/' + 'migrations/';
const base = readFileSync(dir + '20261109210000_pos_open_orders_v1.sql', 'utf8');
const receiptEvidence = readFileSync(dir + '20261110170329_pos_open_orders_vanished_receipt_evidence.sql', 'utf8');
const merged = readFileSync(dir + '20261114161500_pos_open_orders_merged_receipt_evidence.sql', 'utf8');
const quarantine = readFileSync(dir + '20261119080000_pos_open_orders_vanished_quarantine.sql', 'utf8');
const PRODUCTION = [receiptEvidence, merged];
const UPGRADED = [receiptEvidence, merged, quarantine];
const history = new Map([[receiptEvidence, ['20261110170329', 'pos_open_orders_vanished_receipt_evidence']],
  [merged, ['20261114161500', 'pos_open_orders_merged_receipt_evidence']],
  [quarantine, ['20261119080000', 'pos_open_orders_vanished_quarantine']]]);

const date = calculateStoreBusinessDate(new Date().toISOString(), '03:00');
const branchId = 'branch-fixture';
const scope = `${'a'.repeat(64)}:${branchId}`;
const inputFor = businessDate => ({ scope, branchId, businessDate, windowFrom: new Date(`${businessDate}T03:00:00+07:00`).toISOString(), cutoff: '03:00' });
const input = inputFor(date);
const startMs = Math.max(Date.parse(input.windowFrom) + 60_000, Date.now() - 3600_000);
const at = seconds => new Date(startMs + seconds * 1000).toISOString();
const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';

const line = (order, n, item, quantity, price, extra = {}) => ({ detailId: `${order}-l${n}`, parentDetailId: null, additionId: null,
  itemId: item, itemName: `Menu ${item ?? 'custom'}`, unitName: null, quantity, price, amount: quantity * price, lineStatus: 2,
  isOption: false, isOrphanOption: false, isCanceled: false, ...extra });
const snapshotOrder = (orderId, tableName, start, lines, extra = {}) => ({ orderId, orderNo: orderId.toUpperCase(), status: 1,
  statusClass: 'open', orderDate: at(start), businessDate: date, tableName, lines,
  totalAmount: lines.filter(l => !l.isCanceled).reduce((s, l) => s + l.amount, 0), ...extra });

// 21:42 snapshot. Table 14 has an option line and a custom (no ItemID) whisky like production.
const bar1 = snapshotOrder('order-bar1', 'BAR1', 1, [line('bar1', 1, 'item-food-d4', 1, 200000), line('bar1', 2, 'item-s3', 1, 250000)]);
const t14 = snapshotOrder('order-14', '14', 2, [line('t14', 1, 'item-food-b2', 1, 200000), line('t14', 2, 'item-food-e5', 1, 160000),
  line('t14', 3, 'item-s1', 1, 240000), line('t14', 4, 'item-s3', 1, 250000), line('t14', 5, 'item-t3', 1, 0),
  line('t14', 6, null, 1, 3500000), line('t14', 7, null, 1, 170000, { parentDetailId: 't14-l6', additionId: 'addition-jd', isOption: true })]);
const t7 = snapshotOrder('order-7', '7', 3, [line('t7', 1, 'item-food-d3', 1, 160000), line('t7', 2, 'item-m1', 2, 300000)]);
const t16 = snapshotOrder('order-16', '16', 4, [line('t16', 1, 'item-food-f3', 1, 730000)]);
assert.deepEqual([bar1.totalAmount, t14.totalAmount, bar1.totalAmount + t14.totalAmount], [450000, 4520000, 4970000]);

// POS after the merge (21:47): BAR1 holds everything; table 7 ordered one more item.
const bar1Merged = { ...bar1, totalAmount: 4970000, lines: [...bar1.lines, ...t14.lines.map(l => ({ ...l, detailId: 'm' + l.detailId,
  parentDetailId: l.parentDetailId && 'm' + l.parentDetailId }))] };
const t7Updated = { ...t7, totalAmount: t7.totalAmount + 90000, lines: [...t7.lines, line('t7', 3, 'item-o2', 3, 30000)] };
// Receipt #8964 (22:02): food removed before payment; S3 consolidated; option and custom item lines.
const receipt8964 = [
  { RefDetailType: 1, ItemID: 'item-s3', Quantity: 2, UnitPrice: 250000, Amount: 500000 },
  { RefDetailType: 1, ItemID: 'item-t3', Quantity: 1, UnitPrice: 0, Amount: 0 },
  { RefDetailType: 2, ItemID: null, ParentID: 'r-l4', InventoryItemAdditionID: 'addition-jd', Quantity: 1, UnitPrice: 170000, Amount: 170000 },
  { RefDetailType: 3, ItemID: null, Quantity: 1, UnitPrice: 3500000, Amount: 3500000 },
  { RefDetailType: 1, ItemID: 'item-s1', Quantity: 1, UnitPrice: 240000, Amount: 240000 },
].map(d => ({ PromotionAmount: 0, PromotionRate: 0, DiscountRate: 0, SAInvoicePromotionAmount: 0, ...d }));
assert.equal(receipt8964.reduce((s, d) => s + d.Amount, 0), 4410000);

async function database(migrations = UPGRADED) {
  const db = new PGlite();
  await db.exec(PREREQUISITES);
  await db.exec(base);
  await db.query("insert into supabase_migrations.schema_migrations(version, name) values ('20261109210000', 'pos_open_orders_v1')");
  for (const sql of migrations) {
    await db.exec(sql);
    await db.query('insert into supabase_migrations.schema_migrations(version, name) values ($1, $2)', history.get(sql));
  }
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
const read = (db, day = date) => rpc(db, 'pos_open_orders_read', { p_scope: scope, p_business_date: day });
async function claimed(db, day = date) {
  const p_run_id = randomUUID(), p_owner_token = randomUUID();
  await rpc(db, 'pos_open_orders_claim', { p_run_id, p_owner_token, p_scope: scope, p_branch_id: branchId, p_business_date: day });
  return { p_run_id, p_owner_token };
}
const commit = async (db, rows, manifest = {}) => rpc(db, 'pos_open_orders_commit', { ...(await claimed(db)), p_manifest: manifest, p_orders: rows });
async function receipt(db, { id = 8964, orderId = 'order-bar1', status = 3, details = receipt8964, day = date } = {}) {
  await db.query('insert into public.pos_sales_receipts values($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, 'cukcuk', branchId, day, status, false,
    details.reduce((s, d) => s + d.Amount, 0), 0, JSON.stringify({ OrderId: orderId, TableName: 'BAR1, 14', CustomerName: 'never-read',
      DiscountAmount: 0, PromotionAmount: 0, PromotionItemsAmount: 0, SAInvoiceDetails: details })]);
}
async function links(db) {
  return (await db.query(`select id, business_date::text bd, payment_status, is_canceled, raw_json->>'OrderId' oid, raw_json->>'TableName' tn
    from public.pos_sales_receipts where source='cukcuk' and business_date in ($1::date, $1::date + 1) order by id`, [date])).rows
    .map(r => ({ orderId: r.oid ?? '', receiptId: Number(r.id), paymentStatus: r.payment_status, isCanceled: r.is_canceled, businessDate: r.bd, tableName: r.tn }));
}
async function mergeEvidence(db) {
  return (await db.query(`select id, branch_id, business_date::text bd, payment_status, is_canceled, total_amount, discount_amount,
    raw_json->>'OrderId' oid, raw_json->'DiscountAmount' d1, raw_json->'PromotionAmount' d2, raw_json->'PromotionItemsAmount' d3,
    raw_json->'SAInvoiceDetails' details from public.pos_sales_receipts where source='cukcuk' and business_date in ($1::date, $1::date + 1) order by id`, [date])).rows
    .map(r => ({ orderId: r.oid ?? '', receiptId: Number(r.id), paymentStatus: r.payment_status, isCanceled: r.is_canceled, businessDate: r.bd,
      branchId: r.branch_id, totalAmount: Number(r.total_amount), discountAmount: Number(r.discount_amount), headerDiscounts: [r.d1, r.d2, r.d3], details: r.details }));
}

const header = (o, extra = {}) => ({ Id: o.orderId, No: o.orderNo, Date: o.orderDate, Status: o.status, TotalAmount: o.totalAmount, TableName: o.tableName, ...extra });
const detailLines = o => o.lines.map(l => ({ Id: l.detailId, ItemId: l.itemId, ParentId: l.parentDetailId, AdditionId: l.additionId,
  ItemName: l.itemName, Quantity: l.quantity, Price: l.price, Amount: l.amount, Status: l.lineStatus }));
const vanishedEmptyGuid = { Success: true, Data: { Id: EMPTY_GUID, Date: '0001-01-01T00:00:00', Status: 0, TotalAmount: 0, OrderDetails: [] } };
/** listed: orders the POS still lists (status/table may be overridden); every other id answers `vanished`. */
function transport({ listed = [bar1Merged, t7Updated, t16], paid = [], vanished = vanishedEmptyGuid, page } = {}) {
  const calls = [];
  const all = [...listed, ...paid];
  return { calls, login: async () => {}, sleep: async () => {}, send: async request => {
    calls.push(request.kind === 'page' ? 'page' : `detail:${request.orderId}`);
    if (request.kind === 'page') return page ? page(all) : { status: 200, json: { Success: true, Total: all.length,
      Data: [...listed.map(o => header(o)), ...paid.map(o => header(o, { Status: 4, TableName: null }))] } };
    const known = listed.find(o => o.orderId === request.orderId);
    if (!known) return typeof vanished === 'function' ? vanished(request) : { status: 200, json: vanished };
    return { status: 200, json: { Success: true, Data: { ...header(known), OrderDetails: detailLines(known) } } };
  } };
}
const run = (db, t = transport(), extra = {}, runInput = input) => core.runOpenOrderSync({ rpc: (n, a) => rpc(db, n, a), transport: t, uuid: randomUUID,
  loadReceiptEvidence: () => links(db), loadMergeReceiptEvidence: () => mergeEvidence(db), ...extra }, runInput);
async function seeded(migrations = UPGRADED, rows = [bar1, t14, t7, t16]) {
  const db = await database(migrations);
  await commit(db, rows);
  return db;
}
const byId = (snapshot, id) => snapshot.orders.find(o => o.orderId === id);
const without = (order, ...keys) => Object.fromEntries(Object.entries(order).filter(([key]) => !keys.includes(key)));
// Every claim records lastAttemptAt; everything else must be unchanged by a rejected commit.
const stable = snapshot => ({ ...snapshot, sync: without(snapshot.sync, 'lastAttemptAt') });
const overviewOf = async (db, receipts = []) => {
  const snapshot = await read(db);
  return buildTableOverview({ businessDate: date, now: new Date(Date.now() + 1000), enabled: true, catalog: babaTableCatalog(),
    sync: snapshot.sync, orders: snapshot.orders.map(o => ({ ...o, totalAmount: Number(o.totalAmount), raw: {} })), receipts, cutoff: '03:00' });
};
const stateOf = (overview, name) => overview.tables.find(t => t.name === name).state;

test('RED (production DB, contract 3): the 11/18 merge still fails every run and keeps the 21:42 snapshot', async () => {
  const db = await seeded(PRODUCTION);
  try {
    const before = await read(db);
    const diagnostics = [];
    const result = await run(db, transport(), { onDiagnostic: d => diagnostics.push(d) });
    assert.deepEqual(result, { status: 'failed', code: 'orders_vanished_unconfirmed' });
    // Exactly the production log line.
    assert.deepEqual(diagnostics, [{ code: 'orders_vanished_unconfirmed', stage: 'vanished_detail', reason: 'order_id_invalid',
      causeCode: 'orders_invalid_row', vanishedCount: 1, confirmedCount: 0 }]);
    assert.deepEqual((await read(db)).orders, before.orders);
    assert.equal((await read(db)).recoveryContractVersion, 3);
  } finally { await db.close(); }
});

test('GREEN 21:47 (before the receipt): table 14 is quarantined with its last facts; every other order is refreshed', async () => {
  const db = await seeded();
  try {
    const before = await read(db);
    assert.equal(before.recoveryContractVersion, 4);
    const diagnostics = [];
    const t = transport();
    const result = await run(db, t, { onDiagnostic: d => diagnostics.push(d) });
    assert.equal(result.status, 'committed', JSON.stringify(result));
    assert.equal(result.quarantined, 1);
    assert.deepEqual(mapOpenOrdersSyncResult(result).body, { ok: true, outcome: 'committed', orders: 4, lines: result.lines, quarantined: 1 });
    assert.deepEqual(diagnostics, [{ code: 'orders_vanished_quarantined', stage: 'vanished_detail', reason: 'order_id_invalid',
      causeCode: 'orders_invalid_row', vanishedCount: 1, confirmedCount: 0, quarantinedCount: 1 }]);
    const after = await read(db);
    assert.equal(after.sync.lastErrorCode, null);
    assert.equal(after.sync.consecutiveFailures, 0);
    // Quarantined: same id, status, amount, menu and last provider observation time.
    const kept = byId(after, 'order-14');
    assert.deepEqual(without(kept, 'quarantinedAt', 'quarantineReason'), without(byId(before, 'order-14'), 'quarantinedAt', 'quarantineReason'));
    assert.equal(kept.quarantineReason, 'vanished_unconfirmed');
    assert.ok(Date.parse(kept.quarantinedAt) > Date.parse(kept.providerObservedAt));
    assert.equal(kept.closureReceiptId, null);
    // Other orders: latest list and detail.
    assert.equal(Number(byId(after, 'order-7').totalAmount), t7Updated.totalAmount);
    assert.equal(byId(after, 'order-7').lines.length, 3);
    assert.equal(Number(byId(after, 'order-bar1').totalAmount), 4970000);
    assert.ok(Date.parse(byId(after, 'order-7').providerObservedAt) > Date.parse(byId(before, 'order-7').providerObservedAt));
    assert.equal(after.orders.length, 4); // no duplicate, nothing dropped
    const audit = (await db.query('select manifest from pos_open_orders_private.runs where id=$1', [result.runId])).rows[0].manifest;
    assert.equal(audit.quarantinedCount, 1);
    assert.deepEqual(audit.quarantinedOrders.map(q => [q.orderId, q.reason, q.carried]), [['order-14', 'vanished_unconfirmed', false]]);

    // Sales KPI: verified open orders only; the quarantined amount is reported, not summed.
    const classified = core.classifyOrdersForBusinessDate(after.orders.map(o => ({ ...o, totalAmount: Number(o.totalAmount) })), await links(db), date);
    assert.deepEqual(classified.open.map(o => o.orderId).sort(), ['order-16', 'order-7', 'order-bar1']);
    assert.deepEqual(classified.uncertain, [{ orderId: 'order-14', orderNo: 'ORDER-14', reason: 'vanished_unconfirmed', amount: 4520000 }]);
    const kpi = core.buildOpenOrderKpi({ enabled: true, businessDate: date, isLiveBusinessDay: true, isClosed: false,
      paid: { amount: 0, receiptCount: 0 }, sync: after.sync, classified, now: new Date() });
    assert.equal(kpi.status, 'ok');
    assert.equal(kpi.complete, false);
    assert.equal(kpi.quarantinedOrderCount, 1);
    assert.equal(kpi.open.amount, 4970000 + t7Updated.totalAmount + t16.totalAmount);
    assert.equal(kpi.uncertain.amount, 4520000);

    // Tables (27): 14 unknown; BAR1/7/16 occupied from fresh orders; the rest stay idle, not all unknown.
    const overview = await overviewOf(db);
    assert.equal(overview.tables.length, 27);
    assert.equal(overview.collection.health, 'partial');
    assert.equal(overview.snapshotStatus, 'ok');
    assert.equal(stateOf(overview, '14'), 'unknown');
    for (const name of ['BAR1', '7', '16']) assert.equal(stateOf(overview, name), 'occupied', name);
    const others = overview.tables.filter(t => !['14', 'BAR1', '7', '16'].includes(t.name));
    assert.equal(others.length, 23);
    assert.ok(others.every(t => t.state === 'idle'));
    assert.equal(overview.tables.find(t => t.name === '14').orders[0].quarantined, true);
    assert.equal(overview.tables.find(t => t.name === '14').orders[0].verifiedOpen, false);
    assert.deepEqual([overview.summary.occupied, overview.summary.occupiedConfirmed, overview.summary.occupiedPartial, overview.summary.unknown], [null, 3, true, 1]);
  } finally { await db.close(); }
});

test('GREEN 22:02+ (after receipt #8964 with options/custom items/-560,000): still partial, the paid sale counts once', async () => {
  const db = await seeded();
  try {
    assert.equal((await run(db)).status, 'committed');
    const first = byId(await read(db), 'order-14');
    await receipt(db);
    // BAR1 is paid (Status 4, no table); 7 and 16 stay open.
    for (let i = 0; i < 2; i++) {
      const t = transport({ listed: [t7Updated, t16], paid: [bar1Merged] });
      const result = await run(db, t);
      assert.equal(result.status, 'committed', JSON.stringify(result));
      assert.equal(result.quarantined, 1);
      assert.deepEqual(t.calls, ['page', 'detail:order-7', 'detail:order-16', 'detail:order-14']);
    }
    const after = await read(db);
    // Same first quarantine time and preserved facts across runs; the receipt never "closes" it.
    assert.deepEqual(byId(after, 'order-14'), first);
    const audit = (await db.query("select manifest from pos_open_orders_private.runs where status='committed' order by finished_at desc limit 1")).rows[0].manifest;
    assert.deepEqual(audit.quarantinedOrders.map(q => [q.orderId, q.carried]), [['order-14', true]]);
    const receipts = await links(db);
    const classified = core.classifyOrdersForBusinessDate(after.orders.map(o => ({ ...o, totalAmount: Number(o.totalAmount) })), receipts, date);
    assert.equal(classified.converted, 1); // BAR1 -> receipt #8964, once
    assert.equal(classified.merged, 0);
    assert.deepEqual(classified.open.map(o => o.orderId).sort(), ['order-16', 'order-7']);
    assert.deepEqual(classified.uncertain.map(u => u.reason), ['vanished_unconfirmed']);
    const kpi = core.buildOpenOrderKpi({ enabled: true, businessDate: date, isLiveBusinessDay: true, isClosed: false,
      paid: { amount: 4410000, receiptCount: 1 }, sync: after.sync, classified, now: new Date() });
    // Paid 4,410,000 once + verified open only; neither 4,520,000 nor the BAR1 header is added.
    assert.equal(kpi.provisional.amount, 4410000 + t7Updated.totalAmount + t16.totalAmount);
    assert.equal((await db.query('select count(*)::int n from public.pos_sales_receipts')).rows[0].n, 1);
    const overview = await overviewOf(db, receipts.map(r => ({ ...r, paidAt: new Date().toISOString() })));
    assert.equal(overview.collection.health, 'partial');
    assert.equal(stateOf(overview, '14'), 'unknown');
    assert.equal(stateOf(overview, '7'), 'occupied');
  } finally { await db.close(); }
});

test('a quarantined order is re-checked every run and replaced by a new provider observation', async () => {
  // Reappears in the POS list: a normal fresh row, quarantine cleared.
  let db = await seeded();
  try {
    assert.equal((await run(db)).status, 'committed');
    assert.equal((await run(db, transport({ listed: [bar1, t14, t7, t16] }))).status, 'committed');
    const row = byId(await read(db), 'order-14');
    assert.deepEqual([row.quarantinedAt, row.quarantineReason], [null, null]);
  } finally { await db.close(); }
  // Not listed, but its own detail answers with its identity again (e.g. Status 5): confirmed normally.
  db = await seeded();
  try {
    assert.equal((await run(db)).quarantined, 1);
    const canceled = { status: 200, json: { Success: true, Data: { ...header(t14), Status: 5, OrderDetails: detailLines(t14) } } };
    const result = await run(db, transport({ vanished: () => canceled }));
    assert.equal(result.status, 'committed', JSON.stringify(result));
    assert.equal(result.quarantined, undefined);
    const row = byId(await read(db), 'order-14');
    assert.deepEqual([row.status, row.quarantinedAt], [5, null]);
  } finally { await db.close(); }
});

test('11/14 regression on the upgraded DB: an exact merge receipt still closes by proof, never by quarantine', async () => {
  const a = snapshotOrder('order-a', 'BAR8', 1, [line('a', 1, 'item-a', 1, 170000)]);
  const b = snapshotOrder('order-b', 'BAR9', 2, [line('b', 1, 'item-b', 2, 90000)]);
  const db = await seeded(UPGRADED, [a, b, t16]);
  try {
    await receipt(db, { id: 501, orderId: 'order-a', details: [
      { RefDetailType: 1, ItemID: 'item-a', Quantity: 1, UnitPrice: 170000, Amount: 170000 },
      { RefDetailType: 1, ItemID: 'item-b', Quantity: 2, UnitPrice: 90000, Amount: 180000 }] });
    const result = await run(db, transport({ listed: [t16], paid: [a] }));
    assert.equal(result.status, 'committed', JSON.stringify(result));
    assert.equal(result.quarantined, undefined);
    const after = await read(db);
    assert.deepEqual([byId(after, 'order-b').closureMergedIntoOrderId, byId(after, 'order-b').quarantinedAt], ['order-a', null]);
    const classified = core.classifyOrdersForBusinessDate(after.orders.map(o => ({ ...o, totalAmount: Number(o.totalAmount) })), await links(db), date);
    assert.deepEqual([classified.converted, classified.merged, classified.uncertain.length], [1, 1, 0]);
  } finally { await db.close(); }
});

const hardFailures = {
  provider_failure_detail: { t: () => transport({ vanished: { Success: false, Code: 500, ErrorType: 1 } }) },
  provider_http_failure_detail: { t: () => transport({ vanished: () => ({ status: 503, json: null }) }) },
  provider_busy_detail: { t: () => transport({ vanished: { Success: false, Code: 102, ErrorType: 102 } }) },
  wrong_identity_detail: { t: () => transport({ vanished: () => ({ status: 200, json: { Success: true, Data: { Id: 'order-zzz', Date: at(5), Status: 4, TotalAmount: 0 } } }) }) },
  numeric_id_detail: { t: () => transport({ vanished: { Success: true, Data: { Id: 18, Date: at(5), Status: 4, TotalAmount: 0 } } }) },
  other_business_date_detail: { t: () => transport({ vanished: () => ({ status: 200, json: { Success: true, Data: { Id: 'order-14', Date: '2020-01-01T20:00:00+07:00', Status: 4, TotalAmount: 0, OrderDetails: [] } } }) }) },
  incomplete_page: { t: () => transport({ page: all => ({ status: 200, json: { Success: true, Total: all.length + 1, Data: all.map(o => header(o)) } }) }) },
  invalid_list_row: { t: () => transport({ page: all => ({ status: 200, json: { Success: true, Total: all.length, Data: all.map((o, i) => i ? header(o) : { ...header(o), Id: EMPTY_GUID }) } }) }) },
  auth_failure: { t: () => transport({ page: () => ({ status: 401, json: null }) }) },
  receipt_evidence_unavailable: { t: () => transport(), extra: { loadMergeReceiptEvidence: async () => { throw new Error('receipt_evidence_unavailable'); } } },
};
for (const [name, c] of Object.entries(hardFailures)) {
  test(`upgraded DB keeps the whole-run failure for ${name}: snapshot and last success unchanged`, async () => {
    const db = await seeded();
    try {
      const before = await read(db);
      const result = await run(db, c.t(), c.extra ?? {});
      assert.equal(result.status, 'failed', name);
      const after = await read(db);
      assert.deepEqual(after.orders, before.orders, name);
      assert.equal(after.sync.lastSuccessAt, before.sync.lastSuccessAt, name);
      assert.ok(after.sync.lastErrorCode, name);
      assert.ok(after.orders.every(o => o.quarantinedAt === null), name);
    } finally { await db.close(); }
  });
}

test('more than 20 vanished orders stays a whole-run failure (collector and DB bound)', async () => {
  const many = Array.from({ length: 21 }, (_, i) => snapshotOrder(`order-v${i}`, null, 5 + i, [line(`v${i}`, 1, 'item-x', 1, 1000)]));
  const db = await seeded(UPGRADED, [t16, ...many]);
  try {
    assert.equal((await run(db, transport({ listed: [t16] }))).code, 'orders_vanished_unconfirmed');
    const args = { ...(await claimed(db)), p_manifest: { quarantinedCount: 21 },
      p_orders: [t16, ...many.map(o => ({ ...o, quarantineReason: 'vanished_unconfirmed' }))] };
    await assert.rejects(rpc(db, 'pos_open_orders_commit', args), { message: 'open_orders_vanished' });
  } finally { await db.close(); }
});

test('DB independently rejects forged partial payloads atomically and never trusts caller facts', async () => {
  const q = o => ({ ...o, quarantineReason: 'vanished_unconfirmed' });
  const cases = {
    not_in_previous: [[bar1, t14, t7, t16, q(snapshotOrder('order-new', '3', 9, [line('n', 1, 'item-x', 1, 1000)]))], { quarantinedCount: 1 }, 'open_orders_vanished'],
    previously_paid: [[bar1, t14, t7, q({ ...t16, status: 4, statusClass: 'paid_candidate' })], { quarantinedCount: 1 }, 'open_orders_vanished', true],
    with_closure: [[bar1, { ...q(t14), closureReceiptId: 8964 }, t7, t16], { quarantinedCount: 1 }, 'open_orders_payload_invalid'],
    manifest_missing: [[bar1, q(t14), t7, t16], {}, 'open_orders_payload_invalid'],
    manifest_overstated: [[bar1, t14, t7, t16], { quarantinedCount: 1 }, 'open_orders_payload_invalid'],
    other_reason: [[bar1, { ...t14, quarantineReason: 'guess' }, t7, t16], { quarantinedCount: 1 }, 'open_orders_payload_invalid'],
    null_reason: [[bar1, { ...t14, quarantineReason: null }, t7, t16], { quarantinedCount: 1 }, 'open_orders_payload_invalid'],
    omitted: [[bar1, t7, t16], {}, 'open_orders_vanished'],
    duplicated: [[bar1, q(t14), q(t14), t7, t16], { quarantinedCount: 2 }, 'open_orders_payload_invalid'],
    merge_target: [[bar1, q(t14), t7, { ...t16, closureReceiptId: 8964, closureMergedIntoOrderId: 'order-14' }], { quarantinedCount: 1 }, 'open_orders_vanished'],
  };
  for (const [name, [rows, manifest, error, paidPrevious]] of Object.entries(cases)) {
    const db = await seeded(UPGRADED, paidPrevious ? [bar1, t14, t7, { ...t16, status: 4, statusClass: 'paid_candidate', lines: null }] : undefined);
    try {
      const before = await read(db);
      await assert.rejects(commit(db, rows, manifest), { message: error }, name);
      assert.deepEqual(stable(await read(db)), stable(before), name);
    } finally { await db.close(); }
  }
  // Forged facts are ignored: the stored row is the preserved previous one.
  const db = await seeded();
  try {
    const before = await read(db);
    await commit(db, [bar1, q({ ...t14, status: 4, statusClass: 'paid_candidate', totalAmount: 1, tableName: '3', lines: [] }), t7, t16], { quarantinedCount: 1 });
    assert.deepEqual(without(byId(await read(db), 'order-14'), 'quarantinedAt', 'quarantineReason'),
      without(byId(before, 'order-14'), 'quarantinedAt', 'quarantineReason'));
  } finally { await db.close(); }
});

test('idempotent replay of a partial commit and lease/owner fences are unchanged', async () => {
  const db = await seeded();
  try {
    const args = { ...(await claimed(db)), p_manifest: { quarantinedCount: 1 }, p_orders: [bar1, { ...t14, quarantineReason: 'vanished_unconfirmed' }, t7, t16] };
    assert.equal((await rpc(db, 'pos_open_orders_commit', args)).quarantined, 1);
    const snap = await read(db);
    assert.equal((await rpc(db, 'pos_open_orders_commit', args)).replay, true);
    assert.deepEqual(stable(await read(db)), stable(snap));
    await assert.rejects(rpc(db, 'pos_open_orders_commit', { ...args, p_owner_token: randomUUID() }), { message: 'open_orders_run_conflict' });
    const stale = await claimed(db);
    await db.query("update pos_open_orders_private.runs set lease_until = clock_timestamp() - interval '1 second' where id = $1", [stale.p_run_id]);
    await assert.rejects(rpc(db, 'pos_open_orders_commit', { ...args, ...stale }), { message: 'open_orders_lease_lost' });
    assert.deepEqual(stable(await read(db)), stable(snap));
  } finally { await db.close(); }
});

test('03:00 boundary: the next business date starts clean; the quarantined day stays as history', async () => {
  const db = await seeded();
  try {
    assert.equal((await run(db)).quarantined, 1);
    const next = addStoreDays(date, 1);
    const result = await run(db, transport({ listed: [] }), {}, inputFor(next));
    assert.equal(result.status, 'committed', JSON.stringify(result));
    assert.equal(result.quarantined, undefined);
    const nextSnapshot = await read(db, next);
    assert.deepEqual([nextSnapshot.orders, nextSnapshot.sync.businessDate, nextSnapshot.sync.lastErrorCode], [[], next, null]);
    assert.equal(byId(await read(db, date), 'order-14').quarantineReason, 'vanished_unconfirmed');
  } finally { await db.close(); }
});

test('compatibility: an app without the read-contract-4 path never quarantines, even on the upgraded DB', async () => {
  const db = await seeded();
  try {
    const before = await read(db);
    // Contract 4 but no merge evidence loader: same whole-run failure as before.
    const result = await run(db, transport(), { loadMergeReceiptEvidence: undefined });
    assert.equal(result.code, 'orders_vanished_unconfirmed');
    assert.deepEqual((await read(db)).orders, before.orders);
  } finally { await db.close(); }
});

test('migration scope: no receipt, ledger, inventory or payroll DML; earlier migrations untouched by name', () => {
  const sql = quarantine.replace(/--.*$/gm, '');
  assert.doesNotMatch(sql, /\b(insert\s+into|delete\s+from|update)\s+public\./i);
  assert.doesNotMatch(sql, /\b(ledger|inventory|payroll)\w*\./i);
  assert.match(sql, /rename to commit_merge_v1/);
  assert.match(sql, /'recoveryContractVersion', 4/);
});
