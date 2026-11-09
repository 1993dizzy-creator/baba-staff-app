import type { EmployeeLevelInfo } from "../employee-level/types";
import type { PayrollContract } from "./types";
import { calculatePayrollRates } from "./work-policy.ts";

export type CombinedSalaryResult = {
  contractSalary: number;
  fixedRaiseAmount: number;
  levelRaiseAmount: number | null;
  combinedSalary: number | null;
  additionalRaiseCount: number | null;
  /** Present only when an eligible level raise is deliberately not paid. */
  levelRaiseExcluded?: "salary_raise_disabled";
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
  // Level counts but its raise is not paid (e.g. a part-timer kept on the level program).
  // The special raise (contract fixedRaiseAmount) is unaffected and never duplicated.
  if (levelInfo.salaryRaiseEnabled === false) {
    return { contractSalary: contract.baseSalary, fixedRaiseAmount: contract.fixedRaiseAmount, levelRaiseAmount: 0, combinedSalary: contract.baseSalary + contract.fixedRaiseAmount, additionalRaiseCount: 0, levelRaiseExcluded: "salary_raise_disabled" };
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
