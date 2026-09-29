// @ts-expect-error Node's local strip-types test runner requires the extension.
import { isPayrollPaymentOutflow, type LedgerEntry } from "./entries.ts";

// Display-only badge. LedgerEntry.direction stays the accounting bucket used
// for date subtotals; this never feeds any calculation.
export type EntryDisplayBadgeKind = "income" | "expense" | "transfer" | "unpaid" | "payment" | "investment";

export function entryDisplayBadgeKind(
  entry: Pick<LedgerEntry, "direction" | "settlementStatus" | "remainingAmount" | "paymentTransaction" | "payrollPayment" | "fundFlow" | "systemDisplay">,
): EntryDisplayBadgeKind {
  // Supplier payments and card settlement deposits share the display badge.
  if (entry.paymentTransaction) return "payment";
  if (entry.systemDisplay?.kind === "cardSettlementDeposit") return "payment";
  if (entry.systemDisplay?.kind === "investment") return "investment";
  // Only an actual payroll_payment fund outflow reads as spending.
  if (isPayrollPaymentOutflow(entry)) return "expense";
  if (entry.direction !== "expense") return entry.direction;
  const outstanding = entry.settlementStatus === "unpaid" || entry.settlementStatus === "partial" || (entry.remainingAmount ?? 0) > 0;
  return outstanding ? "unpaid" : "expense";
}

export function entryDisplayBadgeLabel(kind: EntryDisplayBadgeKind, lang: "ko" | "vi") {
  const labels = lang === "vi"
    ? { income: "Thu", expense: "Chi", transfer: "Chuyển", unpaid: "Công nợ", payment: "Thanh toán", investment: "Vốn góp" }
    : { income: "수입", expense: "지출", transfer: "이체", unpaid: "미납", payment: "결제", investment: "투자금" };
  return labels[kind];
}

export function entryDisplayBadgeEmoji(kind: EntryDisplayBadgeKind) {
  return { income: "💰", expense: "💸", transfer: "🔄", unpaid: "⏳", payment: "💳", investment: "⚖️" }[kind];
}
