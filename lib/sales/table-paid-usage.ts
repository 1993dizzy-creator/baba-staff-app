import { classifyOrderStatus, singlePaidOrderReceipt, type CollectedOrder } from "../pos/cukcuk/open-orders-core.ts";
import { calculateStoreBusinessDate } from "../store-settings/business-time-core.ts";
import type { DetailReceipt, DetailReceiptRow } from "./table-detail.ts";
import type { CatalogTable, TableOverview, TableTile } from "./table-overview.ts";

export type PaidOrderUsage = { minutes: number; receiptId: number; startedAt: string; referenceAt: string; snapshotAt: string };
const id = (value: string | null | undefined) => value?.trim().toLowerCase() ?? "";
const name = (value: string | null | undefined) => value?.normalize("NFC").trim().toLocaleLowerCase("vi-VN") ?? "";
const instant = (value: string | null | undefined) => value && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN;

/** ONE order's processing time, not physical table occupancy. Missing table names
 * do not erase an exact OrderId/time link; known contradictions and merges block it.
 */
export function projectReceiptOrderUsage(input: {
  overview: TableOverview; orders: CollectedOrder[]; receipts: DetailReceiptRow[];
  receipt: DetailReceipt | null; now: Date; cutoff?: string;
}): PaidOrderUsage | null {
  const { overview, receipt: latest } = input;
  if (overview.snapshotStatus !== "ok" || !latest?.validPaid || latest.canceled || latest.uncertain || latest.link !== "direct"
    || latest.businessDate !== overview.businessDate) return null;
  const receipt = input.receipts.find(r => r.id === latest.id), key = id(receipt?.order_id);
  if (!receipt || !key || receipt.business_date !== overview.businessDate || receipt.payment_status !== 3 || receipt.is_canceled !== false || receipt.ref_date !== latest.referenceAt) return null;
  const linked = input.orders.filter(o => id(o.orderId) === key);
  if (linked.length !== 1) return null;
  const source = linked[0];
  if (source.businessDate !== overview.businessDate || !["open", "paid_candidate"].includes(classifyOrderStatus(source.status))
    || source.closureReceiptId || source.closureMergedIntoOrderId
    || input.orders.some(o => o.closureReceiptId === receipt.id || id(o.closureMergedIntoOrderId) === key)) return null;
  if (name(source.tableName) && name(receipt.table_name) && name(receipt.table_name) !== name(source.tableName)) return null;
  const links = input.receipts.map(r => ({ receiptId: r.id, orderId: r.order_id ?? "", businessDate: r.business_date,
    paymentStatus: r.payment_status, isCanceled: r.is_canceled }));
  if (singlePaidOrderReceipt(key, overview.businessDate, links)?.receiptId !== receipt.id) return null;
  const start = instant(source.orderDate), end = instant(receipt.ref_date), observed = instant(source.providerObservedAt),
    snapshot = instant(overview.snapshotAt), now = input.now.getTime();
  if (![start, end, observed, snapshot, now].every(Number.isFinite) || start > end || start > observed || observed > snapshot || snapshot > now || end > now
    || calculateStoreBusinessDate(new Date(start), input.cutoff) !== overview.businessDate
    || calculateStoreBusinessDate(new Date(end), input.cutoff) !== overview.businessDate) return null;
  return { minutes: Math.floor((end - start) / 60_000), receiptId: receipt.id, startedAt: source.orderDate,
    referenceAt: receipt.ref_date!, snapshotAt: overview.snapshotAt! };
}

/** Header uses the same receipt-level evidence as the latest card. */
export function projectPaidOrderUsage(input: {
  table: TableTile; overview: TableOverview; catalog: CatalogTable[]; orders: CollectedOrder[];
  receipts: DetailReceiptRow[]; latest: DetailReceipt | null; now: Date; cutoff?: string;
}): PaidOrderUsage | null {
  if (input.table.state !== "paid" || input.table.orders.some(o => o.verifiedOpen)
    || !input.latest || input.latest.referenceAt !== input.table.lastPaidAt) return null;
  return projectReceiptOrderUsage({ ...input, receipt: input.latest });
}
