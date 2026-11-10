import type { EmployeeLevelInfo } from "../employee-level/types";
import type { PayrollContract } from "./types";
import { calculatePayrollRates, DEFAULT_STANDARD_WORKDAYS } from "./work-policy.ts";

export type CombinedSalaryResult = {
  contractSalary: number;
  fixedRaiseAmount: number;
  levelRaiseAmount: number | null;
  combinedSalary: number | null;
  additionalRaiseCount: number | null;
  /** Present only when an eligible level raise is deliberately not paid. */
  levelRaiseExcluded?: "salary_raise_disabled";
  reviewCode?: "INVALID_HOURLY_STANDARD_HOURS";
  hourlyStandardMonthlyHours?: number;
  monthlyLevelRaiseAmount?: number;
};

export type CompensationContract = Pick<PayrollContract, "payType" | "baseSalary" | "fixedRaiseAmount" | "standardWorkdays" | "standardMinutesPerDay">;

export function calculateCombinedSalary(contract: CompensationContract, levelInfo: EmployeeLevelInfo): CombinedSalaryResult {
  if (contract.payType === "hourly") {
    const days = contract.standardWorkdays ?? DEFAULT_STANDARD_WORKDAYS;
    const hours = contract.standardMinutesPerDay * days / 60;
    if (!Number.isFinite(days) || days <= 0 || !Number.isInteger(contract.standardMinutesPerDay)
      || contract.standardMinutesPerDay <= 0 || contract.standardMinutesPerDay > 1440 || !Number.isFinite(hours) || hours <= 0
      || !Number.isFinite(contract.baseSalary) || contract.baseSalary < 0) {
      return { contractSalary: contract.baseSalary, fixedRaiseAmount: 0, levelRaiseAmount: null,
        combinedSalary: null, additionalRaiseCount: null, reviewCode: "INVALID_HOURLY_STANDARD_HOURS" };
    }
    if (levelInfo.reason === "MISSING_BASE_DATE") {
      return { contractSalary: contract.baseSalary, fixedRaiseAmount: 0, levelRaiseAmount: null, combinedSalary: null, additionalRaiseCount: null };
    }
    if (!levelInfo.eligible || levelInfo.salaryRaiseEnabled === false || levelInfo.earnedRaiseCount === 0) {
      return { contractSalary: contract.baseSalary, fixedRaiseAmount: 0, levelRaiseAmount: 0, combinedSalary: contract.baseSalary, additionalRaiseCount: 0 };
    }
    const monthlyLevelRaiseAmount = levelInfo.earnedRaiseCount * levelInfo.raiseAmountPerStep;
    const hourlyRate = Math.round(contract.baseSalary + monthlyLevelRaiseAmount / hours);
    if (!Number.isSafeInteger(hourlyRate)) {
      return { contractSalary: contract.baseSalary, fixedRaiseAmount: 0, levelRaiseAmount: null,
        combinedSalary: null, additionalRaiseCount: null, reviewCode: "INVALID_HOURLY_STANDARD_HOURS" };
    }
    // fixedRaiseAmount is a monthly-contract item; never add it to an hourly rate.
    return { contractSalary: contract.baseSalary, fixedRaiseAmount: 0,
      levelRaiseAmount: hourlyRate - contract.baseSalary, combinedSalary: hourlyRate,
      additionalRaiseCount: levelInfo.earnedRaiseCount, hourlyStandardMonthlyHours: hours, monthlyLevelRaiseAmount };
  }
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
export function calculateCompensatedPayrollRates(contract: PayrollContract, levelInfo: EmployeeLevelInfo, salaryContract = contract) {
  // The schedule can change paid minutes/day, but cannot change the hourly raise denominator.
  const compensation = calculateCombinedSalary(salaryContract, levelInfo);
  return {
    ...compensation,
    rates: compensation.combinedSalary === null ? null : calculatePayrollRates(contract, compensation.combinedSalary),
  };
}
