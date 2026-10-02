export type PayableDisplayRow = {
  outstandingAmount: number;
  settlementStatus?: "paid" | "partial" | "unpaid";
  expense: { business_date: string } | null;
};

// A payable row is settled (결제완료) once nothing remains outstanding.
export function isPayableRowSettled(row: Pick<PayableDisplayRow, "outstandingAmount">) {
  return row.outstandingAmount <= 0;
}

export function groupPayableRows<T extends PayableDisplayRow>(rows: readonly T[], includePaid = false) {
  const byDate = new Map<string, T[]>();
  for (const row of rows) {
    if (!includePaid && isPayableRowSettled(row)) continue;
    const date = row.expense?.business_date ?? "";
    byDate.set(date, [...(byDate.get(date) ?? []), row]);
  }
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([businessDate, items]) => ({
      businessDate,
      rows: items,
      total: items.reduce((sum, row) => sum + row.outstandingAmount, 0),
      settlementStatus: items.every(isPayableRowSettled) ? "paid" as const
        : items.some(row => isPayableRowSettled(row) || ("paidAmount" in row && Number(row.paidAmount) > 0) || row.settlementStatus === "partial") ? "partial" as const
        : "unpaid" as const,
    }));
}

// Display-only month buckets (YYYY-MM of each row's own business_date), oldest
// first like the date rows inside them. Rows are passed through untouched; date
// grouping stays in groupPayableRows.
export function groupPayableRowsByMonth<T extends PayableDisplayRow & { id: number | string }>(rows: readonly T[]) {
  const byMonth = new Map<string, T[]>();
  for (const row of rows) {
    const month = (row.expense?.business_date ?? "").slice(0, 7);
    byMonth.set(month, [...(byMonth.get(month) ?? []), row]);
  }
  // Rows without a business date sort last.
  return [...byMonth.entries()]
    .sort(([a], [b]) => (a === "") === (b === "") ? a.localeCompare(b) : a === "" ? 1 : -1)
    .map(([month, items]) => ({ month, rows: items, unpaidCount: countUnsettledPayables(items) }));
}

// Newest dated month among the groups (the one opened by default).
export function latestPayableMonth(groups: readonly { month: string }[]) {
  return groups.filter(group => group.month).at(-1)?.month ?? groups[0]?.month;
}

// Payables (unique ids) that still have a remaining balance: unpaid or partially
// paid. Uses the same settled test as the date rows' 결제완료 badge.
export function countUnsettledPayables(rows: readonly (PayableDisplayRow & { id: number | string })[]) {
  return new Set(rows.filter(row => !isPayableRowSettled(row)).map(row => String(row.id))).size;
}
