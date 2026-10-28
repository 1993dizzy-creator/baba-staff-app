// Pure helpers for the recurring reserve allocation feature. These mirror the SQL
// in ledger_generate_reserve_schedule_v2 / ledger_confirm_reserve_schedule_v2 so the
// UI can preview the same numbers the RPCs will produce.

export type ReserveRecurringRule = {
  monthlyAmount: number;
  recurringDay: number;
  startMonth: string; // YYYY-MM-01
  endMonth: string | null; // YYYY-MM-01 or null
  autoGenerate: boolean;
};

const monthKey = (isoMonth: string) => isoMonth.slice(0, 7);

// scheduled_month >= start_month AND (end_month is null OR scheduled_month <= end_month).
// Target-reached is checked separately (it stops generation regardless of the window).
export function isReserveRecurringActiveForMonth(
  rule: Pick<ReserveRecurringRule, "startMonth" | "endMonth">,
  scheduledMonth: string,
) {
  const month = monthKey(scheduledMonth);
  if (month < monthKey(rule.startMonth)) return false;
  if (rule.endMonth != null && month > monthKey(rule.endMonth)) return false;
  return true;
}

export type ReserveOffsetEntry = {
  id: number;
  entry_type: string;
  amount: number | string;
  occurred_at: string;
  allocation_kind?: string | null;
};

// Business month (03:00 Asia/Ho_Chi_Minh cut-off) of a timestamp, as YYYY-MM.
export function reserveBusinessMonth(occurredAt: string) {
  return new Date(Date.parse(occurredAt) + 4 * 3_600_000).toISOString().slice(0, 7);
}

// "Manual this month" for the v2 RPCs: only legacy (v1) unlinked allocate rows of that
// month. v2 extra/restore never offset the recurring amount, so 60M + extra both count.
export function reserveManualOffset(entries: readonly ReserveOffsetEntry[], scheduledMonth: string, scheduleLinkedEntryIds: ReadonlySet<number>) {
  return entries
    .filter(entry => entry.entry_type === "allocate" && entry.allocation_kind == null
      && !scheduleLinkedEntryIds.has(entry.id) && reserveBusinessMonth(entry.occurred_at) === monthKey(scheduledMonth))
    .reduce((sum, entry) => sum + Number(entry.amount), 0);
}

// monthly amount, minus what was already put aside manually this month, capped so the
// plan never overshoots its target. Never negative.
export function reservePlannedRecurringAmount(input: {
  monthlyAmount: number;
  manualThisMonth: number;
  targetAmount: number;
  currentReserved: number;
}) {
  const monthlyRoom = input.monthlyAmount - input.manualThisMonth;
  const targetRoom = input.targetAmount - input.currentReserved;
  return Math.max(0, Math.min(monthlyRoom, targetRoom));
}

export function reserveTargetReached(targetAmount: number, currentReserved: number) {
  return currentReserved >= targetAmount;
}

// Model of ledger_generate_reserve_schedule_v1's per-plan decision, so the two stay in
// sync and can be tested without a database. `requireAutoGenerate` is true for the daily
// cron and false for the manual owner/master trigger.
export type ReserveScheduleGenerateInput = {
  requireAutoGenerate: boolean;
  planActive: boolean;
  hasRecurringRule: boolean;
  autoGenerate: boolean;
  startMonth: string;
  endMonth: string | null;
  scheduledMonth: string; // YYYY-MM-01
  today: string; // YYYY-MM-DD (Asia/Ho_Chi_Minh, ledger business date)
  recurringDay: number;
  currentReserved: number;
  targetAmount: number;
  liveOccurrenceExists: boolean; // a non-superseded row already exists for plan+month
};

export function shouldGenerateReserveSchedule(input: ReserveScheduleGenerateInput): {
  generate: boolean;
  reason: string;
} {
  // Plan-selection filters (WHERE clause in SQL).
  if (!input.planActive) return { generate: false, reason: "plan_inactive" };
  if (!input.hasRecurringRule) return { generate: false, reason: "no_rule" };
  if (input.requireAutoGenerate && !input.autoGenerate) return { generate: false, reason: "auto_generate_off" };
  if (!isReserveRecurringActiveForMonth(input, input.scheduledMonth)) return { generate: false, reason: "out_of_window" };
  // Per-plan checks inside the loop.
  if (
    input.requireAutoGenerate &&
    monthKey(input.scheduledMonth) === monthKey(input.today) &&
    Number(input.today.slice(8, 10)) < input.recurringDay
  ) {
    return { generate: false, reason: "not_due" };
  }
  if (input.liveOccurrenceExists) return { generate: false, reason: "already_exists" };
  if (reserveTargetReached(input.targetAmount, input.currentReserved)) return { generate: false, reason: "target_reached" };
  return { generate: true, reason: "ok" };
}

export const RESERVE_SCHEDULE_STATUS_LABELS: Record<string, string> = {
  pending: "확정 대기",
  confirmed: "확정됨",
  skipped: "건너뜀",
  superseded: "대체됨",
};
