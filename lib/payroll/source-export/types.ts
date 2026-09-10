import type { CalculationBasis, PayType } from "../types";
import type { PayrollTaxBurdenMode, PayrollTaxMode } from "../tax";

export const PAYROLL_SOURCE_EXPORT_SCHEMA_VERSION = "payroll-source-export-v1" as const;

export type PayrollSourceAttendanceSchedule = {
  id: number;
  revision: number;
  startTime: string;
  endTime: string;
  unpaidBreakMinutes: number;
} | null;

export type PayrollSourceAttendanceItem = {
  businessDate: string;
  attendanceRecordId: number | null;
  classification: "completed_work" | "leave" | "unauthorized_absence" | "working" | "unresolved" | "no_record";
  checkInAt: string | null;
  checkOutAt: string | null;
  sourceUpdatedAt: string | null;
  actualMinutes: number | null;
  lateMinutes: number;
  rawLateMinutes: number;
  effectiveLateMinutes: number;
  earlyLeaveMinutes: number;
  manualLateNormalized: boolean;
  approvalStatus: string | null;
  reason: string | null;
  schedule: PayrollSourceAttendanceSchedule;
  storePolicyRevision: number | null;
  warningCodes: string[];
};

export type PayrollSourceExtraWorkItem = {
  businessDate: string;
  attendanceRecordId: number;
  decisionId: number | null;
  approvedMinutes: number;
  hourlyRateAmount: number;
  referenceAmount: number;
  decidedBy: number | null;
  decidedAt: string | null;
  sourceHash: string;
};

export type PayrollSourceAdjustment = {
  id: number;
  businessDate: string;
  amount: number;
  category: string;
  reason: string;
  memo: string | null;
  cancelled: boolean;
  cancelledAt: string | null;
  cancelledBy: number | null;
  cancellationReason: string | null;
};

export type PayrollSourceContract = {
  contractId: number;
  revision: number;
  payType: PayType;
  calculationBasis: CalculationBasis;
  baseSalaryAmount: number;
  fixedRaiseAmount: number;
  standardWorkdays: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type PayrollSourceEmployee = {
  employee: {
    employeeId: number;
    displayName: string;
    accountingName: string | null;
    part: string | null;
    position: string | null;
  };
  contract: PayrollSourceContract | null;
  contractVersions: PayrollSourceContract[];
  level: {
    versionId: number | null;
    revision: number | null;
    level: number | null;
    appliedRaiseAmount: number | null;
  };
  attendance: {
    recognizedAttendanceDays: number;
    completedWorkDates: string[];
    completed: PayrollSourceAttendanceItem[];
    leave: PayrollSourceAttendanceItem[];
    late: PayrollSourceAttendanceItem[];
    earlyLeave: PayrollSourceAttendanceItem[];
    unauthorizedAbsence: PayrollSourceAttendanceItem[];
    unresolved: PayrollSourceAttendanceItem[];
  };
  extraWork: {
    approvedRegular: PayrollSourceExtraWorkItem[];
    approvedPartTime: PayrollSourceExtraWorkItem[];
    pendingCount: number;
    staleCount: number;
  };
  adjustments: {
    incentives: PayrollSourceAdjustment[];
    penalties: PayrollSourceAdjustment[];
    advances: PayrollSourceAdjustment[];
  };
  attendanceBonus: {
    eligible: boolean;
    referenceAmount: number;
  };
  insurance: {
    settingVersionId: number | null;
    revision: number | null;
    referenceEmployeeAmount: number | null;
    referenceEmployerAmount: number | null;
  };
  tax: {
    settingVersionId: number | null;
    settingRevision: number | null;
    policyVersionId: number | null;
    policyRevision: number | null;
    taxMode: PayrollTaxMode | null;
    burdenMode: PayrollTaxBurdenMode | null;
    referenceCalculatedAmount: number | null;
    requiresReview: boolean;
  };
  mealAllowance: {
    eligibleDays: number;
    referenceAmount: number;
  };
  readiness: {
    readyForAccounting: boolean;
    blockingCodes: string[];
    warningCodes: string[];
  };
  sourceHash: string;
};

export type PayrollSourceExport = {
  schemaVersion: typeof PAYROLL_SOURCE_EXPORT_SCHEMA_VERSION;
  payrollMonth: string;
  calculationThroughDate: string;
  generatedAt: string;
  employees: PayrollSourceEmployee[];
  readiness: {
    readyEmployeeCount: number;
    blockedEmployeeCount: number;
    blockingCodes: string[];
    warningCodes: string[];
  };
  sourceHash: string;
};
