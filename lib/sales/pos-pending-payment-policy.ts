// Pure rules for CUKCUK pending payments (payment_status = 1). Shared by the
// close banner, the receipt list badge and Node tests.

// Admin review badge threshold only. Any active pending receipt holds the
// business day close regardless of age (sales_close_business_day_v1).
export const POS_PENDING_REVIEW_MINUTES = 30;
export const POS_PENDING_HOLD_FAILURE_CODE = "pending_payment";

export type PendingPaymentState = {
  paymentStatus: number | null;
  isCanceled: boolean;
  statusChangedAt?: string | null;
  refDate?: string | null;
};

export function isActivePendingPayment(receipt: PendingPaymentState) {
  return receipt.paymentStatus === 1 && receipt.isCanceled !== true;
}

// status_changed_at is not maintained for older rows; the POS invoice time is the
// earliest moment a receipt can have been pending (same rule as the DB function).
export function getPendingPaymentSince(receipt: PendingPaymentState) {
  return receipt.statusChangedAt || receipt.refDate || null;
}

export function isPendingPaymentReviewDue(receipt: PendingPaymentState, now: Date) {
  if (!isActivePendingPayment(receipt)) return false;
  const since = Date.parse(getPendingPaymentSince(receipt) ?? "");
  // Unknown start: the DB function refuses it, so never offer the correction.
  if (!Number.isFinite(since)) return false;
  return now.getTime() - since >= POS_PENDING_REVIEW_MINUTES * 60_000;
}

export type PendingResolutionInput = {
  resolution: "paid" | "canceled";
  paymentMethod: "cash" | "transfer" | "card" | "other" | null;
  cashReceivedAmount: number | null;
  evidenceNote: string;
  expectedRevision: number;
  requestId: string;
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Shape check only; the DB function re-validates state, amounts and timing under a row lock.
export function parsePendingResolutionBody(body: unknown): PendingResolutionInput | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const resolution = b.resolution === "paid" || b.resolution === "canceled" ? b.resolution : null;
  const evidenceNote = typeof b.evidenceNote === "string" ? b.evidenceNote.trim() : "";
  const expectedRevision = Number(b.expectedRevision);
  const requestId = typeof b.requestId === "string" && UUID_V4.test(b.requestId) ? b.requestId : null;
  if (!resolution || !requestId || evidenceNote.length < 5 || evidenceNote.length > 500
    || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return null;
  if (resolution === "canceled") {
    if (b.paymentMethod !== undefined && b.paymentMethod !== null) return null;
    return { resolution, paymentMethod: null, cashReceivedAmount: null, evidenceNote, expectedRevision, requestId };
  }
  const paymentMethod = ["cash", "transfer", "card", "other"].includes(b.paymentMethod as string)
    ? (b.paymentMethod as PendingResolutionInput["paymentMethod"]) : null;
  if (!paymentMethod) return null;
  let cashReceivedAmount: number | null = null;
  if (paymentMethod === "cash") {
    cashReceivedAmount = Number(b.cashReceivedAmount);
    if (!Number.isSafeInteger(cashReceivedAmount) || cashReceivedAmount < 0) return null;
  }
  return { resolution, paymentMethod, cashReceivedAmount, evidenceNote, expectedRevision, requestId };
}

// Held = a recorded pending_payment close attempt and still no closure, oldest first.
export function selectPendingCloseHoldDates(heldCheckDates: string[], closedDates: string[]) {
  const closed = new Set(closedDates);
  return [...new Set(heldCheckDates)].filter((date) => !closed.has(date)).sort();
}
