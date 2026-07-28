import {
  EMPLOYEE_LEVEL_INTERVAL_MONTHS,
  EMPLOYEE_LEVEL_MAX,
  EMPLOYEE_LEVEL_MAX_RAISE_COUNT,
  EMPLOYEE_LEVEL_NEGOTIATION_MONTHS,
  EMPLOYEE_LEVEL_RAISE_AMOUNT,
  type EmployeeLevel,
  type EmployeeLevelCalculationInput,
  type EmployeeLevelInfo,
  type EmployeeLevelIneligibleReason,
} from "./types";

const DATE_KEY = /^\d{4}-(0[1-9]|1[0-2])-([012]\d|3[01])$/;

export function isEmployeeLevelDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_KEY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function addCalendarMonthsClamped(date: string, months: number) {
  if (!isEmployeeLevelDate(date) || !Number.isInteger(months)) return null;
  const [year, month, day] = date.split("-").map(Number);
  const targetMonthIndex = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return `${String(targetYear).padStart(4, "0")}-${String(targetMonth + 1).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

function completedCalendarMonths(baseDate: string, calculationDate: string) {
  const [baseYear, baseMonth] = baseDate.split("-").map(Number);
  const [asOfYear, asOfMonth] = calculationDate.split("-").map(Number);
  let months = (asOfYear - baseYear) * 12 + asOfMonth - baseMonth;
  const anniversary = addCalendarMonthsClamped(baseDate, months);
  if (anniversary && calculationDate < anniversary) months -= 1;
  return Math.max(0, months);
}

function ineligible(
  reason: EmployeeLevelIneligibleReason,
  baseDate: string | null,
  baseDateSource: "hire_date" | "override" | null,
  calculationDate: string | null
): EmployeeLevelInfo {
  return {
    eligible: false,
    reason,
    level: null,
    displayLabel: null,
    baseDate,
    baseDateSource,
    calculationDate,
    completedQuarterCount: 0,
    earnedRaiseCount: 0,
    raiseAmountPerStep: EMPLOYEE_LEVEL_RAISE_AMOUNT,
    cumulativeRaiseAmount: 0,
    nextLevelDate: null,
    negotiationEligibleAt: baseDate
      ? addCalendarMonthsClamped(baseDate, EMPLOYEE_LEVEL_NEGOTIATION_MONTHS)
      : null,
    negotiationEligible: false,
  };
}

export function calculateEmployeeLevel(
  input: EmployeeLevelCalculationInput
): EmployeeLevelInfo {
  const baseDate = input.levelBaseDateOverride || input.hireDate;
  const baseDateSource = input.levelBaseDateOverride
    ? "override"
    : input.hireDate
      ? "hire_date"
      : null;

  if (input.isSystemAccount) {
    return ineligible("SYSTEM_ACCOUNT", baseDate, baseDateSource, null);
  }
  if (input.levelProgramEnabled !== true) {
    return ineligible("DISABLED", baseDate, baseDateSource, null);
  }
  if (!baseDate) {
    return ineligible("MISSING_BASE_DATE", null, null, null);
  }

  const dates = [input.asOfDate, baseDate];
  if (input.terminationDate) dates.push(input.terminationDate);
  if (dates.some((date) => !isEmployeeLevelDate(date))) {
    return ineligible("INVALID_DATE", null, null, null);
  }

  const calculationDate = input.terminationDate && input.terminationDate < input.asOfDate
    ? input.terminationDate
    : input.asOfDate;
  if (calculationDate < baseDate) {
    return ineligible("BEFORE_BASE_DATE", baseDate, baseDateSource, calculationDate);
  }

  const completedMonths = completedCalendarMonths(baseDate, calculationDate);
  const completedQuarterCount = Math.floor(
    completedMonths / EMPLOYEE_LEVEL_INTERVAL_MONTHS
  );
  const level = Math.min(
    EMPLOYEE_LEVEL_MAX,
    completedQuarterCount + 1
  ) as EmployeeLevel;
  const earnedRaiseCount = Math.min(
    EMPLOYEE_LEVEL_MAX_RAISE_COUNT,
    completedQuarterCount
  );
  const negotiationEligibleAt = addCalendarMonthsClamped(
    baseDate,
    EMPLOYEE_LEVEL_NEGOTIATION_MONTHS
  );
  const negotiationEligible = Boolean(
    negotiationEligibleAt && calculationDate >= negotiationEligibleAt
  );
  const nextLevelDate = level < EMPLOYEE_LEVEL_MAX
    ? addCalendarMonthsClamped(
        baseDate,
        completedQuarterCount * EMPLOYEE_LEVEL_INTERVAL_MONTHS +
          EMPLOYEE_LEVEL_INTERVAL_MONTHS
      )
    : null;

  return {
    eligible: true,
    reason: null,
    level,
    displayLabel: negotiationEligible ? "Lv.8★" : `Lv.${level}`,
    baseDate,
    baseDateSource,
    calculationDate,
    completedQuarterCount,
    earnedRaiseCount,
    raiseAmountPerStep: EMPLOYEE_LEVEL_RAISE_AMOUNT,
    cumulativeRaiseAmount: earnedRaiseCount * EMPLOYEE_LEVEL_RAISE_AMOUNT,
    nextLevelDate,
    negotiationEligibleAt,
    negotiationEligible,
  };
}
