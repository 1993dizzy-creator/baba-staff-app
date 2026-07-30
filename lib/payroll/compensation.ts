import type { EmployeeLevelInfo } from "../employee-level/types";
import type { PayrollContract } from "./types";

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
