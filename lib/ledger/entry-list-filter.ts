// @ts-expect-error Node's local strip-types test runner requires the extension.
import { entryMatchesExpenseFilter, entryRequiresReview, isCardSettlementEntry, isReserveLedgerEntry, type LedgerEntry } from "./entries.ts";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { entryDisplayBadgeKind } from "./entry-display-badge.ts";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { entryDisplayAmount, entryDisplayAmountSign } from "./entry-display-amount.ts";

// Display filters for the daily ledger list. They only choose visible rows;
// amounts, directions and the 전체 subtotal rules are unchanged.
export const LEDGER_ENTRY_FILTERS = [
  "all", "income", "expense", "unpaid", "payment", "card", "transfer",
  "payroll", "adjustment", "investment", "manual", "reserve", "pending",
] as const;
export type LedgerEntryFilter = (typeof LEDGER_ENTRY_FILTERS)[number];

export function ledgerEntryFilterLabel(filter: LedgerEntryFilter, lang: "ko" | "vi") {
  const labels = lang === "vi"
    ? { all: "Tất cả", income: "Thu", expense: "Chi", unpaid: "Công nợ", payment: "Thanh toán", card: "Thẻ", transfer: "Chuyển", payroll: "Lương", manual: "Thủ công", pending: "Cần xác nhận", adjustment: "Điều chỉnh", investment: "Vốn góp", reserve: "Dự phòng" }
    : { all: "전체", income: "수입", expense: "지출", unpaid: "미납", payment: "결제", card: "카드", transfer: "이체", payroll: "급여", manual: "수동", pending: "확인 필요", adjustment: "조정", investment: "투자금", reserve: "준비금" };
  return labels[filter];
}

export function entryMatchesListFilter(entry: LedgerEntry, filter: LedgerEntryFilter) {
  // System adjustments stay out of the list; only a user-facing manual balance
  // adjustment surfaces, and only under 조정.
  if (entry.isSystemAdjustment) return filter === "adjustment" && entry.userAdjustment === "balance";
  // Derived payment-difference rows exist for 조정 only; 전체 keeps them inside the payment row.
  if (entry.paymentDifference) return filter === "adjustment";
  if (filter === "all") return true;
  // Reserve history rows are informational: 전체 and 준비금 only.
  if (isReserveLedgerEntry(entry)) return filter === "reserve";
  // More specific display identities are exclusive to their own filter.
  if (isCardSettlementEntry(entry)) return filter === "card";
  if (entry.userAdjustment) return filter === "adjustment";
  switch (filter) {
    case "income": return entry.direction === "income";
    case "expense": return entryMatchesExpenseFilter(entry);
    // 미납 / 결제 / 투자금 follow the row's own display badge.
    case "unpaid": case "payment": case "investment": return entryDisplayBadgeKind(entry) === filter;
    case "transfer": return entry.transferTransaction === true;
    case "payroll": return entry.employeeCost === true || entry.payrollPayment === true;
    case "manual": return entry.origin === "manual";
    case "pending": return entryRequiresReview(entry);
    case "card": case "adjustment": case "reserve": return false;
  }
}

// Filters whose date header keeps the existing 수입/지출 subtotal pair.
const SUBTOTAL_HEADER_FILTERS = new Set<LedgerEntryFilter>(["all", "income", "expense", "unpaid", "payroll", "manual", "pending"]);

// Date-header amount of one visible row for a single-amount filter, from the
// row's own display amount and display sign (never movement nets). Returns
// null where the header keeps the 수입/지출 subtotal pair.
export function entryFilterHeaderAmount(entry: LedgerEntry, filter: LedgerEntryFilter) {
  if (SUBTOTAL_HEADER_FILTERS.has(filter)) return null;
  const amount = Math.abs(entryDisplayAmount(entry));
  return entryDisplayAmountSign(entry) === "−" ? -amount : amount;
}
