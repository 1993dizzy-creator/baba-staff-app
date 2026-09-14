// DB numeric(16,3)-safe summation via integer thousandths (same technique as
// lib/ledger/payables.ts's sumPayableAmounts / lib/ledger/owner-allocation-core.ts's
// milli/decimal). Kept local rather than imported so this file stays import-free
// and directly require()-able from tests, matching the existing convention for the
// other pure ledger calculators.
function amountUnits(value: number | string): bigint {
  const [whole, fraction = ""] = String(value).split(".");
  return BigInt(whole) * BigInt(1000) + BigInt(fraction.padEnd(3, "0").slice(0, 3)) * (whole.startsWith("-") ? BigInt(-1) : BigInt(1));
}
const amountValue = (units: bigint) => Number(units) / 1000;
function sumInvestmentAmounts(values: readonly (number | string)[]) {
  return amountValue(values.reduce<bigint>((sum, value) => sum + amountUnits(value), BigInt(0)));
}

export const OWNER_INVESTMENT_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// Same 03:00 Asia/Ho_Chi_Minh business-day cutoff ledger_create_owner_investment_v1
// uses to turn occurred_at into business_date
// (v_date:=((p_occurred_at at time zone'Asia/Ho_Chi_Minh')-interval'3 hours')::date),
// expressed as a fixed +07:00 instant boundary — the same pattern buildMonthCloseSnapshot
// already uses for its month-end cutoff (`endAt = \`${endExclusive}T03:00:00+07:00\``).
// Comparing occurred_at against these two instants reproduces business-date month
// bucketing exactly, without recomputing business_date per row.
export function ownerInvestmentMonthBounds(month: string) {
  if (!OWNER_INVESTMENT_MONTH.test(month)) throw new Error("INVALID_MONTH");
  const [year, value] = month.split("-").map(Number);
  const nextYear = value === 12 ? year + 1 : year;
  const nextValue = value === 12 ? 1 : value + 1;
  const nextMonth = `${String(nextYear).padStart(4, "0")}-${String(nextValue).padStart(2, "0")}`;
  return {
    monthStartAt: `${month}-01T03:00:00+07:00`,
    nextMonthStartAt: `${nextMonth}-01T03:00:00+07:00`,
  };
}

// Mirrors lib/ledger/owners.ts's own selected-month effective-participant
// contract exactly — the same rule (effective_from<=monthDate,
// effective_to is null or >=monthDate, is_eligible=true), not a new one, just
// expressed in JS (instead of a SQL .lte/.or/.eq chain) so it is directly unit
// testable from this pure, DB-free file. "configured" for a month means: was an
// eligible participant actually effective during that month, not merely whether
// a participant row exists somewhere in time.
export type OwnerParticipantEligibility = {
  is_eligible: boolean;
  effective_from: string; // YYYY-MM-DD
  effective_to: string | null; // YYYY-MM-DD | null
};
export function isParticipantEffectiveForMonth(participant: OwnerParticipantEligibility, month: string): boolean {
  const monthDate = `${month}-01`;
  return (
    participant.is_eligible &&
    participant.effective_from <= monthDate &&
    (participant.effective_to == null || participant.effective_to >= monthDate)
  );
}

export type OwnerInvestmentEntryType = "opening" | "contribution" | "adjustment";

// Minimal shape the pure calculator needs. A DB row (with extra columns like
// transaction_id/reason/source_snapshot) structurally satisfies this too, so the
// server-only loader (lib/ledger/investments-server.ts) can pass its full rows
// straight through and get them back via `periodRows` without re-fetching or
// re-shaping anything.
export type OwnerInvestmentRow = {
  id: number;
  participant_id: number;
  entry_type: OwnerInvestmentEntryType;
  signed_amount: number | string;
  occurred_at: string;
};

export type OwnerInvestmentSummary = {
  openingCumulative: number;
  periodOpening: number;
  periodContribution: number;
  periodAdjustment: number;
  periodNetChange: number;
  closingCumulative: number;
};

export const ZERO_OWNER_INVESTMENT_SUMMARY: OwnerInvestmentSummary = {
  openingCumulative: 0,
  periodOpening: 0,
  periodContribution: 0,
  periodAdjustment: 0,
  periodNetChange: 0,
  closingCumulative: 0,
};

// Pure and DB-free so month-boundary / 03:00-cutoff / entry-type bucketing behavior
// is directly unit testable. `rows` may carry any history (any month, in any order) —
// this buckets everything itself by comparing occurred_at against the month bounds,
// so a later month's rows never leak into an earlier month's cumulative or period.
export function summarizeOwnerInvestments<T extends OwnerInvestmentRow>(
  rows: readonly T[],
  month: string,
): { summary: OwnerInvestmentSummary; periodRows: T[] } {
  const { monthStartAt, nextMonthStartAt } = ownerInvestmentMonthBounds(month);
  const startMs = Date.parse(monthStartAt);
  const nextStartMs = Date.parse(nextMonthStartAt);
  const before: (number | string)[] = [];
  const periodAll: (number | string)[] = [];
  const periodOpening: (number | string)[] = [];
  const periodContribution: (number | string)[] = [];
  const periodAdjustment: (number | string)[] = [];
  const periodRows: T[] = [];
  for (const row of rows) {
    const occurredMs = Date.parse(row.occurred_at);
    if (!Number.isFinite(occurredMs) || occurredMs >= nextStartMs) continue; // future-month rows: excluded from both opening and this period
    if (occurredMs < startMs) {
      before.push(row.signed_amount);
      continue;
    }
    periodAll.push(row.signed_amount);
    periodRows.push(row);
    if (row.entry_type === "opening") periodOpening.push(row.signed_amount);
    else if (row.entry_type === "contribution") periodContribution.push(row.signed_amount);
    else periodAdjustment.push(row.signed_amount);
  }
  periodRows.sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a.id - b.id);
  return {
    summary: {
      openingCumulative: sumInvestmentAmounts(before),
      periodOpening: sumInvestmentAmounts(periodOpening),
      periodContribution: sumInvestmentAmounts(periodContribution),
      periodAdjustment: sumInvestmentAmounts(periodAdjustment),
      periodNetChange: sumInvestmentAmounts(periodAll),
      // One combined bigint pass over (before + periodAll), not
      // openingCumulative + periodNetChange as two separately-computed numbers —
      // so "closing === opening + net change" holds exactly, by construction.
      closingCumulative: sumInvestmentAmounts([...before, ...periodAll]),
    },
    periodRows,
  };
}

export type OwnerInvestmentEvent = {
  investmentId: number;
  participantId: number;
  participantName: string;
  entryType: OwnerInvestmentEntryType;
  amount: number;
  businessDate: string;
  occurredAt: string;
  fundAccountId: number | null;
  fundAccountName: string | null;
  reason: string | null;
};

export type OwnerInvestmentMonthData = {
  month: string;
  configured: boolean;
  summary: OwnerInvestmentSummary;
  events: OwnerInvestmentEvent[];
};
