// @ts-expect-error Node's local strip-types test runner requires the extension.
import { manualExpenseCategoryEmoji } from "./manual-entry-policy.ts";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { effectivePartnerEmoji } from "../partners/emoji.ts";
import type { PartnerType } from "../partners/policy";
import type { LedgerEntry } from "./entries";

export const EMPLOYEE_COST_EMOJI = "👥";
// Shared by 투자금 and user-facing 조정 rows; the badge text tells them apart.
export const BALANCE_SCALE_EMOJI = "⚖️";
export const CARD_EMOJI = "💳";

export function chooseLedgerEntryEmoji(
  partnerEmoji: string | null | undefined,
  ledgerCategoryEmoji: string,
) {
  return partnerEmoji || ledgerCategoryEmoji;
}

// Party-only rows (e.g. 미납금 현황) have no ledger category, so the ledger
// list's partner emoji is used as-is; without a mapped partner the party's
// type falls back through the same effectivePartnerEmoji policy.
export function ledgerPartyEmoji(partnerEmoji: string | null | undefined, partnerType: string | null | undefined) {
  return chooseLedgerEntryEmoji(partnerEmoji, effectivePartnerEmoji((partnerType || "other") as PartnerType, null) ?? effectivePartnerEmoji("other", null));
}

export function entryCategoryEmoji(entry: Pick<LedgerEntry, "categoryName" | "direction" | "employeeCost" | "systemDisplay" | "userAdjustment">) {
  if (entry.systemDisplay?.kind === "reserve") return "🏦";
  if (entry.systemDisplay?.kind === "investment" || entry.userAdjustment) return BALANCE_SCALE_EMOJI;
  if (entry.systemDisplay?.kind === "pos") return "🧾";
  if (entry.systemDisplay?.kind === "cardSettlementDeposit" ||
      entry.systemDisplay?.kind === "cardSettlementDifference" ||
      entry.systemDisplay?.kind === "cardFeeMonthClose") return CARD_EMOJI;
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
