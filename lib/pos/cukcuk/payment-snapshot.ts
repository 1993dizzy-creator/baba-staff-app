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

export function getPaymentSnapshotFromInvoicePayload(
  payload: JsonObject
): PaymentSnapshot {
  for (const field of PAYMENT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
    const value = payload[field];
    return Array.isArray(value)
      ? { available: true, field, payments: value as JsonObject[] }
      : { available: false, field, payments: [] };
  }

  return { available: false, field: null, payments: [] };
}
