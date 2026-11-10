import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOpenOrderKpi, classifyOrdersForBusinessDate, mergeOrderDetail, normalizeOrderSummary,
  runOpenOrderSync, OpenOrderSyncError,
  type CollectedOrder, type ReceiptLink, type OrderRequest, type OpenOrderSyncDiagnostic,
} from "../lib/pos/cukcuk/open-orders-core.ts";
import { buildDailySalesKpi } from "../lib/sales/daily-kpi.ts";

const businessDate = "2026-11-10";
const now = new Date("2026-11-10T15:12:00Z");
const paid = { totalSales: 1300000, receiptCount: 13, paidReceiptCount: 13,
  salesLineCount: 26, optionLineCount: 0, averageReceiptAmount: 100000 };
function order(status: number, amount = 2410000): CollectedOrder {
  const row = { Id: "order-18", No: "1.18", Date: "2026-11-10T22:00:00+07:00", Status: status, TotalAmount: amount };
  return mergeOrderDetail(normalizeOrderSummary(row), { Data: { ...row, OrderDetails: [
    { Id: "menu-18", Quantity: 1, Amount: amount, Status: 1 },
  ] } }, "03:00");
}
const pending: ReceiptLink = { orderId: "order-18", receiptId: 18, paymentStatus: 1, isCanceled: false };
function view(rows: CollectedOrder[], receipts: ReceiptLink[], summary = paid) {
  const openOrders = buildOpenOrderKpi({ enabled: true, businessDate, isLiveBusinessDay: true, isClosed: false,
    paid: { amount: summary.totalSales, receiptCount: summary.paidReceiptCount },
    sync: { businessDate, lastSuccessAt: now.toISOString(), lastAttemptAt: null, lastErrorCode: null },
    classified: classifyOrdersForBusinessDate(rows, receipts, businessDate), now });
  return buildDailySalesKpi({ summary, openOrders, businessDate, isLiveBusinessDay: true, isClosed: false });
}

for (const status of [1, 3]) {
  test(`RED regression order 1.18: Status ${status} + one pending receipt includes header 2,410,000 exactly once`, () => {
    const result = view([order(status)], [pending, pending]);
    assert.equal(result.openOrders?.open?.amount, 2410000);
    assert.deepEqual([result.amount, result.receiptCount, result.menuLineCount, result.averageAmount],
      [3710000, 14, 27, 265000]);
  });
}

test("RED regression pending -> edited -> paid keeps the four KPIs stable on conversion without double counting", () => {
  const edited = view([order(3, 2500000)], [pending]);
  assert.equal(edited.amount, 3800000);
  const nextPaid = { ...paid, totalSales: 3800000, receiptCount: 14, paidReceiptCount: 14, salesLineCount: 27, averageReceiptAmount: 271429 };
  const converted = view([order(3, 2500000)], [{ ...pending, paymentStatus: 3 }], nextPaid);
  assert.deepEqual([converted.amount, converted.receiptCount, converted.menuLineCount, converted.averageAmount],
    [edited.amount, edited.receiptCount, edited.menuLineCount, edited.averageAmount]);
  assert.equal(converted.openOrders?.open?.amount, 0);
});

test("pending receipt guards: duplicates, cancellation, unknown order/receipt status, missing details and reissue", () => {
  const canceled = { ...pending, paymentStatus: 4, isCanceled: true };
  const cases: [CollectedOrder, ReceiptLink[], string | null][] = [
    [order(3), [pending, { ...pending, receiptId: 19 }], "multiple_receipts"],
    [order(3), [pending, { ...pending, receiptId: 19, paymentStatus: 3 }], "multiple_receipts"],
    [order(3), [canceled], "open_after_canceled_receipt"],
    [order(3), [{ ...pending, isCanceled: true }], "open_after_canceled_receipt"],
    [order(3), [{ ...pending, paymentStatus: 5 }], "open_after_canceled_receipt"],
    [order(4), [pending], "paid_without_receipt"],
    [order(5), [pending], null],
    ...[7, 8].map((status): [CollectedOrder, ReceiptLink[], string] => [order(status), [pending], "unknown_status"]),
    [{ ...order(3), lines: null }, [pending], "open_without_lines"],
    [order(3), [{ ...pending, paymentStatus: 2 }], null],
    [order(3), [{ ...pending, paymentStatus: null }], null],
  ];
  for (const [row, receipts, reason] of cases) {
    const result = classifyOrdersForBusinessDate([row], receipts, businessDate);
    assert.equal(result.open.length, 0);
    assert.deepEqual(result.uncertain.map((item) => item.reason), reason ? [reason] : []);
  }
  const reissued = view([order(3)], [canceled, { ...pending, receiptId: 19, paymentStatus: 3 }]);
  assert.equal(reissued.openOrders?.open?.amount, 0);
  assert.equal(reissued.amount, paid.totalSales);
  // A pending reissue is still one unpaid order, not receipt amount + order amount.
  assert.equal(view([order(3)], [canceled, { ...pending, receiptId: 19 }]).amount, 3710000);
});

test("pending receipt + menu Status 6 retains the header estimate, holds menu count and hides full average", () => {
  const row = order(3);
  row.lines![0] = { ...row.lines![0], amount: 3000000, lineStatus: 6 };
  const result = view([row], [pending]);
  assert.deepEqual([result.amount, result.receiptCount, result.menuLineCount, result.averageAmount], [3710000, 14, 26, null]);
  assert.equal(result.mode, "partial");
});

test("disabled, collection outage, stale and closed states never turn pending orders into a false zero/current average", () => {
  const classified = classifyOrdersForBusinessDate([order(3)], [pending], businessDate);
  for (const [enabled, code, status] of [[false, null, "not_enabled"], [true, "orders_invalid_row", "stale"],
    [true, "orders_vanished_unconfirmed", "incomplete"]] as const) {
    const openOrders = buildOpenOrderKpi({ enabled, businessDate, isLiveBusinessDay: true, isClosed: false,
      paid: { amount: paid.totalSales, receiptCount: 13 }, classified,
      sync: { businessDate, lastSuccessAt: "2026-11-10T22:12:21+07:00", lastAttemptAt: null, lastErrorCode: code },
      now: new Date("2026-11-10T23:12:00+07:00") });
    assert.equal(openOrders.status, status);
    assert.equal(openOrders.open, null);
    const model = buildDailySalesKpi({ summary: paid, openOrders, businessDate, isLiveBusinessDay: true, isClosed: false });
    assert.deepEqual([model.amount, model.receiptCount, model.menuLineCount, model.averageAmount], [1300000, 13, 26, null]);
  }
  const closed = buildDailySalesKpi({ summary: paid, openOrders: view([order(3)], [pending]).openOrders,
    businessDate, isLiveBusinessDay: false, isClosed: true });
  assert.deepEqual([closed.amount, closed.receiptCount, closed.menuLineCount, closed.averageAmount], [1300000, 13, 26, 100000]);
});

async function failedRun(handler: (request: OrderRequest) => unknown, previous: unknown[] = [], diagnosticThrows = false) {
  const calls: string[] = [], writes: { name: string; args: Record<string, unknown> }[] = [];
  const diagnostics: OpenOrderSyncDiagnostic[] = [];
  const result = await runOpenOrderSync({
    rpc: async (name, args) => {
      writes.push({ name, args });
      if (name === "pos_open_orders_claim") return { status: "collecting" };
      if (name === "pos_open_orders_read") return { orders: previous };
      return { status: "failed", code: args.p_code };
    },
    transport: { login: async () => {}, send: async (request) => {
      calls.push(request.kind);
      return { status: 200, json: handler(request) };
    } }, uuid: () => "fixture-run", onDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic); if (diagnosticThrows) throw new Error("logger unavailable");
    },
  }, { scope: "fixture", branchId: "fixture", businessDate, windowFrom: "2026-11-09T20:00:00Z", cutoff: "03:00" });
  assert.ok(!writes.some((write) => write.name === "pos_open_orders_commit"));
  return { result, calls, diagnostics, fail: writes.find((write) => write.name === "pos_open_orders_fail") };
}
const success = (Data: unknown, Total?: number) => ({ Success: true, Data, Total });
const safeHeader = { Id: "order-18", Date: "2026-11-10T22:00:00+07:00", TotalAmount: 2410000, Status: 3 };

test("invalid-row diagnostics distinguish each header validation without exposing the failing value or JSON", async () => {
  const secret = "PRIVATE_CUSTOMER_PHONE_TOKEN";
  const cases = [[null, "row_not_object"], [{ ...safeHeader, Id: "" }, "order_id_missing"],
    [{ ...safeHeader, Date: secret }, "order_date_invalid"], [{ ...safeHeader, TotalAmount: secret }, "total_amount_invalid"],
    [{ ...safeHeader, TotalAmount: -1 }, "total_amount_invalid"]] as const;
  for (const [row, reason] of cases) {
    const { result, calls, diagnostics } = await failedRun(() => success([row], 1));
    assert.deepEqual(result, { status: "failed", code: "orders_invalid_row" });
    assert.deepEqual(calls, ["page"]);
    assert.deepEqual(diagnostics, [{ code: "orders_invalid_row", stage: "page", causeCode: "orders_invalid_row", reason, page: 1, rowIndex: 0 }]);
    assert.ok(!JSON.stringify(diagnostics).includes(secret));
  }
});

test("vanished-order diagnostics preserve validation/provider cause and keep the old failure code/snapshot", async () => {
  const previous = [{ orderId: "order-18", statusClass: "open" }];
  for (const [reply, causeCode, reason] of [
    [success({ ...safeHeader, Date: "INVALID_PRIVATE_DATE" }), "orders_invalid_row", "order_date_invalid"],
    [{ Success: false, Code: 599, Message: "PRIVATE_CUSTOMER_PHONE_TOKEN" }, "provider_failure", undefined],
    [success({ ...safeHeader, OrderDetails: null }), "order_detail_lines_missing", undefined],
  ] as const) {
    const { result, calls, diagnostics, fail } = await failedRun((request) => request.kind === "page" ? success([], 0) : reply, previous);
    assert.deepEqual(result, { status: "failed", code: "orders_vanished_unconfirmed" });
    assert.deepEqual(calls, ["page", "detail"]); // Exactly the existing requests, no diagnostic probe.
    assert.equal(fail?.args.p_code, "orders_vanished_unconfirmed");
    assert.deepEqual(diagnostics, [{ code: "orders_vanished_unconfirmed", stage: "vanished_detail", causeCode,
      ...(reason ? { reason } : {}), vanishedCount: 1, confirmedCount: 0 }]);
    assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE|order-18|OrderDetails/);
  }
});

test("vanished wrong identity/date and confirmation limit remain failures, without extra provider calls", async () => {
  const previous = [{ orderId: "order-18", statusClass: "open" }];
  for (const [header, reason] of [[{ ...safeHeader, Id: "different" }, "vanished_id_mismatch"],
    [{ ...safeHeader, Date: "2026-11-09T22:00:00+07:00" }, "vanished_business_date_mismatch"]] as const) {
    const run = await failedRun((request) => request.kind === "page" ? success([], 0) : success({ ...header, OrderDetails: [] }), previous);
    assert.equal(run.diagnostics[0].reason, reason);
    assert.deepEqual(run.calls, ["page", "detail"]);
  }
  const limited = await failedRun(() => success([], 0), Array.from({ length: 21 }, (_, i) => ({ orderId: `order-${i}`, statusClass: "unknown" })));
  assert.equal(limited.diagnostics[0].reason, "vanished_limit");
  assert.equal(limited.diagnostics[0].vanishedCount, 21);
  assert.deepEqual(limited.calls, ["page"]);
});

test("a later vanished failure reports confirmed progress but never commits a partial snapshot", async () => {
  const previous = [{ orderId: "order-18", statusClass: "open" }, { orderId: "order-19", statusClass: "unknown" }];
  const run = await failedRun((request) => request.kind === "page" ? success([], 0)
    : success({ ...safeHeader, Id: request.orderId, TotalAmount: request.orderId === "order-19" ? null : 2410000, OrderDetails: [] }), previous);
  assert.deepEqual(run.calls, ["page", "detail", "detail"]);
  assert.equal(run.result.code, "orders_vanished_unconfirmed");
  assert.equal(run.diagnostics[0].causeCode, "orders_invalid_row");
  assert.equal(run.diagnostics[0].confirmedCount, 1);
  assert.equal(run.diagnostics[0].vanishedCount, 2);
});

test("listed detail failure has a separate stage; diagnostic sink errors cannot change failure bookkeeping", async () => {
  const run = await failedRun((request) => request.kind === "page" ? success([safeHeader], 1)
    : success({ ...safeHeader, TotalAmount: "PRIVATE_BAD_AMOUNT" }), [], true);
  assert.equal(run.diagnostics[0].stage, "detail");
  assert.equal(run.diagnostics[0].reason, "total_amount_invalid");
  assert.equal(run.fail?.args.p_code, "orders_invalid_row");
  assert.deepEqual(run.calls, ["page", "detail"]);
});

test("diagnostic output rejects unexpected fields, free-text reasons and error messages", async () => {
  const error = new OpenOrderSyncError("orders_invalid_row", "PRIVATE_CUSTOMER_PHONE_TOKEN");
  Object.assign(error, { diagnostic: { stage: "PRIVATE_STAGE", reason: "PRIVATE_REASON", causeCode: "PRIVATE_CAUSE",
    rowIndex: "PRIVATE_INDEX", raw: { Phone: "PRIVATE_PHONE" } } });
  const run = await failedRun(() => { throw error; });
  assert.doesNotMatch(JSON.stringify(run.diagnostics), /PRIVATE|raw|Phone/);
  assert.equal(run.diagnostics[0].stage, "page");
});
