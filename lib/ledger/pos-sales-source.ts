import { createHash } from "node:crypto";
// @ts-expect-error Node's direct TypeScript tests require explicit extensions.
import { buildPaymentSummary, classifyPaymentBucket, filterPaidPayments, findPaymentReconciliationMismatches, getPaidReceiptTotal, paymentSummaryByBucket, type PosPaymentBucket, type PosPaymentRow } from "../sales/payment-summary.ts";

export type PosSourceReceipt = {
  id: number; ref_no: string | null; business_date: string; ref_date: string | null;
  payment_status: number | null; is_canceled: boolean | null;
  final_amount: number | string | null; revision: number | null; updated_at: string | null;
};
export type PosSourcePayment = PosPaymentRow & { id: number };
export type PosLedgerSourceRow = {
  businessDate: string; bucket: PosPaymentBucket; amount: number;
  fingerprint: string; snapshot: Record<string, unknown>;
};
export const POS_BUCKETS = ["cash", "transfer", "card", "other"] as const;

export function validPosBusinessDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

// Fixed schema below plus recursive key sorting makes object insertion order
// irrelevant. Arrays are explicitly ordered by receipt/payment ID and bucket.
export function canonicalPosJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPosJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalPosJson(object[key])}`).join(",")}}`;
  }
  throw new Error("POS_SOURCE_SNAPSHOT_INCOMPLETE");
}

export function posSourceFingerprint(snapshot: unknown) {
  return createHash("sha256").update(canonicalPosJson(snapshot)).digest("hex");
}

function amount(value: number | string | null) {
  if (value === null || (typeof value === "string" && !value.trim())) throw new Error("POS_SOURCE_SNAPSHOT_INCOMPLETE");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("POS_SOURCE_INVALID_AMOUNT");
  return number;
}

function requireFields(row: object, fields: string[]) {
  if (fields.some(field => !Object.hasOwn(row, field) || (row as Record<string, unknown>)[field] === undefined)) throw new Error("POS_SOURCE_SNAPSHOT_INCOMPLETE");
}

export function buildPosBusinessDaySource(businessDate: string, receipts: PosSourceReceipt[], payments: PosSourcePayment[]) {
  if (!validPosBusinessDate(businessDate)) throw new Error("INVALID_POS_BUSINESS_DATE");
  if (receipts.some(row => row.business_date !== businessDate) || payments.some(row => row.business_date !== businessDate)) {
    throw new Error("POS_SOURCE_DATE_MISMATCH");
  }
  for (const row of receipts) requireFields(row, ["id", "business_date", "payment_status", "is_canceled"]);
  const paid = receipts.filter(row => row.payment_status === 3 && row.is_canceled !== true).sort((a, b) => a.id - b.id);
  const eligible = filterPaidPayments(paid, payments).sort((a: PosSourcePayment, b: PosSourcePayment) => a.id - b.id);
  const receiptIds = new Set<number>();
  const paymentIds = new Set<number>();
  for (const row of paid) {
    requireFields(row, ["id", "ref_no", "business_date", "ref_date", "final_amount", "revision", "updated_at"]);
    if (!Number.isSafeInteger(row.id) || row.id < 1 || receiptIds.has(row.id)) throw new Error("POS_SOURCE_SNAPSHOT_INCOMPLETE");
    receiptIds.add(row.id);
    amount(row.final_amount);
  }
  for (const row of eligible) {
    requireFields(row, ["id", "receipt_id", "business_date", "payment_type", "payment_name", "card_name", "amount"]);
    if (!Number.isSafeInteger(row.id) || row.id < 1 || paymentIds.has(row.id)) throw new Error("POS_SOURCE_SNAPSHOT_INCOMPLETE");
    paymentIds.add(row.id);
    amount(row.amount);
    if (classifyPaymentBucket(row) === null) throw new Error("POS_PAYMENT_BUCKET_ALLOCATION_MISMATCH");
  }
  if (findPaymentReconciliationMismatches(paid, eligible).length > 0) throw new Error("POS_PAYMENT_RECONCILIATION_MISMATCH");
  const receiptById = new Map(paid.map(row => [row.id, row]));
  const rows: PosLedgerSourceRow[] = POS_BUCKETS.map(bucket => {
    const detail = eligible.filter(payment => classifyPaymentBucket(payment) === bucket).map(payment => {
      const receipt = receiptById.get(Number(payment.receipt_id));
      if (!receipt) throw new Error("POS_SOURCE_SNAPSHOT_INCOMPLETE");
      // Preserve the existing August bucket snapshot field order and hash.
      return {
        paymentId: payment.id, receiptId: payment.receipt_id, refNo: receipt.ref_no,
        refDate: receipt.ref_date, paymentMethod: payment.payment_name || payment.card_name || null,
        paymentAmount: amount(payment.amount), receiptFinalAmount: amount(receipt.final_amount),
        receiptRevision: receipt.revision ?? 0, receiptUpdatedAt: receipt.updated_at,
      };
    });
    const snapshot = { businessDate, bucket, receiptCount: new Set(detail.map(item => item.receiptId)).size, payments: detail };
    return { businessDate, bucket, amount: detail.reduce((sum, item) => sum + item.paymentAmount, 0),
      fingerprint: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"), snapshot };
  });
  const receiptTotal = getPaidReceiptTotal(paid);
  const salesSummary = buildPaymentSummary(eligible);
  const totalsByBucket = paymentSummaryByBucket(salesSummary);
  const paymentTotal = salesSummary.paymentTotalAmount;
  if (!Number.isSafeInteger(receiptTotal) || !Number.isSafeInteger(paymentTotal)) throw new Error("POS_SOURCE_INVALID_AMOUNT");
  if (receiptTotal !== paymentTotal) throw new Error("POS_PAYMENT_RECONCILIATION_MISMATCH");
  if (rows.reduce((sum, row) => sum + row.amount, 0) !== receiptTotal) throw new Error("POS_PAYMENT_BUCKET_ALLOCATION_MISMATCH");
  const sourceSnapshot = {
    schemaVersion: 1, businessDate, receiptCount: paid.length, receiptTotal, paymentTotal, totalsByBucket,
    receipts: paid.map(row => ({ receiptId: row.id, refNo: row.ref_no, refDate: row.ref_date,
      finalAmount: amount(row.final_amount), revision: row.revision ?? 0, updatedAt: row.updated_at })),
    payments: eligible.map(row => ({ paymentId: row.id, receiptId: row.receipt_id,
      businessDate: row.business_date, paymentType: row.payment_type, paymentName: row.payment_name,
      cardName: row.card_name, amount: amount(row.amount) })),
    rows,
  };
  return { businessDate, receiptCount: paid.length, receiptTotal, ...totalsByBucket, paymentTotal,
    rows, sourceFingerprint: posSourceFingerprint(sourceSnapshot), sourceSnapshot };
}

export type PosBusinessDaySource = ReturnType<typeof buildPosBusinessDaySource>;

export function buildPosLedgerRangeSource(dates: string[], receipts: PosSourceReceipt[], payments: PosSourcePayment[]) {
  if (new Set(dates).size !== dates.length) throw new Error("POS_SOURCE_DATE_MISMATCH");
  const dateSet = new Set(dates);
  if (receipts.some(row => !dateSet.has(row.business_date)) || payments.some(row => !dateSet.has(row.business_date))) throw new Error("POS_SOURCE_DATE_MISMATCH");
  // Detect a paid receipt's allocation stored against another business date.
  const receiptById = new Map(receipts.map(row => [row.id, row]));
  if (filterPaidPayments(receipts, payments).some(row => receiptById.get(Number(row.receipt_id))?.business_date !== row.business_date)) throw new Error("POS_SOURCE_DATE_MISMATCH");
  const days = dates.map(date => buildPosBusinessDaySource(date, receipts.filter(row => row.business_date === date), payments.filter(row => row.business_date === date)));
  const totalsByBucket = { cash: 0, transfer: 0, card: 0, other: 0 };
  for (const day of days) for (const bucket of POS_BUCKETS) totalsByBucket[bucket] += day[bucket];
  return { days, rows: days.flatMap(day => day.rows), totalsByBucket,
    salesSummary: { cashAmount: totalsByBucket.cash, transferAmount: totalsByBucket.transfer,
      cardAmount: totalsByBucket.card, otherAmount: totalsByBucket.other,
      paymentTotalAmount: days.reduce((sum, day) => sum + day.receiptTotal, 0) } };
}
