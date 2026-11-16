import { classifyOrdersForBusinessDate, singlePaidOrderReceipt, type CollectedOrder } from "../pos/cukcuk/open-orders-core.ts";
import { addStoreDays, calculateStoreBusinessDate } from "../store-settings/business-time-core.ts";
import type { TableCatalog, TableReceipt } from "./table-overview.ts";

export type PaidCumulativeEvidence = {
  count: number | null;
  status: "review" | "unavailable";
  reason: "coverage_unverified" | "evidence_conflict" | "snapshot_unhealthy";
  // A lower bound within the supplied snapshot, NEVER a certified full-day total.
  verifiedObservedCount: number | null;
  byTable: Record<string, number>;
  coverage: "unverified";
};

/** Pure existing-read projection. Payment/table events, not blue tiles or customer visits.
 * The current GET has no whole-business-day completeness proof. Publishing a daily
 * total (including zero) would be unjustified, even when the supplied rows are healthy.
 */
export function projectPaidCumulative(input: {
  businessDate: string; now: Date; snapshotAt: string | null; healthy: boolean;
  catalog: TableCatalog; orders: CollectedOrder[]; receipts: TableReceipt[]; cutoff?: string;
}): PaidCumulativeEvidence {
  const result: PaidCumulativeEvidence = { count: null, status: "review", reason: "coverage_unverified",
    verifiedObservedCount: null, byTable: {}, coverage: "unverified" };
  if (!input.healthy || input.catalog.status !== "ok") return { ...result, status: "unavailable", reason: "snapshot_unhealthy" };
  const id = (v: string | null | undefined) => v?.trim().toLowerCase() ?? "";
  const name = (v: string | null | undefined) => v?.normalize("NFC").trim().toLocaleLowerCase("vi-VN") ?? "";
  const tableNames = new Map<string, string | null>();
  for (const t of input.catalog.tables) tableNames.set(name(t.name), tableNames.has(name(t.name)) ? null : t.id);
  const table = (v: string | null | undefined) => tableNames.get(name(v)) ?? null;
  const receipts = new Map<number, TableReceipt>(), orders = new Map<string, CollectedOrder>();
  let conflict = false;
  for (const r of input.receipts) {
    if (![input.businessDate, addStoreDays(input.businessDate, 1)].includes(r.businessDate ?? "")) continue;
    const canonical = { ...r, orderId: id(r.orderId), tableName: name(r.tableName) };
    const previous = receipts.get(r.receiptId);
    if (!Number.isSafeInteger(r.receiptId) || r.receiptId <= 0 || previous && JSON.stringify(previous) !== JSON.stringify(canonical)) conflict = true;
    else receipts.set(r.receiptId, canonical);
  }
  for (const o of input.orders) {
    if (o.businessDate !== input.businessDate) continue;
    const canonical = { ...o, orderId: id(o.orderId), raw: {} }, previous = orders.get(canonical.orderId);
    if (!canonical.orderId || previous && JSON.stringify(previous) !== JSON.stringify(canonical)) conflict = true;
    else orders.set(canonical.orderId, canonical);
  }
  if (conflict) return { ...result, reason: "evidence_conflict" };
  const links = [...receipts.values()], events = new Map<string, Set<string>>();
  const linksByOrder = new Map<string, TableReceipt[]>(), membersByReceipt = new Map<number, CollectedOrder[]>();
  for (const r of links) { if (!linksByOrder.has(r.orderId)) linksByOrder.set(r.orderId, []); linksByOrder.get(r.orderId)!.push(r); }
  for (const o of orders.values()) if (o.closureReceiptId && o.closureMergedIntoOrderId) {
    if (!membersByReceipt.has(o.closureReceiptId)) membersByReceipt.set(o.closureReceiptId, []);
    membersByReceipt.get(o.closureReceiptId)!.push(o);
  }
  const snapshot = Date.parse(input.snapshotAt ?? ""), now = input.now.getTime();
  const validOrder = (o: CollectedOrder, paidTime: number) => {
    const start = Date.parse(o.orderDate), observed = Date.parse(o.providerObservedAt ?? "");
    return Number.isFinite(snapshot) && snapshot <= now && Number.isFinite(start) && Number.isFinite(observed)
      && start <= paidTime && start <= observed && observed <= snapshot && o.status !== 5
      && Number.isFinite(o.totalAmount) && o.totalAmount >= 0
      && calculateStoreBusinessDate(o.orderDate, input.cutoff) === input.businessDate;
  };
  const record = (tableId: string, event: string) => {
    if (!events.has(tableId)) events.set(tableId, new Set());
    events.get(tableId)!.add(event);
  };
  for (const r of links) {
    if (r.isCanceled === true || r.paymentStatus === 4 || r.paymentStatus === 5 || r.paymentStatus === 1) continue;
    if (r.paymentStatus !== 3 || r.isCanceled !== false || !id(r.orderId)) { conflict = true; continue; }
    const at = Date.parse(r.paidAt ?? "");
    if (!Number.isFinite(at) || at > now || calculateStoreBusinessDate(new Date(at), input.cutoff) !== input.businessDate
      || singlePaidOrderReceipt(r.orderId, input.businessDate, linksByOrder.get(r.orderId) ?? [])?.receiptId !== r.receiptId) { conflict = true; continue; }
    const target = orders.get(id(r.orderId));
    if (!target || !validOrder(target, at)) { conflict = true; continue; }
    const members = membersByReceipt.get(r.receiptId) ?? [];
    if (members.length) {
      const targets = new Set(members.map(o => id(o.closureMergedIntoOrderId)));
      const group = [target, ...members];
      if (targets.size !== 1 || !targets.has(id(target.orderId)) || group.some(o => !table(o.tableName) || !validOrder(o, at))
        || members.some(o => !Number.isFinite(Date.parse(o.closureConfirmedAt ?? "")) || Date.parse(o.closureConfirmedAt!) > snapshot
          || classifyOrdersForBusinessDate([o], [...(linksByOrder.get(o.orderId) ?? []), ...(linksByOrder.get(id(o.closureMergedIntoOrderId)) ?? [])], input.businessDate).merged !== 1)) { conflict = true; continue; }
      for (const o of group) record(table(o.tableName)!, `payment:${id(target.orderId)}`);
    } else {
      const targetTable = table(target.tableName);
      if (!targetTable || targetTable !== table(r.tableName) || target.closureMergedIntoOrderId) { conflict = true; continue; }
      record(targetTable, `payment:${id(target.orderId)}`);
    }
  }
  result.byTable = Object.fromEntries([...events].map(([key, values]) => [key, values.size]));
  result.verifiedObservedCount = [...events.values()].reduce((sum, set) => sum + set.size, 0);
  if (conflict) result.reason = "evidence_conflict";
  return result;
}
