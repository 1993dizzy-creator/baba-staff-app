// BABA-TABLE-MERGE-02 (production 2026-11-24, de-identified): at 22:12 table 2's order (two
// manual cocktail lines, 820,000) was merged in POS into BAR9 (TableName "BAR9, 2", new detail
// IDs) and vanished with an empty-GUID detail. It stayed quarantined until 03:00 (57 runs) even
// though BAR9 was paid at 22:36 with receipt #9081 (manual RefDetailType 3 lines, no ItemID).
// Now: the merge is recorded as a link in the run where it happens (a relation, not a payment),
// shown on both tables, and closed once BAR9's paid receipt is saved, even after BAR9 lost its
// lines (Status 4). Real migration chain + public RPC wrappers on PGlite and the real collector.
// Synthetic ids; amounts, names and line shapes mirror the incident. No customer data.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import * as core from '../lib/pos/cukcuk/open-orders-core.ts';
import { calculateStoreBusinessDate, addStoreDays } from '../lib/store-settings/business-time-core.ts';
import { buildTableOverview } from '../lib/sales/table-overview.ts';
import { babaTableCatalog } from '../lib/sales/baba-table-catalog.ts';
import { applyPaymentObservations } from '../lib/sales/table-auto-normal.ts';
import { PREREQUISITES } from './helpers/pos-open-orders-native-fixture.mjs';
import { installCleaningFixture, context, confirm } from './helpers/tables-cleaning-fixture.mjs';

const dir = 'supabase/' + 'migrations/';
const sql = name => readFileSync(dir + name, 'utf8');
const base = sql('20261109210000_pos_open_orders_v1.sql');
const QUARANTINE = sql('20261119080000_pos_open_orders_vanished_quarantine.sql');
const LAST = sql('20261119144531_pos_open_orders_last_verified_table.sql');
const PRODUCTION = [sql('20261110170329_pos_open_orders_vanished_receipt_evidence.sql'),
  sql('20261114161500_pos_open_orders_merged_receipt_evidence.sql'), QUARANTINE, LAST];
const NEW_FILE = '20261125123044_pos_open_orders_merge_links.sql';
const LINKS = sql(NEW_FILE);
const UPGRADED = [...PRODUCTION, LINKS];

const date = calculateStoreBusinessDate(new Date().toISOString(), '03:00');
const branchId = 'branch-fixture';
const scope = `${'a'.repeat(64)}:${branchId}`;
const inputFor = businessDate => ({ scope, branchId, businessDate, windowFrom: new Date(`${businessDate}T03:00:00+07:00`).toISOString(), cutoff: '03:00' });
const input = inputFor(date);
const startMs = Math.max(Date.parse(input.windowFrom) + 60_000, Date.now() - 3600_000);
const at = seconds => new Date(startMs + seconds * 1000).toISOString();
const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';

const ln = (id, itemId, itemName, quantity, price, extra = {}) => ({ detailId: id, parentDetailId: null, additionId: null, itemId, itemName,
  unitName: null, quantity, price, amount: quantity * price, lineStatus: 1, isOption: false, isOrphanOption: false, isCanceled: false, ...extra });
const order = (orderId, tableName, start, lines, extra = {}) => ({ orderId, orderNo: orderId.toUpperCase(), status: 1, statusClass: 'open',
  orderDate: at(start), businessDate: date, tableName, lines, totalAmount: lines.filter(l => !l.isCanceled).reduce((s, l) => s + l.amount, 0), ...extra });
const copyLines = (o, prefix) => o.lines.map(l => ({ ...l, detailId: prefix + l.detailId }));
const merged = (target, tableName, ...members) => {
  const lines = [...target.lines, ...members.flatMap(m => copyLines(m, 'm-'))];
  return { ...target, tableName, lines, totalAmount: lines.reduce((s, l) => s + l.amount, 0) };
};

const SEX = 'Rượu pha chế / Sex on the beach', PEACHY = 'Rượu pha chế / Peachy Melody';
const MULLET = 'Rượu pha chế / Mullet Wine', CHEESE = 'Set phomai nhỏ';
// 20:47 table 2 (order 1.3): manual cocktails only.
const t2 = order('order-t2', '2', 1, [ln('t2-l1', null, SEX, 2, 190000), ln('t2-l2', null, PEACHY, 2, 220000)]);
// 20:52 BAR9 (order 1.4) before the merge.
const bar9 = order('order-bar9', 'BAR9', 2, [ln('b9-l1', 'item-k3', '[K3] Bia Chanh Muối', 1, 99000), ln('b9-l2', 'item-i1', '[I1] Mực', 1, 270000),
  ln('b9-l3', null, MULLET, 2, 220000), ln('b9-l4', 'item-d1', '[D1] Chả cá', 1, 60000),
  ln('b9-l5', null, CHEESE, 1, 200000), ln('b9-l6', 'item-c2', '[C2] Xúc Xích', 1, 250000)]);
// 22:12 POS merge: table 2's lines copied into BAR9 with NEW detail ids.
const bar9Merged = merged(bar9, 'BAR9, 2', t2);
const t5 = order('order-t5', '5', 3, [ln('t5-l1', 'item-k3', '[K3] Bia Chanh Muối', 2, 99000)]);
assert.deepEqual([t2.totalAmount, bar9.totalAmount, bar9Merged.totalAmount], [820000, 1319000, 2139000]);

const detail = (RefDetailType, ItemID, ItemName, Quantity, UnitPrice, extra = {}) => ({ RefDetailType, ItemID, ItemName, Quantity, UnitPrice,
  Amount: Quantity * UnitPrice, PromotionAmount: 0, PromotionRate: 0, DiscountRate: 0, SAInvoicePromotionAmount: 0, ...extra });
// Receipt #9081 (22:36): 4 item lines (RefDetailType 1) and 4 manual lines (RefDetailType 3, no ItemID).
const receipt9081 = [detail(1, 'item-k3', '[K3] Bia Chanh Muối', 1, 99000), detail(1, 'item-i1', '[I1] Mực', 1, 270000),
  detail(3, undefined, MULLET, 2, 220000), detail(1, 'item-d1', '[D1] Chả cá', 1, 60000), detail(3, undefined, PEACHY, 2, 220000),
  detail(3, undefined, SEX, 2, 190000), detail(3, undefined, CHEESE, 1, 200000), detail(1, 'item-c2', '[C2] Xúc Xích', 1, 250000)];
assert.equal(receipt9081.reduce((s, d) => s + d.Amount, 0), 2139000);

async function database(migrations = UPGRADED) {
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
  catch (error) { const e = new Error(core.openOrdersRpcErrorCode(error)); e.detail = error.detail; throw e; }
  finally { await db.exec('reset role'); }
}
const read = (db, day = date) => rpc(db, 'pos_open_orders_read', { p_scope: scope, p_business_date: day });
async function claimed(db, day = date) {
  const p_run_id = randomUUID(), p_owner_token = randomUUID();
  await rpc(db, 'pos_open_orders_claim', { p_run_id, p_owner_token, p_scope: scope, p_branch_id: branchId, p_business_date: day });
  return { p_run_id, p_owner_token };
}
const commit = async (db, rows, manifest = {}) => rpc(db, 'pos_open_orders_commit', { ...(await claimed(db)), p_manifest: manifest, p_orders: rows });
/** A rejected commit leaves its lease; release it so the next claim is not "busy". */
async function rejectedCommit(db, rows, manifest = {}) {
  const run = await claimed(db);
  try { await rpc(db, 'pos_open_orders_commit', { ...run, p_manifest: manifest, p_orders: rows }); }
  catch (error) { await rpc(db, 'pos_open_orders_fail', { ...run, p_code: error.message }); return error; }
  throw new Error('commit unexpectedly accepted');
}
async function addReceipt(db, { id = 9081, orderId = 'order-bar9', status = 3, canceled = false, details = receipt9081, tableName = 'BAR9, 2', header = {} } = {}) {
  await db.query('insert into public.pos_sales_receipts values($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, 'cukcuk', branchId, date, status, canceled,
    details.reduce((s, d) => s + d.Amount, 0), 0, JSON.stringify({ OrderId: orderId, TableName: tableName, CustomerName: 'never-read',
      DiscountAmount: 0, PromotionAmount: 0, PromotionItemsAmount: 0, SAInvoiceDetails: details, ...header })]);
}
// Same columns as lib/pos/cukcuk/open-orders-sync-server.ts and lib/sales/table-overview-server.ts.
async function links(db) {
  return (await db.query(`select id, business_date::text bd, payment_status, is_canceled, raw_json->>'OrderId' oid, raw_json->>'TableName' tn
    from public.pos_sales_receipts where source='cukcuk' and business_date in ($1::date, $1::date + 1) order by id`, [date])).rows
    .map(r => ({ orderId: r.oid ?? '', receiptId: Number(r.id), paymentStatus: r.payment_status, isCanceled: r.is_canceled, businessDate: r.bd, tableName: r.tn }));
}
async function mergeEvidence(db) {
  return (await db.query(`select id, branch_id, business_date::text bd, payment_status, is_canceled, total_amount, discount_amount,
    raw_json->>'OrderId' oid, raw_json->'DiscountAmount' d1, raw_json->'PromotionAmount' d2, raw_json->'PromotionItemsAmount' d3,
    raw_json->'SAInvoiceDetails' details, raw_json->>'TableName' tn
    from public.pos_sales_receipts where source='cukcuk' and business_date in ($1::date, $1::date + 1) order by id`, [date])).rows
    .map(r => ({ orderId: r.oid ?? '', receiptId: Number(r.id), paymentStatus: r.payment_status, isCanceled: r.is_canceled, businessDate: r.bd,
      branchId: r.branch_id, totalAmount: Number(r.total_amount), discountAmount: Number(r.discount_amount), headerDiscounts: [r.d1, r.d2, r.d3],
      details: r.details, tableName: typeof r.tn === 'string' ? r.tn : null }));
}

const header = (o, extra = {}) => ({ Id: o.orderId, No: o.orderNo, Date: o.orderDate, Status: o.status, TotalAmount: o.totalAmount, TableName: o.tableName, ...extra });
const detailLines = o => o.lines.map(l => ({ Id: l.detailId, ItemId: l.itemId, ParentId: l.parentDetailId, AdditionId: l.additionId,
  ItemName: l.itemName, Quantity: l.quantity, Price: l.price, Amount: l.amount, Status: l.lineStatus }));
const vanishedEmptyGuid = { Success: true, Data: { Id: EMPTY_GUID, Date: '0001-01-01T00:00:00', Status: 0, TotalAmount: 0, OrderDetails: [] } };
/** listed: orders the POS lists with details; paid: listed as Status 4 without TableName; everything else vanished. */
function transport({ listed = [bar9Merged, t5], paid = [], canceled = [] } = {}) {
  const calls = [];
  const rows = [...listed.map(o => header(o)), ...paid.map(o => header(o, { Status: 4, TableName: null })), ...canceled.map(o => header(o, { Status: 5 }))];
  return { calls, login: async () => {}, sleep: async () => {}, send: async request => {
    calls.push(request.kind === 'page' ? 'page' : `detail:${request.orderId}`);
    if (request.kind === 'page') return { status: 200, json: { Success: true, Total: rows.length, Data: rows } };
    const known = listed.find(o => o.orderId === request.orderId) ?? canceled.find(o => o.orderId === request.orderId);
    if (!known) return { status: 200, json: vanishedEmptyGuid };
    return { status: 200, json: { Success: true, Data: { ...header(known, canceled.includes(known) ? { Status: 5 } : {}), OrderDetails: detailLines(known) } } };
  } };
}
const run = (db, t = transport(), extra = {}, runInput = input) => core.runOpenOrderSync({ rpc: (n, a) => rpc(db, n, a), transport: t, uuid: randomUUID,
  loadReceiptEvidence: () => links(db), loadMergeReceiptEvidence: () => mergeEvidence(db), ...extra }, runInput);
const committed = async (db, t, extra) => { const result = await run(db, t, extra); assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
const byId = (snapshot, id) => snapshot.orders.find(o => o.orderId === id);
const numeric = snapshot => snapshot.orders.map(o => ({ ...o, totalAmount: Number(o.totalAmount) }));
const lastManifest = async db => (await db.query("select manifest from pos_open_orders_private.runs where status='committed' order by finished_at desc limit 1")).rows[0].manifest;
const overviewOf = async (db, { paid = true } = {}) => {
  const snapshot = await read(db);
  const receipts = (await links(db)).map(r => ({ ...r, paidAt: paid ? new Date().toISOString() : null }));
  return buildTableOverview({ businessDate: date, now: new Date(Date.now() + 1000), enabled: true, catalog: babaTableCatalog(),
    sync: snapshot.sync, orders: snapshot.orders.map(o => ({ ...o, totalAmount: Number(o.totalAmount), raw: {} })), receipts, cutoff: '03:00' });
};
const tile = (overview, name) => overview.tables.find(t => t.name === name);
const classify = async db => core.classifyOrdersForBusinessDate(numeric(await read(db)), await links(db), date);
const linkOf = row => [row.mergeTargetOrderId, row.mergeTargetTable, row.closureReceiptId, row.closureMergedIntoOrderId, row.quarantineReason];

/** 20:52 snapshot, then the 22:12 merge run. */
async function mergedAt2212(migrations = UPGRADED, previous = [bar9, t2, t5], listed = [bar9Merged, t5]) {
  const db = await database(migrations);
  await commit(db, previous);
  const result = await committed(db, transport({ listed }));
  return { db, result };
}

test('RED (production DB, contract 4): the 22:12 merge is quarantined, the board loses BAR9 and table 2 stays unknown after payment', async () => {
  const { db, result } = await mergedAt2212(PRODUCTION);
  try {
    assert.equal((await read(db)).recoveryContractVersion, 4);
    assert.equal(result.quarantined, 1);
    let overview = await overviewOf(db);
    assert.equal(tile(overview, '2').state, 'unknown');
    assert.deepEqual(overview.unlinked.map(o => [o.id, o.tableName]), [['order-bar9', 'BAR9, 2']]);
    assert.equal(tile(overview, 'BAR1').state, 'unknown'); // the unlocated composite order spreads unknown
    await addReceipt(db);
    assert.equal((await committed(db, transport({ listed: [t5], paid: [bar9Merged] }))).quarantined, 1);
    assert.equal(byId(await read(db), 'order-t2').quarantineReason, 'vanished_unconfirmed');
    overview = await overviewOf(db);
    assert.equal(tile(overview, '2').state, 'unknown');
  } finally { await db.close(); }
});

test('GREEN 22:12: table 2 is linked to BAR9 before payment; both tables in use, amounts counted once, nothing quarantined', async () => {
  const { db, result } = await mergedAt2212();
  try {
    assert.equal((await read(db)).recoveryContractVersion, 6);
    assert.equal(result.quarantined, undefined);
    const row = byId(await read(db), 'order-t2');
    assert.deepEqual(linkOf(row), ['order-bar9', 'BAR9, 2', null, null, null]);
    assert.ok(Date.parse(row.mergeLinkedAt) > Date.parse(row.providerObservedAt));
    // Last provider facts only: never a synthesized payment, status or menu.
    assert.deepEqual([row.status, Number(row.totalAmount), row.tableName, row.lines.length, row.quarantinedAt], [1, 820000, '2', 2, null]);
    const manifest = await lastManifest(db);
    assert.deepEqual(manifest.mergeLinks.map(l => [l.orderId, l.target, l.table, l.carried]), [['order-t2', 'order-bar9', 'BAR9, 2', false]]);
    assert.deepEqual(manifest.orderChanges.events.filter(e => e.kind !== 'table_name_changed'),
      [{ kind: 'merge_linked', orderId: 'order-t2', targetOrderId: 'order-bar9', targetTable: 'BAR9, 2' }]);
    assert.ok(manifest.orderChanges.events.some(e => e.kind === 'table_name_changed' && e.orderId === 'order-bar9' && e.toTable === 'BAR9, 2'));

    const classified = await classify(db);
    assert.deepEqual(classified.open.map(o => o.orderId).sort(), ['order-bar9', 'order-t5']);
    assert.deepEqual([classified.mergedPending, classified.merged, classified.uncertain.length], [1, 0, 0]);
    const kpi = core.buildOpenOrderKpi({ enabled: true, businessDate: date, isLiveBusinessDay: true, isClosed: false,
      paid: { amount: 0, receiptCount: 0 }, sync: (await read(db)).sync, classified, now: new Date() });
    assert.deepEqual([kpi.status, kpi.complete, kpi.open.amount], ['ok', true, 2139000 + t5.totalAmount]); // 820,000 never twice

    const overview = await overviewOf(db);
    assert.equal(overview.collection.health, 'healthy');
    assert.deepEqual(overview.unlinked, []);
    assert.deepEqual([tile(overview, '2').state, tile(overview, '2').merge], ['occupied', { role: 'member', paid: false, targetTable: 'BAR9', tables: ['BAR9'] }]);
    assert.deepEqual([tile(overview, 'BAR9').state, tile(overview, 'BAR9').merge], ['occupied', { role: 'target', paid: false, targetTable: 'BAR9', tables: ['2'] }]);
    assert.equal(tile(overview, 'BAR1').state, 'idle'); // no unknown spread to other tables
    const source = tile(overview, '2').orders.find(o => o.id === 'order-t2');
    assert.deepEqual([source.verifiedOpen, source.mergedInto], [false, { orderId: 'order-bar9', table: 'BAR9, 2' }]);
    assert.equal(overview.summary.occupied, 3);
  } finally { await db.close(); }
});

test('GREEN 22:17-22:42: the link is carried, then BAR9 paid (#9081 saved) closes table 2 as merged; one payment, both tables blue', async () => {
  const { db } = await mergedAt2212();
  try {
    const linkedAt = byId(await read(db), 'order-t2').mergeLinkedAt;
    await committed(db);
    assert.equal(byId(await read(db), 'order-t2').mergeLinkedAt, linkedAt);
    assert.deepEqual((await lastManifest(db)).mergeLinks.map(l => [l.orderId, l.carried]), [['order-t2', true]]);
    await addReceipt(db);
    const result = await committed(db, transport({ listed: [t5], paid: [bar9Merged] }));
    assert.equal(result.quarantined, undefined);
    let row = byId(await read(db), 'order-t2');
    assert.deepEqual(linkOf(row), ['order-bar9', 'BAR9, 2', 9081, 'order-bar9', null]); // link kept as history
    assert.equal(row.mergeLinkedAt, linkedAt);
    const audit = await lastManifest(db);
    assert.deepEqual(audit.receiptClosures.map(c => [c.kind, c.orderId, c.receiptId, c.mergedIntoOrderId, c.carried]),
      [['merged_receipt', 'order-t2', 9081, 'order-bar9', false]]);
    assert.ok(audit.orderChanges.events.some(e => e.kind === 'merge_closure' && e.orderId === 'order-t2'));
    // Later runs carry the closure by the unchanged receipt.
    await committed(db, transport({ listed: [t5], paid: [bar9Merged] }));
    assert.deepEqual((await lastManifest(db)).receiptClosures.map(c => [c.orderId, c.carried]), [['order-t2', true]]);
    row = byId(await read(db), 'order-t2');
    assert.deepEqual(linkOf(row), ['order-bar9', 'BAR9, 2', 9081, 'order-bar9', null]);

    const classified = await classify(db);
    assert.deepEqual([classified.converted, classified.merged, classified.mergedPending, classified.uncertain.length], [1, 1, 0, 0]);
    const kpi = core.buildOpenOrderKpi({ enabled: true, businessDate: date, isLiveBusinessDay: true, isClosed: false,
      paid: { amount: 2139000, receiptCount: 1 }, sync: (await read(db)).sync, classified, now: new Date() });
    assert.equal(kpi.provisional.amount, 2139000 + t5.totalAmount);
    const overview = await overviewOf(db);
    assert.equal(overview.collection.health, 'healthy');
    assert.deepEqual([tile(overview, '2').state, tile(overview, '2').merge?.paid, tile(overview, '2').merge?.role], ['paid', true, 'member']);
    assert.deepEqual([tile(overview, 'BAR9').state, tile(overview, 'BAR9').merge?.paid, tile(overview, 'BAR9').merge?.role], ['paid', true, 'target']);
    assert.equal(tile(overview, '2').lastPaidAt, tile(overview, 'BAR9').lastPaidAt);
    assert.equal(overview.unlinkedReceiptCount, 0);
    assert.equal(overview.summary.paidCumulative, 1); // one receipt, once
  } finally { await db.close(); }
});

test('receipt saved after BAR9 reached Status 4 (lines gone): link stays pending (payment confirmation), then closes', async () => {
  const { db } = await mergedAt2212();
  try {
    for (let i = 0; i < 2; i++) {
      const result = await committed(db, transport({ listed: [t5], paid: [bar9Merged] }));
      assert.equal(result.quarantined, undefined);
      assert.deepEqual(linkOf(byId(await read(db), 'order-t2')), ['order-bar9', 'BAR9, 2', null, null, null]);
    }
    assert.equal(byId(await read(db), 'order-bar9').lines, null);
    let overview = await overviewOf(db);
    for (const name of ['2', 'BAR9']) assert.deepEqual([tile(overview, name).state, tile(overview, name).paymentPending], ['unknown', true], name);
    assert.equal(tile(overview, 'BAR1').state, 'idle');
    assert.equal((await classify(db)).mergedPending, 1);
    await addReceipt(db);
    await committed(db, transport({ listed: [t5], paid: [bar9Merged] }));
    assert.deepEqual(linkOf(byId(await read(db), 'order-t2')), ['order-bar9', 'BAR9, 2', 9081, 'order-bar9', null]);
    overview = await overviewOf(db);
    assert.deepEqual(['2', 'BAR9'].map(name => tile(overview, name).state), ['paid', 'paid']);
  } finally { await db.close(); }
});

test('a new customer on table 2 after the merge: the new order occupies 2 first; BAR9 payment never changes it', async () => {
  const { db } = await mergedAt2212();
  try {
    const newcomer = order('order-t2-new', '2', 900, [ln('n-l1', 'item-k3', '[K3] Bia Chanh Muối', 1, 99000)]);
    await committed(db, transport({ listed: [bar9Merged, t5, newcomer] }));
    let overview = await overviewOf(db);
    assert.deepEqual([tile(overview, '2').state, tile(overview, '2').merge], ['occupied', undefined]);
    assert.deepEqual(tile(overview, 'BAR9').merge?.tables, ['2']);
    await addReceipt(db);
    await committed(db, transport({ listed: [t5, newcomer], paid: [bar9Merged] }));
    overview = await overviewOf(db);
    assert.deepEqual([tile(overview, '2').state, tile(overview, 'BAR9').state], ['occupied', 'paid']);
    assert.equal(byId(await read(db), 'order-t2').closureMergedIntoOrderId, 'order-bar9'); // history kept
    const classified = await classify(db);
    assert.deepEqual(classified.open.map(o => o.orderId).sort(), ['order-t2-new', 'order-t5']);
  } finally { await db.close(); }
});

test('A. same OrderId moved to another table is a move: no link, old table released, new table in use', async () => {
  const db = await database();
  try {
    await commit(db, [bar9, t2, t5]);
    const result = await committed(db, transport({ listed: [bar9, { ...t2, tableName: '3' }, t5] }));
    assert.equal(result.quarantined, undefined);
    assert.equal(byId(await read(db), 'order-t2').mergeTargetOrderId, null);
    const overview = await overviewOf(db);
    assert.deepEqual([tile(overview, '2').state, tile(overview, '3').state], ['idle', 'occupied']);
    assert.ok((await lastManifest(db)).orderChanges.events.some(e => e.kind === 'table_name_changed' && e.fromTable === '2' && e.toTable === '3'));
  } finally { await db.close(); }
});

test('B. one order absorbs two tables at once ("BAR9, 2, 3"): both linked; three tiles show the relation', async () => {
  const t3 = order('order-t3', '3', 4, [ln('t3-l1', 'item-k3', '[K3] Bia Chanh Muối', 3, 99000)]);
  const { db, result } = await mergedAt2212(UPGRADED, [bar9, t2, t3, t5], [merged(bar9, 'BAR9, 2, 3', t2, t3), t5]);
  try {
    assert.equal(result.quarantined, undefined);
    const snap = await read(db);
    for (const id of ['order-t2', 'order-t3']) assert.equal(byId(snap, id).mergeTargetOrderId, 'order-bar9', id);
    const overview = await overviewOf(db);
    assert.deepEqual(tile(overview, 'BAR9').merge?.tables, ['2', '3']);
    for (const name of ['2', '3']) assert.deepEqual([tile(overview, name).state, tile(overview, name).merge?.targetTable], ['occupied', 'BAR9'], name);
  } finally { await db.close(); }
});

test('C. two orders merged into a NEW order id ("2, 3"): both linked only with an exact sum; a single re-created order is not', async () => {
  const t3 = order('order-t3', '3', 4, [ln('t3-l1', 'item-k3', '[K3] Bia Chanh Muối', 3, 99000)]);
  const combined = order('order-new', '2, 3', 800, [...copyLines(t2, 'n-'), ...copyLines(t3, 'n-')]);
  let { db, result } = await mergedAt2212(UPGRADED, [bar9, t2, t3, t5], [bar9, combined, t5]);
  try {
    assert.equal(result.quarantined, undefined);
    const snap = await read(db);
    for (const id of ['order-t2', 'order-t3']) assert.equal(byId(snap, id).mergeTargetOrderId, 'order-new', id);
    const overview = await overviewOf(db);
    assert.deepEqual([tile(overview, '2').state, tile(overview, '3').state], ['occupied', 'occupied']);
    assert.deepEqual([tile(overview, '2').merge?.tables, tile(overview, '3').merge?.tables], [['3'], ['2']]);
    const classified = await classify(db);
    assert.deepEqual([classified.mergedPending, classified.open.length], [2, 3]);
  } finally { await db.close(); }
  // Sum differs by one item: no link, both quarantined (the new order is still counted on its own).
  ({ db, result } = await mergedAt2212(UPGRADED, [bar9, t2, t3, t5], [bar9, { ...combined, lines: combined.lines.slice(1),
    totalAmount: combined.totalAmount - combined.lines[0].amount }, t5]));
  try { assert.equal(result.quarantined, 2); } finally { await db.close(); }
  // One vanished order and one new order on the same table: a re-created order is not proven -> quarantine.
  ({ db, result } = await mergedAt2212(UPGRADED, [bar9, t2, t5], [bar9, order('order-new', '2', 800, copyLines(t2, 'n-')), t5]));
  try { assert.equal(result.quarantined, 1); } finally { await db.close(); }
});

test('two orders vanish from table 2 in the same run: which one merged is ambiguous -> neither is linked', async () => {
  const t2b = order('order-t2b', '2', 4, [ln('t2b-l1', null, SEX, 2, 190000), ln('t2b-l2', null, PEACHY, 2, 220000)]);
  const { db, result } = await mergedAt2212(UPGRADED, [bar9, t2, t2b, t5]);
  try {
    assert.equal(result.quarantined, 2);
    const snap = await read(db);
    for (const id of ['order-t2', 'order-t2b']) assert.deepEqual(linkOf(byId(snap, id)).slice(0, 1), [null], id);
    assert.equal(tile(await overviewOf(db), '2').state, 'unknown');
  } finally { await db.close(); }
});

test('an older unrelated quarantined order on table 2 is never linked or closed by the later merge (look-alike menu)', async () => {
  const old2 = order('order-old2', '2', 1, [ln('o-l1', null, SEX, 2, 190000), ln('o-l2', null, PEACHY, 2, 220000)]);
  const later2 = order('order-t2', '2', 600, t2.lines);
  const db = await database();
  try {
    await commit(db, [bar9, old2, t5]);
    assert.equal((await committed(db, transport({ listed: [bar9, t5] }))).quarantined, 1); // old2 vanished, no relation
    await committed(db, transport({ listed: [bar9, later2, t5] }));
    const result = await committed(db, transport({ listed: [merged(bar9, 'BAR9, 2', later2), t5] }));
    assert.equal(result.quarantined, 1);
    const snap = await read(db);
    assert.equal(byId(snap, 'order-t2').mergeTargetOrderId, 'order-bar9');
    assert.deepEqual(linkOf(byId(snap, 'order-old2')), [null, null, null, null, 'vanished_unconfirmed']);
    await addReceipt(db);
    await committed(db, transport({ listed: [t5], paid: [merged(bar9, 'BAR9, 2', later2)] }));
    const after = await read(db);
    assert.equal(byId(after, 'order-t2').closureMergedIntoOrderId, 'order-bar9');
    assert.deepEqual(linkOf(byId(after, 'order-old2')), [null, null, null, null, 'vanished_unconfirmed']);
  } finally { await db.close(); }
});

test('merge time and vanish time differ, or the menu delta does not match: no link (quarantine)', async () => {
  // BAR9 already named "BAR9, 2" one run before table 2 vanished.
  let db = await database();
  try {
    await commit(db, [{ ...bar9, tableName: 'BAR9, 2' }, t2, t5]);
    const result = await committed(db, transport({ listed: [merged(bar9, 'BAR9, 2', t2), t5] }));
    assert.equal(result.quarantined, 1);
  } finally { await db.close(); }
  // BAR9 gained table 2 but only part of its menu.
  db = (await mergedAt2212(UPGRADED, [bar9, t2, t5], [{ ...bar9Merged, lines: bar9Merged.lines.slice(0, -1),
    totalAmount: bar9Merged.totalAmount - 440000 }, t5])).db;
  try { assert.equal(byId(await read(db), 'order-t2').quarantineReason, 'vanished_unconfirmed'); } finally { await db.close(); }
  // Same menu but TableName did not gain table 2 (coincidental items).
  db = (await mergedAt2212(UPGRADED, [bar9, t2, t5], [{ ...bar9Merged, tableName: 'BAR9' }, t5])).db;
  try { assert.equal(byId(await read(db), 'order-t2').quarantineReason, 'vanished_unconfirmed'); } finally { await db.close(); }
  // 11/18 shape: an option line in the merged menu is never proven.
  const t14 = order('order-14', '14', 5, [ln('t14-l1', null, 'Ballentine 17', 1, 3500000),
    ln('t14-l2', null, 'JD', 1, 170000, { parentDetailId: 't14-l1', additionId: 'add-1', isOption: true })]);
  db = (await mergedAt2212(UPGRADED, [bar9, t14, t5], [merged(bar9, 'BAR9, 14', t14), t5])).db;
  try { assert.equal(byId(await read(db), 'order-14').quarantineReason, 'vanished_unconfirmed'); } finally { await db.close(); }
});

test('D. re-split, target canceled, or the merged order reappears: the link is released and never stays forever', async () => {
  // Re-split: BAR9 back to its own table and menu -> table 2's order is quarantined (unknown ending).
  let { db } = await mergedAt2212();
  try {
    const result = await committed(db, transport({ listed: [bar9, t5] }));
    assert.equal(result.quarantined, 1);
    assert.deepEqual(linkOf(byId(await read(db), 'order-t2')), [null, null, null, null, 'vanished_unconfirmed']);
    assert.ok((await lastManifest(db)).orderChanges.events.some(e => e.kind === 'merge_link_released' && e.orderId === 'order-t2'));
  } finally { await db.close(); }
  // Target canceled in POS.
  ({ db } = await mergedAt2212());
  try {
    const result = await committed(db, transport({ listed: [t5], canceled: [bar9Merged] }));
    assert.equal(result.quarantined, 1);
    assert.equal(byId(await read(db), 'order-t2').mergeTargetOrderId, null);
  } finally { await db.close(); }
  // The merged order is listed again with its own id: an ordinary open order.
  ({ db } = await mergedAt2212());
  try {
    await committed(db, transport({ listed: [bar9, t2, t5] }));
    const row = byId(await read(db), 'order-t2');
    assert.deepEqual([row.mergeTargetOrderId, row.quarantinedAt, row.statusClass], [null, null, 'open']);
    assert.equal(tile(await overviewOf(db), '2').state, 'occupied');
  } finally { await db.close(); }
});

test('receipt cancel/reissue and a receipt not naming table 2: only one active paid receipt naming 2 closes the link', async () => {
  let { db } = await mergedAt2212();
  try {
    await addReceipt(db, { id: 9080, status: 4, canceled: true });
    await addReceipt(db, { id: 9081 });
    await committed(db, transport({ listed: [t5], paid: [bar9Merged] }));
    assert.equal(byId(await read(db), 'order-t2').closureReceiptId, 9081);
    assert.equal((await classify(db)).merged, 1);
  } finally { await db.close(); }
  for (const receipts of [[{ id: 9081 }, { id: 9082 }], [{ id: 9081, tableName: 'BAR9' }], [{ id: 9081, status: 1 }]]) {
    ({ db } = await mergedAt2212());
    try {
      for (const r of receipts) await addReceipt(db, r);
      const result = await committed(db, transport({ listed: [t5], paid: [bar9Merged] }));
      assert.equal(result.quarantined, undefined, JSON.stringify(receipts));
      assert.deepEqual(linkOf(byId(await read(db), 'order-t2')), ['order-bar9', 'BAR9, 2', null, null, null], JSON.stringify(receipts));
    } finally { await db.close(); }
  }
});

test('11/14 surviving + merged = receipt proof (merge and payment between two runs) still works, with manual lines', async () => {
  const db = await database();
  try {
    await commit(db, [bar9, t2, t5]);
    await addReceipt(db);
    const result = await committed(db, transport({ listed: [t5], paid: [bar9Merged] }));
    assert.equal(result.quarantined, undefined);
    assert.deepEqual(linkOf(byId(await read(db), 'order-t2')), [null, null, 9081, 'order-bar9', null]);
  } finally { await db.close(); }
});

test('compatibility: the new app on the unapplied DB (contract 4) never sends a link and keeps the existing quarantine', async () => {
  const { db, result } = await mergedAt2212(PRODUCTION);
  try {
    assert.equal(result.quarantined, 1);
    // A link payload would be stored by the old DB as a fresh open row: the app must never send it.
    const prev = await read(db);
    assert.equal(byId(prev, 'order-t2').mergeTargetOrderId, undefined);
  } finally { await db.close(); }
});

test('DB independently rejects forged links atomically (previous snapshot kept)', async () => {
  const strip = ({ quarantinedAt, quarantineReason, lastTableName, lastTableObservedAt, providerObservedAt, closureConfirmedAt,
    mergeLinkedAt, mergeTargetTable, mergeTargetOrderId, ...o }) => o;
  const cases = {
    no_table_change: [[bar9, t2, t5], [{ ...bar9Merged, tableName: 'BAR9' }, t5], 'merge_link_tables'],
    menu_mismatch: [[bar9, t2, t5], [{ ...bar9Merged, lines: bar9Merged.lines.slice(1), totalAmount: bar9Merged.totalAmount - 99000 }, t5], 'merge_link_mismatch'],
    target_missing: [[bar9, t2, t5], [t5, { ...bar9Merged, orderId: 'order-other' }], 'merge_target_invalid'],
    single_new_order: [[bar9, t2, t5], [bar9, t5, order('order-bar9x', '2, 7', 900, copyLines(t2, 'x-'))], 'merge_link_mismatch'],
  };
  for (const [name, [seed, listed, detailCode]] of Object.entries(cases)) {
    const db = await database();
    try {
      await commit(db, seed);
      const before = await read(db);
      const target = name === 'target_missing' ? 'order-bar9' : name === 'single_new_order' ? 'order-bar9x' : 'order-bar9';
      const rows = [...listed.map(o => strip(o)), { ...strip(byId(before, 'order-t2')), mergeTargetOrderId: target }];
      if (name !== 'target_missing' && !rows.some(o => o.orderId === 'order-bar9')) rows.push(strip(byId(before, 'order-bar9')));
      const error = await rejectedCommit(db, rows);
      assert.equal(error.message, 'open_orders_vanished', name);
      assert.equal(error.detail, detailCode, name);
      assert.deepEqual((await read(db)).orders, before.orders, name);
    } finally { await db.close(); }
  }
  // A quarantined or unrelated-target member, and a second vanished order on the merged table.
  const db = await database();
  try {
    const t2b = order('order-t2b', '2', 4, [ln('t2b-l1', 'item-x', 'X', 1, 1000)]);
    await commit(db, [bar9, t2, t2b, t5]);
    const before = await read(db);
    const rows = [strip(bar9Merged), strip(t5), { ...strip(byId(before, 'order-t2')), mergeTargetOrderId: 'order-bar9' },
      { ...strip(byId(before, 'order-t2b')), quarantineReason: 'vanished_unconfirmed' }];
    const error = await rejectedCommit(db, rows, { quarantinedCount: 1 });
    assert.deepEqual([error.message, error.detail], ['open_orders_vanished', 'merge_link_ambiguous']);
    assert.deepEqual((await read(db)).orders, before.orders);
  } finally { await db.close(); }
});

test('app and DB contracts agree: v1/v2 menus, table tokens, containment', async () => {
  const db = await database();
  try {
    const one = async (q, v) => (await db.query(q, v)).rows[0].m;
    const appMenu = map => map && [...map.values()].map(e => ({ item: e.item, price: e.price, quantity: e.quantity, amount: e.amount }))
      .sort((x, y) => x.item < y.item ? -1 : x.item > y.item ? 1 : x.price - y.price);
    const norm = menu => menu && menu.map(e => ({ item: e.item, price: Number(e.price), quantity: Number(e.quantity), amount: Number(e.amount) }))
      .sort((x, y) => x.item < y.item ? -1 : x.item > y.item ? 1 : x.price - y.price);
    const receipts = { incident: receipt9081, padded: receipt9081.map(d => d.ItemName === SEX ? { ...d, ItemName: `  ${SEX}\t` } : d),
      blank_manual: [detail(3, undefined, '  ', 1, 1000)], option: [detail(2, null, 'opt', 1, 1000, { ParentID: 'p' })],
      manual_with_item: [detail(3, 'item-x', 'X', 1, 1000)], item_without_id: [detail(1, '', 'X', 1, 1000)],
      promoted: [detail(3, undefined, 'X', 1, 1000, { PromotionAmount: 100 })], bad_amount: [detail(3, undefined, 'X', 2, 1000, { Amount: 1000 })] };
    for (const [name, details] of Object.entries(receipts)) for (const v of [1, 2]) {
      assert.deepEqual(norm(await one(`select pos_open_orders_private.merge_receipt_menu_v${v}($1::jsonb) m`, [JSON.stringify({ SAInvoiceDetails: details })])),
        appMenu(core.mergeReceiptMenu(details, v)) ?? null, `${name} v${v}`);
    }
    const orders = { incident: [bar9Merged], member: [t2], both: [bar9, t2],
      option: [order('o', '1', 1, [ln('o1', null, 'X', 1, 1000, { isOption: true, parentDetailId: 'p' })])], blank: [order('o', '1', 1, [ln('o1', null, ' ', 1, 1000)])] };
    for (const [name, list] of Object.entries(orders)) for (const v of [1, 2]) {
      assert.deepEqual(norm(await one(`select pos_open_orders_private.merge_order_menu_v${v}($1::jsonb) m`, [JSON.stringify(list)])),
        appMenu(core.mergeOrderMenu(list, v)) ?? null, `${name} v${v}`);
    }
    for (const name of ['BAR9, 2', ' 2 ,BAR9', 'BAR9', 'BAR9, ', 'BAR9, BAR9', '', 'BAR9, 2, 3']) {
      assert.deepEqual(await one('select pos_open_orders_private.merge_table_tokens_v1($1) m', [name]), core.mergeTableTokens(name), name);
    }
    const within = async (a, b) => one('select pos_open_orders_private.merge_menu_within_v1(pos_open_orders_private.merge_order_menu_v2($1::jsonb), pos_open_orders_private.merge_order_menu_v2($2::jsonb)) m',
      [JSON.stringify(a), JSON.stringify(b)]);
    assert.equal(await within([t2], [bar9Merged]), true);
    assert.equal(await within([t2], [bar9]), false);
    assert.equal(core.mergeLinkStillValid(t2, bar9Merged), true);
    assert.equal(core.mergeLinkStillValid(t2, bar9), false);
  } finally { await db.close(); }
});

test('03:00 boundary: links never carry into the next business date; the linked day stays as history', async () => {
  const { db } = await mergedAt2212();
  try {
    const next = addStoreDays(date, 1);
    const result = await run(db, transport({ listed: [] }), {}, inputFor(next));
    assert.equal(result.status, 'committed', JSON.stringify(result));
    assert.deepEqual((await read(db, next)).orders, []);
    assert.equal(byId(await read(db, date), 'order-t2').mergeTargetOrderId, 'order-bar9');
  } finally { await db.close(); }
});

test('auto-normal display: a verified merged payment stays paid without a cleaning key (no timer, no return to normal)', async () => {
  const { db } = await mergedAt2212();
  try {
    await addReceipt(db);
    await committed(db, transport({ listed: [t5], paid: [bar9Merged] }));
    const overview = await overviewOf(db);
    applyPaymentObservations(overview, {}, {});
    assert.deepEqual(['2', 'BAR9'].map(name => [tile(overview, name).state, tile(overview, name).paymentObservation]), [['paid', undefined], ['paid', undefined]]);
    // A plain paid table without a DB key is still made unknown (unchanged).
    const plain = structuredClone(overview);
    delete tile(plain, '2').merge;
    applyPaymentObservations(plain, {}, {});
    assert.equal(tile(plain, '2').state, 'unknown');
  } finally { await db.close(); }
});

test('cleaning context and confirmation keep working on the upgraded read contract (no table_operations change)', async () => {
  const db = new PGlite();
  const day = await installCleaningFixture(db, { afterCleaning: async d => { for (const m of [QUARANTINE, LAST, LINKS]) await d.exec(m); } });
  try {
    await db.exec('update table_operations_private.config set enabled=true');
    await db.query(`insert into pos_open_orders_private.orders(scope,business_date,order_id,order_no,status,status_class,order_date,total_amount,table_name,has_lines,run_id,observed_at)
      values($1,$2,'paid-order','1',4,'paid_candidate',clock_timestamp()-interval '20 minutes',100000,null,false,'00000000-0000-4000-8000-000000000001',clock_timestamp())`,
      [`${'a'.repeat(64)}:${(await db.query('select branch_id from pos_sales_receipts where id=100')).rows[0].branch_id}`, day]);
    const ctx = await context(db, day);
    assert.equal(ctx.snapshot.recoveryContractVersion, 6);
    assert.ok('mergeTargetOrderId' in ctx.snapshot.orders[0]);
    await db.exec('set role service_role');
    try { assert.equal((await confirm(db, day, ctx)).saved, true); } finally { await db.exec('reset role'); }
  } finally { await db.close(); }
});

test('migration scope: no receipt, ledger, inventory or payroll DML; earlier commits renamed, not edited; grants closed', () => {
  const code = LINKS.replace(/--.*$/gm, '');
  assert.doesNotMatch(code, /\b(insert\s+into|delete\s+from|update)\s+public\./i);
  assert.doesNotMatch(code, /\b(ledger|inventory|payroll|table_operations)\w*\./i);
  assert.doesNotMatch(code, /\bdrop\b|\btruncate\b/i);
  assert.match(code, /rename to commit_last_table_v1/);
  assert.match(code, /'recoveryContractVersion', 6/);
  assert.deepEqual([...code.matchAll(/grant execute on function (\S+)\(/g)].map(m => m[1]),
    ['pos_open_orders_private.commit_v1', 'public.pos_open_orders_commit']);
  const created = [...code.matchAll(/create (?:or replace )?function (\S+)\(/g)].map(m => m[1]);
  assert.deepEqual(created, ['pos_open_orders_private.merge_table_tokens_v1', 'pos_open_orders_private.merge_order_menu_v2',
    'pos_open_orders_private.merge_receipt_menu_v2', 'pos_open_orders_private.merge_menu_within_v1', 'pos_open_orders_private.read_v1',
    'pos_open_orders_private.commit_merge_v1', 'pos_open_orders_private.commit_v1', 'public.pos_open_orders_commit']);
});

test('item-only merge proofs keep the same evidence hash on contract 6, and a mid-day migration keeps carried closures', async () => {
  const a = order('order-a', 'BAR8', 1, [ln('a-l1', 'item-a', 'A', 1, 170000)]);
  const b = order('order-b', '7', 2, [ln('b-l1', 'item-b', 'B', 2, 90000)]);
  const details = [detail(1, 'item-a', 'A', 1, 170000), detail(1, 'item-b', 'B', 2, 90000)];
  const hashes = [];
  for (const migrations of [PRODUCTION, UPGRADED]) {
    const db = await database(migrations);
    try {
      await commit(db, [a, b, t5]);
      await addReceipt(db, { id: 501, orderId: 'order-a', details, tableName: 'BAR8' });
      await committed(db, transport({ listed: [t5], paid: [a] }));
      assert.equal(byId(await read(db), 'order-b').closureMergedIntoOrderId, 'order-a');
      hashes.push((await db.query("select closure_evidence_hash h from pos_open_orders_private.orders where order_id='order-b'")).rows[0].h);
      if (migrations === PRODUCTION) {
        await db.exec(LINKS);
        await committed(db, transport({ listed: [t5], paid: [a] }));
        assert.deepEqual((await lastManifest(db)).receiptClosures.map(c => [c.orderId, c.carried]), [['order-b', true]]);
      }
    } finally { await db.close(); }
  }
  assert.equal(hashes[0], hashes[1]);
});
