import { cardMoney } from "./card-settlements.ts";

// Read-only historical card fee rates by SALE month (never by the day a fee was booked).
// Fee per month = matched historical differences attributed to that month's sales
// (calculateMonthlySettlementDifference) + the official month-end closure, exactly the
// values buildCardFeeMonthState already returns, so nothing is counted twice.
// Only confirmed months enter the store average; it updates by itself when a month confirms.
export const CARD_FEE_HISTORY_MIN_SALE_DAYS = 7;
export type CardFeeHistoryStatus = "confirmed" | "provisional" | "estimate_exception" | "pending" | "open" | "partial";
export type CardFeeHistoryInput = {
  month: string; gross: number; saleDays: number; historicalConfirmedFee: number; monthEndFee: number;
  hasClosure: boolean; currentOutstanding: number; monthClosed: boolean; provisionalFee: number;
  // Closed on the provisional estimate (one-off exception record): shown, never averaged.
  estimateException?: boolean;
};

function statusOf(row: CardFeeHistoryInput): CardFeeHistoryStatus {
  // A partial first month (e.g. one recorded sales day) is a reference only.
  if (row.saleDays < CARD_FEE_HISTORY_MIN_SALE_DAYS) return "partial";
  if (row.hasClosure) return "confirmed";
  if (row.provisionalFee !== 0) return row.estimateException ? "estimate_exception" : "provisional";
  if (!row.monthClosed) return "open";
  // Closed with nothing left: every sale was matched, the historical differences are final.
  return row.currentOutstanding === 0 ? "confirmed" : "pending";
}

export function buildCardFeeHistory(input: { months: readonly CardFeeHistoryInput[]; currentMonth: string }) {
  const months = input.months
    .filter(row => row.month < input.currentMonth && row.gross > 0)
    .map(row => {
      const status = statusOf(row);
      const officialFee = cardMoney(row.historicalConfirmedFee + (row.hasClosure ? row.monthEndFee : 0));
      // Provisional months show the manual estimate; pending/open months have no fee yet.
      const fee = status === "provisional" || status === "estimate_exception" ? cardMoney(officialFee + row.provisionalFee)
        : status === "pending" || status === "open" ? null : officialFee;
      return { month: row.month, gross: row.gross, saleDays: row.saleDays, status, fee, rate: fee === null ? null : fee / row.gross };
    })
    .sort((a, b) => b.month.localeCompare(a.month));
  const confirmed = months.filter(row => row.status === "confirmed" && row.rate !== null);
  const gross = confirmed.reduce((sum, row) => sum + row.gross, 0);
  const fee = confirmed.reduce((sum, row) => sum + (row.fee ?? 0), 0);
  const byRate = [...confirmed].sort((a, b) => a.rate! - b.rate! || a.month.localeCompare(b.month));
  return {
    months,
    confirmedCount: confirmed.length,
    // Sales-weighted: total confirmed fee / total confirmed gross. null = still being collected.
    averageRate: gross > 0 ? fee / gross : null,
    lowest: byRate[0] ? { month: byRate[0].month, rate: byRate[0].rate! } : null,
    highest: byRate.at(-1) ? { month: byRate.at(-1)!.month, rate: byRate.at(-1)!.rate! } : null,
  };
}
export type CardFeeHistory = ReturnType<typeof buildCardFeeHistory>;
