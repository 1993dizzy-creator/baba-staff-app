import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTableCatalog, buildTableOverview, tableArea } from '../lib/sales/table-overview.ts';
import { calculateStoreBusinessDate } from '../lib/store-settings/business-time-core.ts';
import { catalog, order, input, overview, now, businessDate, uuid } from './helpers/table-overview-fixture.mjs';

test('catalog uses provider UUIDs/names/areas; malformed/duplicate rows and provider failures never become inventory', () => {
  assert.equal(catalog().tables[0].name, 'BAR');
  assert.equal(catalog().tables[0].id, uuid(1));
  const row = { MapObjectID: uuid(1), MapObjectName: 'A1', AreaID: uuid(2), AreaName: 'Tầng 1', IsAvailable: false };
  const envelope = rows => ({ Code: 200, Success: true, Data: { ListTable: rows, AllowMergeTable: 1 } });
  for (const value of [null, {}, { ...envelope([]), Success: false }, { ...envelope([]), ErrorType: 7 },
    envelope([row, row]), envelope([{ ...row, MapObjectID: '' }]), envelope([{ ...row, IsAvailable: 'true' }]),
    envelope([{ ...row, AreaName: '' }])]) assert.throws(() => parseTableCatalog(value, now.toISOString()));
  assert.equal(tableArea('BAR'), 'bar'); assert.equal(tableArea('Tầng 1'), 'floor1'); assert.equal(tableArea('2층'), 'floor2');
  assert.equal(tableArea('Mezzanine'), 'other:Mezzanine');
});

test('one table can contain multiple distinct OrderIds with identical order numbers; exact duplicate collapses', () => {
  const first = order(), second = order('order-2');
  const result = overview({ orders: [first, first, second] });
  const table = result.tables.find(t => t.name === 'A1');
  assert.equal(table.state, 'occupied'); assert.equal(result.summary.occupied, 1);
  assert.equal(table.orders.length, 2); assert.deepEqual(table.orders.map(o => o.id), ['order-1', 'order-2']);
  assert.equal(table.orders[0].lines[0].quantity, 2);
  assert.equal(table.orders[0].lines[0].price, 50000);
  assert.equal(table.orders[0].amount, 100000);
  const conflict = overview({ orders: [first, { ...first, totalAmount: 999 }] });
  assert.ok(conflict.tables.every(t => t.state === 'unknown'));
});

test('duplicate names across areas, composites, missing names and unmatched BAR stay unlinked without splitting', () => {
  const orders = [order('a', 'A1'), order('b', 'A1+B1'), order('c', null), order('d', 'BAR')];
  const result = overview({ catalog: catalog([['A1', 'Tầng 1'], ['A1', 'Tầng 2'], ['B1', 'Tầng 2']]), orders });
  assert.equal(result.unlinked.length, 4); assert.ok(result.tables.every(t => t.state === 'unknown'));
  const exact = overview({ orders: [order('bar', ' BAR ')] });
  assert.equal(exact.tables[0].state, 'occupied'); assert.equal(exact.tables[0].orders.length, 1);
});

test('historical IsAvailable never certifies vacancy or blocks an independently verified open order', () => {
  const result = overview({ catalog: { ...catalog(), tables: catalog().tables.map(t => ({ ...t, available: true })) } });
  assert.equal(result.tables[1].state,'occupied');assert.equal(result.tables[0].state,'idle');
  assert.equal(result.summary.free, null); assert.equal(result.summary.reserved, null); assert.equal(result.summary.paid, 0);
  for (const status of [4, 5, 6, 7, 8]) assert.notEqual(overview({ orders: [order('a', 'A1', { status })] }).tables[1].state, 'occupied');
});

test('paid receipt excludes the order estimate; canceled receipt or multiple active receipts are uncertain', () => {
  const base = { orderId: 'order-1', receiptId: 1, paymentStatus: 3, isCanceled: false, businessDate };
  for (const receipts of [[base], [{ ...base, isCanceled: true }], [base, { ...base, receiptId: 2 }]]) {
    const result = overview({ receipts });
    assert.equal(result.tables[1].state, 'unknown');
    assert.equal(result.tables[1].orders[0].verifiedOpen, false);
    assert.equal(result.summary.paid, null, 'receipt is not proof of current table paid state');
  }
  assert.equal(overview({ receipts: [{ ...base, paymentStatus: 1 }] }).tables[1].state, 'occupied');
});

test('missing, stale, failed/incomplete, future timestamps and wrong business day never show live occupancy', () => {
  const base = input();
  const variants = [ { enabled: false }, { sync: null }, { sync: { ...base.sync, lastSuccessAt: '2026-11-13T10:00:00Z' } },
    { sync: { ...base.sync, businessDate: '2026-11-12' } }, { sync: { ...base.sync, lastSuccessAt: '2026-11-13T14:00:00Z' } },
    ...['orders_vanished_unconfirmed', 'provider_timeout'].map(lastErrorCode => ({ sync: { ...base.sync, lastErrorCode } })),
    { orders: [order('a', 'A1', { providerObservedAt: '2026-11-13T10:00:00Z' })] },
    { catalog: { ...base.catalog, collectedAt: '2026-11-13T10:00:00Z' } },
  ];
  for (const changes of variants) assert.ok(overview(changes).tables.every(t => t.state !== 'occupied'), JSON.stringify(changes));
  assert.ok(overview({ orders: [order('a', 'A1', { businessDate: '2026-11-12' })] }).tables.every(t => t.state === 'idle'));
  const missing = overview({ catalog: { status: 'not_enabled', tables: [], collectedAt: null } });
  assert.equal(missing.summary.total, null); assert.equal(missing.tables.length, 0); assert.equal(missing.unlinked.length, 1);
});

test('menu review retains source details but flags review; missing details cannot certify occupied', () => {
  const row = order(); row.lines[0].lineStatus = 6;
  assert.equal(overview({ orders: [row] }).tables[1].orders[0].detailsNeedReview, true);
  const result = overview({ orders: [order('a', 'A1', { lines: null })] });
  assert.equal(result.tables[1].state, 'unknown'); assert.equal(result.tables[1].orders[0].lines, null);
});

test('03:00 cutoff keeps previous business date through 02:59:59, including before collection starts', () => {
  assert.equal(calculateStoreBusinessDate('2026-11-13T02:59:59+07:00'), '2026-11-12');
  assert.equal(calculateStoreBusinessDate('2026-11-13T03:00:00+07:00'), businessDate);
  const morning = input({ now: new Date('2026-11-13T16:00:00+07:00') });
  assert.ok(buildTableOverview(morning).tables.every(t => t.state === 'unknown'));
});
