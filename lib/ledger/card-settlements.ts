export type CardSale = { id: number; business_date: string; amount: number | string };
export type CardAllocationLine = {
  reconciliation_id: number;
  pos_card_transaction_id: number;
  allocated_gross_amount: number | string;
  reconciliation: { status: string; deposit_date?: string } | null;
};
export type CardReconciliation = {
  id: number; deposit_date: string; deposit_amount: number | string;
  matched_gross_amount: number | string; difference_amount: number | string; status: string;
};
// Registered by ledger_create_card_deposit_auto_allocate_v1: the deposit amount is
// allocated to card sale principal FIFO. Fee finalization is a separate closure,
// so it is excluded from confirmed-difference (fee) metrics that use "matched".
export const CARD_AUTO_ALLOCATED_STATUS = "auto_allocated";
// Month-end card fee allocations (ledger_card_fee_allocation_lines of a confirmed closure)
// use this pseudo status. Legacy fees retain their month-end date; automatic fees
// use their actual finalization day so historical asset snapshots stay intact.
export const CARD_FEE_ALLOCATION_STATUS = "card_fee";
export const isSettledCardReconciliationStatus = (status: string | null | undefined) => status === "matched" || status === CARD_AUTO_ALLOCATED_STATUS || status === CARD_FEE_ALLOCATION_STATUS;
export const cardFeeMonthLastDay = (feeMonth: string) => {
  const next = new Date(`${feeMonth.slice(0, 7)}-01T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  next.setUTCDate(0);
  return next.toISOString().slice(0, 10);
};
export type CardFeeAllocationRow = { id: number; closure_id: number; pos_card_transaction_id: number; allocated_fee_amount: number | string; closure: { status: string; fee_month: string; finalization_business_date?: string | null } | null };
export function cardFeeRowsAsAllocationLines(rows: readonly CardFeeAllocationRow[]): CardAllocationLine[] {
  return rows.filter(row => row.closure && row.closure.status !== "cancelled").map(row => ({
    // Negative ids keep fee lines apart from reconciliation ids in per-reconciliation maps.
    reconciliation_id: -Number(row.closure_id),
    pos_card_transaction_id: Number(row.pos_card_transaction_id),
    allocated_gross_amount: row.allocated_fee_amount,
    reconciliation: { status: CARD_FEE_ALLOCATION_STATUS, deposit_date: row.closure!.finalization_business_date ?? cardFeeMonthLastDay(row.closure!.fee_month) },
  }));
}
export const cardMoney = (value: number) => Math.round(value * 1000) / 1000;
export const sumCardMoney = (values: readonly (number | string)[]) => values.reduce<number>((sum, value) => sum + Math.round(Number(value) * 1000), 0) / 1000;

export function formatCardSettlementRate(monthlyCardGross: number, monthlySettledGross: number) {
  if (monthlyCardGross <= 0) return "-";
  return `${Number((monthlySettledGross / monthlyCardGross * 100).toFixed(1))}%`;
}

// Attribute a matched reconciliation's difference to the sale month by its
// allocated gross share. Deposit date does not determine this summary.
export function calculateMonthlySettlementDifference(
  sales: readonly CardSale[], lines: readonly CardAllocationLine[], reconciliations: readonly CardReconciliation[],
  start: string, end: string,
) {
  const monthlySaleIds = new Set(sales.filter(sale => sale.business_date >= start && sale.business_date < end).map(sale => Number(sale.id)));
  const matched = new Map(reconciliations.filter(row => row.status === "matched" && Number(row.matched_gross_amount) > 0).map(row => [Number(row.id), row]));
  const monthlyGrossByReconciliation = new Map<number, number>();
  for (const line of lines) {
    const id = Number(line.reconciliation_id);
    if (!monthlySaleIds.has(Number(line.pos_card_transaction_id)) || !matched.has(id)) continue;
    monthlyGrossByReconciliation.set(id, cardMoney((monthlyGrossByReconciliation.get(id) ?? 0) + Number(line.allocated_gross_amount)));
  }
  return cardMoney([...monthlyGrossByReconciliation].reduce((sum, [id, gross]) => {
    const reconciliation = matched.get(id)!;
    return sum + Number(reconciliation.difference_amount) * gross / Number(reconciliation.matched_gross_amount);
  }, 0));
}

export function eligibleCardSalesForDeposit<T extends { business_date: string }>(sales: readonly T[], depositDate: string) {
  return sales.filter(sale => sale.business_date <= depositDate);
}

// Sale business_date controls gross reporting. Deposit dates never filter lines.
export function calculateCardGross<T extends CardSale>(sales: readonly T[], lines: readonly CardAllocationLine[], start: string, end: string) {
  const allocated = new Map<number, number>();
  const settled = new Map<number, number>();
  for (const line of lines) {
    if (!line.reconciliation || line.reconciliation.status === "cancelled") continue;
    const id = Number(line.pos_card_transaction_id);
    allocated.set(id, cardMoney((allocated.get(id) ?? 0) + Number(line.allocated_gross_amount)));
    if (isSettledCardReconciliationStatus(line.reconciliation.status)) settled.set(id, cardMoney((settled.get(id) ?? 0) + Number(line.allocated_gross_amount)));
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

// A selected month's snapshot uses the reconciliation's deposit date. The
// current-state calculation above remains available for operational matching.
export function calculateCardGrossAtMonthEnd<T extends CardSale>(sales: readonly T[], lines: readonly CardAllocationLine[], start: string, end: string) {
  const throughMonth = lines.filter(line => line.reconciliation?.deposit_date && line.reconciliation.deposit_date < end);
  return calculateCardGross(sales, throughMonth, start, end);
}

export function calculateCardDepositSummary(reconciliations: readonly CardReconciliation[], start: string, end: string) {
  const monthly = reconciliations.filter(row => row.status !== "cancelled" && row.deposit_date >= start && row.deposit_date < end);
  const completed = monthly.filter(row => row.status === "matched");
  const monthlyCompletedGross = sumCardMoney(completed.map(row => row.matched_gross_amount));
  const monthlyCompletedDifference = sumCardMoney(completed.map(row => row.difference_amount));
  return {
    actualCardDeposits: sumCardMoney(monthly.map(row => row.deposit_amount)),
    monthlyUnmatchedDeposits: sumCardMoney(monthly.filter(row => row.status === "unmatched" || row.status === "partial").map(row => row.deposit_amount)),
    monthlyCompletedGross,
    monthlyCompletedDeposit: sumCardMoney(completed.map(row => row.deposit_amount)),
    monthlyCompletedDifference,
    actualDifferenceRate: monthlyCompletedGross > 0 ? monthlyCompletedDifference / monthlyCompletedGross : null,
  };
}

export type CardDepositAutoAllocationError = "invalid_amount" | "nothing_outstanding" | "exceeds_outstanding";
export type CardDepositAutoAllocationRow = { transactionId: number; businessDate: string; outstandingBefore: number; allocatedAmount: number; outstandingAfter: number };

// FIFO contract shared with ledger_create_card_deposit_auto_allocate_v1: sales dated on
// or before the deposit date, oldest business_date first, then id; each takes
// min(remaining deposit, outstanding). The allocated total always equals the deposit;
// no fee rate is applied, so remaining sale balances are never treated as fees.
export function planCardDepositAutoAllocation(sales: readonly { id: number; business_date: string; outstandingGrossAmount: number | string }[], depositAmount: number, depositDate: string) {
  const eligible = eligibleCardSalesForDeposit(sales, depositDate).filter(sale => Number(sale.outstandingGrossAmount) > 0)
    .sort((a, b) => a.business_date.localeCompare(b.business_date) || a.id - b.id);
  const availableOutstanding = sumCardMoney(eligible.map(sale => sale.outstandingGrossAmount));
  const plan = (error: CardDepositAutoAllocationError | null, rows: CardDepositAutoAllocationRow[] = []) => ({
    depositAmount, availableOutstanding, rows,
    allocations: rows.map(row => ({ transactionId: row.transactionId, allocatedGrossAmount: row.allocatedAmount })),
    totalAllocated: sumCardMoney(rows.map(row => row.allocatedAmount)),
    remainingDeposit: error ? depositAmount : 0,
    error,
  });
  // DB amounts are numeric(16,3).
  if (!Number.isFinite(depositAmount) || depositAmount <= 0 || cardMoney(depositAmount) !== depositAmount) return plan("invalid_amount");
  if (!eligible.length) return plan("nothing_outstanding");
  if (depositAmount > availableOutstanding) return plan("exceeds_outstanding");
  // Work in integer thousandths so the allocated total matches the deposit exactly.
  let remaining = Math.round(depositAmount * 1000);
  const rows: CardDepositAutoAllocationRow[] = [];
  for (const sale of eligible) {
    if (remaining <= 0) break;
    const before = Math.round(Number(sale.outstandingGrossAmount) * 1000), allocated = Math.min(remaining, before);
    rows.push({ transactionId: sale.id, businessDate: sale.business_date, outstandingBefore: before / 1000, allocatedAmount: allocated / 1000, outstandingAfter: (before - allocated) / 1000 });
    remaining -= allocated;
  }
  return plan(null, rows);
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

export type PriorMonthCardDepositAllocation = {
  reconciliation_id: number;
  allocated_gross_amount: number | string;
  sale: { business_date: string } | null;
  reconciliation: { status: string; deposit_date: string; deposit_amount: number | string; matched_gross_amount: number | string } | null;
};
export type SalesReceiptExplanation = {
  posSales: number;
  priorMonthCardDeposits: number;
  monthEndUnsettledCardSales: number;
  actualSalesReceipts: number;
  allocationDifference: number;
};

// Display-only bridge. Cash totals and the settlement/FIFO/fee policies stay unchanged.
// Attribute real deposits to earlier sales by their recorded allocation share.
export function calculateSalesReceiptExplanation({ posSales, actualSalesReceipts, monthEndUnsettledCardSales, allocations, start, end }: {
  posSales: number; actualSalesReceipts: number; monthEndUnsettledCardSales: number;
  allocations: readonly PriorMonthCardDepositAllocation[]; start: string; end: string;
}): SalesReceiptExplanation {
  const priorByReconciliation = new Map<number, { gross: number; reconciliation: NonNullable<PriorMonthCardDepositAllocation["reconciliation"]> }>();
  for (const line of allocations) {
    const reconciliation = line.reconciliation;
    if (!line.sale || line.sale.business_date >= start || !reconciliation
      || !["matched", "auto_allocated", "partial"].includes(reconciliation.status)
      || reconciliation.deposit_date < start || reconciliation.deposit_date >= end) continue;
    const id = Number(line.reconciliation_id);
    const previous = priorByReconciliation.get(id);
    priorByReconciliation.set(id, { gross: cardMoney((previous?.gross ?? 0) + Number(line.allocated_gross_amount)), reconciliation });
  }
  const priorMonthCardDeposits = sumCardMoney([...priorByReconciliation.values()].map(({ gross, reconciliation }) => {
    const matchedGross = Number(reconciliation.matched_gross_amount);
    // Matched legacy deposits can be net of fees. Partial deposits only explain
    // the allocated principal; their still-unallocated cash stays in the difference.
    const cashShare = matchedGross > 0 ? Math.min(1, Number(reconciliation.deposit_amount) / matchedGross) : 0;
    return cardMoney(gross * cashShare);
  }));
  return { posSales, priorMonthCardDeposits, monthEndUnsettledCardSales, actualSalesReceipts,
    allocationDifference: cardMoney(actualSalesReceipts - (posSales + priorMonthCardDeposits - monthEndUnsettledCardSales)) };
}
