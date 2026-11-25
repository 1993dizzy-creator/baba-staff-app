// BABA-TABLE-MERGE-02 final: a merge linked before payment and paid by one receipt (#9081, TableName
// "BAR9, 2") gives each named table its own DB cleaning/auto-normal key, exactly like an ordinary
// payment. Real migration chain in production order on PGlite (v1..v3 -> cleaning -> auto-normal ->
// quarantine -> successor evidence -> last table) + 20261125123044 merge links + 20261125134901,
// the real collector and the real table projection. Synthetic ids; no customer data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import * as core from '../lib/pos/cukcuk/open-orders-core.ts';
import { buildTableOverview } from '../lib/sales/table-overview.ts';
import { babaTableCatalog, BABA_TABLES } from '../lib/sales/baba-table-catalog.ts';
import { applyPaymentObservations } from '../lib/sales/table-auto-normal.ts';
import { installCleaningFixture, context, confirm, addOrder, scope, tableId as BAR4 } from './helpers/tables-cleaning-fixture.mjs';
import { AUTO_NORMAL, enableAuto, autoContext, observe } from './helpers/tables-auto-normal-fixture.mjs';

const sql = name => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const CHAIN = [AUTO_NORMAL, sql('20261119080000_pos_open_orders_vanished_quarantine.sql'),
  sql('20261119123459_tables_quarantine_successor_evidence.sql'), sql('20261119144531_pos_open_orders_last_verified_table.sql'),
  sql('20261125123044_pos_open_orders_merge_links.sql')];
const EVIDENCE = sql('20261125134901_tables_merge_link_evidence.sql');
const branchId = scope.split(':')[1];
const idOf = name => BABA_TABLES.find(t => t.MapObjectName === name).MapObjectID;
const T2 = idOf('2'), BAR9 = idOf('BAR9');
const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';

async function setup({ evidence = true } = {}) {
  const db = new PGlite();
  const day = await installCleaningFixture(db, { afterCleaning: async d => { for (const m of CHAIN) await d.exec(m); if (evidence) await d.exec(EVIDENCE); } });
  await db.exec('update table_operations_private.config set enabled=true');
  return { db, day };
}
const ln = (id, itemId, itemName, quantity, price) => ({ detailId: id, parentDetailId: null, additionId: null, itemId, itemName,
  unitName: null, quantity, price, amount: quantity * price, lineStatus: 1, isOption: false, isOrphanOption: false, isCanceled: false });
const fixtureOrders = day => {
  const at = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
  const order = (orderId, tableName, ago, lines) => ({ orderId, orderNo: orderId, status: 1, statusClass: 'open', orderDate: at(ago),
    businessDate: day, tableName, lines, totalAmount: lines.reduce((s, l) => s + l.amount, 0) });
  const t2 = order('order-t2', '2', 100, [ln('t2-l1', null, 'Sex on the beach', 2, 190000)]);
  const bar9 = order('order-bar9', 'BAR9', 95, [ln('b9-l1', 'item-k3', 'Bia', 1, 99000)]);
  const lines = [...bar9.lines, ...t2.lines.map(l => ({ ...l, detailId: 'm-' + l.detailId }))];
  const bar9Merged = { ...bar9, tableName: 'BAR9, 2', lines, totalAmount: lines.reduce((s, l) => s + l.amount, 0) };
  const t5 = order('order-t5', '5', 90, [ln('t5-l1', 'item-k3', 'Bia', 2, 99000)]);
  const newcomer = order('order-t2-new', '2', 1, [ln('n-l1', 'item-k3', 'Bia', 1, 99000)]);
  return { t2, bar9, bar9Merged, t5, newcomer };
};

async function rpc(db, name, args) {
  const names = { pos_open_orders_claim: ['p_run_id', 'p_owner_token', 'p_scope', 'p_branch_id', 'p_business_date'],
    pos_open_orders_commit: ['p_run_id', 'p_owner_token', 'p_manifest', 'p_orders'], pos_open_orders_read: ['p_scope', 'p_business_date'],
    pos_open_orders_fail: ['p_run_id', 'p_owner_token', 'p_code'] }[name];
  const values = names.map(key => typeof args[key] === 'object' ? JSON.stringify(args[key]) : args[key]);
  if (name === 'pos_open_orders_claim') values.push(0);
  await db.exec('set role service_role');
  try { return (await db.query(`select public.${name}(${values.map((_, i) => '$' + (i + 1)).join(',')}) as result`, values)).rows[0].result; }
  catch (error) { throw new Error(core.openOrdersRpcErrorCode(error)); }
  finally { await db.exec('reset role'); }
}
async function seed(db, day, rows) {
  const p_run_id = randomUUID(), p_owner_token = randomUUID();
  await rpc(db, 'pos_open_orders_claim', { p_run_id, p_owner_token, p_scope: scope, p_branch_id: branchId, p_business_date: day });
  return rpc(db, 'pos_open_orders_commit', { p_run_id, p_owner_token, p_manifest: {}, p_orders: rows });
}
async function receipts(db, day) {
  return (await db.query(`select id, branch_id, business_date::text bd, payment_status, is_canceled, total_amount, discount_amount,
    raw_json->>'OrderId' oid, raw_json->'DiscountAmount' d1, raw_json->'PromotionAmount' d2, raw_json->'PromotionItemsAmount' d3,
    raw_json->'SAInvoiceDetails' details, raw_json->>'TableName' tn, ref_date
    from public.pos_sales_receipts where source='cukcuk' and business_date in ($1::date, $1::date + 1) order by id`, [day])).rows
    .map(r => ({ orderId: r.oid ?? '', receiptId: Number(r.id), paymentStatus: r.payment_status, isCanceled: r.is_canceled, businessDate: r.bd,
      branchId: r.branch_id, totalAmount: Number(r.total_amount), discountAmount: Number(r.discount_amount), headerDiscounts: [r.d1, r.d2, r.d3],
      details: r.details, tableName: r.tn, refDate: r.ref_date ? new Date(r.ref_date).toISOString() : null }));
}
const header = (o, extra = {}) => ({ Id: o.orderId, No: o.orderNo, Date: o.orderDate, Status: o.status, TotalAmount: o.totalAmount, TableName: o.tableName, ...extra });
function transport({ listed = [], paid = [] }) {
  const rows = [...listed.map(o => header(o)), ...paid.map(o => header(o, { Status: 4, TableName: null }))];
  return { login: async () => {}, sleep: async () => {}, send: async request => {
    if (request.kind === 'page') return { status: 200, json: { Success: true, Total: rows.length, Data: rows } };
    const known = listed.find(o => o.orderId === request.orderId);
    if (!known) return { status: 200, json: { Success: true, Data: { Id: EMPTY_GUID, Date: '0001-01-01T00:00:00', Status: 0, TotalAmount: 0, OrderDetails: [] } } };
    return { status: 200, json: { Success: true, Data: { ...header(known), OrderDetails: known.lines.map(l => ({ Id: l.detailId, ItemId: l.itemId,
      ParentId: null, AdditionId: null, ItemName: l.itemName, Quantity: l.quantity, Price: l.price, Amount: l.amount, Status: 1 })) } } };
  } };
}
async function collect(db, day, t) {
  const result = await core.runOpenOrderSync({ rpc: (n, a) => rpc(db, n, a), transport: t, uuid: randomUUID,
    loadReceiptEvidence: () => receipts(db, day), loadMergeReceiptEvidence: () => receipts(db, day) },
  { scope, branchId, businessDate: day, windowFrom: new Date(`${day}T03:00:00+07:00`).toISOString(), cutoff: '03:00' });
  assert.equal(result.status, 'committed', JSON.stringify(result));
  return result;
}
async function addReceipt(db, day, { id = 9081, orderId = 'order-bar9', tableName = 'BAR9, 2', amount, paidAgo = 2 }) {
  await db.query(`insert into pos_sales_receipts(id,source,branch_id,business_date,payment_status,is_canceled,total_amount,final_amount,ref_date,ref_no,raw_json)
    values($1::bigint,'cukcuk',$2,$3,3,false,$4,$4,clock_timestamp()-($5||' minutes')::interval,$7,$6)`,
  [id, branchId, day, amount, String(paidAgo), JSON.stringify({ OrderId: orderId, TableName: tableName, SAInvoiceDetails: [] }), String(id)]);
}
/** Same composition as lib/sales/table-cleaning-server.ts readCleaningState (manual + automatic). */
function board(ctx, day) {
  const overview = buildTableOverview({ businessDate: day, now: new Date(ctx.serverNow ?? Date.now()), catalog: babaTableCatalog(), enabled: true,
    sync: ctx.snapshot.sync, cutoff: '03:00', orders: ctx.snapshot.orders.map(o => ({ ...o, totalAmount: Number(o.totalAmount), raw: {} })),
    receipts: ctx.receipts.map(r => ({ receiptId: r.id, orderId: r.order_id ?? '', tableName: r.table_name, businessDate: r.business_date,
      paymentStatus: r.payment_status, isCanceled: r.is_canceled, paidAt: r.ref_date })) });
  for (const t of overview.tables) if (t.state === 'paid' && ctx.cleanedTableIds.includes(t.id) && ctx.keys[t.id]) { t.state = 'idle'; delete t.merge; }
  if (ctx.observations) applyPaymentObservations(overview, ctx.observations, ctx.keys, ctx.reviewTableIds);
  return overview;
}
const tileOf = (overview, id) => overview.tables.find(t => t.id === id);

/** Merge at -60 min (linked), BAR9 paid with #9081 two minutes ago and the link closed. */
async function mergedAndPaid({ evidence = true } = {}) {
  const { db, day } = await setup({ evidence });
  const o = fixtureOrders(day);
  await seed(db, day, [o.bar9, o.t2, o.t5]);
  await collect(db, day, transport({ listed: [o.bar9Merged, o.t5] }));
  await addReceipt(db, day, { amount: o.bar9Merged.totalAmount });
  await collect(db, day, transport({ listed: [o.t5], paid: [o.bar9Merged] }));
  const row = (await db.query("select merge_target_order_id m, closure_receipt_id c from pos_open_orders_private.orders where order_id='order-t2'")).rows[0];
  assert.deepEqual([row.m, Number(row.c)], ['order-bar9', 9081]);
  return { db, day, o };
}

test('RED without 20261125134901: a linked merged payment has no DB key on either table (no cleaning, no 30-minute return)', async () => {
  const { db, day } = await mergedAndPaid({ evidence: false });
  try {
    const ctx = await context(db, day);
    assert.deepEqual([ctx.keys[T2], ctx.keys[BAR9]], [undefined, undefined]);
    const overview = board(ctx, day);
    assert.deepEqual([tileOf(overview, T2).state, tileOf(overview, BAR9).state], ['paid', 'paid']); // display only
  } finally { await db.close(); }
});

test('GREEN: both tables blue with their own keys; manual cleaning of 2 does not clean BAR9; one receipt counted once', async () => {
  const { db, day } = await mergedAndPaid();
  try {
    let ctx = await context(db, day);
    assert.equal(ctx.keys[T2].receiptId, 9081);
    assert.equal(ctx.keys[BAR9].receiptId, 9081);
    assert.notEqual(ctx.keys[T2].evidenceKey, ctx.keys[BAR9].evidenceKey); // independent per table
    let overview = board(ctx, day);
    assert.deepEqual([T2, BAR9].map(id => [tileOf(overview, id).state, tileOf(overview, id).merge?.paid]), [['paid', true], ['paid', true]]);
    assert.equal(overview.summary.paidCumulative, 2); // fixture BAR4 receipt + #9081 once (not once per table)
    // Confirm table 2 only, with its own key (same RPC, permission and lock order as any table).
    const key = ctx.keys[T2];
    await db.exec('set role service_role');
    try {
      const saved = (await db.query('select public.tables_cleaning_confirm_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) r',
        [scope, day, T2, 1, randomUUID(), key.receiptId, key.evidenceKey, JSON.stringify(ctx.snapshot), JSON.stringify(ctx.receipts)])).rows[0].r;
      assert.equal(saved.saved, true);
    } finally { await db.exec('reset role'); }
    ctx = await context(db, day);
    assert.deepEqual(ctx.cleanedTableIds, [T2]);
    overview = board(ctx, day);
    assert.deepEqual([tileOf(overview, T2).state, tileOf(overview, T2).merge, tileOf(overview, BAR9).state], ['idle', undefined, 'paid']);
    assert.equal(overview.summary.paidCumulative, 2);
  } finally { await db.close(); }
});

test('GREEN: 30 minutes after the first verified observation both merged tables return to normal automatically', async () => {
  const { db, day } = await mergedAndPaid();
  try {
    const activation = await enableAuto(db);
    let ctx = await autoContext(db, day, activation);
    assert.ok(ctx.keys[T2].autoKey && ctx.keys[BAR9].autoKey);
    assert.equal((await observe(db, day, activation, ctx, [T2, BAR9])).saved, 2);
    ctx = await autoContext(db, day, activation);
    let overview = board(ctx, day);
    assert.deepEqual([T2, BAR9].map(id => [tileOf(overview, id).state, tileOf(overview, id).paymentObservation?.expired]), [['paid', false], ['paid', false]]);
    await db.exec("update table_operations_private.payment_observations set first_verified_at=clock_timestamp()-interval '31 minutes'");
    ctx = await autoContext(db, day, activation);
    overview = board(ctx, day);
    assert.deepEqual([T2, BAR9].map(id => [tileOf(overview, id).state, tileOf(overview, id).merge]), [['idle', undefined], ['idle', undefined]]);
  } finally { await db.close(); }
});

test('a new customer on table 2 after the merged payment: 2 is occupied first and loses its key; BAR9 keeps its own', async () => {
  const { db, day, o } = await mergedAndPaid();
  try {
    const before = await context(db, day);
    await collect(db, day, transport({ listed: [o.t5, o.newcomer], paid: [o.bar9Merged] }));
    const ctx = await context(db, day);
    assert.equal(ctx.keys[T2], undefined);
    assert.equal(ctx.keys[BAR9].receiptId, 9081);
    assert.equal(ctx.keys[BAR9].evidenceKey, before.keys[BAR9].evidenceKey); // independent: a new order on 2 never touches BAR9
    const overview = board(ctx, day);
    assert.deepEqual([tileOf(overview, T2).state, tileOf(overview, BAR9).state], ['occupied', 'paid']);
    assert.equal((await db.query("select merge_target_order_id m from pos_open_orders_private.orders where order_id='order-t2'")).rows[0].m, 'order-bar9');
  } finally { await db.close(); }
});

test('receipt canceled after cleaning: the cleaning event is invalidated and neither table keeps a key', async () => {
  const { db, day } = await mergedAndPaid();
  try {
    const ctx = await context(db, day);
    const key = ctx.keys[T2];
    await db.exec('set role service_role');
    try {
      await db.query('select public.tables_cleaning_confirm_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) r',
        [scope, day, T2, 1, randomUUID(), key.receiptId, key.evidenceKey, JSON.stringify(ctx.snapshot), JSON.stringify(ctx.receipts)]);
    } finally { await db.exec('reset role'); }
    await db.exec('update public.pos_sales_receipts set payment_status=4, is_canceled=true where id=9081');
    assert.equal(Number((await db.query('select count(*) n from table_operations_private.invalidations')).rows[0].n), 1);
    const after = await context(db, day);
    assert.deepEqual([after.keys[T2], after.keys[BAR9], after.cleanedTableIds], [undefined, undefined, []]);
  } finally { await db.close(); }
});

test('proof-only merge (no link, #8885 shape) still blocks cleaning exactly as before', async () => {
  const { db, day } = await setup();
  try {
    const o = fixtureOrders(day);
    await seed(db, day, [o.bar9, o.t2, o.t5]);
    // Merge and payment between two runs: closed by the 11/14 proof, never linked. The receipt names BAR9 only.
    await addReceipt(db, day, { amount: o.bar9Merged.totalAmount, tableName: 'BAR9' });
    await db.exec(`update public.pos_sales_receipts set raw_json=raw_json||jsonb_build_object('DiscountAmount',0,'PromotionAmount',0,'PromotionItemsAmount',0,
      'SAInvoiceDetails',jsonb_build_array(
        jsonb_build_object('RefDetailType',1,'ItemID','item-k3','ItemName','Bia','Quantity',1,'UnitPrice',99000,'Amount',99000),
        jsonb_build_object('RefDetailType',3,'ItemName','Sex on the beach','Quantity',2,'UnitPrice',190000,'Amount',380000))) where id=9081`);
    await collect(db, day, transport({ listed: [o.t5], paid: [o.bar9Merged] }));
    const row = (await db.query("select merge_target_order_id m, closure_merged_into_order_id t from pos_open_orders_private.orders where order_id='order-t2'")).rows[0];
    assert.deepEqual([row.m, row.t], [null, 'order-bar9']);
    const ctx = await context(db, day);
    assert.deepEqual([ctx.keys[BAR9], ctx.keys[T2]], [undefined, undefined]);
  } finally { await db.close(); }
});

test('single-table regression: keys of ordinary tables are byte-identical before and after 20261125134901', async () => {
  const { db, day } = await setup({ evidence: false });
  try {
    await db.query(`insert into pos_open_orders_private.orders(scope,business_date,order_id,order_no,status,status_class,order_date,total_amount,table_name,has_lines,run_id,observed_at)
      values($1,$2,'paid-order','1',4,'paid_candidate',clock_timestamp()-interval '20 minutes',100000,null,false,'00000000-0000-4000-8000-000000000001',clock_timestamp())`, [scope, day]);
    const evidence = async () => (await db.query('select table_operations_private.evidence_v1($1,$2,$3) e', [scope, day, BAR4])).rows[0].e;
    const before = await evidence();
    assert.equal(before.receiptId, 100);
    await db.exec(EVIDENCE);
    assert.deepEqual(await evidence(), before);
    const ctx = await context(db, day);
    await db.exec('set role service_role');
    try { assert.equal((await confirm(db, day, ctx)).saved, true); } finally { await db.exec('reset role'); }
  } finally { await db.close(); }
});

test('migration scope: only evidence_v1 replaced plus one private helper; no POS/accounting DML; grants closed', () => {
  const code = EVIDENCE.replace(/--.*$/gm, '');
  assert.doesNotMatch(code, /\b(insert\s+into|delete\s+from|update)\s+/i);
  assert.doesNotMatch(code, /\bdrop\b|\btruncate\b|\bgrant\b|\balter\b/i);
  assert.deepEqual([...code.matchAll(/create (?:or replace )?function (\S+)\(/g)].map(m => m[1]),
    ['table_operations_private.merge_link_receipt_v1', 'table_operations_private.evidence_v1']);
  assert.match(code, /revoke all on function table_operations_private\.merge_link_receipt_v1\(text,date,bigint,text\) from public,anon,authenticated,service_role/);
});

test('an earlier ordinary payment never keeps a key once a new in-progress order spans the table ("BAR9, 2"): DB and board', async () => {
  const { db, day } = await setup();
  try {
    await addReceipt(db, day, { id: 300, orderId: 'own-bar9', tableName: 'BAR9', amount: 99000, paidAgo: 5 });
    let ctx = await context(db, day);
    const before = ctx.keys[BAR9];
    assert.equal(before.receiptId, 300); // ordinary single-table key
    await addOrder(db, day, { name: 'BAR9, 2', id: 'combo-new' });
    ctx = await context(db, day);
    assert.deepEqual([ctx.keys[BAR9], ctx.keys[T2]], [undefined, undefined]); // DB blocks regardless of the earlier receipt type
    const overview = board(ctx, day);
    for (const id of [BAR9, T2]) assert.notEqual(tileOf(overview, id).state, 'paid');
    const activation = await enableAuto(db);
    const auto = await autoContext(db, day, activation);
    assert.equal(auto.keys[BAR9], undefined);
  } finally { await db.close(); }
});
