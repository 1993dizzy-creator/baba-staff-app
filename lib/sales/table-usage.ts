import { classifyOrdersForBusinessDate, singlePaidOrderReceipt, type CollectedOrder } from "../pos/cukcuk/open-orders-core.ts";
import { calculateStoreBusinessDate } from "../store-settings/business-time-core.ts";
import type { CatalogTable, TableOverview, TableTile } from "./table-overview.ts";
import type { DetailReceiptRow } from "./table-detail.ts";

export type DailyTableUsage = {
  count: number | null;
  status: "confirmed_order_basis" | "review" | "unavailable";
  verifiedOrderCount: number;
  basis: "verified_order_groups";
  snapshotAt: string | null;
  reason: "one_verified_group" | "ambiguous_visits" | "link_review" | "snapshot_unhealthy" | "no_verified_orders";
};

/** Read-only evidence projection, never an occupancy, cleaning or customer-visit decision.
 * Distinct OrderIds do not prove distinct visits. Without a visit/session identity,
 * multiple unrelated groups remain review instead of inventing a daily visit total.
 */
export function projectDailyTableUsage(input: {
  table: TableTile; catalog: CatalogTable[]; overview: TableOverview; orders: CollectedOrder[];
  receipts: DetailReceiptRow[]; now: Date; cutoff?: string;
  merges: { receiptId: number; verified: boolean }[];
}): DailyTableUsage {
  const { table, overview, catalog, receipts, now } = input;
  const result = (status: DailyTableUsage["status"], reason: DailyTableUsage["reason"], verifiedOrderCount = 0, count: number | null = null): DailyTableUsage =>
    ({ status, reason, count, verifiedOrderCount, basis: "verified_order_groups", snapshotAt: overview.snapshotAt });
  if (overview.snapshotStatus !== "ok" || !Number.isFinite(now.getTime()) || !Number.isFinite(Date.parse(overview.snapshotAt ?? ""))) return result("unavailable", "snapshot_unhealthy");
  const name = (v: string | null | undefined) => v?.normalize("NFC").trim().toLocaleLowerCase("vi-VN") ?? "";
  const id = (v: string | null | undefined) => v?.trim().toLowerCase() ?? "";
  const uniqueTable = (v: string | null | undefined) => {
    const matches = catalog.filter(t => name(t.name) === name(v));
    return matches.length === 1 ? matches[0].id : null;
  };
  const links = receipts.map(r => ({ orderId: id(r.order_id), receiptId: r.id, businessDate: r.business_date,
    paymentStatus: r.payment_status, isCanceled: r.is_canceled }));
  const rows = new Map<string, CollectedOrder>();
  const validPayment = (r: DetailReceiptRow, start: number) => {
    const at = Date.parse(r.ref_date ?? ""), amount = r.final_amount === null || typeof r.final_amount === "string" && !r.final_amount.trim() ? NaN : Number(r.final_amount);
    return r.payment_status === 3 && r.is_canceled === false && Number.isFinite(amount) && amount >= 0
      && Number.isFinite(at) && at >= start && at <= now.getTime()
      && calculateStoreBusinessDate(new Date(at), input.cutoff) === overview.businessDate;
  };
  let review = false;
  for (const o of input.orders.filter(o => o.businessDate === overview.businessDate)) {
    const orderId = id(o.orderId), previous = rows.get(orderId);
    if (!orderId || previous && JSON.stringify({ ...previous, raw: {} }) !== JSON.stringify({ ...o, raw: {} })) review = true;
    else rows.set(orderId, o);
  }
  const groups = new Set<string>(), verifiedIds = new Set<string>();
  for (const [orderId, o] of rows) {
    if (uniqueTable(o.tableName) !== table.id) {
      // A receipt cannot locate a missing/different source table or prove a table move.
      if (receipts.some(r => r.business_date === overview.businessDate && id(r.order_id) === orderId && uniqueTable(r.table_name) === table.id)) review = true;
      continue;
    }
    const start = Date.parse(o.orderDate), observed = Date.parse(o.providerObservedAt ?? ""), snapshot = Date.parse(overview.snapshotAt ?? "");
    if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(o.orderDate) || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(o.providerObservedAt ?? "")
      || !Number.isFinite(start) || !Number.isFinite(observed) || start > observed || observed > snapshot || snapshot > now.getTime()
      || calculateStoreBusinessDate(o.orderDate, input.cutoff) !== overview.businessDate) { review = true; continue; }
    const merge = input.merges.find(m => m.verified && (m.receiptId === o.closureReceiptId
      || receipts.some(r => r.id === m.receiptId && id(r.order_id) === orderId)));
    if (merge) {
      const proof = receipts.find(r => r.id === merge.receiptId);
      if (proof && validPayment(proof, start)) { groups.add(`merge:${merge.receiptId}`); verifiedIds.add(orderId); }
      else review = true;
      continue;
    }
    if (o.closureMergedIntoOrderId) { review = true; continue; }
    const paid = singlePaidOrderReceipt(orderId, overview.businessDate, links);
    const r = paid ? receipts.find(r => r.id === paid.receiptId) : null;
    if (r) {
      if (uniqueTable(r.table_name) === table.id && validPayment(r, start)) {
        groups.add(`order:${orderId}`); verifiedIds.add(orderId);
      } else review = true;
      continue;
    }
    const classified = classifyOrdersForBusinessDate([o], links, overview.businessDate);
    if (classified.open.length === 1 && table.orders.some(row => id(row.id) === orderId && row.verifiedOpen)) {
      groups.add(`order:${orderId}`); verifiedIds.add(orderId);
    } else if (o.status !== 5) review = true;
  }
  // Receipt-only or conflicting payment links are never extra table uses.
  for (const r of receipts) if (r.business_date === overview.businessDate && uniqueTable(r.table_name) === table.id
    && !input.merges.some(m => m.receiptId === r.id)
    && !(r.is_canceled === true || r.payment_status === 4 || r.payment_status === 5)
    && !verifiedIds.has(id(r.order_id))) review = true;
  if (review) return result("review", "link_review", verifiedIds.size);
  if (groups.size > 1) return result("review", "ambiguous_visits", verifiedIds.size);
  if (groups.size === 1) return result("confirmed_order_basis", "one_verified_group", verifiedIds.size, 1);
  return result("unavailable", "no_verified_orders");
}
