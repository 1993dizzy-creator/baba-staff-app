// @ts-expect-error Node's local strip-types test runner requires the extension.
import { manualExpenseCategoryEmoji } from "./manual-entry-policy.ts";
import type { LedgerEntry } from "./entries";

export const EMPLOYEE_COST_EMOJI = "👥";

export function chooseLedgerEntryEmoji(
  partnerEmoji: string | null | undefined,
  ledgerCategoryEmoji: string,
) {
  return partnerEmoji || ledgerCategoryEmoji;
}

export function entryCategoryEmoji(entry: Pick<LedgerEntry, "categoryName" | "direction" | "employeeCost" | "systemDisplay">) {
  if (entry.systemDisplay?.kind === "pos") return "🧾";
  if (entry.systemDisplay?.kind === "cardSettlementDeposit" ||
      entry.systemDisplay?.kind === "cardSettlementDifference" ||
      entry.systemDisplay?.kind === "cardFeeMonthClose") return "💳";
  // Payroll rows (including advances with no category) are flagged upstream.
  if (entry.employeeCost) return EMPLOYEE_COST_EMOJI;
  if (entry.categoryName) {
    const manualEmoji = manualExpenseCategoryEmoji(entry.categoryName);
    if (manualEmoji) return manualEmoji;
    if (entry.categoryName.includes("매출")) return "🧾";
    if (entry.categoryName.includes("수수료")) return "🏦";
  }
  return entry.direction === "income" ? "💰" : entry.direction === "expense" ? "📂" : "🔄";
}
