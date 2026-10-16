export type JsonObject = Record<string, unknown>;

export type PaymentSnapshot =
  | { available: true; field: string; payments: JsonObject[] }
  | { available: false; field: string | null; payments: [] };

const PAYMENT_FIELDS = [
  "SAInvoicePayments",
  "saInvoicePayments",
  "Payments",
  "payments",
] as const;

function isPayment(value: unknown): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payment = value as JsonObject;
  const amount = payment.Amount ?? payment.amount;
  if (
    (typeof amount !== "number" && typeof amount !== "string") ||
    (typeof amount === "string" && !amount.trim()) ||
    !Number.isFinite(Number(amount)) || Number(amount) < 0
  ) return false;

  for (const key of ["PaymentType", "paymentType"]) {
    const type = payment[key];
    if (type != null && (String(type).trim() === "" ||
      (typeof type !== "number" && typeof type !== "string") ||
      !Number.isInteger(Number(type)))) return false;
  }
  for (const key of ["PaymentName", "paymentName", "CardID", "CardId", "cardID", "cardId", "CardName", "cardName"]) {
    if (payment[key] != null && typeof payment[key] !== "string") return false;
  }
  const ids = ["SAInvoicePaymentID", "SAInvoicePaymentId", "saInvoicePaymentID", "saInvoicePaymentId"]
    .filter(key => payment[key] != null).map(key => payment[key]);
  return ids.every(id => typeof id === "string") &&
    new Set(ids.map(id => (id as string).trim())).size <= 1;
}

export function getPaymentSnapshotFromInvoicePayload(
  payload: JsonObject
): PaymentSnapshot {
  for (const field of PAYMENT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
    const value = payload[field];
    // A malformed element or contradictory aliases cannot authorize deletions.
    const aliasesAgree = PAYMENT_FIELDS.every(key =>
      !Object.prototype.hasOwnProperty.call(payload, key) ||
      JSON.stringify(payload[key]) === JSON.stringify(value));
    return Array.isArray(value) && value.every(isPayment) && aliasesAgree
      ? { available: true, field, payments: value }
      : { available: false, field, payments: [] };
  }

  return { available: false, field: null, payments: [] };
}
