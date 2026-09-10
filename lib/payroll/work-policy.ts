import type { PayrollContract } from "./types";

export const DEFAULT_STANDARD_WORKDAYS = 26;

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

export function calculateContractMonthlyEquivalent(
  contract: PayrollContract,
  salaryBase = contract.baseSalary,
) {
  if (contract.payType !== "hourly") return Math.round(salaryBase);
  const { dayRate } = calculatePayrollRates(contract, salaryBase);
  return Math.round(dayRate * (contract.standardWorkdays ?? DEFAULT_STANDARD_WORKDAYS));
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
  const recognizedMinutes = input.actualRecognizedMinutes;
  const recognizedWorkdays = recognizedMinutes / contract.standardMinutesPerDay;
  return {
    recognizedMinutes,
    recognizedWorkdays,
    workAmount: input.minuteRate * recognizedMinutes,
    // v6 late penalties are calculated from the immutable run-level policy snapshot.
    automaticLatePenalty: 0,
    automaticEarlyLeavePenalty: 0,
    deductionEarlyLeaveMinutes: 0,
    lateRequiresReview: false,
    earlyLeaveRequiresReview: false,
  };
}

export function applyUnifiedPayrollWorkPolicy(input: Parameters<typeof applyPayrollWorkPolicy>[0]): PayrollWorkPolicyResult {
  const recognizedMinutes = Math.max(0, Math.min(input.contract.standardMinutesPerDay, input.actualRecognizedMinutes));
  return { recognizedMinutes, recognizedWorkdays: recognizedMinutes / input.contract.standardMinutesPerDay, workAmount: input.minuteRate * recognizedMinutes, automaticLatePenalty: 0, automaticEarlyLeavePenalty: 0, deductionEarlyLeaveMinutes: 0, lateRequiresReview: false, earlyLeaveRequiresReview: false };
}

export function selectUnifiedRecognizedMinutes(input:{scheduledMinutes:number;scheduledOverlapMinutes:number;actualMinutes:number;lateMinutes:number;earlyLeaveMinutes:number;manualLateNormalized:boolean}) {
  // BABA 확정 정책(2026-09): 정상근무로 인정된 날은 그날 스케줄 근무시간(scheduledMinutes) 전액을
  // 기본급으로 인정한다. 지각·조퇴·수동 지각정상화는 기본급을 분 단위로 깎지 않고, 각각 독립된
  // 30분 단위 deduction(late_deduction / early_leave_deduction)으로만 처리한다.
  // scheduledOverlapMinutes / actualMinutes / lateMinutes / earlyLeaveMinutes / manualLateNormalized는
  // 더 이상 기본급 인정분에 영향을 주지 않는다(하위호환·호출부 안정성을 위해 시그니처만 유지).
  return input.scheduledMinutes;
}
