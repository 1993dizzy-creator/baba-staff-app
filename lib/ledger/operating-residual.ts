// @ts-expect-error Node's test runner requires the explicit TypeScript extension.
import { reserveBusinessMonth } from "./reserve-recurring.ts";

// 운영상 잔여이익 (operating residual after reserve): a management view, NOT accounting
// profit and NOT cash. Rent paid a year in advance is still an accrual expense of 50M a
// month in operating profit; this view adds that month's rent recognition back and
// subtracts what was actually set aside that month for the next lease instead:
//
//   residual = operating profit + rent recognized this month − new reserve this month
//
// New reserve = allocate entries attributed to the month, except a restore (money put
// back after a release is not a new reservation). Releases and restores never add back.
// Closed months keep their figures: v2 entries are always attributed to the open month
// they were booked in, and the close snapshot's operating profit is used for closed months.

export type ResidualReserveEntry = {
  entry_type: string;
  amount: number | string;
  occurred_at: string;
  allocation_kind?: string | null;
  attribution_month?: string | null;
};

export type ResidualRentRecognition = {
  recognition_month: string;
  amount: number | string;
  economic_effect_sign?: number | string | null;
};

// v2 rows carry attribution_month; v1 rows fall back to the business month of occurred_at.
export function reserveAttributionMonth(entry: Pick<ResidualReserveEntry, "occurred_at" | "attribution_month">) {
  return entry.attribution_month ? entry.attribution_month.slice(0, 7) : reserveBusinessMonth(entry.occurred_at);
}

export function isNewReserveAllocation(entry: Pick<ResidualReserveEntry, "entry_type" | "allocation_kind">) {
  return entry.entry_type === "allocate" && entry.allocation_kind !== "restore";
}

export function monthNewReserve(entries: readonly ResidualReserveEntry[], month: string) {
  return entries
    .filter(entry => isNewReserveAllocation(entry) && reserveAttributionMonth(entry) === month)
    .reduce((sum, entry) => sum + Number(entry.amount), 0);
}

export function monthRentRecognized(rows: readonly ResidualRentRecognition[], month: string) {
  return rows
    .filter(row => row.recognition_month.slice(0, 7) === month)
    .reduce((sum, row) => sum + Number(row.amount) * Number(row.economic_effect_sign ?? 1), 0);
}

export function calculateOperatingResidual(input: { operatingProfit: number | null; rentRecognized: number; newReserve: number }) {
  if (input.operatingProfit === null || !Number.isFinite(input.operatingProfit)) return null;
  // Round to the ledger's 3 decimals so 70,507,820.4 + 50M − 60M stays exact.
  const residual = Math.round((input.operatingProfit + input.rentRecognized - input.newReserve) * 1000) / 1000;
  return { operatingProfit: input.operatingProfit, rentRecognized: input.rentRecognized, newReserve: input.newReserve, residual };
}
