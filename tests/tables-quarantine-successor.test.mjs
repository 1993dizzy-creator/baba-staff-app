// 2026-11-19 P0: a quarantined (vanished, unproven) order A must not hide an independently
// verified newer order B on the same table, while A itself is never closed, paid or summed.
// Pure projection tests on synthetic ids; DB eligibility lives in tables-quarantine-successor-db.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTableOverview } from '../lib/sales/table-overview.ts';
import { tableDetailEvidenceKey } from '../lib/sales/table-detail-refresh.ts';
import { babaTableCatalog } from '../lib/sales/baba-table-catalog.ts';
import { classifyOrdersForBusinessDate } from '../lib/pos/cukcuk/open-orders-core.ts';
import { input, order, now, businessDate, catalog } from './helpers/table-overview-fixture.mjs';

const at = iso => new Date(iso).toISOString();
// A: last listed 19:40 ICT, quarantined by the 19:45 run. now = 20:30 ICT.
const A = (o = {}) => order('order-a', '14', { orderDate: at('2026-11-13T12:00:00Z'), providerObservedAt: at('2026-11-13T12:40:00Z'),
  quarantinedAt: at('2026-11-13T12:45:00Z'), quarantineReason: 'vanished_unconfirmed', totalAmount: 4520000, ...o });
const B = (o = {}) => order('order-b', '14', { orderDate: at('2026-11-13T13:00:00Z'), totalAmount: 300000, ...o });
const view = changes => buildTableOverview(input({ catalog: babaTableCatalog(), ...changes }));
const t14 = r => r.tables.find(t => t.name === '14');
const paid = (orderId, o = {}) => ({ receiptId: 9001, orderId, paymentStatus: 3, isCanceled: false, businessDate,
  tableName: '14', paidAt: at('2026-11-13T13:20:00Z'), ...o });
const others = r => r.tables.filter(t => t.name !== '14');

test('1. quarantined A alone keeps 14 unknown, collection partial, other tables judged normally', () => {
  const r = view({ orders: [A()] });
  assert.equal(r.tables.length, 27);
  assert.equal(t14(r).state, 'unknown');
  assert.equal(r.collection.health, 'partial');
  assert.ok(others(r).every(t => t.state === 'idle'));
  assert.equal(t14(r).orders[0].quarantined, true);
});

test('2. A + later verified B: 14 occupied, B is the only current order, A amount never summed', () => {
  const r = view({ orders: [A(), B()] });
  const tile = t14(r);
  assert.equal(tile.state, 'occupied');
  assert.deepEqual(tile.orders.filter(o => o.verifiedOpen).map(o => o.id), ['order-b']);
  assert.deepEqual(tile.orders.filter(o => o.quarantined).map(o => o.id), ['order-a']);
  assert.equal(r.collection.health, 'partial');
  assert.equal(r.summary.occupied, 1);
  const classified = classifyOrdersForBusinessDate([A(), B()], [], businessDate);
  assert.deepEqual(classified.open.map(o => o.orderId), ['order-b']);
  assert.equal(classified.open.reduce((s, o) => s + o.totalAmount, 0), 300000);
});

test('3. B overlapping the quarantine window or with weak evidence stays unknown', () => {
  for (const b of [
    B({ orderDate: at('2026-11-13T12:44:00Z') }),           // after A's last listing, before quarantine commit
    B({ orderDate: at('2026-11-13T12:10:00Z') }),           // coexisted with A (possible merge target)
    B({ orderDate: at('2026-11-13T12:45:00Z') }),           // equal is not "clearly after"
    B({ providerObservedAt: at('2026-11-13T13:00:00Z') }),  // stale observation
    B({ status: 4 }),                                       // paid candidate without receipt
  ]) assert.equal(t14(view({ orders: [A(), b] })).state, 'unknown');
  // A third, unconfirmed order on the same table blocks too.
  assert.equal(t14(view({ orders: [A(), B(), order('order-c', '14', { status: 9 })] })).state, 'unknown');
  // A quarantine record without a valid time cannot be ordered.
  assert.equal(t14(view({ orders: [A({ quarantinedAt: 'not-a-time' }), B()] })).state, 'unknown');
  // A quarantine whose last observation is after its quarantine time is malformed.
  assert.equal(t14(view({ orders: [A({ providerObservedAt: at('2026-11-13T12:50:00Z') }), B()] })).state, 'unknown');
  // Failed or stale collection never certifies B.
  assert.equal(t14(view({ orders: [A(), B()], sync: { businessDate, lastSuccessAt: now.toISOString(), lastAttemptAt: now.toISOString(), lastErrorCode: 'incomplete' } })).state, 'unknown');
});

test('4. A + paid B: 14 paid by B receipt once; A stays quarantined, no proof is lent to A', () => {
  const receipts = [paid('order-b')];
  const r = view({ orders: [A(), B()], receipts });
  const tile = t14(r);
  assert.equal(tile.state, 'paid');
  assert.equal(tile.lastPaidAt, receipts[0].paidAt);
  assert.equal(r.summary.paidCumulative, 1);
  const classified = classifyOrdersForBusinessDate([A(), B()], receipts, businessDate);
  assert.equal(classified.converted, 1);
  assert.equal(classified.uncertainReasons?.vanished_unconfirmed ?? classified.uncertain.filter(u => u.orderId === 'order-a').length, 1);
  assert.equal(tile.orders.find(o => o.id === 'order-a').quarantined, true);
  // B started inside the quarantine window: payment is shown nowhere as table completion.
  assert.equal(t14(view({ orders: [A(), B({ orderDate: at('2026-11-13T12:44:00Z') })], receipts })).state, 'unknown');
  // A receipt that is not B's (older generation) cannot retire A.
  assert.equal(t14(view({ orders: [A()], receipts: [paid('order-z', { paidAt: at('2026-11-13T11:00:00Z') })] })).state, 'unknown');
});

test('5. C after paid B takes precedence', () => {
  const C = order('order-c', '14', { orderDate: at('2026-11-13T13:25:00Z') });
  const tile = t14(view({ orders: [A(), B(), C], receipts: [paid('order-b')] }));
  assert.equal(tile.state, 'occupied');
  assert.deepEqual(tile.orders.filter(o => o.verifiedOpen).map(o => o.id), ['order-c']);
});

test('6. A reappears or is canceled: re-evaluated from the latest real state', () => {
  const back = A({ quarantinedAt: null, quarantineReason: null, providerObservedAt: now.toISOString() });
  const r = view({ orders: [back, B()] });
  assert.equal(t14(r).state, 'occupied');
  assert.equal(t14(r).orders.filter(o => o.verifiedOpen).length, 2);
  assert.equal(r.collection.health, 'healthy');
  const canceled = view({ orders: [A({ quarantinedAt: null, quarantineReason: null, status: 5, providerObservedAt: now.toISOString() }), B()] });
  assert.equal(t14(canceled).state, 'occupied');
  assert.deepEqual(t14(canceled).orders.map(o => o.id), ['order-b']);
});

test('7. same OrderId moved to another table is a move, not a new visit', () => {
  const moved = order('order-x', '7', { orderDate: at('2026-11-13T12:00:00Z') });
  const r = view({ orders: [moved] });
  assert.equal(r.tables.find(t => t.name === '7').state, 'occupied');
  assert.equal(t14(r).state, 'idle');
  assert.equal(r.summary.occupied, 1);
});

test('8. merge into an order that already existed (same or other table) stays unknown on 14', () => {
  const existing = B({ orderDate: at('2026-11-13T11:50:00Z') });
  assert.equal(t14(view({ orders: [A(), existing] })).state, 'unknown');
  const bar1 = order('order-bar1', 'BAR1', { orderDate: at('2026-11-13T11:30:00Z'), totalAmount: 4970000 });
  const r = view({ orders: [A(), bar1] });
  assert.equal(r.tables.find(t => t.name === 'BAR1').state, 'occupied');
  assert.equal(t14(r).state, 'unknown');
});

test('9. receipt lag, cancellation and reissue', () => {
  // Status 4 before its receipt is collected: not current, not paid.
  assert.equal(t14(view({ orders: [A(), B({ status: 4 })] })).state, 'unknown');
  const canceled = paid('order-b', { receiptId: 9001, isCanceled: true, paymentStatus: 4 });
  assert.equal(t14(view({ orders: [A(), B({ status: 4 })], receipts: [canceled] })).state, 'unknown');
  const reissued = paid('order-b', { receiptId: 9002, paidAt: at('2026-11-13T13:25:00Z') });
  const tile = t14(view({ orders: [A(), B({ status: 4 })], receipts: [canceled, reissued] }));
  assert.equal(tile.state, 'paid');
  assert.equal(tile.lastPaidAt, reissued.paidAt);
});

test('10. composite, missing and duplicate table names never split or locate evidence', () => {
  for (const tableName of ['BAR1, 14', null]) {
    const r = view({ orders: [A(), B({ tableName })] });
    assert.equal(t14(r).state, 'unknown');
    assert.ok(r.unlinked.some(o => o.id === 'order-b'));
  }
  const dup = buildTableOverview(input({ catalog: catalog([['14', 'Tầng 1'], ['14', 'Tầng 2']]), orders: [A(), B()] }));
  assert.ok(dup.tables.every(t => t.state === 'unknown'));
});

test('11. 02:59:59 / 03:00:00 business-day boundary', () => {
  const late = new Date('2026-11-14T02:59:59+07:00');
  const sync = { businessDate, lastSuccessAt: late.toISOString(), lastAttemptAt: late.toISOString(), lastErrorCode: null };
  const b = B({ orderDate: at('2026-11-14T02:50:00+07:00'), providerObservedAt: late.toISOString() });
  assert.equal(t14(view({ now: late, sync, orders: [A(), b] })).state, 'occupied');
  const next = new Date('2026-11-14T03:00:00+07:00');
  assert.equal(t14(view({ now: next, sync, orders: [A(), b] })).state, 'unknown');
});

test('12. quarantine changes always change the detail refresh key', () => {
  const quarantined = view({ orders: [A(), B()] }), restored = view({ orders: [A({ quarantinedAt: null, quarantineReason: null }), B()] });
  const id = t14(quarantined).id;
  assert.notEqual(tableDetailEvidenceKey(quarantined, id), tableDetailEvidenceKey(restored, id));
  assert.notEqual(t14(quarantined).detailEvidence, t14(restored).detailEvidence);
  const requarantined = view({ orders: [A({ quarantinedAt: at('2026-11-13T13:10:00Z') }), B()] });
  assert.notEqual(t14(quarantined).detailEvidence, t14(requarantined).detailEvidence);
});
