// @ts-expect-error Node's strip-types runner needs the explicit extension.
import { manualExpenseCategoryEmoji } from "./manual-entry-policy.ts";

export type DashboardEmojiData = {
  categories: readonly { id: number | string; name: string; emoji?: string | null }[];
  transactions?: readonly { id: number | string; party_id?: number | string | null; category?: { id?: number | string | null; emoji?: string | null } | null }[];
  partners?: readonly { ledgerPartyId: number; emoji?: string | null }[];
};

const incomeCategoryEmoji: Record<string, string> = {
  "예금이자": "🏦", "주류 거스름돈": "🍷", "환불": "↩️",
};
const expenseCauseEmoji: Record<number, string> = {
  [-201]: "👥", [-202]: "🧾", [-203]: "📅", [-204]: "⚖️", [-205]: "⚖️",
};

// IDs come from the existing report: income details are transactions;
// expense details are aggregated category IDs or explicit cash-report causes.
// Never infer a partner or product from memo/name substrings.
export function buildDashboardDetailEmoji(data: DashboardEmojiData) {
  const categories = new Map(data.categories.map(category => [Number(category.id), category]));
  const transactions = new Map((data.transactions ?? []).map(transaction => [Number(transaction.id), transaction]));
  const partnerEmoji = new Map((data.partners ?? []).map(partner => [Number(partner.ledgerPartyId), partner.emoji?.trim()]));
  return (detail: { id: number; emoji?: string | null }, direction: "income" | "expense", parentId: number) => {
    if (detail.emoji?.trim()) return detail.emoji.trim();
    const transaction = direction === "income" ? transactions.get(detail.id) : undefined;
    const partner = transaction?.party_id == null ? undefined : partnerEmoji.get(Number(transaction.party_id));
    if (partner) return partner;
    const category = categories.get(direction === "income" ? Number(transaction?.category?.id ?? parentId) : detail.id) ?? categories.get(parentId);
    const assigned = transaction?.category?.emoji?.trim() || category?.emoji?.trim();
    if (assigned) return assigned;
    if (direction === "expense" && expenseCauseEmoji[detail.id]) return expenseCauseEmoji[detail.id];
    const mapped = category && (manualExpenseCategoryEmoji(category.name) || incomeCategoryEmoji[category.name]);
    return mapped || (direction === "income" ? "💰" : "📦");
  };
}
