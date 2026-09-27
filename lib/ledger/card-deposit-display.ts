import { CARD_AUTO_ALLOCATED_STATUS, sumCardMoney } from "./card-settlements";

// pending holds legacy unmatched/partial deposits from the former manual-matching flow;
// they stay visible (never auto-settled) until someone cancels them.
export function groupCardDeposits<T extends { deposit_date: string; deposit_amount: number | string; status: string }>(rows: readonly T[], month: string) {
  const monthly = rows.filter(row => row.deposit_date.slice(0, 7) === month);
  const matched = monthly.filter(row => row.status === "matched");
  return { pending: monthly.filter(row => ["unmatched", "partial"].includes(row.status)), auto: monthly.filter(row => row.status === CARD_AUTO_ALLOCATED_STATUS), matched,
    cancelled: monthly.filter(row => row.status === "cancelled"), matchedTotal: sumCardMoney(matched.map(row => row.deposit_amount)) };
}
