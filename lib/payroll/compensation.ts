import type { EmployeeLevelInfo } from "../employee-level/types";
import type { PayrollContract } from "./types";
// @ts-expect-error Node's strip-types tests require the explicit extension.
import { calculatePayrollRates } from "./work-policy.ts";

export type CombinedSalaryResult = {
  contractSalary: number;
  fixedRaiseAmount: number;
  levelRaiseAmount: number | null;
  combinedSalary: number | null;
  additionalRaiseCount: number | null;
};

export function calculateCombinedSalary(contract: PayrollContract, levelInfo: EmployeeLevelInfo): CombinedSalaryResult {
  if (contract.payType !== "monthly") {
    return { contractSalary: contract.baseSalary, fixedRaiseAmount: 0, levelRaiseAmount: 0, combinedSalary: contract.baseSalary, additionalRaiseCount: 0 };
  }
  if (levelInfo.reason === "MISSING_BASE_DATE") {
    return { contractSalary: contract.baseSalary, fixedRaiseAmount: contract.fixedRaiseAmount, levelRaiseAmount: null, combinedSalary: null, additionalRaiseCount: null };
  }
  if (!levelInfo.eligible) {
    return { contractSalary: contract.baseSalary, fixedRaiseAmount: contract.fixedRaiseAmount, levelRaiseAmount: 0, combinedSalary: contract.baseSalary + contract.fixedRaiseAmount, additionalRaiseCount: 0 };
  }
  const additionalRaiseCount = levelInfo.earnedRaiseCount;
  const levelRaiseAmount = levelInfo.earnedRaiseCount * levelInfo.raiseAmountPerStep;
  return { contractSalary: contract.baseSalary, fixedRaiseAmount: contract.fixedRaiseAmount, levelRaiseAmount, combinedSalary: contract.baseSalary + contract.fixedRaiseAmount + levelRaiseAmount, additionalRaiseCount };
}

// Resolve compensation once for the effective day's contract and level. Both
// ordinary work and holiday premium must use the resulting base-work item.
export function calculateCompensatedPayrollRates(contract: PayrollContract, levelInfo: EmployeeLevelInfo) {
  const compensation = calculateCombinedSalary(contract, levelInfo);
  return {
    ...compensation,
    rates: compensation.combinedSalary === null ? null : calculatePayrollRates(contract, compensation.combinedSalary),
  };
}
