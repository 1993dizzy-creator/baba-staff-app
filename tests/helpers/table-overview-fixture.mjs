// Synthetic offline fixtures only. Never imported by application code.
import { parseTableCatalog, buildTableOverview } from '../../lib/sales/table-overview.ts';
import { mergeOrderDetail, normalizeOrderSummary } from '../../lib/pos/cukcuk/open-orders-core.ts';
export const now = new Date('2026-11-13T13:30:00Z');
export const businessDate = '2026-11-13';
export const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export function catalog(rows = [['BAR', 'BAR'], ['A1', 'Tầng 1'], ['B1', 'Tầng 2']]) {
  return parseTableCatalog({ Code: 200, Success: true, Data: { AllowMergeTable: 1, ListTable: rows.map(([name, area], i) => ({
    MapObjectID: uuid(i + 1), MapObjectName: name, AreaID: uuid(100 + i), AreaName: area, IsAvailable: false,
  })) } }, now.toISOString());
}
export function order(id = 'order-1', tableName = 'A1', overrides = {}) {
  const raw = { Id: id, No: '1.1', Date: now.toISOString(), Status: 1, TotalAmount: 100000, TableName: tableName };
  const collected = mergeOrderDetail(normalizeOrderSummary(raw), { Data: { ...raw,
    OrderDetails: [{ Id: 'menu-1', ItemName: 'Synthetic menu', Quantity: 2, Price: 50000, Amount: 100000, Status: 1 }],
  } }, '03:00');
  return { ...collected, providerObservedAt: now.toISOString(), ...overrides };
}
export function input(overrides = {}) {
  return { now, businessDate, enabled: true, catalog: catalog(),
    sync: { businessDate, lastSuccessAt: now.toISOString(), lastAttemptAt: now.toISOString(), lastErrorCode: null },
    orders: [order()], receipts: [], ...overrides };
}
export const overview = overrides => buildTableOverview(input(overrides));
