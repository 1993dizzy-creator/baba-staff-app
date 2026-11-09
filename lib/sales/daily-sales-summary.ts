import {
  PAID_POS_PAYMENT_STATUS,
  buildPaymentSummary,
  findPaymentReconciliationMismatches,
  getPaidReceiptTotal,
  type PosPaymentRow,
  type PosReceiptPaymentEligibility,
} from "./payment-summary.ts";
import { posSnapshotTotals } from "./pos-business-day-final-policy.ts";

export type DailySalesPaymentRow = PosPaymentRow & { id?: number | null };

/** Same eligibility as the close source: paid (3) and not canceled. */
export function isCountedPaidReceipt(receipt: PosReceiptPaymentEligibility) {
  return receipt.payment_status === PAID_POS_PAYMENT_STATUS && receipt.is_canceled !== true;
}

/** A payment row is counted once per POS payment id; split payments are separate ids and all count. */
function uniquePaymentRows<T extends DailySalesPaymentRow>(rows: T[]) {
  const seen = new Set<number>();
  return rows.filter((row) => {
    if (row.id === null || row.id === undefined) return true;
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

/**
 * Daily total = sum of POS payments on paid, non-canceled receipts. Receipt final_amount is
 * only used to expose (never to fill) gaps: missing or mismatched payment data stays visible.
 */
export function buildDailyPaymentSales<R extends PosReceiptPaymentEligibility, P extends DailySalesPaymentRow>(
  receipts: R[],
  payments: P[]
) {
  const paidReceipts = receipts.filter(isCountedPaidReceipt);
  const paidReceiptIds = new Set(paidReceipts.map((receipt) => receipt.id));
  const paidPaymentRows = uniquePaymentRows(payments).filter(
    (payment) => payment.receipt_id !== null && paidReceiptIds.has(payment.receipt_id)
  );
  const paymentSummary = buildPaymentSummary(paidPaymentRows);
  const totalSales = paymentSummary.paymentTotalAmount;
  const receiptTotal = getPaidReceiptTotal(paidReceipts);
  const mismatches = findPaymentReconciliationMismatches(paidReceipts, paidPaymentRows);

  return {
    paidReceipts,
    paidPaymentRows,
    paymentSummary,
    totalSales,
    paidReceiptCount: paidReceipts.length,
    averageReceiptAmount: paidReceipts.length > 0 ? Math.round(totalSales / paidReceipts.length) : 0,
    reconciliation: {
      status: mismatches.length > 0 ? ("mismatch" as const) : ("matched" as const),
      receiptTotal,
      paymentTotal: totalSales,
      delta: totalSales - receiptTotal,
      mismatchReceiptCount: mismatches.length,
      missingPaymentReceiptCount: mismatches.filter((item) => item.paymentAmount === 0).length,
    },
  };
}

export type DailyCloseSnapshotRow = {
  revision: number | null;
  closed_at: string | null;
  source_snapshot: unknown;
};

export type DailyCloseCheck = {
  status: "not_closed" | "matched" | "mismatch" | "snapshot_invalid";
  revision: number | null;
  closedAt: string | null;
  closedTotal: number | null;
  currentTotal: number;
  delta: number | null;
};

/** Read-only cross-check of the latest confirmed close against the current POS payment total. */
export function compareDailyCloseSnapshot(
  closure: DailyCloseSnapshotRow | null,
  currentTotal: number
): DailyCloseCheck {
  if (!closure) {
    return { status: "not_closed", revision: null, closedAt: null, closedTotal: null, currentTotal, delta: null };
  }
  const base = { revision: closure.revision ?? null, closedAt: closure.closed_at ?? null, currentTotal };
  let closedTotal: number;
  try {
    closedTotal = posSnapshotTotals(closure.source_snapshot).total;
  } catch {
    return { ...base, status: "snapshot_invalid", closedTotal: null, delta: null };
  }
  const delta = currentTotal - closedTotal;
  return { ...base, status: delta === 0 ? "matched" : "mismatch", closedTotal, delta };
}
