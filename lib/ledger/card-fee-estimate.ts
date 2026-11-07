import { cardMoney, sumCardMoney } from "./card-settlements.ts";

// Read-only fee analysis for one sale month. It never writes and never changes
// buildCardFeeMonthState: the official fee is still only a ledger_card_fee_closures
// row (plus historical matched differences). Manual expenses booked in the card
// difference category are shown separately so a provisional entry is not
// counted a second time on top of the unconfirmed remainder.
export const CARD_FEE_EXPENSE_CATEGORY_NAME = "카드 정산 차액";
export type CardFeeManualExpense = { id: number; amount: number; memo: string | null };

export function buildCardFeeEstimate(input: {
  monthCardGross: number; currentOutstanding: number; historicalConfirmedFee: number; monthEndFee: number;
  hasClosure: boolean; manualExpenses: readonly CardFeeManualExpense[];
}) {
  const gross = cardMoney(input.monthCardGross);
  // Confirmed = matched historical differences + the official month-end closure.
  const confirmedFee = cardMoney(input.historicalConfirmedFee + (input.hasClosure ? input.monthEndFee : 0));
  // Unconfirmed = gross no deposit or closure has consumed yet. It may still be an undeposited sale.
  const unconfirmedEstimate = cardMoney(Math.max(0, input.currentOutstanding));
  const currentEstimate = cardMoney(confirmedFee + unconfirmedEstimate);
  const manualExpenseTotal = sumCardMoney(input.manualExpenses.map(row => row.amount));
  const manualCoveredEstimate = cardMoney(Math.min(manualExpenseTotal, unconfirmedEstimate));
  const unrecognizedEstimate = cardMoney(Math.max(0, unconfirmedEstimate - manualExpenseTotal));
  // A manual expense next to an official closure, or larger than the remainder, is booked twice.
  const duplicateRisk = manualExpenseTotal > 0 && (input.hasClosure || manualExpenseTotal > unconfirmedEstimate);
  const rate = gross > 0 ? currentEstimate / gross : null;
  return {
    gross, confirmedFee, unconfirmedEstimate, currentEstimate, rate,
    manualExpenses: input.manualExpenses.map(row => ({ id: row.id, amount: cardMoney(row.amount), memo: row.memo })),
    manualExpenseTotal, manualCoveredEstimate, unrecognizedEstimate, duplicateRisk,
    // A manual card-fee expense without a closure is provisional, never an official confirmation.
    provisionalManualOnly: manualExpenseTotal > 0 && !input.hasClosure,
  };
}
export type CardFeeEstimate = ReturnType<typeof buildCardFeeEstimate>;
