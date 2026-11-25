import type { CollectedOrder } from "./open-orders-core.ts";

/**
 * Diagnostic-only change evidence for one successful collection run (stored in the existing
 * runs.manifest under ORDER_CHANGES_MANIFEST_KEY). It compares the previous committed snapshot
 * of the SAME business date with the payload about to be committed and never feeds back into
 * collection, classification, table placement or payment decisions.
 *
 * - table_name_changed: the provider listed a different TableName for the same order
 *   (same id + order start time + business date). An observation, not a proven physical move.
 * - payment_candidate: Status 1/3 -> 4. A payment candidate, never a confirmed payment.
 * - merge_linked / merge_link_released: this run submits a new pending merge link (verified again
 *   by the DB, which rejects the whole commit otherwise) or drops a stored one. A relation, never
 *   a payment and never a physical seat move.
 * - receipt_closure / merge_closure / quarantined: only a pointer to the evidence the DB already
 *   writes in the same manifest (receiptClosures / quarantinedOrders). Nothing is copied, and a
 *   merge is linked only when this run submits a verified merge proof (the DB rejects the whole
 *   commit otherwise, so an unverified merge never reaches a stored manifest).
 *
 * No customer data and no raw provider rows: ids, statuses, table names and times only.
 * Repeated identical observations produce nothing because the baseline is the previous snapshot.
 */
export const ORDER_CHANGES_MANIFEST_KEY = "orderChanges";
export const ORDER_CHANGES_VERSION = 1;
export const MAX_ORDER_CHANGE_EVENTS = 40;
const MAX_TEXT = 40;

export type OrderChangeEvent =
  | { kind: "table_name_changed"; orderId: string; fromTable: string; toTable: string; fromObservedAt: string | null }
  | { kind: "payment_candidate"; orderId: string; fromStatus: number; toStatus: 4; lastTable: string | null }
  | { kind: "receipt_closure" | "merge_closure"; orderId: string; evidence: "receiptClosures" }
  | { kind: "quarantined"; orderId: string; evidence: "quarantinedOrders" }
  | { kind: "merge_linked"; orderId: string; targetOrderId: string; targetTable: string | null }
  | { kind: "merge_link_released"; orderId: string; targetOrderId: string };

export type OrderChangeLog = {
  version: number;
  runId: string;
  detectedAt: string;
  events: OrderChangeEvent[];
  eventCount: number;
  droppedCount: number;
};

const text = (value: unknown) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT) : null;
};
const key = (id: unknown) => (typeof id === "string" ? id.trim().toLowerCase() : "");
const sameStart = (a: unknown, b: unknown) => {
  const left = typeof a === "string" ? Date.parse(a) : NaN;
  const right = typeof b === "string" ? Date.parse(b) : NaN;
  return Number.isFinite(left) && left === right;
};

export function buildOrderChangeLog(input: {
  runId: string;
  detectedAt: string;
  businessDate: string;
  previousOrders: CollectedOrder[];
  orders: CollectedOrder[];
  maxEvents?: number;
}): OrderChangeLog | null {
  const previous = new Map<string, CollectedOrder>();
  for (const order of input.previousOrders) {
    if (order?.businessDate === input.businessDate && key(order.orderId)) previous.set(key(order.orderId), order);
  }
  const events: OrderChangeEvent[] = [];
  for (const current of input.orders) {
    if (current?.businessDate !== input.businessDate) continue;
    const id = key(current.orderId);
    const before = previous.get(id);
    // A reused id (different start time) is a different order: no history is shared.
    if (!id || !before || !sameStart(before.orderDate, current.orderDate)) continue;
    const orderId = text(current.orderId) ?? id;
    if (current.mergeTargetOrderId && !current.closureReceiptId) {
      if (!before.mergeTargetOrderId) events.push({ kind: "merge_linked", orderId, targetOrderId: text(current.mergeTargetOrderId) ?? "",
        targetTable: text(current.mergeTargetTable) });
      continue;
    }
    if (before.mergeTargetOrderId && !before.closureReceiptId && !current.closureReceiptId) {
      events.push({ kind: "merge_link_released", orderId, targetOrderId: text(before.mergeTargetOrderId) ?? "" });
    }
    if (current.quarantineReason) {
      if (!before.quarantinedAt) events.push({ kind: "quarantined", orderId, evidence: "quarantinedOrders" });
      continue;
    }
    if (current.closureReceiptId) {
      if (!before.closureReceiptId) {
        events.push({ kind: current.closureMergedIntoOrderId ? "merge_closure" : "receipt_closure", orderId, evidence: "receiptClosures" });
      }
      continue;
    }
    // Fresh provider facts only from here on.
    const fromTable = text(before.tableName);
    const toTable = text(current.tableName);
    if (fromTable && toTable && fromTable.toLowerCase() !== toTable.toLowerCase()) {
      events.push({ kind: "table_name_changed", orderId, fromTable, toTable, fromObservedAt: text(before.providerObservedAt) });
    }
    if ((before.status === 1 || before.status === 3) && current.status === 4) {
      events.push({ kind: "payment_candidate", orderId, fromStatus: before.status, toStatus: 4,
        lastTable: toTable ?? fromTable ?? text(before.lastTableName) });
    }
  }
  if (!events.length) return null;
  const max = Math.max(0, input.maxEvents ?? MAX_ORDER_CHANGE_EVENTS);
  return {
    version: ORDER_CHANGES_VERSION,
    runId: input.runId,
    detectedAt: input.detectedAt,
    events: events.slice(0, max),
    eventCount: events.length,
    droppedCount: Math.max(0, events.length - max),
  };
}

/**
 * Returns the manifest to commit: unchanged (same object) when there is no change, otherwise a
 * copy with one added key. Existing keys are never overwritten, and a builder error only adds a
 * fixed error marker; it never changes or fails the collection result.
 */
export function withOrderChangeLog(manifest: Record<string, unknown>, build: () => OrderChangeLog | null) {
  if (Object.prototype.hasOwnProperty.call(manifest, ORDER_CHANGES_MANIFEST_KEY)) return manifest;
  try {
    const log = build();
    return log ? { ...manifest, [ORDER_CHANGES_MANIFEST_KEY]: log } : manifest;
  } catch {
    return { ...manifest, [ORDER_CHANGES_MANIFEST_KEY]: { version: ORDER_CHANGES_VERSION, error: "build_failed" } };
  }
}
