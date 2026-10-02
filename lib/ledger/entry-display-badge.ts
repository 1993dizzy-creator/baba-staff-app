// @ts-expect-error Node's local strip-types test runner requires the extension.
import { isCardSettlementEntry, isPayrollPaymentOutflow, type LedgerEntry } from "./entries.ts";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { BALANCE_SCALE_EMOJI, CARD_EMOJI } from "./entry-display-emoji.ts";

// Display-only badge. LedgerEntry.direction stays the accounting bucket used
// for date subtotals; this never feeds any calculation.
export type EntryDisplayBadgeKind = "income" | "expense" | "transfer" | "unpaid" | "payment" | "card" | "adjustment" | "investment" | "reserve";

export function entryDisplayBadgeKind(
  entry: Pick<LedgerEntry, "direction" | "settlementStatus" | "remainingAmount" | "paymentTransaction" | "payrollPayment" | "fundFlow" | "systemDisplay" | "userAdjustment">,
): EntryDisplayBadgeKind {
  if (entry.systemDisplay?.kind === "reserve") return "reserve";
  // Card settlement rows read as [카드]; [결제] is only a supplier payable payment.
  if (isCardSettlementEntry(entry)) return "card";
  if (entry.userAdjustment) return "adjustment";
  if (entry.paymentTransaction) return "payment";
  if (entry.systemDisplay?.kind === "investment") return "investment";
  // Only an actual payroll_payment fund outflow reads as spending.
  if (isPayrollPaymentOutflow(entry)) return "expense";
  if (entry.direction !== "expense") return entry.direction;
  const outstanding = entry.settlementStatus === "unpaid" || entry.settlementStatus === "partial" || (entry.remainingAmount ?? 0) > 0;
  return outstanding ? "unpaid" : "expense";
}

export function entryDisplayBadgeLabel(kind: EntryDisplayBadgeKind, lang: "ko" | "vi") {
  const labels = lang === "vi"
    ? { income: "Thu", expense: "Chi", transfer: "Chuyển", unpaid: "Công nợ", payment: "Thanh toán", card: "Thẻ", adjustment: "Điều chỉnh", investment: "Vốn góp", reserve: "Dự phòng" }
    : { income: "수입", expense: "지출", transfer: "이체", unpaid: "미납", payment: "결제", card: "카드", adjustment: "조정", investment: "투자금", reserve: "준비금" };
  return labels[kind];
}

export function entryDisplayBadgeEmoji(kind: EntryDisplayBadgeKind) {
  return { income: "💰", expense: "💸", transfer: "🔄", unpaid: "⏳", payment: "💳", card: CARD_EMOJI, adjustment: BALANCE_SCALE_EMOJI, investment: BALANCE_SCALE_EMOJI, reserve: "🏦" }[kind];
}
