// BABA-TABLE-MERGE-02 (production 2026-11-24, de-identified): table 2's order (two manual
// cocktail lines, 820,000) was merged in POS into BAR9 at 22:12 (TableName "BAR9, 2", new
// detail IDs). It vanished with an empty-GUID detail and was quarantined. BAR9 was paid at
// 22:36 with receipt #9081 (2,139,000; four RefDetailType 3 manual lines without ItemID) and
// the order stayed quarantined until 03:00 (57 runs): manual lines were rejected, and BAR9's
// previous snapshot already held table 2's lines, so "BAR9 + table 2 = receipt" never matched.
// Real migration chain + public RPC wrappers on PGlite and the real collector. Synthetic ids;
// amounts, names and line shapes mirror the incident. No customer data.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import * as core from '../lib/pos/cukcuk/open-orders-core.ts';
import { calculateStoreBusinessDate, addStoreDays } from '../lib/store-settings/business-time-core.ts';
import { buildTableOverview } from '../lib/sales/table-overview.ts';
import { babaTableCatalog } from '../lib/sales/baba-table-catalog.ts';
import { PREREQUISITES } from './helpers/pos-open-orders-native-fixture.mjs';

const dir = 'supabase/' + 'migrations/';
const sql = name => readFileSync(dir + name, 'utf8');
const base = sql('20261109210000_pos_open_orders_v1.sql');
const PRODUCTION = [sql('20261110170329_pos_open_orders_vanished_receipt_evidence.sql'),
  sql('20261114161500_pos_open_orders_merged_receipt_evidence.sql'), sql('20261119080000_pos_open_orders_vanished_quarantine.sql'),
  sql('20261119144531_pos_open_orders_last_verified_table.sql')];
const NEW_FILE = '20261125115152_pos_open_orders_absorbed_merge_manual_items.sql';
const ABSORBED = sql(NEW_FILE);
const UPGRADED = [...PRODUCTION, ABSORBED];

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

const SEX = 'Rượu pha chế / Sex on the beach', PEACHY = 'Rượu pha chế / Peachy Melody';
const MULLET = 'Rượu pha chế / Mullet Wine', CHEESE = 'Set phomai nhỏ';
// 20:47 table 2 (order 1.3): manual cocktails only.
const t2 = order('order-t2', '2', 1, [ln('t2-l1', null, SEX, 2, 190000), ln('t2-l2', null, PEACHY, 2, 220000)]);
// 20:52 BAR9 (order 1.4) before the merge.
const bar9Own = [ln('b9-l1', 'item-k3', '[K3] Bia Chanh Muối', 1, 99000), ln('b9-l2', 'item-i1', '[I1] Mực Một Nắng Nướng', 1, 270000),
  ln('b9-l3', null, MULLET, 2, 220000), ln('b9-l4', 'item-d1', '[D1] Chả cá chiên giòn', 1, 60000),
  ln('b9-l5', null, CHEESE, 1, 200000), ln('b9-l6', 'item-c2', '[C2] Xúc Xích Tổng Hợp', 1, 250000)];
const bar9 = order('order-bar9', 'BAR9', 2, bar9Own);
// 22:12 POS merge: table 2's lines copied into BAR9 with NEW detail ids.
const bar9Merged = { ...bar9, tableName: 'BAR9, 2', lines: [...bar9Own, ...t2.lines.map(l => ({ ...l, detailId: 'm-' + l.detailId }))] };
bar9Merged.totalAmount = bar9Merged.lines.reduce((s, l) => s + l.amount, 0);
const t5 = order('order-t5', '5', 3, [ln('t5-l1', 'item-k3', '[K3] Bia Chanh Muối', 2, 99000)]);
assert.deepEqual([t2.totalAmount, bar9.totalAmount, bar9Merged.totalAmount], [820000, 1319000, 2139000]);

const detail = (RefDetailType, ItemID, ItemName, Quantity, UnitPrice, extra = {}) => ({ RefDetailType, ItemID, ItemName, Quantity, UnitPrice,
  Amount: Quantity * UnitPrice, PromotionAmount: 0, PromotionRate: 0, DiscountRate: 0, SAInvoicePromotionAmount: 0, ...extra });
// Receipt #9081 (22:36): 8 lines, 4 item lines (RefDetailType 1) and 4 manual lines (RefDetailType 3, no ItemID).
const receipt9081 = [detail(1, 'item-k3', '[K3] Bia Chanh Muối', 1, 99000), detail(1, 'item-i1', '[I1] Mực Một Nắng Nướng', 1, 270000),
  detail(3, undefined, MULLET, 2, 220000), detail(1, 'item-d1', '[D1] Chả cá chiên giòn', 1, 60000), detail(3, undefined, PEACHY, 2, 220000),
  detail(3, undefined, SEX, 2, 190000), detail(3, undefined, CHEESE, 1, 200000), detail(1, 'item-c2', '[C2] Xúc Xích Tổng Hợp', 1, 250000)];
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
async function addReceipt(db, { id = 9081, orderId = 'order-bar9', status = 3, canceled = false, details = receipt9081, tableName = 'BAR9, 2',
  day = date, header = {} } = {}) {
  await db.query('insert into public.pos_sales_receipts values($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, 'cukcuk', branchId, day, status, canceled,
    details.reduce((s, d) => s + d.Amount, 0), 0, JSON.stringify({ OrderId: orderId, TableName: tableName, CustomerName: 'never-read',
      DiscountAmount: 0, PromotionAmount: 0, PromotionItemsAmount: 0, SAInvoiceDetails: details, ...header })]);
}
// Same columns as lib/pos/cukcuk/open-orders-sync-server.ts.
async function links(db) {
  return (await db.query(`select id, business_date::text bd, payment_status, is_canceled, raw_json->>'OrderId' oid
    from public.pos_sales_receipts where source='cukcuk' and business_date in ($1::date, $1::date + 1) order by id`, [date])).rows
    .map(r => ({ orderId: r.oid ?? '', receiptId: Number(r.id), paymentStatus: r.payment_status, isCanceled: r.is_canceled, businessDate: r.bd }));
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
function transport({ listed = [bar9Merged, t5], paid = [] } = {}) {
  const calls = [];
  const all = [...listed, ...paid];
  return { calls, login: async () => {}, sleep: async () => {}, send: async request => {
    calls.push(request.kind === 'page' ? 'page' : `detail:${request.orderId}`);
    if (request.kind === 'page') return { status: 200, json: { Success: true, Total: all.length,
      Data: [...listed.map(o => header(o)), ...paid.map(o => header(o, { Status: 4, TableName: null }))] } };
    const known = listed.find(o => o.orderId === request.orderId);
    if (!known) return { status: 200, json: vanishedEmptyGuid };
    return { status: 200, json: { Success: true, Data: { ...header(known), OrderDetails: detailLines(known) } } };
  } };
}
const run = (db, t = transport(), extra = {}, runInput = input) => core.runOpenOrderSync({ rpc: (n, a) => rpc(db, n, a), transport: t, uuid: randomUUID,
  loadReceiptEvidence: () => links(db), loadMergeReceiptEvidence: () => mergeEvidence(db), ...extra }, runInput);
const byId = (snapshot, id) => snapshot.orders.find(o => o.orderId === id);
const numeric = snapshot => snapshot.orders.map(o => ({ ...o, totalAmount: Number(o.totalAmount) }));
const lastManifest = async db => (await db.query("select manifest from pos_open_orders_private.runs where status='committed' order by finished_at desc limit 1")).rows[0].manifest;
const overviewOf = async (db, receipts = []) => {
  const snapshot = await read(db);
  return buildTableOverview({ businessDate: date, now: new Date(Date.now() + 1000), enabled: true, catalog: babaTableCatalog(),
    sync: snapshot.sync, orders: snapshot.orders.map(o => ({ ...o, totalAmount: Number(o.totalAmount), raw: {} })), receipts, cutoff: '03:00' });
};
const stateOf = (overview, name) => overview.tables.find(t => t.name === name).state;
const paidReceipts = async db => (await links(db)).map(r => ({ ...r, paidAt: new Date().toISOString() }));

/** 20:52 seed -> 22:12 merge run (quarantine) -> 22:17 run -> receipt saved -> 22:42 run. */
async function incident(migrations = UPGRADED, { receipt = {}, merged = bar9Merged, previous = [bar9, t2, t5], extraQuarantined = [] } = {}) {
  const db = await database(migrations);
  await commit(db, previous);
  for (let i = 0; i < 2; i++) {
    const result = await run(db, transport({ listed: [merged, t5] }));
    assert.equal(result.status, 'committed', JSON.stringify(result));
    assert.equal(result.quarantined, 1 + extraQuarantined.length);
  }
  const quarantined = byId(await read(db), 'order-t2');
  assert.equal(quarantined.quarantineReason, 'vanished_unconfirmed');
  // The surviving order's stored snapshot already holds table 2's lines (the double-count trap).
  assert.equal(byId(await read(db), 'order-bar9').lines.length, merged.lines.length);
  if (receipt) await addReceipt(db, receipt);
  const paidRun = await run(db, transport({ listed: [t5], paid: [merged] }));
  return { db, paidRun, quarantined };
}

test('RED (production DB, contract 4): 11/24 #9081 keeps table 2 quarantined after the payment', async () => {
  const { db, paidRun } = await incident(PRODUCTION);
  try {
    assert.equal((await read(db)).recoveryContractVersion, 4);
    assert.equal(paidRun.status, 'committed', JSON.stringify(paidRun));
    assert.equal(paidRun.quarantined, 1);
    const after = await read(db);
    assert.equal(byId(after, 'order-t2').quarantineReason, 'vanished_unconfirmed');
    const classified = core.classifyOrdersForBusinessDate(numeric(after), await links(db), date);
    assert.deepEqual([classified.converted, classified.merged, classified.uncertain.map(u => u.reason)], [1, 0, ['vanished_unconfirmed']]);
    assert.equal(stateOf(await overviewOf(db, await paidReceipts(db)), '2'), 'unknown');
  } finally { await db.close(); }
});

test('RED (pure proof): version 1 rejects the manual lines; surviving + merged double counts even with manual lines', () => {
  assert.equal(core.mergeReceiptMenu(receipt9081), null);
  assert.equal(core.mergeOrderMenu([t2]), null);
  const v2 = core.mergeReceiptMenu(receipt9081, 2);
  const doubled = core.mergeOrderMenu([bar9Merged, t2], 2);
  assert.equal([...v2.values()].reduce((s, e) => s + e.amount, 0), 2139000);
  assert.equal([...doubled.values()].reduce((s, e) => s + e.amount, 0), 2959000); // 2,139,000 + 820,000 counted twice
});

test('GREEN 22:42: table 2 closes as merged into BAR9 by #9081, counted once; later runs carry the proof', async () => {
  const { db, paidRun, quarantined } = await incident();
  try {
    assert.equal((await read(db)).recoveryContractVersion, 5);
    assert.equal(paidRun.status, 'committed', JSON.stringify(paidRun));
    assert.equal(paidRun.quarantined, undefined);
    let after = await read(db);
    const t2Row = byId(after, 'order-t2');
    assert.deepEqual([t2Row.closureReceiptId, t2Row.closureMergedIntoOrderId, t2Row.quarantinedAt, t2Row.quarantineReason],
      [9081, 'order-bar9', null, null]);
    // Last provider facts preserved: never a synthesized Status 4 or new menu.
    assert.deepEqual([t2Row.status, Number(t2Row.totalAmount), t2Row.tableName, t2Row.providerObservedAt, t2Row.lines.length],
      [1, 820000, '2', quarantined.providerObservedAt, 2]);
    const audit = await lastManifest(db);
    assert.deepEqual(audit.receiptClosures.map(c => [c.kind, c.orderId, c.receiptId, c.mergedIntoOrderId, c.carried]),
      [['merged_receipt', 'order-t2', 9081, 'order-bar9', false]]);
    const hash = (await db.query("select closure_evidence_hash h from pos_open_orders_private.orders where order_id='order-t2'")).rows[0].h;
    assert.match(hash, /^[0-9a-f]{32}$/);

    // Later runs: BAR9 is Status 4 without lines; the proof is carried by the unchanged receipt.
    for (let i = 0; i < 2; i++) {
      const t = transport({ listed: [t5], paid: [bar9Merged] });
      const result = await run(db, t);
      assert.equal(result.status, 'committed', JSON.stringify(result));
      assert.equal(result.quarantined, undefined);
      assert.ok(!t.calls.includes('detail:order-t2'));
    }
    after = await read(db);
    assert.equal(byId(after, 'order-t2').closureMergedIntoOrderId, 'order-bar9');
    assert.deepEqual((await lastManifest(db)).receiptClosures.map(c => [c.orderId, c.carried]), [['order-t2', true]]);

    // Sales: the paid receipt once, table 2 never added again, nothing uncertain.
    const classified = core.classifyOrdersForBusinessDate(numeric(after), await links(db), date);
    assert.deepEqual([classified.converted, classified.merged, classified.uncertain.length], [1, 1, 0]);
    assert.deepEqual(classified.open.map(o => o.orderId), ['order-t5']);
    const kpi = core.buildOpenOrderKpi({ enabled: true, businessDate: date, isLiveBusinessDay: true, isClosed: false,
      paid: { amount: 2139000, receiptCount: 1 }, sync: after.sync, classified, now: new Date() });
    assert.deepEqual([kpi.status, kpi.complete, kpi.quarantinedOrderCount], ['ok', true, 0]);
    assert.equal(kpi.provisional.amount, 2139000 + t5.totalAmount);
    // Tables: 2 is no longer unknown; the collection is complete again.
    const overview = await overviewOf(db, await paidReceipts(db));
    assert.notEqual(stateOf(overview, '2'), 'unknown');
    assert.equal(stateOf(overview, '5'), 'occupied');
    assert.notEqual(overview.collection.health, 'partial');
  } finally { await db.close(); }
});

test('GREEN: a new customer on table 2 after the proof is an ordinary open order (occupancy independent of the merged one)', async () => {
  const { db, paidRun } = await incident();
  try {
    assert.equal(paidRun.quarantined, undefined);
    const newcomer = order('order-t2-new', '2', 900, [ln('n-l1', 'item-k3', '[K3] Bia Chanh Muối', 1, 99000)]);
    const result = await run(db, transport({ listed: [t5, newcomer], paid: [bar9Merged] }));
    assert.equal(result.status, 'committed', JSON.stringify(result));
    const after = await read(db);
    assert.equal(byId(after, 'order-t2').closureMergedIntoOrderId, 'order-bar9');
    const classified = core.classifyOrdersForBusinessDate(numeric(after), await links(db), date);
    assert.deepEqual(classified.open.map(o => o.orderId).sort(), ['order-t2-new', 'order-t5']);
    assert.equal(stateOf(await overviewOf(db, await paidReceipts(db)), '2'), 'occupied');
  } finally { await db.close(); }
});

test('GREEN: merge and payment between two runs (BAR9 snapshot not yet merged) closes by surviving + merged with manual lines', async () => {
  const db = await database();
  try {
    await commit(db, [bar9, t2, t5]);
    await addReceipt(db);
    const result = await run(db, transport({ listed: [t5], paid: [bar9Merged] }));
    assert.equal(result.status, 'committed', JSON.stringify(result));
    assert.equal(result.quarantined, undefined);
    const row = byId(await read(db), 'order-t2');
    assert.deepEqual([row.closureReceiptId, row.closureMergedIntoOrderId], [9081, 'order-bar9']);
  } finally { await db.close(); }
});

// Every variant must keep table 2 quarantined, commit the run (no global failure) and never close by guess.
const variants = {
  amount_mismatch: { receipt: { details: receipt9081.map(d => d.ItemName === PEACHY ? { ...d, Quantity: 1, Amount: 220000 } : d) } },
  extra_receipt_item: { receipt: { details: [...receipt9081, detail(1, 'item-x', 'X', 1, 50000)] } },
  partial_name: { receipt: { details: receipt9081.map(d => d.ItemName === PEACHY ? { ...d, ItemName: 'Peachy' } : d) } },
  option_line_11_18: { receipt: { details: [...receipt9081.filter(d => d.ItemName !== CHEESE),
    detail(2, null, CHEESE, 1, 200000, { ParentID: 'r-l1', InventoryItemAdditionID: 'add-1' })] } },
  line_discount: { receipt: { details: receipt9081.map(d => d.ItemName === SEX ? { ...d, DiscountRate: 10 } : d) } },
  header_discount: { receipt: { header: { PromotionAmount: 1000 } } },
  manual_with_item_id: { receipt: { details: receipt9081.map(d => d.ItemName === SEX ? { ...d, ItemID: 'item-sex' } : d) } },
  unknown_line_type: { receipt: { details: receipt9081.map(d => d.ItemName === SEX ? { ...d, RefDetailType: 4 } : d) } },
  receipt_table_without_2: { receipt: { tableName: 'BAR9' } },
  receipt_table_other: { receipt: { tableName: 'BAR9, 3' } },
  receipt_table_missing: { receipt: { tableName: null } },
  unpaid_receipt: { receipt: { status: 1 } },
  canceled_receipt: { receipt: { canceled: true, status: 4 } },
  no_receipt: { receipt: null },
  target_table_not_merged: { merged: { ...bar9Merged, tableName: 'BAR9' } },
};
for (const [name, c] of Object.entries(variants)) {
  test(`insufficient or ambiguous evidence (${name}): table 2 stays quarantined, the run commits`, async () => {
    const { db, paidRun } = await incident(UPGRADED, c);
    try {
      assert.equal(paidRun.status, 'committed', `${name} ${JSON.stringify(paidRun)}`);
      assert.equal(paidRun.quarantined, 1, name);
      const row = byId(await read(db), 'order-t2');
      assert.deepEqual([row.quarantineReason, row.closureReceiptId, row.closureMergedIntoOrderId], ['vanished_unconfirmed', null, null], name);
    } finally { await db.close(); }
  });
}

test('two quarantined orders on table 2: neither closes (which one merged is ambiguous)', async () => {
  const t2b = order('order-t2b', '2', 4, [ln('t2b-l1', null, SEX, 2, 190000), ln('t2b-l2', null, PEACHY, 2, 220000)]);
  const db = await database();
  try {
    await commit(db, [bar9, t2, t2b, t5]);
    assert.equal((await run(db, transport({ listed: [bar9Merged, t5] }))).quarantined, 2);
    await addReceipt(db);
    const result = await run(db, transport({ listed: [t5], paid: [bar9Merged] }));
    assert.equal(result.status, 'committed', JSON.stringify(result));
    assert.equal(result.quarantined, 2);
    const after = await read(db);
    for (const id of ['order-t2', 'order-t2b']) assert.equal(byId(after, id).quarantineReason, 'vanished_unconfirmed', id);
  } finally { await db.close(); }
});

test('an identical-menu quarantined order on another table is never taken; only the table-2 order closes', async () => {
  const t3 = order('order-t3', '3', 4, [ln('t3-l1', null, SEX, 2, 190000), ln('t3-l2', null, PEACHY, 2, 220000)]);
  const db = await database();
  try {
    await commit(db, [bar9, t2, t3, t5]);
    assert.equal((await run(db, transport({ listed: [bar9Merged, t5] }))).quarantined, 2);
    await addReceipt(db);
    const result = await run(db, transport({ listed: [t5], paid: [bar9Merged] }));
    assert.equal(result.status, 'committed', JSON.stringify(result));
    assert.equal(result.quarantined, 1);
    const after = await read(db);
    assert.equal(byId(after, 'order-t2').closureMergedIntoOrderId, 'order-bar9');
    assert.equal(byId(after, 'order-t3').quarantineReason, 'vanished_unconfirmed');
  } finally { await db.close(); }
});

test('surviving + merged with two identical manual-menu candidates stays ambiguous (never picks one)', async () => {
  const t3 = order('order-t3', '3', 4, [ln('t3-l1', null, SEX, 2, 190000), ln('t3-l2', null, PEACHY, 2, 220000)]);
  const db = await database();
  try {
    await commit(db, [bar9, t2, t3, t5]);
    await addReceipt(db);
    const result = await run(db, transport({ listed: [t5], paid: [bar9Merged] }));
    assert.equal(result.status, 'committed', JSON.stringify(result));
    assert.equal(result.quarantined, 2);
  } finally { await db.close(); }
});

test('receipt evidence arriving after BAR9 lost its lines (Status 4 snapshot) is not enough: stays quarantined, no failure', async () => {
  const { db, paidRun } = await incident(UPGRADED, { receipt: null });
  try {
    assert.equal(paidRun.quarantined, 1);
    await addReceipt(db);
    const result = await run(db, transport({ listed: [t5], paid: [bar9Merged] }));
    assert.equal(result.status, 'committed', JSON.stringify(result));
    assert.equal(result.quarantined, 1);
    assert.equal(byId(await read(db), 'order-t2').quarantineReason, 'vanished_unconfirmed');
  } finally { await db.close(); }
});

test('11/14 item-only merge regression on contract 5: same proof and the same evidence hash as contract 3/4', async () => {
  const a = order('order-a', 'BAR8', 1, [ln('a-l1', 'item-a', 'A', 1, 170000)]);
  const b = order('order-b', 'BAR9', 2, [ln('b-l1', 'item-b', 'B', 2, 90000)]);
  const details = [detail(1, 'item-a', 'A', 1, 170000), detail(1, 'item-b', 'B', 2, 90000)];
  const hashes = [];
  for (const migrations of [PRODUCTION, UPGRADED]) {
    const db = await database(migrations);
    try {
      await commit(db, [a, b, t5]);
      await addReceipt(db, { id: 501, orderId: 'order-a', details, tableName: 'BAR8' });
      const result = await run(db, transport({ listed: [t5], paid: [a] }));
      assert.equal(result.status, 'committed', JSON.stringify(result));
      assert.equal(byId(await read(db), 'order-b').closureMergedIntoOrderId, 'order-a');
      hashes.push((await db.query("select closure_evidence_hash h from pos_open_orders_private.orders where order_id='order-b'")).rows[0].h);
    } finally { await db.close(); }
  }
  assert.equal(hashes[0], hashes[1]);
});

test('migration applied mid-day: an item-only proof carried from contract 4 stays carried on contract 5', async () => {
  const a = order('order-a', 'BAR8', 1, [ln('a-l1', 'item-a', 'A', 1, 170000)]);
  const b = order('order-b', 'BAR9', 2, [ln('b-l1', 'item-b', 'B', 2, 90000)]);
  const db = await database(PRODUCTION);
  try {
    await commit(db, [a, b, t5]);
    await addReceipt(db, { id: 501, orderId: 'order-a', details: [detail(1, 'item-a', 'A', 1, 170000), detail(1, 'item-b', 'B', 2, 90000)], tableName: 'BAR8' });
    assert.equal((await run(db, transport({ listed: [t5], paid: [a] }))).status, 'committed');
    await db.exec(ABSORBED);
    const result = await run(db, transport({ listed: [t5], paid: [a] }));
    assert.equal(result.status, 'committed', JSON.stringify(result));
    assert.deepEqual((await lastManifest(db)).receiptClosures.map(c => [c.orderId, c.carried]), [['order-b', true]]);
  } finally { await db.close(); }
});

test('compatibility: the new app on the unapplied DB (contract 4) never sends a version 2 proof (old DB would fail the run)', async () => {
  const { db } = await incident(PRODUCTION);
  try {
    // What a version 2 proof would send: the old DB rejects it as a whole-run failure.
    const prev = await read(db);
    const rows = [{ ...t5 }, { ...bar9Merged, status: 4, statusClass: 'paid_candidate', tableName: null, lines: null },
      { ...byId(prev, 'order-t2'), closureReceiptId: 9081, closureMergedIntoOrderId: 'order-bar9' }]
      .map(({ quarantinedAt, quarantineReason, lastTableName, lastTableObservedAt, providerObservedAt, closureConfirmedAt, ...o }) => o);
    const forged = await claimed(db);
    await assert.rejects(rpc(db, 'pos_open_orders_commit', { ...forged, p_manifest: {}, p_orders: rows }), { message: 'open_orders_vanished' });
    await rpc(db, 'pos_open_orders_fail', { ...forged, p_code: 'open_orders_vanished' });
    // The collector, gated by contract 5, keeps committing with the quarantine instead.
    const result = await run(db, transport({ listed: [t5], paid: [bar9Merged] }));
    assert.deepEqual([result.status, result.quarantined], ['committed', 1]);
  } finally { await db.close(); }
});

test('DB independently rejects forged absorbed proofs (atomic, previous snapshot kept)', async () => {
  const cases = {
    // Member never quarantined: surviving + merged double counts, absorbed needs a prior quarantine.
    member_not_quarantined: async db => { await commit(db, [bar9Merged, t2, t5]); },
    // Another quarantined order on the merged tables is unaccounted for.
    other_quarantined_on_table: async db => {
      const t2b = order('order-t2b', '2', 4, [ln('t2b-l1', 'item-k3', 'K3', 1, 99000)]);
      await commit(db, [bar9, t2, t2b, t5]);
      await run(db, transport({ listed: [bar9Merged, t5] }));
    },
  };
  for (const [name, setup] of Object.entries(cases)) {
    const db = await database();
    try {
      await setup(db);
      await addReceipt(db);
      const before = await read(db);
      const rows = before.orders.filter(o => o.orderId !== 'order-t2')
        .map(o => o.orderId === 'order-bar9' ? { ...o, status: 4, statusClass: 'paid_candidate', tableName: null, lines: null } : o)
        .map(({ quarantinedAt, quarantineReason, lastTableName, lastTableObservedAt, providerObservedAt, closureConfirmedAt, ...o }) =>
          quarantinedAt ? { ...o, quarantineReason: 'vanished_unconfirmed' } : o);
      const t2Row = { ...byId(before, 'order-t2'), closureReceiptId: 9081, closureMergedIntoOrderId: 'order-bar9' };
      for (const k of ['quarantinedAt', 'quarantineReason', 'lastTableName', 'lastTableObservedAt', 'providerObservedAt', 'closureConfirmedAt']) delete t2Row[k];
      const quarantinedCount = rows.filter(o => o.quarantineReason).length;
      await assert.rejects(commit(db, [...rows, t2Row], quarantinedCount ? { quarantinedCount } : {}), { message: 'open_orders_vanished' }, name);
      assert.deepEqual((await read(db)).orders, before.orders, name);
    } finally { await db.close(); }
  }
});

test('app and DB menu contracts agree (v1 and v2) on the incident and edge lines', async () => {
  const db = await database();
  try {
    const dbMenu = async (fn, arg) => (await db.query(`select pos_open_orders_private.${fn}($1::jsonb) m`, [JSON.stringify(arg)])).rows[0].m;
    const appMenu = map => map && [...map.values()].map(e => ({ item: e.item, price: e.price, quantity: e.quantity, amount: e.amount }))
      .sort((x, y) => x.item < y.item ? -1 : x.item > y.item ? 1 : x.price - y.price);
    const norm = menu => menu && menu.map(e => ({ item: e.item, price: Number(e.price), quantity: Number(e.quantity), amount: Number(e.amount) }))
      .sort((x, y) => x.item < y.item ? -1 : x.item > y.item ? 1 : x.price - y.price);
    const receipts = {
      incident: receipt9081,
      padded_name: receipt9081.map(d => d.ItemName === SEX ? { ...d, ItemName: `  ${SEX}\t` } : d),
      blank_manual_name: [detail(3, undefined, '  ', 1, 1000)],
      option: [detail(2, null, 'opt', 1, 1000, { ParentID: 'p' })],
      manual_with_item: [detail(3, 'item-x', 'X', 1, 1000)],
      item_without_id: [detail(1, '', 'X', 1, 1000)],
      promoted: [detail(3, undefined, 'X', 1, 1000, { PromotionAmount: 100 })],
      bad_amount: [detail(3, undefined, 'X', 2, 1000, { Amount: 1000 })],
    };
    for (const [name, details] of Object.entries(receipts)) {
      for (const version of [1, 2]) {
        const fn = version === 1 ? 'merge_receipt_menu_v1' : 'merge_receipt_menu_v2';
        assert.deepEqual(norm(await dbMenu(fn, { SAInvoiceDetails: details })), appMenu(core.mergeReceiptMenu(details, version)) ?? null, `${name} v${version}`);
      }
    }
    const orders = { incident: [bar9Merged], member: [t2], both: [bar9, t2],
      option: [order('o', '1', 1, [ln('o1', null, 'X', 1, 1000, { isOption: true, parentDetailId: 'p' })])],
      blank_name: [order('o', '1', 1, [ln('o1', null, ' ', 1, 1000)])] };
    for (const [name, list] of Object.entries(orders)) {
      for (const version of [1, 2]) {
        const fn = version === 1 ? 'merge_order_menu_v1' : 'merge_order_menu_v2';
        assert.deepEqual(norm(await dbMenu(fn, list)), appMenu(core.mergeOrderMenu(list, version)) ?? null, `${name} v${version}`);
      }
    }
    for (const name of ['BAR9, 2', ' 2 ,BAR9', 'BAR9', 'BAR9, ', 'BAR9, BAR9', '']) {
      const own = (await db.query('select pos_open_orders_private.merge_table_tokens_v1($1) t', [name])).rows[0].t;
      assert.deepEqual(own, core.mergeTableTokens(name), name);
    }
  } finally { await db.close(); }
});

test('03:00 boundary: the next business date starts clean; the proven day stays as history', async () => {
  const { db, paidRun } = await incident();
  try {
    assert.equal(paidRun.quarantined, undefined);
    const next = addStoreDays(date, 1);
    const result = await run(db, transport({ listed: [] }), {}, inputFor(next));
    assert.equal(result.status, 'committed', JSON.stringify(result));
    assert.deepEqual((await read(db, next)).orders, []);
    assert.equal(byId(await read(db, date), 'order-t2').closureMergedIntoOrderId, 'order-bar9');
  } finally { await db.close(); }
});

test('migration scope: new helpers + commit_merge_v1/read_v1 only; no receipt, ledger, inventory or payroll DML; grants closed', () => {
  const code = ABSORBED.replace(/--.*$/gm, '');
  assert.doesNotMatch(code, /\b(insert\s+into|delete\s+from)\s+public\./i);
  assert.doesNotMatch(code, /\bupdate\s+public\./i);
  assert.doesNotMatch(code, /\b(ledger|inventory|payroll)\w*\./i);
  assert.doesNotMatch(code, /\bdrop\b|\btruncate\b|\balter\s+table\b/i);
  const created = [...code.matchAll(/create (?:or replace )?function (\S+)\(/g)].map(m => m[1]);
  assert.deepEqual(created, ['pos_open_orders_private.merge_table_tokens_v1', 'pos_open_orders_private.merge_order_menu_v2',
    'pos_open_orders_private.merge_receipt_menu_v2', 'pos_open_orders_private.read_v1', 'pos_open_orders_private.commit_merge_v1']);
  assert.match(code, /'recoveryContractVersion', 5/);
  assert.doesNotMatch(code, /grant /i);
});
