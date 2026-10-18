// One logical attempt per user/party in this tab. Uncertain outcomes survive reloads.
export type PayablePaymentBody = {
  partyId: number; fundAccountId: number; occurredAt: string; amount: number;
  allocations: { payableId: number; allocatedAmount: number }[]; memo: string | null;
};
export type PendingPayablePayment = { requestId: string; body: PayablePaymentBody };
const changedEvent = "ledger-payable-payment-changed";
const running = new Map<string, Promise<void>>();
// Only V2 business validation results prove this key has no successful payment.
// Authentication/API refusals can occur AFTER an earlier committed response was lost.
const refusedPaymentCodes = new Set(["INVALID_AMOUNT", "INVALID_PARTY", "INVALID_ACCOUNT", "INVALID_ALLOCATIONS", "DUPLICATE_PAYABLE", "PAYABLE_PARTY_MISMATCH", "INVALID_ALLOCATION", "ALLOCATION_SUM_MISMATCH", "AMOUNT_EXCEEDS_OUTSTANDING", "ALREADY_PAID"]);
function storageKey(partyId: number) {
  const user = JSON.parse(localStorage.getItem("baba_user") || "null");
  if (!user?.id) throw new Error("PAYMENT_SESSION_REQUIRED");
  return `ledger-payable-payment:${user.id}:${partyId}`;
}
function canonical(body: PayablePaymentBody) {
  return JSON.stringify({ partyId: body.partyId, fundAccountId: body.fundAccountId, amount: body.amount, occurredAt: new Date(body.occurredAt).toISOString(),
    allocations: [...body.allocations].sort((a, b) => a.payableId - b.payableId), memo: body.memo?.trim() || null });
}
export function pendingPayablePayment(partyId: number): PendingPayablePayment | null {
  const raw = sessionStorage.getItem(storageKey(partyId));
  return raw ? JSON.parse(raw) as PendingPayablePayment : null;
}
function changed() { window.dispatchEvent(new Event(changedEvent)); }
export function subscribePayablePayment(listener: () => void) {
  window.addEventListener(changedEvent, listener);
  return () => window.removeEventListener(changedEvent, listener);
}
export function sendPayablePayment(body: PayablePaymentBody, onConfirmed: () => Promise<void>): Promise<void> {
  const key = storageKey(body.partyId);
  const pending = pendingPayablePayment(body.partyId);
  if (pending && canonical(pending.body) !== canonical(body)) return Promise.reject(new Error("PAYMENT_REQUEST_PENDING"));
  const active = running.get(key);
  if (active) return active;
  const attempt = pending ?? { requestId: crypto.randomUUID(), body };
  // Storage failure prevents sending: losing the key would make retry unsafe.
  sessionStorage.setItem(key, JSON.stringify(attempt));
  const work = (async () => {
    const response = await fetch("/api/admin/ledger/payables/pay", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...attempt.body, requestId: attempt.requestId }),
    });
    const result = await response.json();
    if (!response.ok) {
      if ([400, 409].includes(response.status) && refusedPaymentCodes.has(result.code)) {
        sessionStorage.removeItem(key); changed();
      }
      throw new Error(result.code || "PAYMENT_FAILED");
    }
    if (!result.ok || result.result?.status !== "paid") throw new Error("PAYMENT_RESULT_UNCERTAIN");
    await onConfirmed(); // Retain the key if refreshing displayed balances fails.
    sessionStorage.removeItem(key);
  })().finally(() => { running.delete(key); changed(); });
  running.set(key, work);
  changed();
  return work;
}
