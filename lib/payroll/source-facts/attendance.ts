import type { AttendanceDayFacts, WorkScheduleVersion } from "../types";

export type PayrollAttendanceSourceClassification =
  | "completed_work"
  | "leave"
  | "unauthorized_absence"
  | "working"
  | "unresolved"
  | "no_record";

export type PayrollAttendanceSourceFact = {
  businessDate: string;
  attendanceRecordId: number | null;
  classification: PayrollAttendanceSourceClassification;
  recognizedAttendanceDay: boolean;
  attendanceStatus: AttendanceDayFacts["attendanceStatus"];
  approvalStatus: string | null;
  checkInAt: string | null;
  checkOutAt: string | null;
  sourceUpdatedAt: string | null;
  actualMinutes: number | null;
  scheduledMinutes: number | null;
  scheduledOverlapMinutes: number | null;
  lateMinutes: number;
  // rawLateMinutes/effectiveLateMinutes: 수동 지각 정상화로 attendance_records.late_minutes가 0으로
  // 덮인 뒤에도 원래 지각시간을 APP↔T8 교차검증에서 확인할 수 있도록 원천 값을 보존한다.
  rawLateMinutes: number;
  effectiveLateMinutes: number;
  lateThresholdMinutes: number;
  earlyLeaveMinutes: number;
  earlyLeaveThresholdMinutes: number;
  manualLateNormalized: boolean;
  leaveApproved: boolean;
  unauthorizedAbsence: boolean;
  schedule: {
    id: number;
    revision: number;
    startTime: string;
    endTime: string;
    unpaidBreakMinutes: number;
  } | null;
  storePolicyRevision: number | null;
  warningCodes: string[];
};

export function classifyPayrollAttendanceSource(input: {
  businessDate: string;
  facts: AttendanceDayFacts;
  attendanceRecord: {
    id: number;
    status: string;
    checkInAt: string | null;
    checkOutAt: string | null;
    approvalStatus: string | null;
    updatedAt: string | null;
  } | null;
  schedule: WorkScheduleVersion | null;
  storePolicyRevision: number | null;
}): PayrollAttendanceSourceFact {
  const { attendanceRecord: record, facts } = input;
  const leave = record?.status === "leave";
  const unauthorizedAbsence = record?.status === "unauthorized_absence";
  const blockingAttendance = facts.warningCodes.some((code) =>
    ["MISSING_CHECK_IN", "MISSING_CHECK_OUT", "INVALID_TIME_RANGE", "PENDING_LEAVE_APPROVAL"].includes(code),
  );
  const classification: PayrollAttendanceSourceClassification = !record
    ? "no_record"
    : leave
      ? "leave"
      : unauthorizedAbsence
        ? "unauthorized_absence"
        : record.checkInAt && !record.checkOutAt
          ? "working"
          : blockingAttendance || facts.actualMinutes === null
            ? "unresolved"
            : "completed_work";

  return {
    businessDate: input.businessDate,
    attendanceRecordId: record?.id ?? null,
    classification,
    recognizedAttendanceDay: classification === "completed_work",
    attendanceStatus: facts.attendanceStatus,
    approvalStatus: record?.approvalStatus ?? null,
    checkInAt: record?.checkInAt ?? null,
    checkOutAt: record?.checkOutAt ?? null,
    sourceUpdatedAt: record?.updatedAt ?? null,
    actualMinutes: facts.actualMinutes,
    scheduledMinutes: facts.scheduledMinutes,
    scheduledOverlapMinutes: facts.scheduledOverlapMinutes,
    lateMinutes: facts.lateMinutes,
    rawLateMinutes: facts.rawLateMinutes,
    effectiveLateMinutes: facts.effectiveLateMinutes,
    lateThresholdMinutes: facts.lateThresholdMinutes,
    earlyLeaveMinutes: facts.earlyLeaveMinutes,
    earlyLeaveThresholdMinutes: facts.earlyLeaveThresholdMinutes,
    manualLateNormalized: facts.manualLateNormalized,
    leaveApproved: leave && record?.approvalStatus === "approved",
    unauthorizedAbsence,
    schedule: input.schedule ? {
      id: input.schedule.id,
      revision: input.schedule.revision,
      startTime: input.schedule.startTime,
      endTime: input.schedule.endTime,
      unpaidBreakMinutes: input.schedule.unpaidBreakMinutes,
    } : null,
    storePolicyRevision: input.storePolicyRevision,
    warningCodes: [...facts.warningCodes],
  };
}
