import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { buildDailySalesKpi } from '../lib/sales/daily-kpi.ts';
import { buildOpenOrderKpi, classifyOrdersForBusinessDate, mergeOrderDetail, normalizeOrderSummary } from '../lib/pos/cukcuk/open-orders-core.ts';
import { salesText } from '../lib/text/sales.ts';
import { renderDailySales, dailyCards } from './helpers/daily-sales-kpi-view.mjs';

const businessDate = '2026-11-10';
const now = new Date('2026-11-10T13:30:00Z');
const summary = { totalSales: 1300000, receiptCount: 13, paidReceiptCount: 13,
  salesLineCount: 26, optionLineCount: 5, averageReceiptAmount: 100000, canceledReceiptCount: 2 };
const line = (id, extra = {}) => ({ Id: `line-${id}`, ItemName: `Menu ${id}`, Quantity: 1, Amount: 100000, Status: 1, ...extra });
const order = (id, extra = {}, lines = [line(id)]) => {
  const raw = { Id: `order-${id}`, No: `1.${id}`, Status: 1, Date: '2026-11-10T20:00:00+07:00', TotalAmount: 100000, ...extra };
  return mergeOrderDetail(normalizeOrderSummary(raw), { Data: { ...raw, OrderDetails: lines } }, '03:00');
};
const orders = () => Array.from({ length: 8 }, (_, i) => order(i + 1, { Status: i % 2 ? 3 : 1 }));
const openKpi = (rows = orders(), receipts = [], paid = summary) => buildOpenOrderKpi({ enabled: true, businessDate,
  isLiveBusinessDay: true, isClosed: false, paid: { amount: paid.totalSales, receiptCount: paid.paidReceiptCount },
  sync: { businessDate, lastSuccessAt: '2026-11-10T13:29:00Z', lastAttemptAt: null, lastErrorCode: null },
  classified: classifyOrdersForBusinessDate(rows, receipts, businessDate), now });
const model = (openOrders = openKpi(), extra = {}) => buildDailySalesKpi({ summary, openOrders, businessDate,
  isLiveBusinessDay: true, isClosed: false, ...extra });
const response = (openOrders = openKpi(), extra = {}) => ({ ok: true, businessDate, summary,
  closeCheck: { status: 'not_closed' }, openOrders, ...extra });

test('live four KPIs: 13 paid receipts + 8 orders = 21, paid lines + menu lines, provisional mean', () => {
  const result = model();
  assert.deepEqual([result.amount, result.receiptCount, result.menuLineCount, result.averageAmount, result.mode],
    [2100000, 21, 34, 100000, 'complete']);
  assert.equal(result.openOrders.open.orderCount, 8);
  assert.deepEqual(summary, { totalSales: 1300000, receiptCount: 13, paidReceiptCount: 13,
    salesLineCount: 26, optionLineCount: 5, averageReceiptAmount: 100000, canceledReceiptCount: 2 });
});

test('amount edit and payment conversion update all KPIs without counting an order twice', () => {
  const edited = orders();
  edited[0] = order(1, { Status: 3, TotalAmount: 200000 }, [line(1, { Amount: 200000 })]);
  assert.equal(model(openKpi(edited)).amount, 2200000);
  const nextPaid = { ...summary, totalSales: 1500000, paidReceiptCount: 14, receiptCount: 14, salesLineCount: 27 };
  for (const status of [1, 3, 4]) {
    edited[0] = { ...edited[0], status };
    const receipt = { orderId: 'order-1', receiptId: 14, paymentStatus: 3, isCanceled: false };
    const converted = model(openKpi(edited, [receipt, receipt], nextPaid), { summary: nextPaid });
    assert.deepEqual([converted.amount, converted.receiptCount, converted.menuLineCount], [2200000, 21, 34]);
  }
});

test('menu/option/combo child duplicates stay out of sold-line counts; quantities are not line counts', () => {
  const parent = line(1, { Quantity: 4 });
  const child = line(2, { ParentId: 'line-1', Amount: 20000 });
  const addition = line(3, { AdditionId: 'addition-1', Amount: 5000 });
  const zero = line(4, { Quantity: 0, Amount: 0 });
  const result = model(openKpi([order(1, { TotalAmount: 125000 }, [parent, child, child, addition, zero])]));
  assert.equal(result.menuLineCount, 27);
  assert.equal(result.openOrders.open.optionLineCount, 2);
  assert.equal(result.openOrders.open.itemQuantity, 4);
  assert.equal(result.mode, 'complete');
});

test('true zero open orders is complete; disabled, missing, stale or failed snapshots never mean zero', () => {
  const empty = model(openKpi([]));
  assert.equal(empty.mode, 'complete');
  assert.equal(empty.amount, summary.totalSales);
  assert.equal(empty.averageAmount, summary.averageReceiptAmount);
  for (const status of ['not_enabled', 'unavailable', 'stale', 'incomplete']) {
    const missing = model({ ...openKpi(), status });
    assert.equal(missing.mode, 'unavailable', status);
    assert.deepEqual([missing.amount, missing.receiptCount, missing.menuLineCount, missing.averageAmount], [1300000, 13, 26, null]);
  }
  assert.equal(model(undefined, { openOrders: undefined }).mode, 'unavailable');
  assert.equal(model({ ...openKpi(), businessDate: '2026-11-09' }).mode, 'unavailable');
  assert.equal(model({ ...openKpi(), paid: { amount: 1, receiptCount: 13 } }).mode, 'unavailable');
});

test('Status 5/7/8 orders produce a known subtotal, never a full estimated average', () => {
  for (const status of [5, 7, 8]) {
    const result = model(openKpi([...orders(), order(9, { Status: status, TotalAmount: 700000 })]));
    assert.equal(result.mode, 'partial');
    assert.equal(result.amount, 2100000);
    assert.equal(result.receiptCount, 21);
    assert.equal(result.averageAmount, null);
    assert.equal(result.openOrders.uncertain.reasons.unknown_status, 1);
  }
});

test('Status 6 / detail mismatch preserves header subtotal but never claims unverified menu counts or average', () => {
  const rows = [order(12, { TotalAmount: 200000 }, [line(1), line(2), line(3, { Status: 6 })])];
  const result = model(openKpi(rows));
  assert.equal(result.amount, 1500000);
  assert.equal(result.receiptCount, 14);
  assert.equal(result.menuLineCount, 26);
  assert.equal(result.menuNeedsReview, true);
  assert.equal(result.averageAmount, null);
  assert.equal(result.openOrders.open.menuLineCount, 3); // Central data is not rewritten.
  assert.equal(result.openOrders.detailWarnings[0].lineAmount, 300000);
});

test('closed, historical and server-closed days retain all four existing paid values even with open data', () => {
  for (const extra of [{ isClosed: true }, { isLiveBusinessDay: false }, { openOrders: { ...openKpi(), status: 'closed' } }]) {
    const result = model(openKpi(), extra);
    assert.deepEqual([result.amount, result.receiptCount, result.menuLineCount, result.averageAmount, result.mode],
      [1300000, 13, 26, 100000, 'paid']);
  }
});

for (const lang of ['ko', 'vi']) {
  test(`${lang}: actual four cards distinguish complete, partial, unavailable, menu uncertainty and closed`, () => {
    const t = salesText[lang].daily;
    const html = renderDailySales(response(), { lang });
    const cards = dailyCards(html);
    assert.ok(cards);
    assert.equal((cards.match(/min-height:88px/g) ?? []).length, 4);
    assert.match(cards, /2\.100\.000/);
    assert.match(cards, /21/);
    assert.ok(cards.includes(t.openOrdersAmount));
    assert.ok(cards.includes(t.provisionalAverage));
    assert.ok(!html.includes(t.openOrdersTitle), 'no separate order KPI panel');
    const partial = renderDailySales(response(openKpi([...orders(), order(9, { Status: 5 })])), { lang });
    assert.ok(dailyCards(partial).includes(t.knownSubtotal));
    assert.ok(dailyCards(partial).includes(t.currentAverageUnavailable));
    for (const status of ['not_enabled', 'unavailable', 'stale', 'incomplete']) {
      const unavailable = renderDailySales(response({ ...openKpi(), status }), { lang });
      assert.match(dailyCards(unavailable), /1\.300\.000/);
      assert.ok(dailyCards(unavailable).includes(t.paidOnly));
      assert.ok(unavailable.includes(t.overallScaleUnavailable));
      assert.ok(dailyCards(unavailable).includes(t.currentAverageUnavailable));
    }
    const menus = renderDailySales(response(openKpi([order(12, { TotalAmount: 200000 }, [line(1), line(2), line(3, { Status: 6 })])])), { lang });
    assert.ok(menus.includes(t.menuCountUnavailable));
    assert.ok(menus.includes(t.openOrdersDetailWarning));
    const closed = renderDailySales(response(openKpi(), { closeCheck: { status: 'matched' } }), { lang, live: false });
    assert.match(dailyCards(closed), /1\.300\.000/);
    assert.ok(!closed.includes(t.openOrdersNote));
    assert.ok(!dailyCards(closed).includes(t.currentAverageUnavailable));
  });
}

test('the page integrates only central order results; yellow pending receipt banner is never a KPI source', () => {
  const page = readFileSync('app/(protected)/admin/sales/page.tsx', 'utf8');
  const policy = readFileSync('lib/sales/daily-kpi.ts', 'utf8');
  for (const source of [page, policy]) assert.doesNotMatch(source, /pendingPayments|pending\.count|pending\.totalAmount|open-orders-sync-server|loginCukcuk/);
  assert.match(page, /onClosed=\{fetchSalesToday\}/);
  assert.match(page, /<OpenOrdersPanel data=\{kpi\?\.openOrders\}/);
});

test('runtime READ flag: only trimmed true enables central reads; disabled returns not_enabled before DB/date access', async () => {
  const code = ts.transpileModule(readFileSync('lib/sales/open-orders-read-server.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const flag of [undefined, '', 'false', 'TRUE', '1', 'true', ' true ']) {
    let dates = 0, snapshots = 0;
    const dependencies = {
      'server-only': {},
      '@/lib/supabase/server': { supabaseServer: { rpc: async () => { snapshots++; return {
        data: { sync: { businessDate, lastSuccessAt: '2026-11-10T13:29:00Z', lastAttemptAt: null, lastErrorCode: null }, orders: [] }, error: null,
      }; } } },
      '@/lib/pos/cukcuk/open-orders-scope': { openOrdersScope: () => 'offline' },
      '@/lib/pos/cukcuk/open-orders-core': { buildOpenOrderKpi, classifyOrdersForBusinessDate,
        OPEN_ORDERS_RPC: { read: 'pos_open_orders_read' } },
      '@/lib/store-settings/business-time-core': { addStoreDays: () => '2026-11-11' },
      '@/lib/store-settings/business-time-adapter': { resolveConfiguredBusinessDate: async () => { dates++; return businessDate; } },
      '@/lib/sales/daily-sales-summary': { fetchAllExactPages: async () => ({ data: [], error: null }) },
    };
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', 'process', code)(name => {
      assert.ok(name in dependencies, name); return dependencies[name];
    }, mod, mod.exports, { env: { POS_OPEN_ORDERS_READ_ENABLED: flag } });
    const result = await mod.exports.loadOpenOrderKpi({ businessDate, isClosed: false,
      paid: { amount: summary.totalSales, receiptCount: summary.paidReceiptCount }, now });
    const enabled = flag?.trim() === 'true';
    assert.equal(result.status, enabled ? 'ok' : 'not_enabled');
    assert.deepEqual([dates, snapshots], enabled ? [1, 1] : [0, 0]);
    assert.equal(result.open?.orderCount ?? null, enabled ? 0 : null);
  }
});
