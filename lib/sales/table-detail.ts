import { classifyOrdersForBusinessDate, mergeTableTokens, singlePaidOrderReceipt, type CollectedOrder } from "../pos/cukcuk/open-orders-core.ts";
import type { CatalogTable, TableOverview, TableTile } from "./table-overview.ts";
import { projectDailyTableUsage, type DailyTableUsage } from "./table-usage.ts";
import { projectReceiptOrderUsage, type PaidOrderUsage } from "./table-paid-usage.ts";

// Display-only evidence. None of these timestamps authorizes a vacancy/cleaning transition.
export type DetailReceiptRow = {
  id: number; order_id: string | null; ref_no: string | null; business_date: string;
  table_name: string | null; ref_date: string | null; final_amount: number | string | null;
  payment_status: number | null; is_canceled: boolean | null; status_changed_at: string | null;
};
export type DetailReceipt = {
  id: number; number: string | null; businessDate: string; tableName: string | null;
  amount: number | null; referenceAt: string | null; statusObservedAt: string | null;
  canceled: boolean; reissued: boolean; validPaid: boolean; uncertain: boolean;
  link: "direct" | "verified_merge" | "merge_review";
  orderUsage?: PaidOrderUsage | null;
  lines: { id: number; name: string; quantity: number | null; amount: number | null; canceled: boolean }[];
};
export type TableDetail = {
  collection?: TableOverview["collection"];
  table: TableTile; businessDate: string; snapshotAt: string | null; snapshotStatus: string;
  historyFrom: string; current: DetailReceipt[]; previous: DetailReceipt[]; latest: DetailReceipt | null;
  usage: DailyTableUsage;
  paidUsage?: PaidOrderUsage | null;
  merges: { receiptId: number; tables: string[]; receiptTable: string | null; verified: boolean }[];
  cleaning: { enabled: boolean; reason: "active_orders" | "snapshot_unhealthy" | "merge_review" | "no_payment" | "storage_not_approved" | "state_changed" | "ready";
    token?: { businessDate: string; receiptId: number; evidenceKey: string } };
  // Only persisted server verification can provide a deadline. Receipt timestamps cannot.
  timer: { enabled: false; reason: "unverified_payment_time" }
    | { enabled: true; firstVerifiedAt: string; expiresAt: string; expired: boolean };
};
const key = (value: string | null | undefined) => value?.normalize("NFC").trim().toLocaleLowerCase("vi-VN") ?? "";
const idKey = (value: string | null | undefined) => value?.trim().toLowerCase() ?? "";
export const detailNumber = (value: unknown): number | null =>
  (typeof value === "number" || typeof value === "string" && value.trim() !== "") && Number.isFinite(Number(value)) ? Number(value) : null;
const validTime = (value: string | null, now: Date) => value && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now.getTime() ? value : null;

/** Uses central v3 merge closures, never receipt TableName to infer physical movement. */
export function projectTableDetail(input: {
  table: TableTile; catalog: CatalogTable[]; overview: TableOverview; orders: CollectedOrder[];
  receipts: DetailReceiptRow[]; now: Date; historyFrom: string; cutoff?: string;
}): TableDetail {
  const { table, catalog, overview, orders, now, historyFrom } = input;
  const unique = new Map<number, DetailReceiptRow>();
  for (const row of input.receipts) {
    if (!Number.isSafeInteger(row.id) || row.id <= 0) throw Error("DETAIL_INVALID_RECEIPT");
    const prior = unique.get(row.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw Error("DETAIL_RECEIPT_CONFLICT");
    unique.set(row.id, row);
  }
  const receipts = [...unique.values()];
  const links = receipts.map(r => ({ orderId: idKey(r.order_id), receiptId: r.id, businessDate: r.business_date,
    paymentStatus: r.payment_status, isCanceled: r.is_canceled }));
  const exactName = (name: string | null) => {
    const matches = catalog.filter(t => key(t.name) === key(name));
    return matches.length === 1 ? matches[0].name : null;
  };
  const mergedReceiptIds = new Set<number>();
  const merges: TableDetail["merges"] = [];
  const related = new Map<number, "verified_merge" | "merge_review">();
  for (const receipt of receipts) {
    const members = orders.filter(o => o.businessDate === overview.businessDate && o.closureReceiptId === receipt.id && o.closureMergedIntoOrderId);
    if (!members.length) continue;
    mergedReceiptIds.add(receipt.id);
    const targets = new Set(members.map(o => idKey(o.closureMergedIntoOrderId)));
    const targetOrders = orders.filter(o => o.businessDate === overview.businessDate && targets.has(idKey(o.orderId)));
    const group = [...members, ...targetOrders];
    // A paid surviving order has no TableName any more; its receipt's composite name ("BAR9, 2")
    // places it only when every part is a catalog table and every member's table is one of them.
    const receiptParts = (mergeTableTokens(receipt.table_name) ?? []).map(exactName);
    const receiptPlaced = receiptParts.length > 1 && receiptParts.every(n => !!n)
      && members.every(o => receiptParts.some(n => key(n) === key(exactName(o.tableName))));
    const placed = (o: CollectedOrder) => !!exactName(o.tableName) || targetOrders.includes(o) && receiptPlaced;
    const names = [...new Set([...group.map(o => exactName(o.tableName)), ...(receiptPlaced ? receiptParts : [])])
      .values()].filter((n): n is string => !!n);
    const verified = targets.size === 1 && targetOrders.length === 1 && idKey(receipt.order_id) === [...targets][0]
      && receipt.business_date === overview.businessDate && receipt.is_canceled === false
      && group.every(placed)
      && members.every(o => !!validTime(o.closureConfirmedAt ?? null, now)
        && classifyOrdersForBusinessDate([o], links, overview.businessDate).merged === 1)
      && singlePaidOrderReceipt(receipt.order_id ?? "", overview.businessDate, links)?.receiptId === receipt.id;
    if (names.some(n => key(n) === key(table.name))) {
      related.set(receipt.id, verified ? "verified_merge" : "merge_review");
      merges.push({ receiptId: receipt.id, tables: names, receiptTable: receipt.table_name, verified });
    }
  }
  const relevant = receipts.filter(r => related.has(r.id) || !mergedReceiptIds.has(r.id) && exactName(r.table_name) === table.name);
  const canceled = (r: DetailReceiptRow) => r.is_canceled === true || r.payment_status === 4 || r.payment_status === 5;
  const projected = relevant.map((r): DetailReceipt => {
    const active = receipts.filter(other => idKey(other.order_id) === idKey(r.order_id) && other.business_date === r.business_date && !canceled(other));
    const amount = detailNumber(r.final_amount);
    const uncertain = r.is_canceled === null || !idKey(r.order_id) || active.length > 1 || amount === null || amount < 0 || !validTime(r.ref_date, now);
    const link = related.get(r.id) ?? "direct";
    return { id: r.id, number: r.ref_no, businessDate: r.business_date, tableName: r.table_name,
      amount: amount !== null && amount >= 0 ? amount : null, referenceAt: validTime(r.ref_date, now),
      statusObservedAt: validTime(r.status_changed_at, now), canceled: canceled(r),
      reissued: !canceled(r) && r.payment_status === 3 && receipts.some(other => other.id !== r.id && idKey(other.order_id) === idKey(r.order_id)
        && other.business_date === r.business_date && canceled(other)),
      validPaid: r.payment_status === 3 && r.is_canceled === false && !uncertain && link !== "merge_review",
      uncertain: uncertain || link === "merge_review", link, lines: [] };
  }).sort((a, b) => (Date.parse(b.referenceAt ?? "") || 0) - (Date.parse(a.referenceAt ?? "") || 0) || b.id - a.id);
  const current = projected.filter(r => r.businessDate === overview.businessDate);
  const previous = projected.filter(r => r.businessDate >= historyFrom && r.businessDate < overview.businessDate);
  const latest = current.find(r => r.validPaid) ?? null;
  for (const receipt of current) receipt.orderUsage = projectReceiptOrderUsage({ ...input, receipts, receipt });
  const reason = table.state === "occupied" || table.orders.some(o => o.verifiedOpen) ? "active_orders"
    : overview.snapshotStatus !== "ok" || table.state === "unknown" ? "snapshot_unhealthy"
    : merges.length ? "merge_review" : table.state !== "paid" || !latest ? "no_payment" : "storage_not_approved";
  return { table, businessDate: overview.businessDate, snapshotAt: overview.snapshotAt, snapshotStatus: overview.snapshotStatus,
    collection: overview.collection,
    usage: projectDailyTableUsage({ ...input, receipts, merges }),
    paidUsage: table.state === "paid" && !table.orders.some(o => o.verifiedOpen) && latest?.referenceAt === table.lastPaidAt ? latest.orderUsage ?? null : null,
    historyFrom, current, previous, latest, merges, cleaning: { enabled: false, reason }, timer: { enabled: false, reason: "unverified_payment_time" } };
}
