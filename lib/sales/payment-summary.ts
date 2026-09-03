export const PAID_POS_PAYMENT_STATUS = 3;

export type PosPaymentBucket = "cash" | "transfer" | "card" | "other";

export type PosReceiptPaymentEligibility = {
  id: number;
  payment_status: number | null;
  is_canceled?: boolean | null;
  final_amount?: number | string | null;
};

export type PosPaymentRow = {
  receipt_id: number | null;
  business_date: string;
  payment_type: number | null;
  payment_name: string | null;
  card_name: string | null;
  amount: number | string | null;
};

export type PosPaymentSummary = {
  cashAmount: number;
  transferAmount: number;
  cardAmount: number;
  otherAmount: number;
  paymentTotalAmount: number;
};

export function toPaymentNumber(value: number | string | null | undefined) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function normalizePaymentName(value: string | null | undefined) {
  return (value || "").trim().toLowerCase();
}

export function isCashPayment(paymentName: string, cardName: string) {
  return paymentName === "ti\u1ec1n m\u1eb7t" || cardName === "ti\u1ec1n m\u1eb7t";
}

export function isTransferPayment(paymentName: string, cardName: string) {
  return paymentName === "chuy\u1ec3n kho\u1ea3n" || cardName === "chuy\u1ec3n kho\u1ea3n";
}

export function isCardLikePayment(payment: PosPaymentRow, paymentName: string, cardName: string) {
  if (isCashPayment(paymentName, cardName) || isTransferPayment(paymentName, cardName)) return false;
  return payment.payment_type === 2 || Boolean(cardName) || paymentName.includes("visa") || paymentName.includes("master") || paymentName.includes("card") || cardName.includes("visa") || cardName.includes("master") || cardName.includes("card");
}

export function isOtherPayment(paymentName: string, cardName: string) {
  return paymentName === "kh\u00e1c" || paymentName === "khac" || cardName === "kh\u00e1c" || cardName === "khac";
}

export function classifyPaymentBucket(payment: PosPaymentRow): PosPaymentBucket | null {
  const paymentName = normalizePaymentName(payment.payment_name);
  const cardName = normalizePaymentName(payment.card_name);
  if (isCashPayment(paymentName, cardName)) return "cash";
  if (isTransferPayment(paymentName, cardName)) return "transfer";
  if (isCardLikePayment(payment, paymentName, cardName)) return "card";
  if (isOtherPayment(paymentName, cardName)) return "other";
  return null;
}

export function buildPaymentSummary(payments: PosPaymentRow[]): PosPaymentSummary {
  return payments.reduce<PosPaymentSummary>((summary, payment) => {
    const amount = toPaymentNumber(payment.amount);
    const bucket = classifyPaymentBucket(payment);
    summary.paymentTotalAmount += amount;
    if (bucket === "cash") summary.cashAmount += amount;
    else if (bucket === "transfer") summary.transferAmount += amount;
    else if (bucket === "card") summary.cardAmount += amount;
    else if (bucket === "other") summary.otherAmount += amount;
    return summary;
  }, { cashAmount: 0, transferAmount: 0, cardAmount: 0, otherAmount: 0, paymentTotalAmount: 0 });
}

export function filterPaidPayments<T extends PosPaymentRow>(receipts: PosReceiptPaymentEligibility[], payments: T[]) {
  const paidReceiptIds = new Set(receipts.filter((receipt) => receipt.payment_status === PAID_POS_PAYMENT_STATUS && receipt.is_canceled !== true).map((receipt) => receipt.id));
  return payments.filter((payment) => payment.receipt_id !== null && paidReceiptIds.has(payment.receipt_id));
}

export function getPaidReceiptTotal(receipts: PosReceiptPaymentEligibility[]) {
  return receipts.reduce(
    (total, receipt) =>
      receipt.payment_status === PAID_POS_PAYMENT_STATUS &&
      receipt.is_canceled !== true
        ? total + toPaymentNumber(receipt.final_amount)
        : total,
    0
  );
}

export type PosPaymentReconciliationMismatch = {
  receiptId: number;
  receiptAmount: number;
  paymentAmount: number;
};

export function findPaymentReconciliationMismatches(
  receipts: PosReceiptPaymentEligibility[],
  payments: PosPaymentRow[]
) {
  const paidReceipts = receipts.filter(
    (receipt) =>
      receipt.payment_status === PAID_POS_PAYMENT_STATUS &&
      receipt.is_canceled !== true
  );
  const paymentTotals = new Map<number, number>();
  for (const payment of payments) {
    if (payment.receipt_id === null) continue;
    paymentTotals.set(
      payment.receipt_id,
      (paymentTotals.get(payment.receipt_id) || 0) + toPaymentNumber(payment.amount)
    );
  }

  return paidReceipts.flatMap<PosPaymentReconciliationMismatch>((receipt) => {
    const receiptAmount = toPaymentNumber(receipt.final_amount);
    const paymentAmount = paymentTotals.get(receipt.id) || 0;
    return Math.abs(receiptAmount - paymentAmount) < 0.01
      ? []
      : [{ receiptId: receipt.id, receiptAmount, paymentAmount }];
  });
}

export function paymentSummaryByBucket(summary: PosPaymentSummary): Record<PosPaymentBucket, number> {
  return { cash: summary.cashAmount, transfer: summary.transferAmount, card: summary.cardAmount, other: summary.otherAmount };
}
