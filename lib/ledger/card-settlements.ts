export type CardSale = { id: number; business_date: string; amount: number | string };
export type CardAllocationLine = {
  reconciliation_id: number;
  pos_card_transaction_id: number;
  allocated_gross_amount: number | string;
  reconciliation: { status: string } | null;
};
export type CardReconciliation = {
  id: number; deposit_date: string; deposit_amount: number | string;
  matched_gross_amount: number | string; difference_amount: number | string; status: string;
};
export const cardMoney = (value: number) => Math.round(value * 1000) / 1000;
export const sumCardMoney = (values: readonly (number | string)[]) => values.reduce<number>((sum, value) => sum + Math.round(Number(value) * 1000), 0) / 1000;

// Sale business_date controls gross reporting. Deposit dates never filter lines.
export function calculateCardGross<T extends CardSale>(sales: readonly T[], lines: readonly CardAllocationLine[], start: string, end: string) {
  const allocated = new Map<number, number>();
  const settled = new Map<number, number>();
  for (const line of lines) {
    if (!line.reconciliation || line.reconciliation.status === "cancelled") continue;
    const id = Number(line.pos_card_transaction_id);
    allocated.set(id, cardMoney((allocated.get(id) ?? 0) + Number(line.allocated_gross_amount)));
    if (line.reconciliation.status === "matched") settled.set(id, cardMoney((settled.get(id) ?? 0) + Number(line.allocated_gross_amount)));
  }
  const balances = sales.map(sale => {
    const allocatedGrossAmount = allocated.get(Number(sale.id)) ?? 0;
    return { ...sale, allocatedGrossAmount, outstandingGrossAmount: cardMoney(Math.max(0, Number(sale.amount) - allocatedGrossAmount)) };
  });
  const monthly = balances.filter(sale => sale.business_date >= start && sale.business_date < end);
  const monthlyCardGross = sumCardMoney(monthly.map(sale => sale.amount));
  const monthlyUnreconciledGross = sumCardMoney(monthly.map(sale => sale.outstandingGrossAmount));
  return {
    sales: balances,
    monthlyCardGross,
    monthlyReconciledGross: cardMoney(monthlyCardGross - monthlyUnreconciledGross),
    monthlySettledGross: sumCardMoney(monthly.map(sale => Math.min(Number(sale.amount), settled.get(Number(sale.id)) ?? 0))),
    monthlyUnreconciledGross,
    totalUnreconciledGross: sumCardMoney(balances.map(sale => sale.outstandingGrossAmount)),
  };
}

export function calculateCardDepositSummary(reconciliations: readonly CardReconciliation[], start: string, end: string) {
  const monthly = reconciliations.filter(row => row.status !== "cancelled" && row.deposit_date >= start && row.deposit_date < end);
  const completed = monthly.filter(row => row.status === "matched");
  const monthlyCompletedGross = sumCardMoney(completed.map(row => row.matched_gross_amount));
  const monthlyCompletedDifference = sumCardMoney(completed.map(row => row.difference_amount));
  return {
    actualCardDeposits: sumCardMoney(monthly.map(row => row.deposit_amount)),
    monthlyUnmatchedDeposits: sumCardMoney(monthly.filter(row => row.status !== "matched").map(row => row.deposit_amount)),
    monthlyCompletedGross,
    monthlyCompletedDeposit: sumCardMoney(completed.map(row => row.deposit_amount)),
    monthlyCompletedDifference,
    actualDifferenceRate: monthlyCompletedGross > 0 ? monthlyCompletedDifference / monthlyCompletedGross : null,
  };
}

export function recommendCardAllocations(sales: readonly { id: number; business_date: string; outstandingGrossAmount: number }[], depositAmount: number, expectedFeeRate: number) {
  if (!Number.isFinite(depositAmount) || depositAmount <= 0 || !Number.isFinite(expectedFeeRate) || expectedFeeRate < 0 || expectedFeeRate >= 1) throw new Error("INVALID_RECOMMENDATION");
  // Round upward to the DB's 0.001 precision so a zero-fee recommendation can confirm.
  const targetGross = Math.ceil(depositAmount / (1 - expectedFeeRate) * 1000) / 1000;
  let remaining = targetGross;
  const allocations: Array<{ transactionId: number; allocatedGrossAmount: number }> = [];
  for (const sale of [...sales].sort((a, b) => a.business_date.localeCompare(b.business_date) || a.id - b.id)) {
    if (remaining <= 0) break;
    const amount = cardMoney(Math.min(remaining, sale.outstandingGrossAmount));
    if (amount <= 0) continue;
    allocations.push({ transactionId: sale.id, allocatedGrossAmount: amount });
    remaining = cardMoney(remaining - amount);
  }
  return { targetGross, allocations, unallocatedGross: remaining };
}

// Editing replaces this reconciliation's lines in the RPC. Its existing gross
// must be available again, even when it fully consumed a sale's remaining gross.
export function buildEditableCardSales<T extends CardSale & { allocatedGrossAmount: number; outstandingGrossAmount: number }>(candidates: readonly T[], existing: readonly { pos_card_transaction_id: number; allocated_gross_amount: number | string; sale: T | null }[]) {
  const rows = new Map(candidates.map(sale => [Number(sale.id), { ...sale }]));
  for (const line of existing) {
    const id = Number(line.pos_card_transaction_id), ownGross = Number(line.allocated_gross_amount);
    const candidate = rows.get(id);
    if (candidate) rows.set(id, { ...candidate, allocatedGrossAmount: cardMoney(Math.max(0, candidate.allocatedGrossAmount - ownGross)), outstandingGrossAmount: cardMoney(candidate.outstandingGrossAmount + ownGross) });
    else if (line.sale) rows.set(id, { ...line.sale, allocatedGrossAmount: cardMoney(Math.max(0, Number(line.sale.amount) - ownGross)), outstandingGrossAmount: ownGross });
  }
  return [...rows.values()].sort((a, b) => a.business_date.localeCompare(b.business_date) || a.id - b.id);
}
