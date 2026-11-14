// Synthetic replay of the production shape observed on 2026-11-14 around 20:27-20:30 (+07).
// No production identifiers, amounts or customer data. Shape only:
// - the open-order collector already reports an order as Status 4 (paid) without a table name,
// - the receipt collector still holds that order's receipt as pending (PaymentStatus 1),
//   naming the table, until its next 5-minute run flips it to PaymentStatus 3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTableOverview } from '../lib/sales/table-overview.ts';
import { babaTableCatalog } from '../lib/sales/baba-table-catalog.ts';
import { order } from './helpers/table-overview-fixture.mjs';

const businessDate = '2026-11-14';
const now = new Date('2026-11-14T13:29:00Z'); // 20:29 +07
const observed = '2026-11-14T13:27:20Z'; // 20:27:20 +07 collector commit
const sync = { businessDate, lastSuccessAt: observed, lastAttemptAt: observed, lastErrorCode: null };
const at = hhmm => `2026-11-14T${hhmm}:00+07:00`;
const open = (id, table, start) => order(id, table, { businessDate, orderDate: at(start), providerObservedAt: observed });
const paidOrder = (id, start) => order(id, null, { status: 4, lines: null, businessDate, orderDate: at(start), providerObservedAt: observed });
const receipt = (receiptId, orderId, tableName, paidAt, paymentStatus = 3) =>
  ({ orderId, receiptId, paymentStatus, isCanceled: false, businessDate, tableName, paidAt: at(paidAt) });

const paidBefore = [['p7', '7', '18:10', '19:25'], ['p17', '17', '18:17', '19:37'], ['p15', '15', '18:11', '20:02'], ['p5', '5', '19:23', '20:12']];
const occupied = [['o1', '1', '18:46'], ['o13', '13', '19:32'], ['o18', '18', '19:46'], ['o4', '4', '19:52'], ['o12', '12', '20:16'],
  ['oBAR9', 'BAR9', '17:38'], ['oBAR11', 'BAR11', '20:17'], ['oBAR7', 'BAR7', '20:22'], ['o6', '6', '20:22']];

const build = transition => buildTableOverview({
  businessDate, now, enabled: true, catalog: babaTableCatalog(), sync, collectionExpected: true, cutoff: '03:00',
  orders: [...paidBefore.map(([id, , start]) => paidOrder(id, start)), ...occupied.map(([id, table, start]) => open(id, table, start)),
    ...transition.orders],
  receipts: [...paidBefore.map(([id, table, , paid], i) => receipt(8000 + i, id, table, paid)), ...transition.receipts],
});
const state = (view, name) => view.tables.find(t => t.name === name).state;

test('baseline before the transition: four paid tables and the occupied tables are shown', () => {
  // Table 11 is still open (Status 3, payment requested) with a pending receipt: occupied wins.
  const view = build({ orders: [order('t11', '11', { status: 3, businessDate, orderDate: at('19:11'), providerObservedAt: observed })],
    receipts: [receipt(8100, 't11', '11', '20:18', 1)] });
  assert.equal(view.summary.paid, 4);
  assert.equal(state(view, '11'), 'occupied');
  for (const [, table] of paidBefore) assert.equal(state(view, table), 'paid');
});

test('20:27-20:30 window: one table between POS paid and receipt paid must not erase other tables', () => {
  // Order already Status 4 (table name dropped by POS); receipt still pending and names table 11.
  const view = build({ orders: [paidOrder('t11', '19:11')], receipts: [receipt(8100, 't11', '11', '20:18', 1)] });
  // Only the transitioning table is uncertain; it is placed by its own receipt, not left store-wide.
  assert.equal(state(view, '11'), 'unknown');
  assert.equal(view.unlinked.some(o => o.id === 't11'), false);
  for (const [, table] of paidBefore) assert.equal(state(view, table), 'paid', `table ${table}`);
  for (const [, table] of occupied) assert.equal(state(view, table), 'occupied', `table ${table}`);
  // Exact totals stay unavailable while one table is unknown (Owner-confirmed: never a guessed count).
  assert.equal(view.summary.unknown, 1);
  assert.equal(view.summary.paid, null);
});

test('after the receipt flips to paid the table becomes paid and totals recover', () => {
  const view = build({ orders: [paidOrder('t11', '19:11')], receipts: [receipt(8100, 't11', '11', '20:24')] });
  assert.equal(state(view, '11'), 'paid');
  assert.equal(view.summary.paid, 5);
  assert.equal(view.summary.unknown, 0);
});

test('a Status 4 order with no receipt at all still blocks store-wide (location unknown)', () => {
  const view = build({ orders: [paidOrder('t11', '19:11')], receipts: [] });
  assert.equal(view.unlinked.some(o => o.id === 't11'), true);
  for (const table of ['7', '17', '5']) assert.equal(state(view, table), 'unknown');
});

test('pending receipts never locate an open order or one with two active receipts', () => {
  // An open order without a table name is not placed by a pending receipt: no guessed occupancy.
  const openNoName = build({ orders: [order('t11', null, { businessDate, orderDate: at('19:11'), providerObservedAt: observed })],
    receipts: [receipt(8100, 't11', '11', '20:18', 1)] });
  assert.equal(openNoName.unlinked.some(o => o.id === 't11'), true);
  assert.notEqual(state(openNoName, '11'), 'occupied');
  const twoActive = build({ orders: [paidOrder('t11', '19:11')],
    receipts: [receipt(8100, 't11', '11', '20:18', 1), receipt(8101, 't11', '12', '20:19', 1)] });
  assert.equal(twoActive.unlinked.some(o => o.id === 't11'), true);
  assert.equal(state(twoActive, '7'), 'unknown');
});
