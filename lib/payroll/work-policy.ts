import type { PayrollContract } from "./types";

export type PayrollWorkPolicyResult = {
  recognizedMinutes: number;
  recognizedWorkdays: number;
  workAmount: number;
  automaticLatePenalty: number;
  automaticEarlyLeavePenalty: number;
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
  const usesDayRate = contract.payType === "monthly" || contract.calculationBasis === "day";
  const recognizedMinutes = usesDayRate ? contract.standardMinutesPerDay : input.actualRecognizedMinutes;
  const recognizedWorkdays = usesDayRate ? 1 : recognizedMinutes / contract.standardMinutesPerDay;
  const workAmount = usesDayRate ? input.dayRate : input.minuteRate * recognizedMinutes;
  return {
    recognizedMinutes,
    recognizedWorkdays,
    workAmount,
    automaticLatePenalty: usesDayRate && contract.lateAdjustmentMode === "deduct_minutes" ? input.minuteRate * input.lateMinutes : 0,
    automaticEarlyLeavePenalty: usesDayRate && contract.earlyLeaveAdjustmentMode === "deduct_minutes" ? input.minuteRate * input.earlyLeaveMinutes : 0,
    lateRequiresReview: usesDayRate && input.lateMinutes > 0 && contract.lateAdjustmentMode === "separate",
    earlyLeaveRequiresReview: usesDayRate && input.earlyLeaveMinutes > 0 && contract.earlyLeaveAdjustmentMode === "separate",
  };
}
