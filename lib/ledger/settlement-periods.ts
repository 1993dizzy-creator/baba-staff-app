import { sumPayableAmounts, type PurchaseSettlement } from "./payables.ts";

// Read-only derived view: groups a partner's payables into its settlement periods
// (정산 기준). It never writes due dates, allocations or movements, and a period's
// reference date is a ledger grouping reference -- not an actual payment date and
// not an overdue determination.

export type SettlementPolicyValue = {
  paymentMode: string;
  settlementMode: string | null;
  settlementRule: string | null;
  settlementDays: number[] | null;
  defaultPaymentTermDays: number | null;
};

export type SettlementPeriodPayable = {
  id: number;
  businessDate: string | null;
  originalAmount: number | string;
  settlement: Pick<PurchaseSettlement, "adjustmentAmount" | "cashPaidAmount" | "remainingAmount" | "payments">;
};

export type SettlementPeriod = {
  key: string;
  kind: "period" | "undated";
  start: string | null;
  end: string | null;
  referenceDate: string | null;
  payableCount: number;
  purchaseAmount: number;
  adjustmentAmount: number;
  paidAmount: number;
  remainingAmount: number;
  lastPaymentDate: string | null;
  // as-of position only; never an overdue claim
  // open: as-of date inside the period; settling: period ended, reference date not yet
  // reached; reference_passed: reference date passed with a balance left (not "overdue").
  position: "open" | "settling" | "reference_passed" | "upcoming" | "unknown";
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const toUtc = (date: string) => Date.parse(`${date}T00:00:00Z`);
const fromUtc = (time: number) => new Date(time).toISOString().slice(0, 10);
const addDays = (date: string, days: number) => fromUtc(toUtc(date) + days * 86_400_000);
const lastDayOfMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate(); // month 1-12
const ymd = (year: number, month: number, day: number) => fromUtc(Date.UTC(year, month - 1, day));
const validDate = (value: string | null): value is string => typeof value === "string" && DATE.test(value) && fromUtc(toUtc(value)) === value;

// Monthly cutoffs for one month: 0 and days beyond the month's length are the month end.
function monthCutoffs(days: readonly number[], year: number, month: number) {
  const last = lastDayOfMonth(year, month);
  return [...new Set(days.map(day => (day === 0 || day >= last ? last : day)))].sort((a, b) => a - b);
}

// Returns the settlement period containing businessDate, or null when the policy
// cannot be computed safely from the stored terms alone (ad hoc, net days, unset,
// immediate/unspecified, or missing/invalid days).
export function settlementPeriodFor(policy: SettlementPolicyValue, businessDate: string): { start: string; end: string; referenceDate: string } | null {
  if (!isPeriodPolicy(policy) || !validDate(businessDate)) return null;
  const days = policy.settlementDays!;
  if (policy.settlementRule === "weekly") {
    // Purchases Mon-Sun settle by the first selected weekday after that Sunday.
    const weekday = days[0]; // 1=Mon .. 7=Sun
    const isoDay = ((new Date(toUtc(businessDate)).getUTCDay() + 6) % 7) + 1;
    const start = addDays(businessDate, 1 - isoDay);
    const end = addDays(start, 6);
    return { start, end, referenceDate: addDays(end, weekday) };
  }
  const [year, month, day] = businessDate.split("-").map(Number);
  const cutoffs = monthCutoffs(days, year, month);
  const endDay = cutoffs.find(cutoff => cutoff >= day);
  let end: string, previousCutoff: string;
  if (endDay !== undefined) {
    end = ymd(year, month, endDay);
    const index = cutoffs.indexOf(endDay);
    if (index > 0) previousCutoff = ymd(year, month, cutoffs[index - 1]);
    else {
      const prevYear = month === 1 ? year - 1 : year, prevMonth = month === 1 ? 12 : month - 1;
      const prevCutoffs = monthCutoffs(days, prevYear, prevMonth);
      previousCutoff = ymd(prevYear, prevMonth, prevCutoffs[prevCutoffs.length - 1]);
    }
  } else {
    const nextYear = month === 12 ? year + 1 : year, nextMonth = month === 12 ? 1 : month + 1;
    end = ymd(nextYear, nextMonth, monthCutoffs(days, nextYear, nextMonth)[0]);
    previousCutoff = ymd(year, month, cutoffs[cutoffs.length - 1]);
  }
  return { start: addDays(previousCutoff, 1), end, referenceDate: end };
}

export function isPeriodPolicy(policy: SettlementPolicyValue | null | undefined): policy is SettlementPolicyValue {
  if (!policy || policy.paymentMode !== "postpaid" || policy.settlementMode !== "scheduled") return false;
  const days = policy.settlementDays;
  if (!Array.isArray(days) || !days.every(day => Number.isInteger(day))) return false;
  if (policy.settlementRule === "weekly") return days.length === 1 && days[0] >= 1 && days[0] <= 7;
  if (policy.settlementRule === "monthly_once") return days.length === 1 && days[0] >= 0 && days[0] <= 31;
  if (policy.settlementRule === "monthly_twice") return days.length === 2 && days.every(day => day >= 0 && day <= 31) && days[0] !== days[1];
  return false;
}

// Groups payables by settlement period as of asOfDate. Only periods that still have a
// remaining balance are returned (partially paid periods included); fully settled
// periods are omitted. Undated payables form their own trailing bucket. Returns null
// when the policy is not period based, so callers show the plain list unchanged.
export function buildSettlementPeriods(policy: SettlementPolicyValue | null | undefined, payables: readonly SettlementPeriodPayable[], asOfDate: string): SettlementPeriod[] | null {
  if (!isPeriodPolicy(policy)) return null;
  const buckets = new Map<string, { kind: SettlementPeriod["kind"]; start: string | null; end: string | null; referenceDate: string | null; rows: SettlementPeriodPayable[] }>();
  for (const payable of payables) {
    const period = payable.businessDate ? settlementPeriodFor(policy, payable.businessDate) : null;
    const key = period ? `${period.start}~${period.end}` : "undated";
    const bucket = buckets.get(key) ?? (period ? { kind: "period" as const, ...period, rows: [] } : { kind: "undated" as const, start: null, end: null, referenceDate: null, rows: [] });
    bucket.rows.push(payable);
    buckets.set(key, bucket);
  }
  const periods: SettlementPeriod[] = [];
  for (const [key, bucket] of buckets) {
    const remainingAmount = sumPayableAmounts(bucket.rows.map(row => row.settlement.remainingAmount));
    if (remainingAmount <= 0) continue;
    const paymentDates = bucket.rows.flatMap(row => row.settlement.payments.map(payment => payment.businessDate)).filter(Boolean).sort();
    const position: SettlementPeriod["position"] = bucket.kind === "undated" || !validDate(asOfDate) ? "unknown"
      : asOfDate < bucket.start! ? "upcoming"
      : asOfDate <= bucket.end! ? "open"
      : asOfDate > bucket.referenceDate! ? "reference_passed" : "settling";
    periods.push({
      key, kind: bucket.kind, start: bucket.start, end: bucket.end, referenceDate: bucket.referenceDate,
      payableCount: bucket.rows.length,
      purchaseAmount: sumPayableAmounts(bucket.rows.map(row => row.originalAmount)),
      adjustmentAmount: sumPayableAmounts(bucket.rows.map(row => row.settlement.adjustmentAmount)),
      paidAmount: sumPayableAmounts(bucket.rows.map(row => row.settlement.cashPaidAmount)),
      remainingAmount,
      lastPaymentDate: paymentDates.length ? paymentDates[paymentDates.length - 1] : null,
      position,
    });
  }
  return periods.sort((a, b) => (a.kind === "undated" ? 1 : 0) - (b.kind === "undated" ? 1 : 0) || String(a.start).localeCompare(String(b.start)));
}

export type SettlementDateGroup<G> = {
  key: string;
  kind: "period" | "undated";
  start: string | null;
  end: string | null;
  referenceDate: string | null;
  // First month (YYYY-MM) of a period that starts before the viewed month, e.g. "2026-10".
  carriedFromMonth: string | null;
  payableCount: number;
  remainingAmount: number;
  dates: G[];
};

// Display-only regrouping of the existing per-date groups (selected-date payment list)
// under their settlement periods. Amount and count come from the same buildSettlementPeriods
// result shown in the summary when the period is present there; otherwise the date
// groups' own totals are used. Returns null for non-period terms (the plain list stays).
export function groupDatesBySettlementPeriod<G extends { businessDate: string; total: number; rows: readonly unknown[] }>(
  policy: SettlementPolicyValue | null | undefined,
  dateGroups: readonly G[],
  periods: readonly SettlementPeriod[] | null | undefined,
  viewMonth: string,
): SettlementDateGroup<G>[] | null {
  if (!isPeriodPolicy(policy)) return null;
  const byKey = new Map((periods ?? []).map(period => [period.key, period]));
  const buckets = new Map<string, SettlementDateGroup<G>>();
  const monthStart = `${viewMonth}-01`;
  for (const group of dateGroups) {
    const range = group.businessDate ? settlementPeriodFor(policy, group.businessDate) : null;
    const key = range ? `${range.start}~${range.end}` : "undated";
    const bucket = buckets.get(key) ?? {
      key, kind: range ? "period" as const : "undated" as const,
      start: range?.start ?? null, end: range?.end ?? null, referenceDate: range?.referenceDate ?? null,
      carriedFromMonth: range && /^\d{4}-\d{2}$/.test(viewMonth) && range.start < monthStart ? range.start.slice(0, 7) : null,
      payableCount: 0, remainingAmount: 0, dates: [] as G[],
    };
    bucket.dates.push(group);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].map(bucket => {
    const period = byKey.get(bucket.key);
    return period
      ? { ...bucket, payableCount: period.payableCount, remainingAmount: period.remainingAmount }
      : { ...bucket, payableCount: bucket.dates.reduce((sum, group) => sum + group.rows.length, 0), remainingAmount: sumPayableAmounts(bucket.dates.map(group => group.total)) };
  }).sort((a, b) => (a.kind === "undated" ? 1 : 0) - (b.kind === "undated" ? 1 : 0) || String(a.start).localeCompare(String(b.start)));
}

// Same carry-over rule for the summary rows.
export function settlementCarriedFromMonth(period: Pick<SettlementPeriod, "kind" | "start">, viewMonth: string) {
  return period.kind === "period" && period.start && /^\d{4}-\d{2}$/.test(viewMonth) && period.start < `${viewMonth}-01` ? period.start.slice(0, 7) : null;
}

// Period header checkbox: selects/clears all of that period's dates, leaving every
// other selected date untouched.
export function setDatesSelected(current: ReadonlySet<string>, dates: readonly string[], checked: boolean) {
  const next = new Set(current);
  for (const date of dates) { if (checked) next.add(date); else next.delete(date); }
  return next;
}
export function periodSelectionState(dates: readonly string[], selected: ReadonlySet<string> | undefined): "all" | "some" | "none" {
  const count = dates.filter(date => selected?.has(date)).length;
  return dates.length > 0 && count === dates.length ? "all" : count > 0 ? "some" : "none";
}
