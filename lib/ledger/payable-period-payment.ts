export type PeriodPayableRow = {
  id: number;
  outstandingAmount: number;
  expense: { business_date: string; memo?: string | null; source_snapshot?: Record<string, unknown> | null; display_snapshot?: Record<string, unknown> | null } | null;
};
export type PayablePeriodContext = { month: string; closingOutstanding: number; rows: PeriodPayableRow[] };

// Historical balances are display-only. Allocation amounts always come from
// the live detail API, restricted to items outstanding in the selected period.
export function currentPeriodPayables<T extends { id: number; outstandingAmount: number }>(rows: readonly T[], period?: PayablePeriodContext): T[] {
  if (!period) return [...rows];
  const ids = new Set(period.rows.filter(row => row.outstandingAmount > 0).map(row => Number(row.id)));
  return rows.filter(row => ids.has(Number(row.id)));
}
