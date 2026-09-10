// @ts-expect-error Node's test runner requires the explicit TypeScript extension.
import { PAYROLL_AUTOMATION_START_DATE, PAYROLL_FACTS_ENGINE_VERSION, type AttendanceDayFacts, type PayrollWarningCode, type WorkScheduleVersion } from "./types.ts";

const OFFSET = "+07:00";

type RecordInput = {
  id: number;
  status: string;
  checkInAt: string | null;
  checkOutAt: string | null;
  approvalStatus: string | null;
  storedLateMinutes?: number | null;
  storedEarlyLeaveMinutes?: number | null;
  storedWorkMinutes?: number | null;
};

function addDay(date: string) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function atTime(date: string, time: string, cutoff = "03:00") {
  const next = time < cutoff;
  return new Date(`${next ? addDay(date) : date}T${time}:00${OFFSET}`).getTime();
}

function minutes(start: number, end: number) {
  return Math.max(0, Math.floor((end - start) / 60_000));
}

export function normalizeAttendanceDayFacts(input: {
  userId: number;
  businessDate: string;
  attendanceRecord: RecordInput | null;
  schedule: WorkScheduleVersion | null;
  hireDate?: string | null;
  storeSettingsRevision?: number | null;
  lateGraceMinutes?: number;
  earlyLeaveGraceMinutes?: number;
  manualLateNormalized?: boolean;
}): AttendanceDayFacts {
  const warnings: PayrollWarningCode[] = [];
  const record = input.attendanceRecord;
  if (input.hireDate && input.businessDate < input.hireDate) warnings.push("BEFORE_HIRE_DATE");
  if (!input.schedule || input.businessDate < PAYROLL_AUTOMATION_START_DATE) {
    warnings.push("SCHEDULE_HISTORY_UNAVAILABLE");
  }

  const scheduledStart = input.schedule ? atTime(input.businessDate, input.schedule.startTime) : null;
  const scheduledEnd = input.schedule ? atTime(input.businessDate, input.schedule.endTime) : null;
  const scheduledMinutes = scheduledStart !== null && scheduledEnd !== null
    ? Math.max(0, minutes(scheduledStart, scheduledEnd) - (input.schedule?.unpaidBreakMinutes ?? 0))
    : null;

  let actualMinutes: number | null = null;
  let overlap: number | null = null;
  let overtime = 0;
  let late = 0;
  let early = 0;
  let rawEarly = 0;
  let rawLateMinutes = 0;
  let effectiveLate = 0;
  const lateThresholdMinutes = input.lateGraceMinutes ?? 0;

  if (record?.checkInAt && record.checkOutAt) {
    const actualStart = new Date(record.checkInAt).getTime();
    const actualEnd = new Date(record.checkOutAt).getTime();
    if (!Number.isFinite(actualStart) || !Number.isFinite(actualEnd) || actualEnd <= actualStart) {
      warnings.push("INVALID_TIME_RANGE");
    } else {
      actualMinutes = minutes(actualStart, actualEnd);
      if (scheduledStart !== null && scheduledEnd !== null) {
        overlap = Math.max(0, minutes(Math.max(actualStart, scheduledStart), Math.min(actualEnd, scheduledEnd)) - (input.schedule?.unpaidBreakMinutes ?? 0));
        rawLateMinutes = minutes(scheduledStart, Math.min(actualStart, scheduledEnd));
        rawEarly = minutes(Math.max(actualEnd, scheduledStart), scheduledEnd);
        // 정책 grace 적용 후 실제 지각분 — 급여 지각 패널티 산정 기준(정상화 여부와 무관).
        effectiveLate = rawLateMinutes > lateThresholdMinutes ? rawLateMinutes : 0;
        // 표시/개근 판정용 late — 수동 지각 정상화 시 0으로 덮어쓴다(기존 의미 유지).
        late = input.manualLateNormalized ? 0 : effectiveLate;
        // 조퇴 유예는 threshold가 아니라 공제되는 허용 시간이다(정책 엔진과 동일한 의미).
        early = Math.max(0, rawEarly - (input.earlyLeaveGraceMinutes ?? 0));
        overtime = minutes(actualStart, Math.min(actualEnd, scheduledStart)) + minutes(Math.max(actualStart, scheduledEnd), actualEnd);
      }
    }
  } else if (record?.status === "unauthorized_absence") {
    actualMinutes = 0;
    overlap = 0;
  } else if (record?.checkInAt) {
    warnings.push("MISSING_CHECK_OUT");
  } else if ((record && record.status !== "leave") || (!record && input.schedule)) {
    warnings.push("MISSING_CHECK_IN");
  }

  if (record?.status === "leave") {
    if (record.approvalStatus !== "approved") warnings.push("PENDING_LEAVE_APPROVAL");
    else warnings.push("LEAVE_PAYROLL_TREATMENT_UNSPECIFIED");
  }

  const attendanceStatus: AttendanceDayFacts["attendanceStatus"] = !record
    ? "no_record"
    : record.status === "unauthorized_absence"
      ? "unauthorized_absence"
    : record.status === "leave"
      ? "leave"
      : record.checkInAt && !record.checkOutAt
        ? "unresolved"
        : late > 0 && early > 0
          ? "late_and_early_leave"
          : early > 0
            ? "early_leave"
            : late > 0
              ? "late"
              : record.checkOutAt
                ? "done"
                : "working";

  const excluded = warnings.includes("BEFORE_HIRE_DATE");
  if (record) {
    if (record.status !== attendanceStatus) warnings.push("STORED_STATUS_POLICY_MISMATCH");
    if (record.storedLateMinutes !== undefined && Number(record.storedLateMinutes || 0) !== late) warnings.push("STORED_LATE_MINUTES_MISMATCH");
    if (record.storedEarlyLeaveMinutes !== undefined && Number(record.storedEarlyLeaveMinutes || 0) !== early) warnings.push("STORED_EARLY_LEAVE_MINUTES_MISMATCH");
    if (actualMinutes !== null && record.storedWorkMinutes !== undefined && Number(record.storedWorkMinutes || 0) !== actualMinutes) warnings.push("STORED_WORK_MINUTES_MISMATCH");
  }
  const review = warnings.length > 0;
  return {
    userId: input.userId,
    businessDate: input.businessDate,
    scheduledMinutes,
    actualMinutes,
    scheduledOverlapMinutes: overlap,
    manualLateNormalized: input.manualLateNormalized === true,
    lateMinutes: late,
    rawLateMinutes,
    effectiveLateMinutes: effectiveLate,
    lateThresholdMinutes,
    earlyLeaveMinutes: early,
    rawEarlyLeaveMinutes: rawEarly,
    earlyLeaveThresholdMinutes: input.earlyLeaveGraceMinutes ?? 0,
    isEarlyLeave: early > 0,
    overtimeCandidateMinutes: overtime,
    attendanceStatus,
    payrollStatus: excluded ? "excluded" : warnings.includes("PENDING_LEAVE_APPROVAL") ? "pending" : review ? "requires_review" : "calculable",
    warningCodes: [...new Set(warnings)],
    stored: {
      status: record?.status ?? null,
      lateMinutes: record?.storedLateMinutes ?? null,
      earlyLeaveMinutes: record?.storedEarlyLeaveMinutes ?? null,
      workMinutes: record?.storedWorkMinutes ?? null,
    },
    source: {
      attendanceRecordId: record?.id ?? null,
      scheduleVersionId: input.schedule?.id ?? null,
      scheduleRevision: input.schedule?.revision ?? null,
      storeSettingsRevision: input.storeSettingsRevision ?? null,
      engineVersion: PAYROLL_FACTS_ENGINE_VERSION,
    },
  };
}
