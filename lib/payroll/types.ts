export const PAYROLL_AUTOMATION_START_DATE = "2026-07-01";
// v2 (2026-09): rawLateMinutes / effectiveLateMinutes / lateThresholdMinutes 추가.
// effectiveLateMinutes는 수동 지각 정상화와 무관하게 정책 grace 적용 후 실제 지각분을 담는다.
export const PAYROLL_FACTS_ENGINE_VERSION = "attendance-facts-v2";
export const PAYROLL_PROJECTION_ENGINE_VERSION = "payroll-projection-v1";

export type PayType = "monthly" | "daily" | "hourly";
export type CalculationBasis = "minute" | "hour" | "fixed_monthly";
export type RoundingMode = "none" | "floor" | "ceil" | "nearest";
export type AdjustmentMode = "separate" | "deduct_minutes" | "ignore";
export type OvertimeMode = "requires_approval" | "ignore";
export type PaidLeaveMode = "manual_review" | "paid" | "unpaid";
export type PayrollStatus = "calculable" | "excluded" | "pending" | "requires_review";

export type PayrollWarningCode =
  | "SCHEDULE_HISTORY_UNAVAILABLE"
  | "NO_PAYROLL_CONTRACT"
  | "MISSING_CHECK_IN"
  | "MISSING_CHECK_OUT"
  | "INVALID_TIME_RANGE"
  | "PENDING_LEAVE_APPROVAL"
  | "LEAVE_PAYROLL_TREATMENT_UNSPECIFIED"
  | "OVERTIME_APPROVAL_UNAVAILABLE"
  | "CONTRACT_OVERLAP"
  | "BEFORE_HIRE_DATE"
  | "STORED_STATUS_POLICY_MISMATCH"
  | "STORED_LATE_MINUTES_MISMATCH"
  | "STORED_EARLY_LEAVE_MINUTES_MISMATCH"
  | "STORED_WORK_MINUTES_MISMATCH"
  | "EMPLOYEE_LEVEL_BASE_DATE_REQUIRED"
  | "PART_TIME_EXTRA_WORK_REVIEW_REQUIRED"
  | "PART_TIME_EXTRA_WORK_DECISION_STALE";

export type WorkScheduleVersion = {
  id: number;
  userId: number;
  startTime: string;
  endTime: string;
  unpaidBreakMinutes: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  revision: number;
  changeReason: string | null;
};

export type PayrollContract = {
  id: number;
  userId: number;
  payType: PayType;
  calculationBasis: CalculationBasis;
  baseSalary: number;
  fixedRaiseAmount: number;
  standardWorkdays: number | null;
  standardMinutesPerDay: number;
  timeBlockMinutes: number;
  roundingMode: RoundingMode;
  lateAdjustmentMode: AdjustmentMode;
  earlyLeaveAdjustmentMode: AdjustmentMode;
  overtimeMode: OvertimeMode;
  paidLeaveMode: PaidLeaveMode;
  effectiveFrom: string;
  effectiveTo: string | null;
  revision: number;
  createdBy?: number | null;
  createdAt?: string | null;
  note?: string | null;
};

export type AttendanceDayFacts = {
  userId: number;
  businessDate: string;
  scheduledMinutes: number | null;
  actualMinutes: number | null;
  scheduledOverlapMinutes: number | null;
  manualLateNormalized: boolean;
  // lateMinutes: 표시/개근 판정용. 정책 grace 적용 후 값이며, 수동 지각 정상화(manualLateNormalized) 시 0.
  lateMinutes: number;
  // rawLateMinutes: 스케줄 시작 대비 실제 check-in 지연(분). grace 적용 전, 정상화 여부와 무관.
  rawLateMinutes: number;
  // effectiveLateMinutes: 정책 grace 적용 후 실제 지각분. 급여의 지각 패널티 산정 기준(정상화되어도 유지).
  effectiveLateMinutes: number;
  lateThresholdMinutes: number;
  earlyLeaveMinutes: number;
  rawEarlyLeaveMinutes: number;
  earlyLeaveThresholdMinutes: number;
  isEarlyLeave: boolean;
  overtimeCandidateMinutes: number;
  attendanceStatus: "no_record" | "working" | "done" | "late" | "early_leave" | "late_and_early_leave" | "leave" | "unauthorized_absence" | "unresolved";
  payrollStatus: PayrollStatus;
  warningCodes: PayrollWarningCode[];
  stored: {
    status: string | null;
    lateMinutes: number | null;
    earlyLeaveMinutes: number | null;
    workMinutes: number | null;
  };
  source: {
    attendanceRecordId: number | null;
    scheduleVersionId: number | null;
    scheduleRevision: number | null;
    storeSettingsRevision: number | null;
    engineVersion: typeof PAYROLL_FACTS_ENGINE_VERSION;
  };
};

export type PayrollProjection = {
  calculationBasis: CalculationBasis;
  recognizedMinutes: number | null;
  recognizedHours: number | null;
  recognizedDays: number | null;
  estimatedAmount: number | null;
  adjustmentMinutes: number;
  overtimeCandidateMinutes: number;
  payrollStatus: PayrollStatus;
  warningCodes: PayrollWarningCode[];
  engineVersion: typeof PAYROLL_PROJECTION_ENGINE_VERSION;
};
