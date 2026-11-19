// 2026-11-19 P0: between POS Status 4 (TableName dropped) and the receipt collector linking the
// paid receipt, an order with NO receipt yet made every non-occupied table unknown. The DB now
// keeps the table the provider last listed for that same order/date (lastTableName). Synthetic
// replay of the 2026-11-14 20:29 shape; no production identifiers or customer data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTableOverview } from '../lib/sales/table-overview.ts';
import { babaTableCatalog } from '../lib/sales/baba-table-catalog.ts';
import { unavailableTableOverview } from '../lib/sales/table-detail-refresh.ts';
import { order } from './helpers/table-overview-fixture.mjs';

const businessDate = '2026-11-14';
const now = new Date('2026-11-14T13:29:00Z'); // 20:29 +07
const observed = '2026-11-14T13:27:20Z';
const sync = { businessDate, lastSuccessAt: observed, lastAttemptAt: observed, lastErrorCode: null };
const at = hhmm => `2026-11-14T${hhmm}:00+07:00`;
const open = (id, table, start) => order(id, table, { businessDate, orderDate: at(start), providerObservedAt: observed });
const status4 = (id, start, extra = {}) => order(id, null, { status: 4, lines: null, businessDate, orderDate: at(start), providerObservedAt: observed, ...extra });
const last = (table, seen = at('20:22')) => ({ lastTableName: table, lastTableObservedAt: seen });
const receipt = (receiptId, orderId, tableName, paidAt, paymentStatus = 3) =>
  ({ orderId, receiptId, paymentStatus, isCanceled: false, businessDate, tableName, paidAt: at(paidAt) });

const paidBefore = [['p7', '7', '18:10', '19:25'], ['p17', '17', '18:17', '19:37'], ['p15', '15', '18:11', '20:02'], ['p5', '5', '19:23', '20:12']];
const occupied = [['o1', '1', '18:46'], ['o13', '13', '19:32'], ['o4', '4', '19:52'], ['oBAR7', 'BAR7', '20:22']];
const build = (extra, options = {}) => buildTableOverview({
  businessDate, now, enabled: true, catalog: babaTableCatalog(), sync, cutoff: '03:00', ...options,
  orders: [...paidBefore.map(([id, , start]) => status4(id, start)), ...occupied.map(([id, table, start]) => open(id, table, start)), ...extra.orders],
  receipts: [...paidBefore.map(([id, table, , paid], i) => receipt(8000 + i, id, table, paid)), ...(extra.receipts ?? [])],
});
const tile = (view, name) => view.tables.find(t => t.name === name);
const state = (view, name) => tile(view, name).state;
const othersKept = view => {
  for (const [, table] of paidBefore) assert.equal(state(view, table), 'paid', `paid table ${table}`);
  for (const [, table] of occupied) assert.equal(state(view, table), 'occupied', `occupied table ${table}`);
  assert.equal(state(view, '12'), 'idle');
};

test('Status 4 with a last verified table and no receipt: only that table is confirming payment', () => {
  const view = build({ orders: [status4('t11', '19:11', last('11'))] });
  assert.equal(state(view, '11'), 'unknown');
  assert.equal(tile(view, '11').paymentPending, true);
  assert.equal(view.unlinked.length, 0);
  othersKept(view);
  for (const t of view.tables.filter(t => t.name !== '11')) assert.equal(t.paymentPending, undefined, t.name);
  // Never a guessed total while one table is unconfirmed; confirmed occupancy stays countable.
  assert.equal(view.summary.unknown, 1);
  assert.equal(view.summary.paid, null);
  assert.equal(view.summary.occupiedConfirmed, occupied.length);
});

test('without last location (DB migration not applied or never listed) the old store-wide rule stays', () => {
  for (const extra of [{}, { lastTableName: null, lastTableObservedAt: null }]) {
    const view = build({ orders: [status4('t11', '19:11', extra)] });
    assert.equal(view.unlinked.some(o => o.id === 't11'), true);
    for (const table of ['7', '17', '5', '12']) assert.equal(state(view, table), 'unknown');
    assert.equal(view.tables.some(t => t.paymentPending), false);
  }
});

test('single pending receipt keeps the existing placement; same last table agrees', () => {
  for (const extra of [{}, last('11')]) {
    const view = build({ orders: [status4('t11', '19:11', extra)], receipts: [receipt(8100, 't11', '11', '20:18', 1)] });
    assert.equal(state(view, '11'), 'unknown');
    assert.equal(tile(view, '11').paymentPending, true);
    othersKept(view);
  }
});

test('last table and pending receipt disagree: both related tables unknown, nothing else', () => {
  const view = build({ orders: [status4('t11', '19:11', last('11'))], receipts: [receipt(8100, 't11', '12', '20:18', 1)] });
  for (const name of ['11', '12']) {
    assert.equal(state(view, name), 'unknown', name);
    assert.equal(tile(view, name).paymentPending, undefined, name);
  }
  for (const [, table] of paidBefore) assert.equal(state(view, table), 'paid');
  for (const [, table] of occupied) assert.equal(state(view, table), 'occupied');
});

test('two active receipts: existing conflict rule (unlocated, store-wide) even with a last table', () => {
  const view = build({ orders: [status4('t11', '19:11', last('11'))],
    receipts: [receipt(8100, 't11', '11', '20:18', 1), receipt(8101, 't11', '12', '20:19', 1)] });
  assert.equal(view.unlinked.some(o => o.id === 't11'), true);
  assert.equal(state(view, '7'), 'unknown');
});

test('paid receipt collected: normal paid transition, no confirming label', () => {
  const view = build({ orders: [status4('t11', '19:11', last('11'))], receipts: [receipt(8100, 't11', '11', '20:24')] });
  assert.equal(state(view, '11'), 'paid');
  assert.equal(tile(view, '11').paymentPending, undefined);
  assert.equal(view.summary.paid, 5);
  assert.equal(view.summary.unknown, 0);
});

test('canceled or reissued receipt never certifies payment: the table stays unknown', () => {
  const canceled = build({ orders: [status4('t11', '19:11', last('11'))],
    receipts: [{ ...receipt(8100, 't11', '11', '20:24'), isCanceled: true }] });
  assert.notEqual(state(canceled, '11'), 'paid');
  const another = build({ orders: [status4('t11', '19:11', last('11'))], receipts: [receipt(8200, 'other', '11', '20:18', 1)] });
  assert.equal(state(another, '11'), 'unknown');
  assert.equal(tile(another, '11').paymentPending, undefined);
});

test('invalid last evidence is ignored: other day, before the order, future, unknown table', () => {
  const cases = {
    'previous business day (before 03:00 boundary)': last('11', '2026-11-14T02:59:00+07:00'),
    'seen before this order started (reused id)': last('11', at('19:00')),
    'seen after the current observation': last('11', '2026-11-14T13:28:00Z'),
    'not a catalog table': last('99'),
    'malformed time': last('11', 'not-a-time'),
  };
  for (const [name, extra] of Object.entries(cases)) {
    const view = build({ orders: [status4('t11', '19:11', extra)] });
    assert.equal(view.unlinked.some(o => o.id === 't11'), true, name);
    assert.equal(state(view, '12'), 'unknown', name);
    assert.equal(view.tables.some(t => t.paymentPending), false, name);
  }
});

test('03:00 boundary: a same-business-day listing after midnight still places the order', () => {
  const late = buildTableOverview({ businessDate, now: new Date('2026-11-14T19:59:00Z'), enabled: true, catalog: babaTableCatalog(), cutoff: '03:00',
    sync: { businessDate, lastSuccessAt: '2026-11-14T19:58:00Z', lastAttemptAt: '2026-11-14T19:58:00Z', lastErrorCode: null },
    orders: [order('t11', null, { status: 4, lines: null, businessDate, orderDate: at('23:30'), providerObservedAt: '2026-11-14T19:58:00Z',
      ...last('11', '2026-11-15T02:50:00+07:00') })], receipts: [] });
  assert.equal(tile(late, '11').paymentPending, true);
  assert.equal(state(late, '12'), 'idle');
});

test('collection failure, stale or read failure: global safe state, no confirming label', () => {
  const extra = { orders: [status4('t11', '19:11', last('11'))] };
  const views = [build(extra, { readFailed: true }),
    build(extra, { sync: { ...sync, lastErrorCode: 'collection_failed' } }),
    build(extra, { now: new Date('2026-11-14T15:29:00Z') })];
  for (const view of views) {
    for (const name of ['11', '7', '1']) assert.equal(state(view, name), 'unknown');
    assert.equal(view.tables.some(t => t.paymentPending), false);
  }
  const unavailable = unavailableTableOverview(build(extra));
  assert.equal(unavailable.tables.some(t => t.paymentPending), false);
});

test('confirming table is never paid, so cleaning confirm and 30-minute auto-normal stay closed', () => {
  // Both gates require state "paid" (table-cleaning-server confirm, payment observer).
  const view = build({ orders: [status4('t7b', '20:15', last('7'))] });
  assert.equal(state(view, '7'), 'unknown');
  assert.equal(tile(view, '7').paymentPending, true);
  assert.equal(tile(view, '7').lastPaidAt, at('19:25'));
  for (const table of ['17', '15', '5']) assert.equal(state(view, table), 'paid');
});

test('quarantined order is never shown as confirming payment', () => {
  const view = build({ orders: [{ ...open('qa', '11', '19:00'), quarantinedAt: at('20:00') }] });
  assert.equal(state(view, '11'), 'unknown');
  assert.equal(tile(view, '11').paymentPending, undefined);
});
