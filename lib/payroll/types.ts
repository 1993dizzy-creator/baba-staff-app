export const PAYROLL_AUTOMATION_START_DATE = "2026-08-01";
export const PAYROLL_FACTS_ENGINE_VERSION = "attendance-facts-v1";
export const PAYROLL_PROJECTION_ENGINE_VERSION = "payroll-projection-v1";

export type PayType = "monthly" | "daily" | "hourly";
export type CalculationBasis = "minute" | "hour" | "day";
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
  | "STORED_WORK_MINUTES_MISMATCH";

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
};

export type AttendanceDayFacts = {
  userId: number;
  businessDate: string;
  scheduledMinutes: number | null;
  actualMinutes: number | null;
  scheduledOverlapMinutes: number | null;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeCandidateMinutes: number;
  attendanceStatus: "no_record" | "working" | "done" | "late" | "early_leave" | "late_and_early_leave" | "leave" | "unresolved";
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
