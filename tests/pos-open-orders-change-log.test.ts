// P1 diagnostics: order change evidence in the existing runs.manifest. Synthetic ids only.
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ORDER_CHANGE_EVENTS,
  ORDER_CHANGES_MANIFEST_KEY,
  buildOrderChangeLog,
  withOrderChangeLog,
} from "../lib/pos/cukcuk/open-orders-change-log.ts";
import { runOpenOrderSync, type CollectedOrder, type OrderRequest, type OrderTransport } from "../lib/pos/cukcuk/open-orders-core.ts";

const DATE = "2026-11-09";
const START = "2026-11-09T13:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const order = (n: number, extra: Partial<CollectedOrder> = {}): CollectedOrder => ({
  orderId: uuid(n), orderNo: `1.${n}`, status: 1, statusClass: "open", orderDate: START, totalAmount: 100000, raw: {},
  businessDate: DATE, tableName: "11", lines: [], ...extra,
});
const paid = (n: number, extra: Partial<CollectedOrder> = {}) => order(n, { status: 4, statusClass: "paid_candidate", tableName: null, lines: null, ...extra });
const build = (previousOrders: CollectedOrder[], orders: CollectedOrder[], extra: { maxEvents?: number } = {}) =>
  buildOrderChangeLog({ runId: uuid(900), detectedAt: "2026-11-09T14:00:00.000Z", businessDate: DATE, previousOrders, orders, ...extra });

test("1. repeated collection of unchanged orders writes no change log", () => {
  const snapshot = [order(1), order(2, { tableName: "7", status: 3 }), paid(3)];
  assert.equal(build(snapshot, snapshot.map((o) => ({ ...o }))), null);
  assert.equal(build([], snapshot), null, "first observation is not a change");
  const manifest = { businessDate: DATE, mode: "full" };
  assert.equal(withOrderChangeLog(manifest, () => build(snapshot, snapshot)), manifest, "manifest is the same object");
});

test("2. same order listed at 11 then 14 is recorded as a table-name observation", () => {
  const log = build([order(1, { providerObservedAt: "2026-11-09T13:30:00+00:00" })], [order(1, { tableName: " 14 " })]);
  assert.deepEqual(log?.events, [{ kind: "table_name_changed", orderId: uuid(1), fromTable: "11", toTable: "14", fromObservedAt: "2026-11-09T13:30:00+00:00" }]);
  assert.deepEqual([log?.runId, log?.detectedAt, log?.eventCount, log?.droppedCount], [uuid(900), "2026-11-09T14:00:00.000Z", 1, 0]);
  // Case-only or blank names are not a change.
  assert.equal(build([order(1, { tableName: "BAR10" })], [order(1, { tableName: "bar10" })]), null);
  assert.equal(build([order(1)], [order(1, { tableName: "  " })]), null);
});

test("3. Status 1/3 -> 4 is a payment candidate with the last listed table, never a payment", () => {
  const log = build([order(1, { tableName: "14" }), order(2, { status: 3, tableName: "BAR4" })], [paid(1), paid(2, { tableName: "BAR4" })]);
  assert.deepEqual(log?.events, [
    { kind: "payment_candidate", orderId: uuid(1), fromStatus: 1, toStatus: 4, lastTable: "14" },
    { kind: "payment_candidate", orderId: uuid(2), fromStatus: 3, toStatus: 4, lastTable: "BAR4" },
  ]);
  assert.doesNotMatch(JSON.stringify(log), /paid"|"payment_confirmed|"settled/);
  // Unknown statuses do not count as a transition source.
  assert.equal(build([order(1, { status: 7, statusClass: "unknown" })], [paid(1)]), null);
});

test("4. a Status 4 that persists does not repeat the event", () => {
  assert.equal(build([paid(1, { lastTableName: "14" })], [paid(1)]), null);
  assert.equal(build([paid(1, { tableName: "14" })], [paid(1, { tableName: "14" })]), null);
});

test("5. reused ids and other business dates never share history", () => {
  assert.equal(build([order(1, { orderDate: "2026-11-09T12:00:00.000Z" })], [order(1, { tableName: "14" })]), null);
  assert.equal(build([order(1, { businessDate: "2026-11-08" })], [order(1, { tableName: "14" })]), null);
  assert.equal(build([order(1)], [paid(1, { businessDate: "2026-11-10" })]), null);
  // The same instant in another offset format is the same order start.
  assert.equal(build([order(1, { orderDate: "2026-11-09T20:00:00+07:00" })], [order(1, { tableName: "14" })])?.eventCount, 1);
});

test("6. new closures/quarantines only point to the DB evidence; carried ones are not repeated", () => {
  const log = build(
    [order(1), order(2), order(3), order(4, { closureReceiptId: 77, closureMergedIntoOrderId: uuid(9) }), order(5, { quarantinedAt: "2026-11-09T13:40:00+00:00" })],
    [order(1, { closureReceiptId: 55, closureMergedIntoOrderId: uuid(9), tableName: "99" }),
      order(2, { closureReceiptId: 56, closureMergedIntoOrderId: null }),
      order(3, { quarantineReason: "vanished_unconfirmed", tableName: "99" }),
      order(4, { closureReceiptId: 77, closureMergedIntoOrderId: uuid(9) }),
      order(5, { quarantineReason: "vanished_unconfirmed" })]);
  assert.deepEqual(log?.events, [
    { kind: "merge_closure", orderId: uuid(1), evidence: "receiptClosures" },
    { kind: "receipt_closure", orderId: uuid(2), evidence: "receiptClosures" },
    { kind: "quarantined", orderId: uuid(3), evidence: "quarantinedOrders" },
  ]);
  // Preserved (closed/quarantined) facts never produce a table or status event.
  assert.doesNotMatch(JSON.stringify(log), /table_name_changed|receiptId|"99"|lines|amount/i);
});

test("7. an unproven merge is quarantined, never logged as a merge", () => {
  const log = build([order(1)], [order(1, { quarantineReason: "vanished_unconfirmed" })]);
  assert.deepEqual(log?.events.map((e) => e.kind), ["quarantined"]);
});

test("limits: event count is capped, overflow counted, text truncated, inputs untouched, no customer data", () => {
  const n = MAX_ORDER_CHANGE_EVENTS + 5;
  const previous = Array.from({ length: n }, (_, i) => Object.freeze(order(i + 1, { raw: Object.freeze({ CustomerName: "secret", CustomerTel: "+84-912-345" }) })));
  const current = Array.from({ length: n }, (_, i) => Object.freeze(order(i + 1, { tableName: `T${"x".repeat(80)}`, raw: Object.freeze({ CustomerTel: "+84-912-345" }) })));
  const log = build(previous, current);
  assert.deepEqual([log?.events.length, log?.eventCount, log?.droppedCount], [MAX_ORDER_CHANGE_EVENTS, n, 5]);
  assert.ok(log!.events.every((e) => e.kind !== "table_name_changed" || e.toTable.length === 40));
  assert.doesNotMatch(JSON.stringify(log), /secret|912-345|Customer/);
  assert.ok(JSON.stringify(log).length < 12_000, "bounded size");
});

test("manifest safety: existing keys are kept, an existing key is never overwritten, builder errors only add a marker", () => {
  const manifest = Object.freeze({ businessDate: DATE, mode: "full", total: 2, quarantinedCount: 0 });
  const added = withOrderChangeLog(manifest, () => build([order(1)], [order(1, { tableName: "14" })]));
  assert.deepEqual(Object.keys(added), [...Object.keys(manifest), ORDER_CHANGES_MANIFEST_KEY]);
  for (const [k, v] of Object.entries(manifest)) assert.equal((added as Record<string, unknown>)[k], v);
  const taken = { ...manifest, [ORDER_CHANGES_MANIFEST_KEY]: "kept" };
  assert.equal(withOrderChangeLog(taken, () => build([order(1)], [order(1, { tableName: "14" })])), taken);
  assert.deepEqual(withOrderChangeLog(manifest, () => { throw new Error("boom"); }),
    { ...manifest, [ORDER_CHANGES_MANIFEST_KEY]: { version: 1, error: "build_failed" } });
  for (const reserved of ["storedOrders", "storedLines", "receiptClosures", "retainedCancellations", "quarantinedOrders"]) {
    assert.notEqual(ORDER_CHANGES_MANIFEST_KEY, reserved);
  }
});

// --- Through the real collector (runOpenOrderSync) ---
const ok = (data: unknown, total?: number) => ({ status: 200, json: { Success: true, Code: 200, ErrorType: 0, Data: data, ...(total === undefined ? {} : { Total: total }) } });
const header = (n: number, extra: Record<string, unknown> = {}) => ({ Id: uuid(n), No: `1.${n}`, Status: 1, Date: "2026-11-09T20:00:00+07:00", TotalAmount: 100000, TableName: "11", ...extra });
function transport(rows: Record<string, unknown>[] | Error): OrderTransport {
  return {
    async login() {},
    async sleep() {},
    async send(request: OrderRequest) {
      if (rows instanceof Error) throw rows;
      if (request.kind === "page") return ok(rows, rows.length);
      const row = rows.find((r) => r.Id === request.orderId);
      return ok({ ...row, CustomerName: "secret", CustomerTel: "+84-912-345",
        OrderDetails: [{ Id: uuid(5000), ItemId: uuid(6000), ItemName: "Item", Quantity: 1, Price: 100000, Amount: 100000 }] });
    },
  };
}
const syncInput = { scope: "s", branchId: "b", businessDate: DATE, windowFrom: "2026-11-08T20:00:00.000Z", cutoff: "03:00" };
async function run(previousOrders: unknown[], rows: Record<string, unknown>[] | Error) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const result = await runOpenOrderSync({ now: () => Date.parse("2026-11-09T14:00:00.000Z"),
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === "pos_open_orders_claim") return { status: "collecting" };
      if (name === "pos_open_orders_read") return { orders: previousOrders };
      if (name === "pos_open_orders_fail") return { status: "failed", code: args.p_code };
      return { status: "committed" };
    }, transport: transport(rows), uuid: () => uuid(777) }, syncInput);
  const commit = calls.find((c) => c.name === "pos_open_orders_commit");
  return { result, calls, manifest: commit?.args.p_manifest as Record<string, unknown> | undefined, orders: commit?.args.p_orders };
}
const prevRow = (n: number, extra: Record<string, unknown> = {}) => ({ orderId: uuid(n), orderNo: `1.${n}`, status: 1, statusClass: "open",
  orderDate: "2026-11-09T13:00:00+00:00", businessDate: DATE, totalAmount: 100000, tableName: "11", lines: [], providerObservedAt: "2026-11-09T13:50:00+00:00", ...extra });

test("collector: change log is added only when the provider facts changed, payload unchanged either way (10)", async () => {
  const same = await run([prevRow(1)], [header(1)]);
  assert.equal(same.result.status, "committed");
  assert.equal(same.manifest?.[ORDER_CHANGES_MANIFEST_KEY], undefined);
  const moved = await run([prevRow(1)], [header(1, { TableName: "14" })]);
  const changed = await run([prevRow(1, { tableName: "14", status: 3 })], [header(1, { TableName: "14" })]);
  assert.deepEqual(moved.manifest?.[ORDER_CHANGES_MANIFEST_KEY], { version: 1, runId: uuid(777), detectedAt: "2026-11-09T14:00:00.000Z",
    events: [{ kind: "table_name_changed", orderId: uuid(1), fromTable: "11", toTable: "14", fromObservedAt: "2026-11-09T13:50:00+00:00" }],
    eventCount: 1, droppedCount: 0 });
  // Same provider rows; a different previous snapshot changes only the diagnostic key.
  const baseline = await run([prevRow(1, { orderDate: "2026-11-09T12:00:00+00:00" })], [header(1, { TableName: "14" })]);
  assert.equal(baseline.manifest?.[ORDER_CHANGES_MANIFEST_KEY], undefined, "reused id: no history");
  assert.deepEqual(moved.orders, baseline.orders);
  assert.deepEqual(changed.orders, baseline.orders);
  const { [ORDER_CHANGES_MANIFEST_KEY]: _log, ...rest } = moved.manifest!;
  assert.deepEqual(rest, baseline.manifest);
  assert.doesNotMatch(JSON.stringify(moved.manifest), /secret|912-345|Customer/);

  const toPaid = await run([prevRow(1, { tableName: "14" })], [header(1, { Status: 4, TableName: null })]);
  assert.deepEqual((toPaid.manifest?.[ORDER_CHANGES_MANIFEST_KEY] as { events: unknown[] }).events,
    [{ kind: "payment_candidate", orderId: uuid(1), fromStatus: 1, toStatus: 4, lastTable: "14" }]);
});

test("8. a failed collection commits nothing, so no change is recorded as normal history", async () => {
  const failed = await run([prevRow(1)], new Error("network"));
  assert.equal(failed.result.status, "failed");
  assert.deepEqual(failed.calls.map((c) => c.name), ["pos_open_orders_claim", "pos_open_orders_read", "pos_open_orders_fail"]);
  assert.deepEqual(Object.keys(failed.calls[2].args).sort(), ["p_code", "p_owner_token", "p_run_id"]);
});
