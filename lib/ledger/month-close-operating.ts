// @ts-expect-error Node's test runner requires the explicit TypeScript extension.
import { allocateCardDifferenceBySaleMonth, type CardDifferenceLine } from "./card-difference-attribution.ts";
// @ts-expect-error Node's test runner requires the explicit TypeScript extension.
import { cardMoney } from "./card-settlements.ts";
// @ts-expect-error Node's test runner requires the explicit TypeScript extension.
import { calculateMonthCloseRevenue } from "./month-close-revenue.ts";

type RecognizedTransaction = {
  type: string;
  source_type: string;
  source_key: string | null;
  amount: number | string;
  economic_effect_sign: number;
  category: { name: string } | null;
};

export function calculateMonthCloseOperatingSummary(month: string, recognized: RecognizedTransaction[], cardFeeLines: CardDifferenceLine[]) {
  const revenue = calculateMonthCloseRevenue(recognized);
  const expenseRows = recognized.filter(tx => tx.type === "expense" || tx.type === "expense_recognition");
  const signed = (tx: RecognizedTransaction) => Number(tx.amount) * Number(tx.economic_effect_sign ?? 1);
  const byCategory: Record<string, number> = {};
  for (const tx of expenseRows) {
    const name = tx.category?.name ?? "미분류";
    byCategory[name] = (byCategory[name] ?? 0) + signed(tx);
  }
  const attributedCardDifference = allocateCardDifferenceBySaleMonth(cardFeeLines)[month] ?? 0;
  const depositMonthRecognizedDifference = cardMoney(expenseRows.filter(tx => tx.source_type === "card_settlement_difference" || tx.source_type === "card_settlement_difference_reversal").reduce((sum, tx) => sum + signed(tx), 0));
  const cardAttributionAdjustment = cardMoney(attributedCardDifference - depositMonthRecognizedDifference);
  if (cardAttributionAdjustment) byCategory["카드 정산 차액 · 매출월 귀속"] = cardMoney((byCategory["카드 정산 차액 · 매출월 귀속"] ?? 0) + cardAttributionAdjustment);
  const totalExpense = cardMoney(Object.values(byCategory).reduce((sum, value) => sum + value, 0));
  return {
    revenue,
    expense: { byCategory, total: totalExpense, attributedCardDifference, depositMonthRecognizedDifference, cardAttributionAdjustment },
    operatingResult: { revenue: revenue.total, expense: totalExpense, operatingProfit: cardMoney(revenue.total - totalExpense) },
  };
}
