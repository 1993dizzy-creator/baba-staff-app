import type { LedgerEntry } from "./entries";

// Display-only badge. LedgerEntry.direction stays the accounting bucket used
// for date subtotals; this never feeds any calculation.
export type EntryDisplayBadgeKind = "income" | "expense" | "transfer" | "unpaid" | "payment";

export function entryDisplayBadgeKind(
  entry: Pick<LedgerEntry, "direction" | "settlementStatus" | "remainingAmount" | "paymentTransaction" | "employeeCost">,
): EntryDisplayBadgeKind {
  // 결제 is reserved for supplier payable payments.
  if (entry.paymentTransaction) return "payment";
  // Payroll pay-outs and advances (payroll_payment, direction transfer) read as
  // spending; the labor cost itself is recognized once by the payroll batch.
  if (entry.employeeCost && entry.direction === "transfer") return "expense";
  if (entry.direction !== "expense") return entry.direction;
  const outstanding = entry.settlementStatus === "unpaid" || entry.settlementStatus === "partial" || (entry.remainingAmount ?? 0) > 0;
  return outstanding ? "unpaid" : "expense";
}

export function entryDisplayBadgeLabel(kind: EntryDisplayBadgeKind, lang: "ko" | "vi") {
  const labels = lang === "vi"
    ? { income: "Thu", expense: "Chi", transfer: "Chuyển", unpaid: "Công nợ", payment: "Thanh toán" }
    : { income: "수입", expense: "지출", transfer: "이체", unpaid: "미납", payment: "결제" };
  return labels[kind];
}

export function entryDisplayBadgeEmoji(kind: EntryDisplayBadgeKind) {
  return { income: "💰", expense: "💸", transfer: "🔄", unpaid: "⏳", payment: "💳" }[kind];
}
