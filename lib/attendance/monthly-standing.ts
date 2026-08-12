import type { AttendanceDayFacts } from "@/lib/payroll/types";

export type MonthlyAttendanceStanding = {
  actualWorkDays: number;
  lateCount: number;
  earlyLeaveCount: number;
  unauthorizedAbsenceCount: number;
  blockingCount: number;
  perfectAttendanceCurrent: boolean;
  blockingReasons?: Array<{
    date: string;
    code: "SCHEDULE_OVERLAP" | "MISSING_CHECK_IN" | "MISSING_CHECK_OUT" | "INVALID_TIME_RANGE" | "PENDING_LEAVE_APPROVAL";
  }>;
};

export type MonthlyAttendanceStandingDay = {
  date: string;
  facts: AttendanceDayFacts | null;
  hasSchedule: boolean;
  exempt?: boolean;
  approvedLeave?: boolean;
  completedBusinessDay: boolean;
  blockingReason?: "SCHEDULE_OVERLAP";
};

export function classifyMonthlyAttendanceDay(input: {
  employed: boolean;
  storeClosed: boolean;
  scheduleCount: number;
}) {
  if (!input.employed || input.storeClosed || input.scheduleCount === 0) {
    return { exempt: true, hasSchedule: false, blockingReason: undefined } as const;
  }
  if (input.scheduleCount === 1) {
    return { exempt: false, hasSchedule: true, blockingReason: undefined } as const;
  }
  return { exempt: false, hasSchedule: true, blockingReason: "SCHEDULE_OVERLAP" } as const;
}

export function resolveAttendanceStoreClosed(input: {
  weeklyStoreClosed: boolean;
  babaPremiumHoliday: boolean;
}) {
  return input.weeklyStoreClosed && !input.babaPremiumHoliday;
}

export function evaluateMonthlyAttendanceStanding(input: {
  attendanceTrackingEnabled: boolean;
  days: readonly MonthlyAttendanceStandingDay[];
}): MonthlyAttendanceStanding {
  const seenWorkedDates = new Set<string>();
  let lateCount = 0;
  let earlyLeaveCount = 0;
  let unauthorizedAbsenceCount = 0;
  type BlockingReason = NonNullable<MonthlyAttendanceStanding["blockingReasons"]>[number];
  const blockingByDate = new Map<string, BlockingReason>();

  for (const day of input.days) {
    if (day.exempt || !day.hasSchedule) continue;
    if (day.completedBusinessDay && day.blockingReason) {
      blockingByDate.set(day.date, { date: day.date, code: day.blockingReason });
    }
    if (day.approvedLeave) continue;
    const facts = day.facts;
    if (!facts) {
      if (day.completedBusinessDay && !blockingByDate.has(day.date)) blockingByDate.set(day.date, { date: day.date, code: "MISSING_CHECK_IN" });
      continue;
    }
    if (facts.lateMinutes > 0) lateCount += 1;
    if (facts.earlyLeaveMinutes > 0) earlyLeaveCount += 1;
    if (facts.attendanceStatus === "unauthorized_absence") unauthorizedAbsenceCount += 1;
    const worked = facts.actualMinutes !== null && facts.actualMinutes > 0 &&
      facts.attendanceStatus !== "leave" && facts.attendanceStatus !== "unresolved";
    if (worked) seenWorkedDates.add(day.date);
    const blockingWarnings = new Set([
      "MISSING_CHECK_IN",
      "MISSING_CHECK_OUT",
      "INVALID_TIME_RANGE",
      "PENDING_LEAVE_APPROVAL",
    ]);
    const blockingWarning = facts.warningCodes.find((code) => blockingWarnings.has(code));
    if (day.completedBusinessDay && blockingWarning && !blockingByDate.has(day.date)) {
      blockingByDate.set(day.date, {
        date: day.date,
        code: blockingWarning as BlockingReason["code"],
      });
    }
  }

  const actualWorkDays = seenWorkedDates.size;
  const blockingReasons = [...blockingByDate.values()];
  const blockingCount = blockingReasons.length;
  return {
    actualWorkDays,
    lateCount,
    earlyLeaveCount,
    unauthorizedAbsenceCount,
    blockingCount,
    perfectAttendanceCurrent: input.attendanceTrackingEnabled && actualWorkDays >= 1 &&
      lateCount === 0 && earlyLeaveCount === 0 && unauthorizedAbsenceCount === 0 && blockingCount === 0,
    blockingReasons,
  };
}
