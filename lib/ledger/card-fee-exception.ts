// One-off "estimate exception" closing of a card fee month (October 2026, #4119): the provisional
// manual expense stays as booked and the month is recorded as closed on that estimate because the
// actual card-company fee could not be confirmed. Recorded once as an append-only audit row by
// scripts/ledger/card-fee-october-estimate-exception-20261108-ONE-OFF.sql; read-only here.
export const CARD_FEE_ESTIMATE_EXCEPTION_ACTION = "card_fee_month_estimate_exception";

export type CardFeeEstimateException = { month: string; amount: number; reason: string | null; recordedAt: string };

export function parseCardFeeEstimateExceptions(rows: readonly { after_snapshot: unknown; reason: string | null; created_at: string }[]): CardFeeEstimateException[] {
  return rows.flatMap(row => {
    const snapshot = row.after_snapshot as { feeMonth?: unknown; provisionalAmount?: unknown; officialFeeConfirmed?: unknown } | null;
    const month = typeof snapshot?.feeMonth === "string" && /^\d{4}-\d{2}-01$/.test(snapshot.feeMonth) ? snapshot.feeMonth.slice(0, 7) : null;
    const amount = Number(snapshot?.provisionalAmount);
    // Only a well-formed record that explicitly says the fee was NOT officially confirmed counts.
    if (!month || !Number.isFinite(amount) || amount <= 0 || snapshot?.officialFeeConfirmed !== false) return [];
    return [{ month, amount, reason: row.reason, recordedAt: row.created_at }];
  });
}
