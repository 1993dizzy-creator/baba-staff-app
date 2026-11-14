// CUKCUK order merge (2026-11-14 shape, de-identified): three open orders merged in POS into
// one surviving order and paid on one receipt. Real migrations + public RPC wrappers on local
// in-memory PostgreSQL (PGlite) only. No production identifiers, amounts or customer data.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import * as core from '../lib/pos/cukcuk/open-orders-core.ts';
import { calculateStoreBusinessDate, addStoreDays } from '../lib/store-settings/business-time-core.ts';
import { buildTableOverview } from '../lib/sales/table-overview.ts';
import { babaTableCatalog } from '../lib/sales/baba-table-catalog.ts';

const dir = 'supabase/' + 'migrations/';
const base = readFileSync(dir + '20261109210000_pos_open_orders_v1.sql', 'utf8');
const receiptEvidence = readFileSync(dir + '20261110170329_pos_open_orders_vanished_receipt_evidence.sql', 'utf8');
const merged = readFileSync(dir + '20261114161500_pos_open_orders_merged_receipt_evidence.sql', 'utf8');
const date = calculateStoreBusinessDate(new Date().toISOString(), '03:00');
const branchId = 'branch-fixture';
const scope = `${'a'.repeat(64)}:${branchId}`;
const input = { scope, branchId, businessDate: date, windowFrom: new Date(`${date}T03:00:00+07:00`).toISOString(), cutoff: '03:00' };
// Order times inside this business date and before the real clock (freshness checks compare them to now).
const startMs = Math.max(Date.parse(input.windowFrom) + 60_000, Date.now() - 3600_000);
const at = seconds => new Date(startMs + seconds * 1000).toISOString();

// Menu items (synthetic ids). D and F share a price on purpose: an amount-only match is not enough.
const line = (order, n, item, quantity, price, extra = {}) => ({ detailId: `${order}-l${n}`, parentDetailId: null, additionId: null,
  itemId: item, itemName: `Menu ${item}`, unitName: null, quantity, price, amount: quantity * price, lineStatus: 2,
  isOption: false, isOrphanOption: false, isCanceled: false, ...extra });
const snapshotOrder = (orderId, tableName, start, lines, extra = {}) => ({ orderId, orderNo: orderId.toUpperCase(), status: 1,
  statusClass: 'open', orderDate: at(start), businessDate: date, tableName, lines,
  totalAmount: lines.filter(l => !l.isCanceled).reduce((s, l) => s + l.amount, 0), ...extra });
const target = snapshotOrder('order-t', 'BAR8', 1, [line('t', 1, 'item-a', 1, 170000)]);
const memberA = snapshotOrder('order-a', 'BAR9', 2, [line('a', 1, 'item-b', 2, 90000), line('a', 2, 'item-b', 1, 90000),
  line('a', 3, 'item-c', 1, 30000), line('a', 4, 'item-d', 1, 60000), line('a', 5, 'item-e', 1, 150000)]);
const memberB = snapshotOrder('order-b', 'BAR11', 3, [line('b', 1, 'item-f', 1, 60000), line('b', 2, 'item-a', 1, 170000),
  line('b', 3, 'item-g', 1, 180000)]);
const other = snapshotOrder('order-o', '13', 4, [line('o', 1, 'item-h', 1, 1410000)]);
assert.deepEqual([target.totalAmount, memberA.totalAmount, memberB.totalAmount], [170000, 510000, 410000]);

// The merged receipt: POS re-issues detail ids and consolidates identical items.
const mergedDetails = [['item-a', 2, 170000], ['item-b', 3, 90000], ['item-c', 1, 30000], ['item-d', 1, 60000], ['item-e', 1, 150000],
  ['item-f', 1, 60000], ['item-g', 1, 180000]].map(([ItemID, Quantity, UnitPrice], i) => ({ RefDetailType: 1, ItemID, Quantity, UnitPrice,
  Amount: Quantity * UnitPrice, OrderDetailID: `reissued-${i}`, PromotionAmount: 0, PromotionRate: 0, DiscountRate: 0, SAInvoicePromotionAmount: 0 }));

async function database(migrations = [receiptEvidence, merged]) {
  const db = new PGlite();
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create table public.pos_sales_receipts(id bigint primary key, source text, branch_id text, business_date date, payment_status integer,
      is_canceled boolean, total_amount numeric, discount_amount numeric, raw_json jsonb);`);
  await db.exec(base);
  for (const sql of migrations) await db.exec(sql);
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
async function commit(db, rows) {
  return rpc(db, 'pos_open_orders_commit', { ...(await claimed(db)), p_manifest: {}, p_orders: rows });
}
async function receipt(db, { id = 501, orderId = 'order-t', status = 3, canceled = false, day = date, branch = branchId,
  details = mergedDetails, total, discount = 0, header = {} } = {}) {
  const sum = total ?? details.reduce((s, d) => s + d.Amount, 0);
  await db.query('insert into public.pos_sales_receipts values($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, 'cukcuk', branch, day, status, canceled,
    sum, discount, JSON.stringify({ OrderId: orderId, CustomerName: 'never-read', DiscountAmount: discount, PromotionAmount: 0,
      PromotionItemsAmount: 0, SAInvoiceDetails: details, ...header })]);
}
// Same projection as the server loaders (no customer fields).
async function links(db) {
  return (await db.query(`select id, business_date::text bd, payment_status, is_canceled, raw_json->>'OrderId' oid from public.pos_sales_receipts
    where source='cukcuk' and business_date in ($1::date, $1::date + 1) order by id`, [date])).rows
    .map(r => ({ orderId: r.oid ?? '', receiptId: Number(r.id), paymentStatus: r.payment_status, isCanceled: r.is_canceled, businessDate: r.bd }));
}
async function mergeEvidence(db) {
  return (await db.query(`select id, branch_id, business_date::text bd, payment_status, is_canceled, total_amount, discount_amount,
    raw_json->>'OrderId' oid, raw_json->'DiscountAmount' d1, raw_json->'PromotionAmount' d2, raw_json->'PromotionItemsAmount' d3,
    raw_json->'SAInvoiceDetails' details from public.pos_sales_receipts where source='cukcuk' and business_date in ($1::date, $1::date + 1) order by id`, [date])).rows
    .map(r => ({ orderId: r.oid ?? '', receiptId: Number(r.id), paymentStatus: r.payment_status, isCanceled: r.is_canceled, businessDate: r.bd,
      branchId: r.branch_id, totalAmount: r.total_amount === null ? null : Number(r.total_amount),
      discountAmount: r.discount_amount === null ? null : Number(r.discount_amount), headerDiscounts: [r.d1, r.d2, r.d3], details: r.details }));
}
// POS after the merge: surviving order is Status 4 without a table; merged orders are gone.
function transport({ vanished = { Success: true, Data: null }, listed = [target, other] } = {}) {
  const calls = [];
  const header = o => ({ Id: o.orderId, No: o.orderNo, Date: o.orderDate, Status: o === target ? 4 : o.status, TotalAmount: o.totalAmount,
    TableName: o === target ? null : o.tableName });
  return { calls, login: async () => {}, sleep: async () => {}, send: async request => {
    calls.push(request.kind === 'page' ? 'page' : `detail:${request.orderId}`);
    if (request.kind === 'page') return { status: 200, json: { Success: true, Total: listed.length, Data: listed.map(header) } };
    const known = listed.find(o => o.orderId === request.orderId);
    if (!known) return typeof vanished === 'function' ? vanished(request) : { status: 200, json: vanished };
    return { status: 200, json: { Success: true, Data: { ...header(known), OrderDetails: known.lines.map(l => ({ Id: l.detailId, ItemId: l.itemId,
      ItemName: l.itemName, Quantity: l.quantity, Price: l.price, Amount: l.amount, Status: l.lineStatus })) } } };
  } };
}
const run = (db, t = transport(), extra = {}) => core.runOpenOrderSync({ rpc: (n, a) => rpc(db, n, a), transport: t, uuid: randomUUID,
  loadReceiptEvidence: () => links(db), loadMergeReceiptEvidence: () => mergeEvidence(db), ...extra }, input);
async function seeded(migrations) {
  const db = await database(migrations);
  await commit(db, [target, memberA, memberB, other]);
  return db;
}
const byId = (snapshot, id) => snapshot.orders.find(o => o.orderId === id);

test('RED->GREEN: 11/14 merge (BAR8+BAR9+BAR11 -> one paid receipt) commits with explicit merge evidence and no duplicate sale', async () => {
  const db = await seeded();
  try {
    const before = await read(db);
    await receipt(db);
    const t = transport();
    const result = await run(db, t);
    assert.equal(result.status, 'committed', JSON.stringify(result));
    const after = await read(db);
    assert.equal(after.recoveryContractVersion, 3);
    for (const member of [memberA, memberB]) {
      const row = byId(after, member.orderId);
      // Preserved provider facts: never forged into a Status 4 the POS did not send.
      assert.deepEqual([row.status, row.statusClass, row.tableName, Number(row.totalAmount)], [1, 'open', member.tableName, member.totalAmount]);
      assert.deepEqual(row.lines, byId(before, member.orderId).lines);
      assert.equal(row.providerObservedAt, byId(before, member.orderId).providerObservedAt);
      assert.equal(Number(row.closureReceiptId), 501);
      assert.equal(row.closureMergedIntoOrderId, 'order-t');
    }
    assert.equal(byId(after, 'order-t').status, 4);
    assert.equal(byId(after, 'order-t').closureMergedIntoOrderId, null);
    const audit = (await db.query('select manifest from pos_open_orders_private.runs where id=$1', [result.runId])).rows[0].manifest;
    assert.deepEqual(audit.receiptClosures.map(c => [c.kind, c.orderId, c.receiptId, c.mergedIntoOrderId, c.carried]),
      [['merged_receipt', 'order-a', 501, 'order-t', false], ['merged_receipt', 'order-b', 501, 'order-t', false]]);
    // Sales: one receipt, counted once. Merged orders are neither open nor a second sale.
    const classified = core.classifyOrdersForBusinessDate(after.orders, await links(db), date);
    assert.deepEqual([classified.converted, classified.merged, classified.open.map(o => o.orderId), classified.uncertain], [1, 2, ['order-o'], []]);
    assert.equal((await db.query('select count(*)::int n from public.pos_sales_receipts')).rows[0].n, 1);
    assert.equal(after.sync.lastErrorCode, null);
  } finally { await db.close(); }
});

test('repeated collection keeps the same merge closure without re-reading vanished details; replay is unchanged', async () => {
  const db = await seeded();
  try {
    await receipt(db);
    assert.equal((await run(db)).status, 'committed');
    const first = await read(db);
    const hashes = async () => (await db.query('select order_id, closure_evidence_hash h from pos_open_orders_private.orders where closure_evidence_hash is not null order by 1')).rows;
    const firstHashes = await hashes();
    assert.equal(firstHashes.length, 2);
    for (let i = 0; i < 2; i++) {
      const t = transport();
      const again = await run(db, t);
      assert.equal(again.status, 'committed', JSON.stringify(again));
      assert.deepEqual(t.calls, ['page', 'detail:order-o']); // surviving order now Status 4 has no lines; merged ones are carried
      const audit = (await db.query('select manifest from pos_open_orders_private.runs where id=$1', [again.runId])).rows[0].manifest;
      assert.deepEqual(audit.receiptClosures.map(c => c.carried), [true, true]);
    }
    const later = await read(db);
    for (const id of ['order-a', 'order-b']) {
      const stable = order => Object.fromEntries(Object.entries(order).filter(([key]) => key !== 'closureConfirmedAt'));
      assert.deepEqual(stable(byId(later, id)), stable(byId(first, id)));
    }
    assert.deepEqual(await hashes(), firstHashes);
    // Idempotent replay of a committed run.
    const args = { ...(await claimed(db)), p_manifest: {}, p_orders: later.orders.map(o => ({ ...o, closureReceiptId: o.closureReceiptId ?? undefined })) };
    await rpc(db, 'pos_open_orders_commit', args);
    const snap = await read(db);
    assert.equal((await rpc(db, 'pos_open_orders_commit', args)).replay, true);
    assert.deepEqual(await read(db), snap);
  } finally { await db.close(); }
});

test('a later change of the merge receipt reopens the protection instead of keeping a stale closure', async () => {
  for (const change of ['canceled', 'reissued_lines']) {
    const db = await seeded();
    try {
      await receipt(db);
      assert.equal((await run(db)).status, 'committed');
      if (change === 'canceled') await db.exec('update public.pos_sales_receipts set is_canceled = true');
      else await db.query("update public.pos_sales_receipts set raw_json = jsonb_set(raw_json, '{SAInvoiceDetails,0,Quantity}', '1'), total_amount = total_amount - 170000");
      const before = await read(db);
      const result = await run(db);
      assert.equal(result.status, 'failed', change);
      assert.deepEqual((await read(db)).orders, before.orders, change);
    } finally { await db.close(); }
  }
});

test('03:00 boundary: a merge receipt on the next business date is accepted, other dates are not', async () => {
  for (const [day, ok] of [[addStoreDays(date, 1), true], [addStoreDays(date, 2), false], [addStoreDays(date, -1), false]]) {
    const db = await seeded();
    try {
      await receipt(db, { day });
      assert.equal((await run(db)).status, ok ? 'committed' : 'failed', day);
    } finally { await db.close(); }
  }
});

const rejectCases = {
  pending: { receipt: { status: 1 } },
  canceled: { receipt: { canceled: true } },
  amount_only: { receipt: { details: [{ ...mergedDetails[0], ItemID: 'item-z', Quantity: 1, UnitPrice: 1090000, Amount: 1090000 }] } },
  missing_item: { receipt: { details: mergedDetails.slice(0, -1) } },
  quantity_diff: { receipt: { details: mergedDetails.map((d, i) => i === 1 ? { ...d, Quantity: 2, Amount: 180000 } : d) } },
  swapped_same_price: { receipt: { details: mergedDetails.map(d => d.ItemID === 'item-d' ? { ...d, ItemID: 'item-f' } : d.ItemID === 'item-f' ? { ...d, ItemID: 'item-x' } : d) } },
  discount: { receipt: { discount: 10000 } },
  line_promotion: { receipt: { details: mergedDetails.map((d, i) => i === 0 ? { ...d, PromotionAmount: 10000 } : d) } },
  option_line: { receipt: { details: [...mergedDetails, { RefDetailType: 2, ItemID: 'opt', ParentID: 'reissued-0', Quantity: 1, UnitPrice: 0, Amount: 0 }] } },
  other_branch: { receipt: { branch: 'branch-other' } },
  no_receipt: { none: true },
  duplicate_active: { extra: [{ id: 502, status: 1 }] },
  member_own_receipt: { extra: [{ id: 503, orderId: 'order-a', status: 1, details: mergedDetails.slice(1, 2) }] },
  transient_detail_error: { vanished: { Success: false, Code: 102, ErrorType: 102 } },
  wrong_identity_detail: { vanished: () => ({ status: 200, json: { Success: true, Data: { Id: 'order-zzz', Date: at(5), Status: 4, TotalAmount: 0 } } }) },
};
for (const [name, c] of Object.entries(rejectCases)) {
  test(`rejects ${name}: run fails, previous snapshot and last success are kept`, async () => {
    const db = await seeded();
    try {
      if (!c.none) await receipt(db, c.receipt);
      for (const extra of c.extra ?? []) await receipt(db, extra);
      const before = await read(db);
      const result = await run(db, transport(c.vanished ? { vanished: c.vanished } : {}), { now: undefined });
      assert.equal(result.status, 'failed', name);
      assert.equal(result.code, 'orders_vanished_unconfirmed', name);
      const after = await read(db);
      assert.deepEqual(after.orders, before.orders, name);
      assert.equal(after.sync.lastSuccessAt, before.sync.lastSuccessAt, name);
    } finally { await db.close(); }
  });
}

test('ambiguity: two vanished look-alike orders that could each explain the receipt are never closed', async () => {
  const db = await database();
  try {
    const twin = { ...memberB, orderId: 'order-b2', orderNo: 'B2', tableName: 'BAR3', lines: memberB.lines.map(l => ({ ...l, detailId: 'b2' + l.detailId })) };
    await commit(db, [target, memberA, memberB, twin, other]);
    await receipt(db);
    const result = await run(db);
    assert.equal(result.code, 'orders_vanished_unconfirmed');
  } finally { await db.close(); }
});

test('DB independently rejects forged or inconsistent merge payloads atomically', async () => {
  const forged = {
    menu_mismatch: async db => { await receipt(db, { details: mergedDetails.slice(0, -1) }); return [target, { ...memberA, closureReceiptId: 501, closureMergedIntoOrderId: 'order-t' }, { ...memberB, closureReceiptId: 501, closureMergedIntoOrderId: 'order-t' }, other]; },
    partial_group: async db => { await receipt(db); return [target, { ...memberA, closureReceiptId: 501, closureMergedIntoOrderId: 'order-t' }, memberB, other]; },
    target_missing: async db => { await receipt(db); return [{ ...memberA, closureReceiptId: 501, closureMergedIntoOrderId: 'order-t' }, { ...memberB, closureReceiptId: 501, closureMergedIntoOrderId: 'order-t' }, other]; },
    two_targets: async db => { await receipt(db); return [target, { ...memberA, closureReceiptId: 501, closureMergedIntoOrderId: 'order-t' }, { ...memberB, closureReceiptId: 501, closureMergedIntoOrderId: 'order-o' }, other]; },
    reused_as_paid_proof: async db => { await receipt(db); return [{ ...target, closureReceiptId: 501 }, { ...memberA, closureReceiptId: 501, closureMergedIntoOrderId: 'order-t' }, { ...memberB, closureReceiptId: 501, closureMergedIntoOrderId: 'order-t' }, other]; },
    wrong_receipt_id: async db => { await receipt(db); await receipt(db, { id: 777, orderId: 'order-o', details: other.lines.map(() => ({ RefDetailType: 1, ItemID: 'item-h', Quantity: 1, UnitPrice: 1410000, Amount: 1410000 })) });
      return [target, { ...memberA, closureReceiptId: 777, closureMergedIntoOrderId: 'order-t' }, { ...memberB, closureReceiptId: 777, closureMergedIntoOrderId: 'order-t' }, other]; },
    other_branch: async db => { await receipt(db, { branch: 'branch-other' }); return [target, { ...memberA, closureReceiptId: 501, closureMergedIntoOrderId: 'order-t' }, { ...memberB, closureReceiptId: 501, closureMergedIntoOrderId: 'order-t' }, other]; },
    target_is_member: async db => { await receipt(db); return [target, { ...memberA, closureReceiptId: 501, closureMergedIntoOrderId: 'order-a' }, { ...memberB, closureReceiptId: 501, closureMergedIntoOrderId: 'order-a' }, other]; },
  };
  // Positive control: the same direct payload with the genuine receipt is accepted, so every
  // rejection below comes from the specific inconsistency, not from the direct-commit path.
  {
    const db = await seeded();
    try {
      await receipt(db);
      await commit(db, [target, { ...memberA, closureReceiptId: 501, closureMergedIntoOrderId: 'order-t' },
        { ...memberB, closureReceiptId: 501, closureMergedIntoOrderId: 'order-t' }, other]);
      assert.equal(byId(await read(db), 'order-b').closureMergedIntoOrderId, 'order-t');
    } finally { await db.close(); }
  }
  for (const [name, build] of Object.entries(forged)) {
    const db = await seeded();
    try {
      const rows = await build(db);
      const before = await read(db);
      const runsBefore = (await db.query("select id, manifest from pos_open_orders_private.runs where status='committed' order by id")).rows;
      await assert.rejects(commit(db, rows), /open_orders_vanished|open_orders_payload_invalid/, name);
      assert.deepEqual((await read(db)).orders, before.orders, name);
      assert.deepEqual((await db.query("select id, manifest from pos_open_orders_private.runs where status='committed' order by id")).rows, runsBefore, name);
    } finally { await db.close(); }
  }
});

test('lease, ownership and writer fence still guard merge commits', async () => {
  const db = await seeded();
  try {
    await receipt(db);
    const rows = [target, { ...memberA, closureReceiptId: 501, closureMergedIntoOrderId: 'order-t' }, { ...memberB, closureReceiptId: 501, closureMergedIntoOrderId: 'order-t' }, other];
    const ids = await claimed(db);
    await assert.rejects(rpc(db, 'pos_open_orders_commit', { ...ids, p_owner_token: randomUUID(), p_manifest: {}, p_orders: rows }), /open_orders_run_conflict/);
    await db.query("update pos_open_orders_private.runs set lease_until=clock_timestamp()-interval '1 second' where id=$1", [ids.p_run_id]);
    await assert.rejects(rpc(db, 'pos_open_orders_commit', { ...ids, p_manifest: {}, p_orders: rows }), /open_orders_lease_lost/);
    assert.equal(byId(await read(db), 'order-a').closureMergedIntoOrderId, null);
  } finally { await db.close(); }
});

test('unupgraded DB (contract 2) never receives merge evidence and keeps the original failure', async () => {
  const db = await seeded([receiptEvidence]);
  try {
    await receipt(db);
    let mergeLoads = 0;
    const result = await run(db, transport(), { loadMergeReceiptEvidence: async () => { mergeLoads++; return mergeEvidence(db); } });
    assert.equal(result.code, 'orders_vanished_unconfirmed');
    assert.equal(mergeLoads, 0);
  } finally { await db.close(); }
});

test('single-order paid-receipt closure still works after the merge migration', async () => {
  const db = await database();
  try {
    await commit(db, [memberB]);
    await receipt(db, { id: 610, orderId: 'order-b', details: [] });
    const result = await run(db, transport({ listed: [] }));
    assert.equal(result.status, 'committed', JSON.stringify(result));
    const row = byId(await read(db), 'order-b');
    assert.deepEqual([Number(row.closureReceiptId), row.closureMergedIntoOrderId, row.status], [610, null, 1]);
  } finally { await db.close(); }
});

test('migration is atomic on rollback and helpers stay private', async () => {
  const db = await database([receiptEvidence]);
  try {
    await commit(db, [memberB]);
    await db.exec('begin'); await db.exec(merged); await db.exec('rollback');
    assert.equal((await db.query("select count(*)::int n from information_schema.columns where table_schema='pos_open_orders_private' and column_name='closure_merged_into_order_id'")).rows[0].n, 0);
    assert.equal((await read(db)).recoveryContractVersion, 2);
    await db.exec(merged);
    assert.equal((await read(db)).recoveryContractVersion, 3);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await db.exec('set role ' + role);
      try {
        for (const fn of ["merge_receipt_menu_v1('{}'::jsonb)", "merge_order_menu_v1('[]'::jsonb)", 'merge_zero_v1(null)']) {
          await assert.rejects(db.query(`select pos_open_orders_private.${fn}`), /permission denied/, `${role} ${fn}`);
        }
      } finally { await db.exec('reset role'); }
    }
  } finally { await db.close(); }
});

test('/tables after the merge: merged tables are history (not occupied, not unknown) and totals stay countable', async () => {
  const db = await seeded();
  try {
    await receipt(db);
    assert.equal((await run(db)).status, 'committed');
    const snapshot = await read(db);
    const receipts = (await links(db)).map(r => ({ ...r, tableName: '2', paidAt: at(20) }));
    const nowAt = new Date(Date.parse(snapshot.sync.lastSuccessAt) + 30_000);
    const view = buildTableOverview({ businessDate: date, now: nowAt, enabled: true, catalog: babaTableCatalog(), cutoff: '03:00',
      collectionExpected: true, sync: snapshot.sync, orders: snapshot.orders, receipts });
    const state = name => view.tables.find(t => t.name === name).state;
    assert.equal(state('BAR9'), 'idle');
    assert.equal(state('BAR11'), 'idle');
    assert.equal(state('13'), 'occupied');
    assert.equal(view.summary.unknown, 0);
    assert.equal(view.summary.occupied, 1);
  } finally { await db.close(); }
});

test('preflight -> apply -> postflight all pass; documented rollback restores contract 2 and the single-order proof', async () => {
  const checks = async (db, name) => (await db.query(readFileSync(`docs/sql/pos-open-orders-merged-receipt-evidence-${name}.sql`, 'utf8'))).rows
    .filter(row => row.pass !== true).map(row => row.check_name);
  const db = await database([receiptEvidence]);
  try {
    assert.deepEqual(await checks(db, 'preflight'), []);
    await db.exec(merged);
    assert.deepEqual(await checks(db, 'postflight'), []);
    assert.ok((await checks(db, 'preflight')).includes('merge columns are not present yet'));
    // A merge closure exists when rolling back: it is cleared, provider facts stay.
    await commit(db, [target, memberA, memberB, other]);
    await receipt(db);
    assert.equal((await run(db)).status, 'committed');
    await db.exec(readFileSync('docs/sql/pos-open-orders-merged-receipt-evidence-rollback.sql', 'utf8'));
    const after = await read(db);
    assert.equal(after.recoveryContractVersion, 2);
    assert.deepEqual([byId(after, 'order-a').closureReceiptId, byId(after, 'order-a').status, 'closureMergedIntoOrderId' in byId(after, 'order-a')], [null, 1, false]);
    assert.equal((await db.query("select count(*)::int n from pg_proc where proname like 'merge\_%'")).rows[0].n, 0);
    assert.deepEqual(await checks(db, 'preflight'), []);
    // Back to the pre-fix guard for merged orders (never a silent pass) ...
    assert.equal((await run(db)).code, 'orders_vanished_unconfirmed');
    // ... while the existing single-order receipt proof still works.
    const fresh = await database([receiptEvidence, merged]);
    try {
      await fresh.exec(readFileSync('docs/sql/pos-open-orders-merged-receipt-evidence-rollback.sql', 'utf8'));
      await commit(fresh, [memberB]);
      await receipt(fresh, { id: 610, orderId: 'order-b', details: [] });
      assert.equal((await run(fresh, transport({ listed: [] }))).status, 'committed');
    } finally { await fresh.close(); }
    assert.equal((await db.query('select count(*)::int n from public.pos_sales_receipts')).rows[0].n, 1);
  } finally { await db.close(); }
});
