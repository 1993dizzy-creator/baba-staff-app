export type MonthCloseCardReconciliation = {
  id: number | string;
  status: string;
  deposit_amount: number | string;
  matched_gross_amount: number | string;
  difference_amount: number | string;
};

type LineReconciliation = {
  deposit_date: string;
  status: string;
};

export type MonthCloseCardLine = {
  pos_card_transaction_id: number | string;
  allocated_gross_amount: number | string;
  reconciliation: LineReconciliation | LineReconciliation[] | null;
};

export type MonthCloseCardSale = {
  id: number;
  amount: number | string;
};

function lineReconciliation(line: MonthCloseCardLine) {
  return Array.isArray(line.reconciliation) ? line.reconciliation[0] : line.reconciliation;
}

export function calculateMonthCloseCardSnapshot(
  cards: readonly MonthCloseCardReconciliation[],
  cardLines: readonly MonthCloseCardLine[],
  cardSales: readonly MonthCloseCardSale[],
  endExclusive: string
) {
  const matched = cards.filter(row => row.status === "matched");
  const eligibleLines = cardLines.filter(line => {
    const reconciliation = lineReconciliation(line);
    return reconciliation?.status === "matched" && reconciliation.deposit_date < endExclusive;
  });
  const allocatedBySale = new Map<number, number>();
  for (const line of eligibleLines) {
    const saleId = Number(line.pos_card_transaction_id);
    allocatedBySale.set(saleId, (allocatedBySale.get(saleId) ?? 0) + Number(line.allocated_gross_amount));
  }
  const matchedIds = new Set(matched.map(row => Number(row.id)));

  return {
    unsettledGross: cardSales.reduce(
      (sum, row) => sum + Math.max(0, Number(row.amount) - (allocatedBySale.get(row.id) ?? 0)),
      0
    ),
    unmatchedDeposits: cards
      .filter(row => row.status !== "cancelled" && !matchedIds.has(Number(row.id)))
      .reduce((sum, row) => sum + Number(row.deposit_amount), 0),
    completedGross: matched.reduce((sum, row) => sum + Number(row.matched_gross_amount), 0),
    settlementDifference: matched.reduce((sum, row) => sum + Number(row.difference_amount), 0),
  };
}
