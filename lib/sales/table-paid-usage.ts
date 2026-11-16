import { classifyOrderStatus, singlePaidOrderReceipt, type CollectedOrder } from "../pos/cukcuk/open-orders-core.ts";
import { calculateStoreBusinessDate } from "../store-settings/business-time-core.ts";
import type { DetailReceipt, DetailReceiptRow } from "./table-detail.ts";
import type { CatalogTable, TableOverview, TableTile } from "./table-overview.ts";

export type PaidOrderUsage = { minutes: number; receiptId: number; referenceAt: string; snapshotAt: string };
const id = (value: string | null | undefined) => value?.trim().toLowerCase() ?? "";
const name = (value: string | null | undefined) => value?.normalize("NFC").trim().toLocaleLowerCase("vi-VN") ?? "";
const instant = (value: string | null | undefined) => value && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN;

/** Read-only duration for ONE original order and its latest direct paid receipt.
 * Never reconstruct lost table names, merge several orders or use the observation
 * timer/current clock as the end of a completed order's duration.
 */
export function projectPaidOrderUsage(input: {
  table: TableTile; overview: TableOverview; catalog: CatalogTable[]; orders: CollectedOrder[];
  receipts: DetailReceiptRow[]; latest: DetailReceipt | null; now: Date; cutoff?: string;
}): PaidOrderUsage | null {
  const { table, overview, latest } = input;
  if (table.state !== "paid" || overview.snapshotStatus !== "ok" || table.orders.some(o => o.verifiedOpen)
    || !latest?.validPaid || latest.canceled || latest.uncertain || latest.link !== "direct"
    || latest.businessDate !== overview.businessDate || latest.referenceAt !== table.lastPaidAt) return null;
  const receipt = input.receipts.find(r => r.id === latest.id), key = id(receipt?.order_id);
  if (!receipt || !key || receipt.payment_status !== 3 || receipt.is_canceled !== false || receipt.ref_date !== latest.referenceAt) return null;
  const linked = input.orders.filter(o => id(o.orderId) === key);
  if (linked.length !== 1) return null;
  const source = linked[0];
  if (source.businessDate !== overview.businessDate || !["open", "paid_candidate"].includes(classifyOrderStatus(source.status))
    || source.closureReceiptId || source.closureMergedIntoOrderId
    || input.orders.some(o => o.closureReceiptId === receipt.id || id(o.closureMergedIntoOrderId) === key)) return null;
  // TableOrder.tableName can be filled from a receipt. Only the RAW central name
  // can certify this original order's table, so do not use that fallback here.
  const matches = input.catalog.filter(t => name(t.name) === name(source.tableName));
  if (!name(source.tableName) || matches.length !== 1 || matches[0].id !== table.id || name(receipt.table_name) !== name(source.tableName)) return null;
  const links = input.receipts.map(r => ({ receiptId: r.id, orderId: r.order_id ?? "", businessDate: r.business_date,
    paymentStatus: r.payment_status, isCanceled: r.is_canceled }));
  if (singlePaidOrderReceipt(key, overview.businessDate, links)?.receiptId !== receipt.id) return null;
  const start = instant(source.orderDate), end = instant(receipt.ref_date), observed = instant(source.providerObservedAt),
    snapshot = instant(overview.snapshotAt), now = input.now.getTime();
  if (![start, end, observed, snapshot, now].every(Number.isFinite) || start > end || start > observed || observed > snapshot || snapshot > now || end > now
    || calculateStoreBusinessDate(new Date(start), input.cutoff) !== overview.businessDate
    || calculateStoreBusinessDate(new Date(end), input.cutoff) !== overview.businessDate) return null;
  return { minutes: Math.floor((end - start) / 60_000), receiptId: receipt.id, referenceAt: receipt.ref_date!, snapshotAt: overview.snapshotAt! };
}
