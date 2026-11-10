import assert from "node:assert/strict";
import test from "node:test";
import { classifyOrderStatus, collectOpenOrderSnapshot, mergeOrderDetail, normalizeOrderSummary,
  unfinishedOrderIds, singlePaidOrderReceipt, classifyOrdersForBusinessDate, runOpenOrderSync, type OrderTransport } from "../lib/pos/cukcuk/open-orders-core.ts";

const businessDate = "2026-11-10";
const header = { Id: "order-18", No: "1.18", Date: "2026-11-10T22:00:00+07:00", Status: 3, TotalAmount: 2410000 };
const previous = mergeOrderDetail(normalizeOrderSummary(header), { Data: { ...header, OrderDetails: [
  { Id: "line-18", Quantity: 1, Amount: 2410000, Status: 1 },
] } }, "03:00");
const paid = { orderId: "order-18", receiptId: 18, paymentStatus: 3, isCanceled: false, businessDate };
const run = (Data: unknown, receipts = [paid], extra = {}) => {
  const sent: string[] = [];
  const transport: OrderTransport = { login: async () => {}, send: async request => {
    sent.push(request.kind);
    return { status: 200, json: request.kind === "page" ? { Success: true, Total: 0, Data: [] } : { Success: true, Data } };
  } };
  const input = { branchId: "fixture", businessDate, windowFrom: "2026-11-09T20:00:00Z", cutoff: "03:00",
    previousUnfinishedIds: [previous.orderId], previousOrders: [previous], loadReceiptEvidence: async () => receipts, ...extra };
  return { result: collectOpenOrderSnapshot(transport, input), sent };
};

test("RED: missing detail ID with one independent paid receipt recovers the preserved snapshot without inventing provider facts", async () => {
  const snapshot = await run({ ...header, Id: undefined }).result;
  assert.equal(snapshot.orders.length, 1);
  assert.equal(snapshot.orders[0].orderId, previous.orderId);
  assert.equal(snapshot.orders[0].status, 3);
  assert.equal((snapshot.orders[0] as unknown as { closureReceiptId: number }).closureReceiptId, 18);
});

test("RED: official Status 5 is canceled and no longer an unfinished-order recheck", () => {
  assert.equal(classifyOrderStatus(5), "canceled");
  assert.deepEqual(unfinishedOrderIds([{ orderId: previous.orderId, status: 5, statusClass: "unknown" }]), []);
});

test("missing ID without independent evidence remains blocked", async () => {
  await assert.rejects(run({ ...header, Id: undefined }, []).result, { code: "orders_vanished_unconfirmed",
    diagnostic: { stage: "vanished_detail", reason: "order_id_missing", causeCode: "orders_invalid_row", vanishedCount: 1, confirmedCount: 0 } });
});

test("missing Data can use independent evidence; wrong identity, malformed ID/date/data cannot", async () => {
  assert.equal((await run(undefined).result).orders[0].closureReceiptId, 18);
  for (const [Data, reason] of [[{ ...header, Id: "different" }, "vanished_id_mismatch"],
    [{ ...header, Id: 18 }, "order_id_invalid"], [{ ...header, Date: "bad" }, "order_date_invalid"],
    [{ ...header, Date: "2026-11-09T22:00:00+07:00" }, "vanished_business_date_mismatch"],
    [[], "detail_data_invalid"]] as const) {
    await assert.rejects(run(Data).result, (error: unknown) => {
      const failure = error as { code: string; diagnostic: { reason: string } };
      assert.equal(failure.code, "orders_vanished_unconfirmed");
      assert.equal(failure.diagnostic.reason, reason);
      return true;
    });
  }
  await assert.rejects(run(undefined, []).result, { diagnostic: { stage: "vanished_detail", reason: "detail_data_missing",
    causeCode: "order_detail_mismatch", vanishedCount: 1, confirmedCount: 0 } });
});

test("pending, canceled-only and duplicate active receipts are not closure evidence; a canceled reissue plus one paid receipt is", async () => {
  const missing = { ...header, Id: undefined };
  for (const rows of [[{ ...paid, paymentStatus: 1 }], [{ ...paid, paymentStatus: 4 }], [{ ...paid, isCanceled: true }],
    [paid, { ...paid, receiptId: 19 }], [paid, { ...paid, receiptId: 19, paymentStatus: 1 }],
    [{ ...paid, orderId: "other-order" }], [{ ...paid, businessDate: "2026-11-09" }]]) {
    await assert.rejects(run(missing, rows).result, { code: "orders_vanished_unconfirmed" });
  }
  const result = await run(missing, [{ ...paid, receiptId: 17, paymentStatus: 4 }, paid, paid]).result;
  assert.equal(result.orders[0].closureReceiptId, 18);
});

test("03:00 cutoff: same/next receipt business date closes the previous business day's order, other dates cannot", () => {
  for (const date of [businessDate, "2026-11-11"]) {
    assert.equal(singlePaidOrderReceipt(previous.orderId, businessDate, [{ ...paid, businessDate: date }])?.receiptId, 18);
  }
  assert.equal(singlePaidOrderReceipt(previous.orderId, businessDate, [{ ...paid, businessDate: "2026-11-12" }]), null);
  const boundary = { ...header, Date: "2026-11-11T02:59:59+07:00" };
  assert.equal(mergeOrderDetail(normalizeOrderSummary(boundary), { Data: { ...boundary, OrderDetails: [] } }, "03:00").businessDate, businessDate);
  boundary.Date = "2026-11-11T03:00:00+07:00";
  assert.equal(mergeOrderDetail(normalizeOrderSummary(boundary), { Data: { ...boundary, OrderDetails: [] } }, "03:00").businessDate, "2026-11-11");
});

test("receipt-proven old header is never reused as a fresh open estimate after proof changes", async () => {
  const snapshot = await run({ ...header, Id: undefined }).result;
  assert.equal(classifyOrdersForBusinessDate(snapshot.orders, [paid], businessDate).converted, 1);
  for (const rows of [[], [{ ...paid, paymentStatus: 1 }]]) {
    const classified = classifyOrdersForBusinessDate(snapshot.orders, rows, businessDate);
    assert.equal(classified.open.length, 0);
    assert.equal(classified.uncertain[0].reason, "closure_evidence_changed");
  }
  const canceled = { ...previous, status: 5, statusClass: "canceled" as const };
  const classification = classifyOrdersForBusinessDate([canceled], [], businessDate);
  assert.deepEqual([classification.open.length, classification.uncertain.length, classification.canceled], [0, 0, 1]);
});

test("an unupgraded DB cannot silently accept unsupported closure metadata", async () => {
  let receiptReads = 0;
  const result = await runOpenOrderSync({
    rpc: async name => name === "pos_open_orders_claim" ? { status: "collecting" }
      : name === "pos_open_orders_read" ? { orders: [previous] } : {},
    transport: { login: async () => {}, send: async request => ({ status: 200, json: request.kind === "page"
      ? { Success: true, Total: 0, Data: [] } : { Success: true, Data: { ...header, Id: undefined } } }) },
    uuid: () => "fixture", loadReceiptEvidence: async () => { receiptReads++; return [paid]; },
  }, { branchId: "fixture", scope: "fixture", businessDate, windowFrom: "2026-11-09T20:00:00Z", cutoff: "03:00" });
  assert.equal(result.code, "orders_vanished_unconfirmed");
  assert.equal(receiptReads, 0);
});

test("provider failure is distinct from missing Id and never bypassed by a paid receipt", async () => {
  let evidenceReads = 0;
  await assert.rejects(collectOpenOrderSnapshot({ login: async () => {}, send: async request => ({ status: 200,
    json: request.kind === "page" ? { Success: true, Data: [], Total: 0 } : { Success: false, Code: 404 } }) },
  { branchId: "fixture", businessDate, windowFrom: "2026-11-09T20:00:00Z", cutoff: "03:00",
    previousOrders: [previous], previousUnfinishedIds: [previous.orderId],
    loadReceiptEvidence: async () => { evidenceReads++; return [paid]; } }),
  { code: "orders_vanished_unconfirmed", diagnostic: { stage: "vanished_detail", causeCode: "provider_failure", vanishedCount: 1, confirmedCount: 0 } });
  assert.equal(evidenceReads, 0);
});

test("a normally listed canceled Status 5 needs no menu request and never becomes unpaid sales", async () => {
  const sent: string[] = [];
  const result = await collectOpenOrderSnapshot({ login: async () => {}, send: async request => {
    sent.push(request.kind); return { status: 200, json: { Success: true, Total: 1, Data: [{ ...header, Status: 5 }] } };
  } }, { branchId: "fixture", businessDate, windowFrom: "2026-11-09T20:00:00Z", cutoff: "03:00" });
  assert.deepEqual(sent, ["page"]);
  assert.equal(result.orders[0].statusClass, "canceled");
  assert.equal(result.orders[0].lines, null);
  assert.equal(classifyOrdersForBusinessDate(result.orders, [], businessDate).canceled, 1);
});
