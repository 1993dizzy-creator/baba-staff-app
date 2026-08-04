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
  if (!contract || facts.actualMinutes === null || hardReview) {
    return { calculationBasis, recognizedMinutes: null, recognizedHours: null, recognizedDays: null, estimatedAmount: null, adjustmentMinutes: 0, overtimeCandidateMinutes: facts.overtimeCandidateMinutes, payrollStatus: facts.payrollStatus === "excluded" ? "excluded" : "requires_review", warningCodes: [...new Set(warnings)], engineVersion: PAYROLL_PROJECTION_ENGINE_VERSION };
  }

  const minuteRecognized = calculationBasis === "minute" ? facts.actualMinutes : (facts.scheduledOverlapMinutes ?? facts.actualMinutes);
  const recognizedMinutes = calculationBasis === "hour"
    ? roundMinutes(minuteRecognized, contract.timeBlockMinutes, contract.roundingMode)
    : minuteRecognized;
  const recognizedDays = recognizedMinutes / contract.standardMinutesPerDay;
  return {
    calculationBasis,
    recognizedMinutes,
    recognizedHours: recognizedMinutes / 60,
    recognizedDays,
    estimatedAmount: amountFor(recognizedMinutes, recognizedDays, contract),
    adjustmentMinutes: 0,
    overtimeCandidateMinutes: facts.overtimeCandidateMinutes,
    payrollStatus: facts.payrollStatus,
    warningCodes: [...new Set(warnings)],
    engineVersion: PAYROLL_PROJECTION_ENGINE_VERSION,
  };
}
