export type PayableDisplayRow = {
  outstandingAmount: number;
  settlementStatus?: "paid" | "partial" | "unpaid";
  expense: { business_date: string } | null;
};

export function groupPayableRows<T extends PayableDisplayRow>(rows: readonly T[], includePaid = false) {
  const byDate = new Map<string, T[]>();
  for (const row of rows) {
    if (!includePaid && row.outstandingAmount <= 0) continue;
    const date = row.expense?.business_date ?? "";
    byDate.set(date, [...(byDate.get(date) ?? []), row]);
  }
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([businessDate, items]) => ({
      businessDate,
      rows: items,
      total: items.reduce((sum, row) => sum + row.outstandingAmount, 0),
      settlementStatus: items.every(row => row.outstandingAmount <= 0) ? "paid" as const
        : items.some(row => row.outstandingAmount <= 0 || ("paidAmount" in row && Number(row.paidAmount) > 0) || row.settlementStatus === "partial") ? "partial" as const
        : "unpaid" as const,
    }));
}
