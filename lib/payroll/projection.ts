// @ts-expect-error Node's test runner requires the explicit TypeScript extension.
import { PAYROLL_PROJECTION_ENGINE_VERSION, type AttendanceDayFacts, type CalculationBasis, type PayrollContract, type PayrollProjection, type PayrollWarningCode } from "./types.ts";

export function roundMinutes(value: number, block: number, mode: PayrollContract["roundingMode"]) {
  if (mode === "none" || block <= 1) return value;
  const units = value / block;
  const rounded = mode === "floor" ? Math.floor(units) : mode === "ceil" ? Math.ceil(units) : Math.round(units);
  return Math.max(0, rounded * block);
}

function amountFor(minutes: number, days: number, contract: PayrollContract) {
  if (contract.payType === "hourly") return Math.round((contract.baseSalary * minutes) / 60);
  if (contract.payType === "daily") return Math.round(contract.baseSalary * days);
  if (!contract.standardWorkdays) return null;
  return Math.round((contract.baseSalary * days) / contract.standardWorkdays);
}

export function projectPayrollAttendanceDay(
  facts: AttendanceDayFacts,
  contract: PayrollContract | null,
  calculationBasis: CalculationBasis
): PayrollProjection {
  const warnings: PayrollWarningCode[] = [...facts.warningCodes];
  if (!contract) warnings.push("NO_PAYROLL_CONTRACT");
  const hardReview = !contract || facts.payrollStatus === "requires_review" || facts.payrollStatus === "pending" || facts.attendanceStatus === "unresolved" || warnings.includes("PENDING_LEAVE_APPROVAL") || warnings.includes("LEAVE_PAYROLL_TREATMENT_UNSPECIFIED");
  if (!contract || facts.scheduledOverlapMinutes === null || hardReview) {
    return { calculationBasis, recognizedMinutes: null, recognizedHours: null, recognizedDays: null, estimatedAmount: null, adjustmentMinutes: 0, overtimeCandidateMinutes: facts.overtimeCandidateMinutes, payrollStatus: facts.payrollStatus === "excluded" ? "excluded" : "requires_review", warningCodes: [...new Set(warnings)], engineVersion: PAYROLL_PROJECTION_ENGINE_VERSION };
  }

  const minuteRecognized = facts.scheduledOverlapMinutes;
  const recognizedMinutes = calculationBasis === "hour"
    ? roundMinutes(minuteRecognized, contract.timeBlockMinutes, contract.roundingMode)
    : calculationBasis === "day"
      ? contract.standardMinutesPerDay
      : minuteRecognized;
  const recognizedDays = calculationBasis === "day" ? 1 : recognizedMinutes / contract.standardMinutesPerDay;
  const adjustmentMinutes = calculationBasis === "day" && (facts.lateMinutes > 0 || facts.earlyLeaveMinutes > 0)
    ? (contract.lateAdjustmentMode === "ignore" ? 0 : facts.lateMinutes) +
      (contract.earlyLeaveAdjustmentMode === "ignore" ? 0 : facts.earlyLeaveMinutes)
    : 0;
  return {
    calculationBasis,
    recognizedMinutes,
    recognizedHours: recognizedMinutes / 60,
    recognizedDays,
    estimatedAmount: amountFor(recognizedMinutes, recognizedDays, contract),
    adjustmentMinutes,
    overtimeCandidateMinutes: facts.overtimeCandidateMinutes,
    payrollStatus: facts.payrollStatus,
    warningCodes: [...new Set(warnings)],
    engineVersion: PAYROLL_PROJECTION_ENGINE_VERSION,
  };
}
