import type { EmployeeLevelInfo } from "@/lib/employee-level/types";
import type { PayrollContract } from "@/lib/payroll/types";

export function calculateFixedMonthlyPayroll(
  contract: PayrollContract,
  levelInfo: EmployeeLevelInfo,
  asOfDate: string,
) {
  if (contract.payType !== "monthly" || contract.calculationBasis !== "fixed_monthly") return null;
  if (levelInfo.reason === "MISSING_BASE_DATE") return null;
  const raiseExcluded = levelInfo.eligible && levelInfo.salaryRaiseEnabled === false;
  const earnedRaiseCount = levelInfo.eligible ? levelInfo.earnedRaiseCount : 0;
  const levelRaiseAmount = raiseExcluded ? 0 : earnedRaiseCount * levelInfo.raiseAmountPerStep;
  return {
    amount: Math.round(contract.baseSalary + contract.fixedRaiseAmount + levelRaiseAmount),
    levelSnapshot: {
      level: levelInfo.level,
      displayLabel: levelInfo.displayLabel,
      earnedRaiseCount,
      raiseAmountPerStep: levelInfo.raiseAmountPerStep,
      appliedLevelRaiseAmount: levelRaiseAmount,
      calculationDate: asOfDate,
      // Present only when the level raise is deliberately not paid (keeps legacy hashes).
      ...(raiseExcluded ? { levelRaiseExcluded: "salary_raise_disabled" as const } : {}),
    },
  };
}
