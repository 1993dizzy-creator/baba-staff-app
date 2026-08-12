import type { MonthlyAttendanceStanding } from "@/lib/attendance/monthly-standing";

export type AttendanceBonusPolicyVersion = {
  id: number;
  effectiveMonth: string;
  minimumActualWorkdays: number;
  allowedLateCount: number;
  allowedEarlyLeaveCount: number;
  bonusAmount: number;
  revision: number;
};

export type AttendanceBonusEligibilityVersion = {
  id: number;
  userId: number;
  isEligible: boolean;
  effectiveMonth: string;
  revision: number;
};

export function selectAttendanceBonusPolicyAt(
  versions: readonly AttendanceBonusPolicyVersion[], month: string,
) {
  return [...versions].filter((row) => row.effectiveMonth <= month)
    .sort((a, b) => b.effectiveMonth.localeCompare(a.effectiveMonth) || b.revision - a.revision)[0] ?? null;
}

export function selectAttendanceBonusEligibilityAt(
  versions: readonly AttendanceBonusEligibilityVersion[], month: string,
) {
  return [...versions].filter((row) => row.effectiveMonth <= month)
    .sort((a, b) => b.effectiveMonth.localeCompare(a.effectiveMonth) || b.revision - a.revision)[0] ?? null;
}

export function qualifiesForAttendanceBonus(input: {
  monthClosed: boolean;
  attendanceTrackingEnabled: boolean;
  policy: AttendanceBonusPolicyVersion | null;
  eligibility: AttendanceBonusEligibilityVersion | null;
  standing: MonthlyAttendanceStanding;
}) {
  const { policy, eligibility, standing } = input;
  return Boolean(input.monthClosed && input.attendanceTrackingEnabled && policy &&
    eligibility?.isEligible === true && standing.actualWorkDays >= policy.minimumActualWorkdays &&
    standing.lateCount <= policy.allowedLateCount &&
    standing.earlyLeaveCount <= policy.allowedEarlyLeaveCount &&
    standing.unauthorizedAbsenceCount === 0 && standing.blockingCount === 0);
}
