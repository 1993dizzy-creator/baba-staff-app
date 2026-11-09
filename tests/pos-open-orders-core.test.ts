import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  OpenOrderSyncError,
  buildOpenOrderKpi,
  classifyOrderStatus,
  classifyOrdersForBusinessDate,
  collectOpenOrderSnapshot,
  fetchAllOrderPages,
  mergeOrderDetail,
  normalizeOrderLines,
  orderLineTotals,
  providerFailureCode,
  runOpenOrderSync,
  type CollectedOrder,
  type OrderRequest,
  type OrderTransport,
} from "../lib/pos/cukcuk/open-orders-core.ts";

const CUTOFF = "03:00";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const order = (n: number, extra: Record<string, unknown> = {}) => ({
  Id: uuid(n), No: `1.${n}`, Status: 1, Date: "2026-11-09T20:00:00+07:00", TotalAmount: 100000, ...extra,
});
const ok = (data: unknown, total?: number) => ({ status: 200, json: { Success: true, Code: 200, ErrorType: 0, Data: data, ...(total === undefined ? {} : { Total: total }) } });

type Reply = { status: number | null; json: unknown } | Error;
function transport(handler: (request: OrderRequest, call: number) => Reply) {
  const sent: OrderRequest[] = [];
  let logins = 0;
  const t: OrderTransport & { sent: OrderRequest[]; logins: () => number } = {
    sent,
    logins: () => logins,
    async login() { logins++; },
    async send(request) {
      sent.push(request);
      const reply = handler(request, sent.length);
      if (reply instanceof Error) throw reply;
      return reply;
    },
    async sleep() {},
  };
  return t;
}
const pagedServer = (rows: unknown[], limit = 100) => (request: OrderRequest) => {
  if (request.kind !== "page") throw new Error("unexpected detail");
  return ok(rows.slice((request.page - 1) * limit, request.page * limit), rows.length);
};
const state = () => ({ relogins: 0, maxRelogins: 1 });

test("paging collects 250 orders over 3 pages of 100 and stops at Total", async () => {
  const rows = Array.from({ length: 250 }, (_, i) => order(i + 1));
  const t = transport(pagedServer(rows));
  const result = await fetchAllOrderPages(t, { branchId: "b", lastSyncDate: "2026-11-08T20:00:00.000Z" }, state());
  assert.equal(result.orders.length, 250);
  assert.equal(result.pages, 3);
  assert.deepEqual(t.sent.map((r) => r.kind === "page" && [r.page, r.limit]), [[1, 100], [2, 100], [3, 100]]);
  assert.equal(new Set(result.orders.map((o) => o.orderId)).size, 250);
});

test("paging fails on a changed Total, short page, missing Total or a row shifted into the next page", async () => {
  const rows = Array.from({ length: 150 }, (_, i) => order(i + 1));
  const run = (handler: (r: OrderRequest) => Reply) => fetchAllOrderPages(transport(handler), { branchId: "b", lastSyncDate: "x" }, state());
  await assert.rejects(run((r) => ok(rows.slice(0, 100), r.kind === "page" && r.page === 1 ? 150 : 151)), { code: "orders_total_changed" });
  await assert.rejects(run((r) => ok(rows.slice(0, r.kind === "page" && r.page === 1 ? 99 : 50), 150)), { code: "orders_page_count_mismatch" });
  await assert.rejects(run(() => ok(rows.slice(0, 100))), { code: "orders_total_missing" });
  await assert.rejects(run((r) => ok(r.kind === "page" && r.page === 1 ? rows.slice(0, 100) : rows.slice(99, 149), 150)), { code: "orders_duplicate_id" });
  await assert.rejects(run(() => ok([{ Id: uuid(1) }], 1)), { code: "orders_invalid_row" });
});

test("102 backs off and retries serially; persistent 102 fails the run", async () => {
  let n = 0;
  const flaky = transport((r) => (++n <= 2 ? { status: 200, json: { Success: false, Code: 102, ErrorType: 102 } } : pagedServer([order(1)])(r)));
  assert.equal((await fetchAllOrderPages(flaky, { branchId: "b", lastSyncDate: "x" }, state())).orders.length, 1);
  const busy = transport(() => ({ status: 200, json: { Success: false, ErrorType: 102 } }));
  await assert.rejects(fetchAllOrderPages(busy, { branchId: "b", lastSyncDate: "x" }, state()), { code: "provider_busy_102" });
  assert.equal(busy.sent.length, 3);
});

test("token expiry and error 7 re-login once per run, then fail; timeout and HTTP errors fail without retry", async () => {
  let n = 0;
  const expired = transport((r) => (++n === 1 ? { status: 401, json: null } : pagedServer([order(1)])(r)));
  const s = state();
  assert.equal((await fetchAllOrderPages(expired, { branchId: "b", lastSyncDate: "x" }, s)).orders.length, 1);
  assert.equal(expired.logins(), 1);
  assert.equal(s.relogins, 1);

  const seven = transport(() => ({ status: 200, json: { Success: false, Code: 7, ErrorType: 7 } }));
  await assert.rejects(fetchAllOrderPages(seven, { branchId: "b", lastSyncDate: "x" }, state()), { code: "provider_error_7" });
  assert.equal(seven.logins(), 1);
  assert.equal(seven.sent.length, 2);

  const timeout = transport(() => new OpenOrderSyncError("provider_timeout", "page"));
  await assert.rejects(fetchAllOrderPages(timeout, { branchId: "b", lastSyncDate: "x" }, state()), { code: "provider_timeout" });
  assert.equal(timeout.sent.length, 1);

  assert.equal(providerFailureCode(500, { Success: true }), "provider_http_failure");
  assert.equal(providerFailureCode(200, { Success: false, Code: 400 }), "provider_failure");
  assert.equal(providerFailureCode(200, { Success: true, Code: 200 }), null);
});

test("order status: only 1 is open; 4 is a paid candidate; anything else is unknown", () => {
  assert.deepEqual([1, "1", 4, 2, 3, null, "x"].map(classifyOrderStatus), ["open", "open", "paid_candidate", "unknown", "unknown", "unknown", "unknown"]);
});

const line = (id: number, extra: Record<string, unknown> = {}) => ({ Id: uuid(1000 + id), ItemId: uuid(5000 + id), ItemName: `Item ${id}`, Quantity: 1, Price: 50000, Amount: 50000, ...extra });

test("detail lines: identical repeats collapse, conflicting repeats fail, options/additions follow their parent", () => {
  const lines = normalizeOrderLines([
    line(1),
    line(1),
    line(2, { Quantity: 2, Amount: 100000 }),
    line(3, { ParentId: uuid(1001), Amount: 10000 }),
    line(4, { AdditionId: uuid(9000), Amount: 5000 }),
    line(5, { ParentId: uuid(1999), Amount: 7000 }),
    line(6, { Quantity: 0, Amount: 0 }),
  ]);
  assert.equal(lines.length, 6);
  assert.deepEqual(lines.map((l) => [l.isOption, l.isOrphanOption, l.isCanceled]), [
    [false, false, false], [false, false, false], [true, false, false], [true, false, false], [true, true, false], [false, false, true],
  ]);
  assert.deepEqual(orderLineTotals(lines), { menuLineCount: 2, optionLineCount: 3, itemQuantity: 3, lineAmount: 172000, orphanOptionCount: 1 });
  assert.throws(() => normalizeOrderLines([line(1), line(1, { Quantity: 3 })]), { code: "order_detail_duplicate_line" });
  assert.throws(() => normalizeOrderLines(undefined), { code: "order_detail_lines_missing" });
});

test("detail must match its order; a quantity change in a later run replaces the earlier snapshot", () => {
  const summary = { orderId: uuid(1), orderNo: "1.1", status: 1, statusClass: "open" as const, orderDate: "2026-11-09T13:00:00.000Z", totalAmount: 100000, raw: {} };
  const first = mergeOrderDetail(summary, ok({ ...order(1), OrderDetails: [line(1)] }).json, CUTOFF);
  const second = mergeOrderDetail(summary, ok({ ...order(1), TotalAmount: 150000, OrderDetails: [line(1, { Quantity: 3, Amount: 150000 })] }).json, CUTOFF);
  assert.equal(orderLineTotals(first.lines!).itemQuantity, 1);
  assert.equal(orderLineTotals(second.lines!).itemQuantity, 3);
  assert.equal(second.totalAmount, 150000);
  assert.throws(() => mergeOrderDetail(summary, ok({ ...order(2), OrderDetails: [] }).json, CUTOFF), { code: "order_detail_mismatch" });
  assert.throws(() => mergeOrderDetail(summary, { Success: true, Data: null }, CUTOFF), { code: "order_detail_mismatch" });
});

test("00:00-03:00 belongs to the previous business date; 03:00 starts the next one", async () => {
  const rows = [
    order(1, { Date: "2026-11-09T16:00:00+07:00" }),
    order(2, { Date: "2026-11-10T02:59:00+07:00" }),
    order(3, { Date: "2026-11-10T03:00:00+07:00" }),
    order(4, { Date: "2026-11-09T02:30:00+07:00" }),
  ];
  const t = transport((r) => (r.kind === "page" ? ok(rows, rows.length) : ok({ ...rows.find((o) => o.Id === r.orderId), OrderDetails: [line(1)] })));
  const snap = await collectOpenOrderSnapshot(t, { branchId: "b", businessDate: "2026-11-09", windowFrom: "2026-11-08T20:00:00.000Z", cutoff: CUTOFF });
  assert.deepEqual(snap.orders.map((o) => o.orderNo), ["1.1", "1.2"]);
  assert.deepEqual(snap.orders.map((o) => o.businessDate), ["2026-11-09", "2026-11-09"]);
  assert.equal(snap.manifest.enumeratedCount, 4);
  assert.equal(snap.manifest.detailCount, 2);
  // LastSyncDate is only a lower bound (24h before the business day start), not the change detector.
  assert.equal(snap.manifest.lastSyncDate, "2026-11-07T20:00:00.000Z");
});

test("Status 1/3/7/8 get menu details (serial); only the paid candidate 4 is list-only", async () => {
  const rows = [order(1), order(3, { Status: 3 }), order(7, { Status: 7 }), order(8, { Status: 8 }), order(4, { Status: 4 })];
  const t = transport((r) => (r.kind === "page" ? ok(rows, rows.length) : ok({ ...rows.find((o) => o.Id === r.orderId), OrderDetails: [line(1)] })));
  const snap = await collectOpenOrderSnapshot(t, { branchId: "b", businessDate: "2026-11-09", windowFrom: "2026-11-08T20:00:00.000Z", cutoff: CUTOFF });
  assert.deepEqual(t.sent.map((r) => r.kind), ["page", "detail", "detail", "detail", "detail"]);
  assert.deepEqual(snap.orders.map((o) => [o.status, o.statusClass, o.lines === null]), [
    [1, "open", false], [3, "unknown", false], [7, "unknown", false], [8, "unknown", false], [4, "paid_candidate", true],
  ]);
  assert.equal(snap.manifest.detailCount, 4);

  // KPI completeness: unverified statuses are reported, never summed, and mark the KPI incomplete.
  const classified = classifyOrdersForBusinessDate(snap.orders, [], "2026-11-09");
  assert.deepEqual(classified.statusCounts, { "1": 1, "3": 1, "7": 1, "8": 1, "4": 1 });
  const kpi = buildOpenOrderKpi({ enabled: true, businessDate: "2026-11-09", isLiveBusinessDay: true, isClosed: false,
    paid: { amount: 0, receiptCount: 0 }, sync: { businessDate: "2026-11-09", lastSuccessAt: "2026-11-09T13:59:00.000Z", lastAttemptAt: null, lastErrorCode: null },
    classified, now: new Date("2026-11-09T14:00:00.000Z") });
  assert.equal(kpi.status, "ok");
  assert.equal(kpi.complete, false);
  assert.equal(kpi.open?.orderCount, 1);
  assert.deepEqual(kpi.uncertain?.reasons, { unknown_status: 3, paid_without_receipt: 1 });
  assert.deepEqual(kpi.statusCounts, { "1": 1, "3": 1, "7": 1, "8": 1, "4": 1 });
  // Only confirmed open orders with no uncertainty and no orphan options are complete.
  const only = buildOpenOrderKpi({ ...{ enabled: true, businessDate: "2026-11-09", isLiveBusinessDay: true, isClosed: false, paid: { amount: 0, receiptCount: 0 } },
    sync: { businessDate: "2026-11-09", lastSuccessAt: "2026-11-09T13:59:00.000Z", lastAttemptAt: null, lastErrorCode: null },
    classified: classifyOrdersForBusinessDate(snap.orders.slice(0, 1), [], "2026-11-09"), now: new Date("2026-11-09T14:00:00.000Z") });
  assert.equal(only.complete, true);
  const orphan = classifyOrdersForBusinessDate([{ ...snap.orders[0], lines: normalizeOrderLines([line(2, { ParentId: uuid(9999) })]) }], [], "2026-11-09");
  assert.equal(buildOpenOrderKpi({ ...{ enabled: true, businessDate: "2026-11-09", isLiveBusinessDay: true, isClosed: false, paid: { amount: 0, receiptCount: 0 } },
    sync: { businessDate: "2026-11-09", lastSuccessAt: "2026-11-09T13:59:00.000Z", lastAttemptAt: null, lastErrorCode: null },
    classified: orphan, now: new Date("2026-11-09T14:00:00.000Z") }).complete, false);
});

const collected = (n: number, extra: Partial<CollectedOrder> = {}): CollectedOrder => ({
  orderId: uuid(n), orderNo: `1.${n}`, status: 1, statusClass: "open", orderDate: "2026-11-09T13:00:00.000Z",
  totalAmount: 100000 * n, raw: {}, businessDate: "2026-11-09", tableName: null,
  lines: normalizeOrderLines([line(n), line(n + 100, { ParentId: uuid(1000 + n), Amount: 5000 })]), ...extra,
});

test("order/receipt: a paid receipt removes the order from the estimate; uncertain cases are reported, not summed", () => {
  const orders = [
    collected(1),
    collected(2),
    collected(3),
    collected(4, { status: 4, statusClass: "paid_candidate", lines: null }),
    collected(5, { status: 9, statusClass: "unknown", lines: null }),
    collected(6),
    collected(7),
    collected(8, { businessDate: "2026-11-10" }),
    collected(9, { lines: null }),
  ];
  const receipts = [
    { orderId: uuid(2).toUpperCase(), receiptId: 20, paymentStatus: 3, isCanceled: false },
    { orderId: uuid(2), receiptId: 20, paymentStatus: 3, isCanceled: false },
    { orderId: uuid(3), receiptId: 30, paymentStatus: 1, isCanceled: false },
    { orderId: uuid(6), receiptId: 60, paymentStatus: 3, isCanceled: false },
    { orderId: uuid(6), receiptId: 61, paymentStatus: 3, isCanceled: false },
    { orderId: uuid(7), receiptId: 70, paymentStatus: 4, isCanceled: true },
  ];
  const result = classifyOrdersForBusinessDate(
    [...orders, collected(10, { status: 2, statusClass: "unknown", lines: null })],
    [...receipts, { orderId: uuid(10), receiptId: 100, paymentStatus: 5, isCanceled: true }],
    "2026-11-09"
  );
  assert.deepEqual(result.open.map((o) => o.orderNo), ["1.1"]);
  assert.equal(result.converted, 1);
  assert.equal(result.receiptPending, 1);
  // Order 10 is no longer open in POS and only has a canceled receipt: excluded.
  assert.equal(result.receiptCanceled, 1);
  assert.equal(result.otherBusinessDate, 1);
  assert.deepEqual(result.uncertain.map((u) => [u.orderNo, u.reason]), [
    ["1.4", "paid_without_receipt"], ["1.5", "unknown_status"], ["1.6", "multiple_receipts"],
    // Order 7 is still Status=1 in POS but its only receipt was canceled: possibly re-opened.
    ["1.7", "open_after_canceled_receipt"], ["1.9", "open_without_lines"],
  ]);
});

test("production pattern: a canceled receipt re-issued as paid on the same OrderId is one paid sale", () => {
  // e.g. receipts 8385 (status 4) + 8388 (status 3) on one OrderId, 2026-10-20.
  const result = classifyOrdersForBusinessDate([collected(1)], [
    { orderId: uuid(1), receiptId: 8385, paymentStatus: 4, isCanceled: true },
    { orderId: uuid(1), receiptId: 8388, paymentStatus: 3, isCanceled: false },
  ], "2026-11-09");
  assert.deepEqual([result.open.length, result.converted, result.uncertain.length], [0, 1, 0]);
  // Two active receipts on one order remain uncertain.
  const twoPaid = classifyOrdersForBusinessDate([collected(1)], [
    { orderId: uuid(1), receiptId: 1, paymentStatus: 3, isCanceled: false },
    { orderId: uuid(1), receiptId: 2, paymentStatus: 1, isCanceled: false },
  ], "2026-11-09");
  assert.deepEqual(twoPaid.uncertain.map((u) => u.reason), ["multiple_receipts"]);
  // Manual app receipts carry no OrderId and never link to an order.
  const manual = classifyOrdersForBusinessDate([collected(1)], [{ orderId: "", receiptId: 3, paymentStatus: 3, isCanceled: false }], "2026-11-09");
  assert.equal(manual.open.length, 1);
});

const paid = { amount: 39_647_400, receiptCount: 26 };
const now = new Date("2026-11-09T14:00:00.000Z");
const fresh = { businessDate: "2026-11-09", lastSuccessAt: "2026-11-09T13:58:00.000Z", lastAttemptAt: "2026-11-09T13:58:00.000Z", lastErrorCode: null };

test("KPI: fresh snapshot gives open estimate and provisional totals beside unchanged paid values", () => {
  const classified = classifyOrdersForBusinessDate([collected(1), collected(2)], [], "2026-11-09");
  const kpi = buildOpenOrderKpi({ enabled: true, businessDate: "2026-11-09", isLiveBusinessDay: true, isClosed: false, paid, sync: fresh, classified, now });
  assert.equal(kpi.status, "ok");
  assert.deepEqual(kpi.paid, paid);
  assert.deepEqual(kpi.open, { amount: 300000, orderCount: 2, menuLineCount: 2, optionLineCount: 2, itemQuantity: 2 });
  assert.deepEqual(kpi.provisional, { amount: 39_947_400, count: 28, averageAmount: Math.round(39_947_400 / 28) });
  assert.equal(kpi.ageSeconds, 120);
  // A correctly collected empty snapshot is a real 0, distinct from "unavailable".
  const empty = buildOpenOrderKpi({ enabled: true, businessDate: "2026-11-09", isLiveBusinessDay: true, isClosed: false, paid, sync: fresh, classified: classifyOrdersForBusinessDate([], [], "2026-11-09"), now });
  assert.equal(empty.status, "ok");
  assert.equal(empty.open?.amount, 0);
});

test("KPI: disabled, closed, missing, failed or late data never shows 0 as an estimate", () => {
  const classified = classifyOrdersForBusinessDate([collected(1)], [], "2026-11-09");
  const make = (over: Partial<Parameters<typeof buildOpenOrderKpi>[0]>) =>
    buildOpenOrderKpi({ enabled: true, businessDate: "2026-11-09", isLiveBusinessDay: true, isClosed: false, paid, sync: fresh, classified, now, ...over });
  for (const [over, status] of [
    [{ enabled: false }, "not_enabled"],
    [{ isClosed: true }, "closed"],
    [{ isLiveBusinessDay: false }, "closed"],
    [{ sync: null }, "unavailable"],
    [{ classified: null }, "unavailable"],
    [{ sync: { ...fresh, businessDate: "2026-11-08" } }, "unavailable"],
    [{ sync: { ...fresh, lastSuccessAt: "2026-11-09T13:40:00.000Z", lastErrorCode: "provider_timeout" } }, "stale"],
  ] as const) {
    const kpi = make(over);
    assert.equal(kpi.status, status);
    assert.equal(kpi.open, null);
    assert.equal(kpi.provisional, null);
    assert.deepEqual(kpi.paid, paid);
  }
  const stale = make({ sync: { ...fresh, lastSuccessAt: "2026-11-09T13:40:00.000Z", lastErrorCode: "provider_timeout" } });
  assert.equal(stale.lastSuccessAt, "2026-11-09T13:40:00.000Z");
  assert.equal(stale.lastErrorCode, "provider_timeout");
});

test("run: claim busy/fresh never calls CUKCUK; failure is recorded and the snapshot is not committed", async () => {
  const calls: string[] = [];
  const input = { scope: "s", branchId: "b", businessDate: "2026-11-09", windowFrom: "2026-11-08T20:00:00.000Z", cutoff: CUTOFF };
  for (const status of ["busy", "fresh"]) {
    const t = transport(() => { throw new Error("must not call"); });
    const result = await runOpenOrderSync({ rpc: async (name) => { calls.push(name); return { status }; }, transport: t, uuid: () => uuid(1) }, input);
    assert.equal(result.status, status);
    assert.equal(t.sent.length, 0);
    assert.equal(t.logins(), 0);
  }
  calls.length = 0;
  const failing = transport(() => ({ status: 200, json: { Success: false, ErrorType: 102 } }));
  const failed = await runOpenOrderSync({ rpc: async (name, args) => { calls.push(name); return name === "pos_open_orders_claim" ? { status: "collecting" } : { status: "failed", code: args.p_code }; }, transport: failing, uuid: () => uuid(2) }, input);
  assert.deepEqual(failed, { status: "failed", code: "provider_busy_102" });
  assert.deepEqual(calls, ["pos_open_orders_claim", "pos_open_orders_fail"]);

  calls.length = 0;
  let committed: Record<string, unknown> | null = null;
  const good = transport((r) => (r.kind === "page" ? ok([order(1)], 1) : ok({ ...order(1), CustomerName: "secret", CustomerTel: "0900", OrderDetails: [line(1)] })));
  await runOpenOrderSync({ rpc: async (name, args) => { calls.push(name); if (name === "pos_open_orders_commit") committed = args; return { status: name === "pos_open_orders_claim" ? "collecting" : "committed" }; }, transport: good, uuid: () => uuid(3) }, input);
  assert.deepEqual(calls, ["pos_open_orders_claim", "pos_open_orders_commit"]);
  assert.doesNotMatch(JSON.stringify(committed), /secret|0900|CustomerTel/);
});

test("browsers never reach CUKCUK: read paths import no CUKCUK transport or login", () => {
  const read = (path: string) => readFileSync(path, "utf8");
  const reader = read("lib/sales/open-orders-read-server.ts");
  const route = read("app/api/admin/sales/today/route.ts");
  const page = read("app/(protected)/admin/sales/page.tsx");
  const panel = read("components/sales/OpenOrdersPanel.tsx");
  for (const source of [reader, route, page, panel]) {
    assert.doesNotMatch(source, /open-orders-sync-server|loginCukcuk|pos\/cukcuk\/auth|graphapi\.cukcuk|orders\/paging/);
  }
  // Disabled by default: the reader returns "not_enabled" before any DB read.
  const loader = reader.slice(reader.indexOf("export async function loadOpenOrderKpi"));
  assert.ok(loader.indexOf("if (!openOrdersReadEnabled())") < loader.indexOf("supabaseServer"));
  assert.ok(loader.indexOf("if (!openOrdersReadEnabled())") < loader.indexOf("resolveConfiguredBusinessDate("));
  assert.match(reader, /POS_OPEN_ORDERS_READ_ENABLED\?\.trim\(\) === "true"/);
  // The panel renders nothing until enabled, so the 2nd-phase KPI cards are unchanged.
  assert.match(panel, /if \(!data \|\| data\.status === "not_enabled"\) return null;/);
  assert.match(page, /import type \{ OpenOrderKpi \}/);
  assert.match(panel, /import type \{ OpenOrderKpi \}/);
  const sync = read("lib/pos/cukcuk/open-orders-sync-server.ts");
  assert.match(sync, /^import "server-only";/);
  assert.match(sync, /POS_OPEN_ORDERS_SYNC_ENABLED/);
  // Not activated: no route or cron imports the collector, and vercel.json has no schedule for it.
  assert.doesNotMatch(read("vercel.json"), /open-orders/);
});
