import { singlePaidOrderReceipt } from "../pos/cukcuk/open-orders-core.ts";
import { addStoreDays, calculateStoreBusinessDate } from "../store-settings/business-time-core.ts";
import { PAID_POS_PAYMENT_STATUS } from "./payment-summary.ts";
import type { TableReceipt } from "./table-overview.ts";

export type PaidCumulativeEvidence = {
  count: number | null;
  status: "ok" | "review" | "unavailable";
  reason: "verified_receipts" | "evidence_conflict" | "snapshot_unhealthy";
  coverage: "queried_receipts";
};

/** Count valid paid receipts in the existing business-day read, not tables or visits.
 * Names and merge membership never allocate extra completions. The existing
 * single-active-receipt policy guards cancellation/reissue and ambiguous payments.
 */
export function projectPaidCumulative(input: {
  businessDate: string; now: Date; healthy: boolean; receipts: TableReceipt[]; cutoff?: string;
}): PaidCumulativeEvidence {
  const result: PaidCumulativeEvidence = { count: null, status: "unavailable", reason: "snapshot_unhealthy", coverage: "queried_receipts" };
  if (!input.healthy || !Number.isFinite(input.now.getTime())) return result;
  const days = [input.businessDate, addStoreDays(input.businessDate, 1)];
  const unique = new Map<number, TableReceipt>();
  const conflict = (): PaidCumulativeEvidence => ({ ...result, status: "review", reason: "evidence_conflict" });
  for (const row of input.receipts) {
    if (!row.businessDate) return conflict();
    if (!days.includes(row.businessDate)) continue;
    const receipt: TableReceipt = { receiptId: row.receiptId, businessDate: row.businessDate,
      orderId: row.orderId.trim().toLowerCase(), paymentStatus: row.paymentStatus, isCanceled: row.isCanceled, paidAt: row.paidAt ?? null };
    const prior = unique.get(receipt.receiptId);
    if (!Number.isSafeInteger(receipt.receiptId) || receipt.receiptId <= 0
      || prior && JSON.stringify(prior) !== JSON.stringify(receipt)) return conflict();
    unique.set(receipt.receiptId, receipt);
  }
  const receipts = [...unique.values()], byOrder = new Map<string, TableReceipt[]>();
  for (const row of receipts) {
    if (!byOrder.has(row.orderId)) byOrder.set(row.orderId, []);
    byOrder.get(row.orderId)!.push(row);
  }
  let count = 0;
  for (const r of receipts) {
    if (r.businessDate !== input.businessDate) continue;
    if (r.isCanceled === true || r.paymentStatus === 4 || r.paymentStatus === 5) continue;
    if (r.paymentStatus === null || !Number.isInteger(r.paymentStatus) || r.paymentStatus < 0 || r.paymentStatus > 5) return conflict();
    if (r.paymentStatus !== PAID_POS_PAYMENT_STATUS) continue;
    if (r.isCanceled !== false || !r.orderId) return conflict();
    const reference = Date.parse(r.paidAt ?? "");
    if (!Number.isFinite(reference) || reference > input.now.getTime()
      || calculateStoreBusinessDate(new Date(reference), input.cutoff) !== input.businessDate
      || singlePaidOrderReceipt(r.orderId, input.businessDate, byOrder.get(r.orderId) ?? [])?.receiptId !== r.receiptId) return conflict();
    count++;
  }
  return { count, status: "ok", reason: "verified_receipts", coverage: "queried_receipts" };
}
