import { reserveCurrentAmount } from "./reserve-balances.ts";

type FundsViewCutoff = { mode: "live" | "provisional" | "closed_snapshot"; asOf: string };

// Reserve history as of the selected month, with the same cutoff the ledger API
// uses for reserve balances: live = occurred_at <= asOf (load time), other
// months = occurred_at < month-end cutoff. Later entries are never shown for a
// past month. The amount shown stays the month's own figure (snapshot for a
// closed month); `total` is only used to flag a history/amount mismatch.
export function reserveHistoryAsOf<T extends { entry_type: string; amount: number | string; occurred_at: string }>(
  entries: readonly T[],
  fundsView: FundsViewCutoff,
) {
  const cutoff = Date.parse(fundsView.asOf);
  const visible = entries.filter((entry) => {
    const at = Date.parse(entry.occurred_at);
    return fundsView.mode === "live" ? at <= cutoff : at < cutoff;
  });
  return { entries: visible, total: reserveCurrentAmount(visible) };
}
