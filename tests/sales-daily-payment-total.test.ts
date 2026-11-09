import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  DAILY_SALES_PAGE_SIZE,
  DAILY_SALES_SOURCE_INCOMPLETE,
  buildDailyPaymentSales,
  compareDailyCloseSnapshot,
  fetchAllExactPages,
} from "../lib/sales/daily-sales-summary.ts";
import { buildPaymentSummary } from "../lib/sales/payment-summary.ts";
import { salesText } from "../lib/text/sales.ts";

const route = readFileSync("app/api/admin/sales/today/route.ts", "utf8");
const page = readFileSync("app/(protected)/admin/sales/page.tsx", "utf8");
const D = "2026-11-06";

type Pay = [number, number | null, string, string | null, number];
const receipt = (id: number, final_amount: number, payment_status = 3, is_canceled = false) =>
  ({ id, payment_status, is_canceled, final_amount });
const pay = ([id, payment_type, payment_name, card_name, amount]: Pay, receipt_id: number) =>
  ({ id, receipt_id, business_date: D, payment_type, payment_name, card_name, amount });
const cash = (id: number, receipt_id: number, amount: number) => pay([id, 1, "Tiền mặt", null, amount], receipt_id);
const transfer = (id: number, receipt_id: number, amount: number) => pay([id, 2, "Chuyển khoản", "Chuyển khoản", amount], receipt_id);

// 2026-11-06 production rows (read-only copy): [receiptId, final, total_amount, vat, isModified, payments]
const NOV6: [number, number, number, number, boolean, Pay[]][] = [
  [8702, 1118000, 1030000, 88000, false, [[9616, 2, "Chuyển khoản", "Chuyển khoản", 1118000]]],
  [8703, 907200, 840000, 67200, false, [[9615, 2, "Chuyển khoản", "Chuyển khoản", 907200]]],
  [8704, 1471200, 1350000, 121200, false, [[9617, 2, "Chuyển khoản", "Chuyển khoản", 1471200]]],
  [8705, 721000, 660000, 61000, false, [[9618, 2, "VISA", "VISA", 721000]]],
  [8706, 1198800, 1110000, 88800, false, [[9619, 2, "Chuyển khoản", "Chuyển khoản", 1198800]]],
  [8707, 843000, 780000, 63000, false, [[9620, 2, "Chuyển khoản", "Chuyển khoản", 843000]]],
  [8708, 894000, 820000, 74000, false, [[9621, 2, "VISA", "VISA", 894000]]],
  [8709, 650000, 600000, 50000, false, [[9622, 1, "Tiền mặt", null, 110000], [9623, 2, "Chuyển khoản", "Chuyển khoản", 540000]]],
  [8710, 781600, 720000, 61600, false, [[9624, 2, "VISA", "VISA", 781600]]],
  [8711, 1535000, 1400000, 55000, true, [[9626, null, "Tiền mặt", null, 1535000]]],
  [8712, 763800, 700000, 63800, false, [[9627, 2, "Chuyển khoản", "Chuyển khoản", 763800]]],
  [8713, 926700, 847000, 79700, false, [[9628, 2, "VISA", "VISA", 926700]]],
  [8714, 891000, 820000, 71000, false, [[9629, 2, "VISA", "VISA", 891000]]],
  [8715, 8564000, 7800000, 764000, false, [[9630, 2, "VISA", "VISA", 8564000]]],
  [8716, 5216600, 4780000, 436600, false, [[9631, 2, "VISA", "VISA", 5216600]]],
  [8717, 400500, 369000, 31500, false, [[9632, 2, "Chuyển khoản", "Chuyển khoản", 400500]]],
  [8718, 1425000, 1300000, 125000, false, [[9636, 2, "Chuyển khoản", "Chuyển khoản", 1425000]]],
  [8719, 583000, 530000, 53000, false, [[9633, null, "Tiền mặt", null, 583000]]],
  [8720, 1476000, 1350000, 126000, false, [[9634, 2, "Chuyển khoản", "Chuyển khoản", 1476000]]],
  [8721, 995400, 910000, 85400, false, [[9635, 1, "Tiền mặt", null, 995400]]],
  [8722, 150000, 150000, 0, false, [[9637, null, "Tiền mặt", null, 150000]]],
  [8723, 1014200, 930000, 84200, false, [[9638, 2, "VISA", "VISA", 1014200]]],
  [8724, 1546000, 1410000, 136000, false, [[9639, 1, "Tiền mặt", null, 1546000]]],
  [8725, 3135200, 2860000, 275200, false, [[9640, 2, "Chuyển khoản", "Chuyển khoản", 3135200]]],
  [8726, 1382400, 1280000, 102400, false, [[9642, 1, "Tiền mặt", null, 1382400]]],
  [8727, 1057800, 970000, 87800, false, [[9641, 2, "Chuyển khoản", "Chuyển khoản", 1057800]]],
];
// Closure #67 rev 1 (automatic) snapshot totals for 2026-11-06.
const NOV6_SNAPSHOT = { receiptTotal: 39647400, totalsByBucket: { cash: 6301800, transfer: 14336500, card: 19009100, other: 0 } };

test("2026-11-06: total sales = POS payment total 39,647,400 over 26 paid receipts; VAT and modified diff not deducted", () => {
  const receipts = NOV6.map(([id, fa]) => receipt(id, fa));
  const payments = NOV6.flatMap(([id, , , , , pays]) => pays.map((p) => pay(p, id)));
  const daily = buildDailyPaymentSales(receipts, payments);
  assert.equal(daily.paidReceiptCount, 26);
  assert.equal(daily.totalSales, 39_647_400);
  assert.equal(daily.paymentSummary.paymentTotalAmount, 39_647_400);
  assert.deepEqual(
    { cash: daily.paymentSummary.cashAmount, transfer: daily.paymentSummary.transferAmount, card: daily.paymentSummary.cardAmount, other: daily.paymentSummary.otherAmount },
    NOV6_SNAPSHOT.totalsByBucket
  );
  assert.equal(daily.averageReceiptAmount, Math.round(39_647_400 / 26));
  assert.equal(daily.reconciliation.status, "matched");
  assert.equal(daily.reconciliation.receiptTotal, 39_647_400);
  // VAT 3,251,400 and the modified receipt's 880,000 difference are not subtracted.
  assert.equal(NOV6.reduce((s, r) => s + r[3], 0), 3_251_400);
  assert.notEqual(daily.totalSales, 39_647_400 - 3_251_400);
  assert.notEqual(daily.totalSales, 39_647_400 - 880_000);
  // The old basis (receipt total_amount) would have shown 36,316,000.
  assert.equal(NOV6.reduce((s, r) => s + r[2], 0), 36_316_000);
  const check = compareDailyCloseSnapshot({ revision: 1, closed_at: "2026-11-06T20:05:43Z", source_snapshot: NOV6_SNAPSHOT }, daily.totalSales);
  assert.deepEqual([check.status, check.closedTotal, check.delta], ["matched", 39_647_400, 0]);
});

test("zero receipts: totals, average and reconciliation stay at zero", () => {
  const daily = buildDailyPaymentSales([], []);
  assert.deepEqual([daily.totalSales, daily.paidReceiptCount, daily.averageReceiptAmount], [0, 0, 0]);
  assert.equal(daily.reconciliation.status, "matched");
  assert.equal(compareDailyCloseSnapshot(null, 0).status, "not_closed");
});

test("canceled, paid-but-canceled and unpaid receipts and their payments are excluded", () => {
  const receipts = [receipt(1, 100000), receipt(2, 200000, 4), receipt(3, 300000, 3, true), receipt(4, 400000, 2), receipt(5, 500000, 5)];
  const payments = [cash(11, 1, 100000), cash(12, 2, 200000), cash(13, 3, 300000), cash(14, 4, 400000), cash(15, 5, 500000), cash(16, 99, 999000)];
  const daily = buildDailyPaymentSales(receipts, payments);
  assert.equal(daily.totalSales, 100000);
  assert.equal(daily.paidReceiptCount, 1);
  assert.equal(daily.averageReceiptAmount, 100000);
  assert.deepEqual(daily.paidPaymentRows.map((p) => p.id), [11]);
});

test("split payment counts each payment once and the receipt once", () => {
  const receipts = [receipt(1, 650000), receipt(2, 350000)];
  const payments = [cash(1, 1, 110000), transfer(2, 1, 540000), transfer(3, 2, 350000)];
  const daily = buildDailyPaymentSales(receipts, payments);
  assert.equal(daily.totalSales, 1_000_000);
  assert.equal(daily.paidReceiptCount, 2);
  assert.equal(daily.averageReceiptAmount, 500000);
  assert.equal(daily.paymentSummary.cashAmount, 110000);
  assert.equal(daily.paymentSummary.transferAmount, 890000);
  // A repeated payment row (same POS payment id) is not counted twice.
  const dup = buildDailyPaymentSales(receipts, [...payments, transfer(2, 1, 540000)]);
  assert.equal(dup.totalSales, 1_000_000);
  assert.equal(dup.reconciliation.status, "matched");
});

test("missing payment data is exposed, never filled from the receipt amount", () => {
  const receipts = [receipt(1, 300000), receipt(2, 200000), receipt(3, 100000)];
  const payments = [cash(1, 1, 300000), cash(3, 3, 90000)];
  const daily = buildDailyPaymentSales(receipts, payments);
  assert.equal(daily.totalSales, 390000);
  assert.equal(daily.averageReceiptAmount, 130000);
  assert.deepEqual(daily.reconciliation, {
    status: "mismatch", receiptTotal: 600000, paymentTotal: 390000, delta: -210000,
    mismatchReceiptCount: 2, missingPaymentReceiptCount: 1,
  });
});

test("close snapshot mismatch keeps the confirmed total and reports the difference", () => {
  const snapshot = { receiptTotal: 1_000_000, totalsByBucket: { cash: 400000, transfer: 600000, card: 0, other: 0 } };
  const check = compareDailyCloseSnapshot({ revision: 2, closed_at: "2026-11-07T17:00:00Z", source_snapshot: snapshot }, 1_150_000);
  assert.deepEqual(check, { status: "mismatch", revision: 2, closedAt: "2026-11-07T17:00:00Z", closedTotal: 1_000_000, currentTotal: 1_150_000, delta: 150000 });
  assert.equal(snapshot.receiptTotal, 1_000_000);
  const invalid = compareDailyCloseSnapshot({ revision: 1, closed_at: null, source_snapshot: { receiptTotal: 5 } }, 5);
  assert.deepEqual([invalid.status, invalid.closedTotal, invalid.delta], ["snapshot_invalid", null, null]);
});

test("route: totalSales and average come from POS payments, close check is read-only", () => {
  assert.doesNotMatch(route, /sum \+ toNumber\(receipt\.total_amount\)\s*,\s*0\s*\)\s*;\s*const paidReceiptCount/);
  assert.match(route, /const totalSales = dailySales\.totalSales;/);
  assert.match(route, /averageReceiptAmount: dailySales\.averageReceiptAmount/);
  assert.match(route, /paymentReconciliation: dailySales\.reconciliation/);
  assert.match(route, /const closeCheck = compareDailyCloseSnapshot\(/);
  assert.match(route, /closeCheck,\s*openOrders,/);
  // Open-order estimates stay outside summary; paid KPIs are unchanged.
  const summaryBlock = route.slice(route.indexOf("const summary = {"), route.indexOf("};", route.indexOf("const summary = {")));
  assert.doesNotMatch(summaryBlock, /open|provisional/i);
  assert.match(route, /isClosed: closeCheck\.status !== "not_closed"/);
  assert.match(route, /paid: \{ amount: totalSales, receiptCount: paidReceiptCount \}/);
  assert.match(route, /\.from\("pos_sales_business_day_closures"\)\s*\.select\("revision, closed_at, source_snapshot"\)/);
  assert.doesNotMatch(route, /\.(insert|update|upsert|delete|rpc)\(/);
  assert.match(route, /"id, receipt_id, business_date, payment_type, payment_name, card_name, amount"/);
  // Hourly sales scope is untouched.
  assert.match(route, /current\.amount \+= toNumber\(receipt\.total_amount\);/);
});

test("KO/VI: daily bottom label is POS-based; monthly label unchanged; warnings render both languages", () => {
  assert.equal(salesText.ko.daily.paymentTotal, "결제 합계(POS기준)");
  assert.equal(salesText.vi.daily.paymentTotal, "Tổng thanh toán (theo POS)");
  assert.equal(salesText.ko.common.paymentTotal, "결제 합계");
  assert.equal(salesText.vi.common.paymentTotal, "Tổng thanh toán");
  const koKeys = Object.keys(salesText.ko.daily).sort();
  assert.deepEqual(Object.keys(salesText.vi.daily).sort(), koKeys);
  for (const key of ["paymentMismatchWarning", "closeMismatchWarning", "closeSnapshotInvalid", "closedTotalLabel", "currentPaymentTotalLabel", "differenceLabel", "closeMismatchHint"]) {
    assert.ok(salesText.ko.daily[key as keyof typeof salesText.ko.daily]);
    assert.ok(salesText.vi.daily[key as keyof typeof salesText.vi.daily]);
    assert.match(page, new RegExp(`dailyText\\.${key}`));
  }
  assert.match(page, /\{dailyText\.paymentTotal\}/);
});

test("paging collects every row past the 1,000-row cap and fails instead of returning a partial list", async () => {
  const all = Array.from({ length: 2345 }, (_, i) => ({ id: i + 1 }));
  const calls: [number, number][] = [];
  const server = (rows: { id: number }[], cap = 1000) => async (from: number, to: number) => {
    calls.push([from, to]);
    return { data: rows.slice(from, Math.min(to + 1, from + cap)), error: null, count: rows.length };
  };
  const ok = await fetchAllExactPages(server(all));
  assert.equal(ok.error, null);
  assert.equal(ok.data?.length, 2345);
  assert.deepEqual(new Set(ok.data?.map((r) => r.id)).size, 2345);
  assert.deepEqual(calls.slice(0, 2), [[0, 499], [500, 999]]);
  assert.equal(DAILY_SALES_PAGE_SIZE, 500);

  // A server cap smaller than the page size must not end collection early.
  const capped = await fetchAllExactPages(server(all, 300));
  assert.equal(capped.data?.length, 2345);

  const empty = await fetchAllExactPages(server([]));
  assert.deepEqual(empty, { data: [], error: null });

  // Rows added/removed between pages (count changes) -> incomplete, not a partial total.
  let n = 0;
  const shifting = await fetchAllExactPages(async (from, to) => ({ data: all.slice(from, to + 1), error: null, count: n++ === 0 ? 2345 : 2346 }));
  assert.deepEqual(shifting, { data: null, error: { message: DAILY_SALES_SOURCE_INCOMPLETE } });

  // Missing count, early empty page, or a page error -> no data.
  assert.equal((await fetchAllExactPages(async () => ({ data: all.slice(0, 10), error: null, count: null }))).data, null);
  assert.equal((await fetchAllExactPages(async (from) => ({ data: from === 0 ? all.slice(0, 500) : [], error: null, count: 2345 }))).error?.message, DAILY_SALES_SOURCE_INCOMPLETE);
  const failed = await fetchAllExactPages(async (from) => from === 0
    ? { data: all.slice(0, 500), error: null, count: 2345 }
    : { data: null, error: { message: "timeout" }, count: null });
  assert.deepEqual(failed, { data: null, error: { message: "timeout" } });
});

test("route: all three source reads are paged with exact counts and keep per-table failures", () => {
  for (const table of ["pos_sales_receipts", "pos_sales_receipt_lines", "pos_sales_receipt_payments"]) {
    const start = route.indexOf(`.from("${table}")`);
    const block = route.slice(start, route.indexOf(".range(from, to)", start) + 16);
    assert.match(block, /\{\s*count: "exact",?\s*\}/);
    assert.match(block, /\.order\("id", \{ ascending: true \}\)/);
    assert.match(route.slice(start - 120, start), /fetchAllExactPages<\w+>\(\(from, to\) =>/);
  }
  assert.match(route, /Failed to fetch sales receipts: \$\{receiptsError\.message\}/);
  assert.match(route, /Failed to fetch sales lines: \$\{linesError\.message\}/);
  assert.match(route, /Failed to fetch sales payments: \$\{paymentsError\.message\}/);
});

test("canceled-flag paid receipts are excluded from item counts and top items like totals and receipt count", () => {
  assert.match(route, /const paidReceiptIds = new Set\(dailySales\.paidReceipts\.map\(\(receipt\) => receipt\.id\)\);/);
  assert.match(route, /isPaidReceiptLine\(line, paidReceiptIds\)/);
  assert.match(route, /topItems: buildTopItems\(lineRows, paidReceiptIds\)/);
  const daily = buildDailyPaymentSales([receipt(1, 100000), receipt(2, 200000, 3, true)], [cash(1, 1, 100000), cash(2, 2, 200000)]);
  assert.deepEqual(daily.paidReceipts.map((r) => r.id), [1]);
  assert.equal(daily.paidReceiptCount, 1);
  assert.equal(daily.totalSales, 100000);
});

test("buildPaymentSummary remains the shared bucket helper", () => {
  assert.equal(buildPaymentSummary([cash(1, 1, 5)]).paymentTotalAmount, 5);
});
