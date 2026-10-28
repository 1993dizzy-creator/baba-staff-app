// @ts-expect-error Node's local strip-types test runner requires the extension.
import { isCardSettlementEntry, isPayrollPaymentOutflow, type LedgerEntry } from "./entries.ts";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { BALANCE_SCALE_EMOJI, CARD_EMOJI } from "./entry-display-emoji.ts";

// Display-only badge. LedgerEntry.direction stays the accounting bucket used
// for date subtotals; this never feeds any calculation.
export type EntryDisplayBadgeKind = "income" | "expense" | "transfer" | "unpaid" | "partial" | "payment" | "card" | "adjustment" | "investment" | "reserve" | "allocation";

export function entryDisplayBadgeKind(
  entry: Pick<LedgerEntry, "direction" | "settlementStatus" | "remainingAmount" | "paymentTransaction" | "payrollPayment" | "fundFlow" | "systemDisplay" | "userAdjustment" | "prepaidAllocation">,
): EntryDisplayBadgeKind {
  if (entry.systemDisplay?.kind === "reserve") return "reserve";
  // A monthly share of an expense paid in advance: P&L only, never a payment.
  if (entry.prepaidAllocation) return "allocation";
  // Card settlement rows read as [카드]; [결제] is only a supplier payable payment.
  if (isCardSettlementEntry(entry)) return "card";
  if (entry.userAdjustment) return "adjustment";
  if (entry.paymentTransaction) return "payment";
  if (entry.systemDisplay?.kind === "investment") return "investment";
  // Only an actual payroll_payment fund outflow reads as spending.
  if (isPayrollPaymentOutflow(entry)) return "expense";
  if (entry.direction !== "expense") return entry.direction;
  // A payable purchase reads by its settlement as of the view month
  // (미납 → 일부결제 → 결제); a fully paid purchase is never [지출].
  if (entry.settlementStatus === "paid") return "payment";
  if (entry.settlementStatus === "partial") return "partial";
  const outstanding = entry.settlementStatus === "unpaid" || (entry.remainingAmount ?? 0) > 0;
  return outstanding ? "unpaid" : "expense";
}

export function entryDisplayBadgeLabel(kind: EntryDisplayBadgeKind, lang: "ko" | "vi") {
  const labels = lang === "vi"
    ? { income: "Thu", expense: "Chi", transfer: "Chuyển", unpaid: "Công nợ", partial: "Trả một phần", payment: "Thanh toán", card: "Thẻ", adjustment: "Điều chỉnh", investment: "Vốn góp", reserve: "Dự phòng", allocation: "Phân bổ trả trước" }
    : { income: "수입", expense: "지출", transfer: "이체", unpaid: "미납", partial: "일부결제", payment: "결제", card: "카드", adjustment: "조정", investment: "투자금", reserve: "준비금", allocation: "선납배분" };
  return labels[kind];
}

export function entryDisplayBadgeEmoji(kind: EntryDisplayBadgeKind) {
  return { income: "💰", expense: "💸", transfer: "🔄", unpaid: "⏳", partial: "🌓", payment: "💳", card: CARD_EMOJI, adjustment: BALANCE_SCALE_EMOJI, investment: BALANCE_SCALE_EMOJI, reserve: "🏦", allocation: "📆" }[kind];
}
