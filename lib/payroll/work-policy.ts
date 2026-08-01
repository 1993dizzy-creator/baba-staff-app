import type { PayrollContract } from "./types";

export function calculatePayrollRates(contract: PayrollContract, salaryBase = contract.baseSalary) {
  const dayRate = contract.payType === "monthly"
    ? (contract.standardWorkdays ? salaryBase / contract.standardWorkdays : 0)
    : contract.payType === "daily"
      ? contract.baseSalary
      : (contract.baseSalary / 60) * contract.standardMinutesPerDay;
  return {
    dayRate,
    minuteRate: contract.payType === "hourly" ? contract.baseSalary / 60 : dayRate / contract.standardMinutesPerDay,
  };
}

export type PayrollWorkPolicyResult = {
  recognizedMinutes: number;
  recognizedWorkdays: number;
  workAmount: number;
  automaticLatePenalty: number;
  automaticEarlyLeavePenalty: number;
  deductionEarlyLeaveMinutes: number;
  lateRequiresReview: boolean;
  earlyLeaveRequiresReview: boolean;
};

export function applyPayrollWorkPolicy(input: {
  contract: PayrollContract;
  actualRecognizedMinutes: number;
  dayRate: number;
  minuteRate: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
}): PayrollWorkPolicyResult {
  const { contract } = input;
  const usesDayRate = contract.calculationBasis === "day";
  const recognizedMinutes = usesDayRate ? contract.standardMinutesPerDay : input.actualRecognizedMinutes;
  const recognizedWorkdays = usesDayRate ? 1 : recognizedMinutes / contract.standardMinutesPerDay;
  const workAmount = usesDayRate ? input.dayRate : input.minuteRate * recognizedMinutes;
  const deductionEarlyLeaveMinutes = usesDayRate && input.earlyLeaveMinutes > 0
    ? input.earlyLeaveMinutes
    : 0;
  return {
    recognizedMinutes,
    recognizedWorkdays,
    workAmount,
    // v6 late penalties are calculated from the immutable run-level policy snapshot.
    automaticLatePenalty: 0,
    // No new early-leave policy is introduced. Day-based legacy behavior remains compatible.
    automaticEarlyLeavePenalty: contract.earlyLeaveAdjustmentMode === "deduct_minutes" ? input.minuteRate * deductionEarlyLeaveMinutes : 0,
    deductionEarlyLeaveMinutes,
    lateRequiresReview: false,
    earlyLeaveRequiresReview: usesDayRate && input.earlyLeaveMinutes > 0 && contract.earlyLeaveAdjustmentMode === "separate",
  };
}
