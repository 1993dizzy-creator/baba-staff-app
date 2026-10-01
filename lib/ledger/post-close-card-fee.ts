// @ts-expect-error Node local tests require the explicit extension.
import { cardMoney } from "./card-settlements.ts";
// Normalize only an expected append-only fee when comparing an immutable close
// with today's recalculation. All holdings, allocations and other drift remain.
type Snapshot = {
  card?: { feeClosure?: { autoConfirmed?: boolean; feeAmount: number } | null; feeStatus?: string; finalConfirmedFee?: number };
  expense?: { byCategory: Record<string, number>; total: number };
  operatingResult?: { expense: number; operatingProfit: number };
};
export function normalizePostCloseCardFeeSnapshot<T extends Snapshot>(current: T, stored: Snapshot): T {
  const normalized = structuredClone(current);
  // A display-only status added after an older close is not accounting drift.
  if (normalized.card && stored.card && !("feeStatus" in stored.card)) delete normalized.card.feeStatus;
  const key = "카드 정산 차액";
  // An automatic fee and its append-only reversal net to zero. The aggregate
  // retains a zero category that an originally pending snapshot never had.
  if (!current.card?.feeClosure && !stored.card?.feeClosure
      && normalized.expense?.byCategory[key] === 0
      && !(key in (stored.expense?.byCategory ?? {}))) delete normalized.expense.byCategory[key];
  const fee = current.card?.feeClosure;
  if (!fee?.autoConfirmed || stored.card?.feeClosure || !current.expense || !current.operatingResult) return normalized;
  const amount = fee.feeAmount;
  if (!Number.isFinite(amount) || amount <= 0) return normalized;
  normalized.expense!.total = cardMoney(normalized.expense!.total - amount);
  normalized.expense!.byCategory[key] = cardMoney((normalized.expense!.byCategory[key] ?? 0) - amount);
  if (!(key in (stored.expense?.byCategory ?? {})) && normalized.expense!.byCategory[key] === 0) delete normalized.expense!.byCategory[key];
  normalized.operatingResult!.expense = cardMoney(normalized.operatingResult!.expense - amount);
  normalized.operatingResult!.operatingProfit = cardMoney(normalized.operatingResult!.operatingProfit + amount);
  for (const field of ["feeClosure", "feeStatus", "finalConfirmedFee"] as const) {
    if (stored.card && field in stored.card) Object.assign(normalized.card!, { [field]: stored.card[field] });
    else delete normalized.card![field];
  }
  return normalized;
}
