import {
  EMPLOYEE_LEVEL_INTERVAL_MONTHS,
  EMPLOYEE_LEVEL_MAX,
  EMPLOYEE_LEVEL_MAX_RAISE_COUNT,
  EMPLOYEE_LEVEL_NEGOTIATION_MONTHS,
  EMPLOYEE_LEVEL_RAISE_AMOUNT,
  isEmployeeLevelEligibleRole,
  type EmployeeLevel,
  type EmployeeLevelBaseMode,
  type EmployeeLevelCalculationInput,
  type EmployeeLevelInfo,
  type EmployeeLevelIneligibleReason,
} from "./types.ts";
import { baseMonthFromStartDate, hireMonthBase } from "./month.ts";

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

/** Non-default extras only: absent keys keep legacy payroll hashes unchanged. */
function optionalLevelFields(baseMonth: string | null, salaryRaiseEnabled: boolean) {
  return {
    ...(baseMonth ? { baseMonth } : {}),
    ...(salaryRaiseEnabled ? {} : { salaryRaiseEnabled: false as const }),
  };
}

type ResolvedBase = {
  baseDate: string | null;
  baseDateSource: EmployeeLevelBaseMode | null;
  baseMonth: string | null;
  /** Month modes only: from this date until the base month starts the employee is Lv.0. */
  levelZeroFrom: string | null;
};

/**
 * Legacy (mode absent, "hire_date", "override"): exactly the previous rule — the
 * override date, else the hire date. Month modes resolve to the base month's 1st day.
 */
function resolveLevelBase(input: EmployeeLevelCalculationInput): ResolvedBase {
  if (input.levelBaseMode === "hire_month") {
    const baseMonth = hireMonthBase(input.hireDate);
    return { baseDate: baseMonth ? `${baseMonth}-01` : null, baseDateSource: baseMonth ? "hire_month" : null, baseMonth, levelZeroFrom: input.hireDate };
  }
  if (input.levelBaseMode === "override_month") {
    const baseMonth = baseMonthFromStartDate(input.levelBaseDateOverride);
    return { baseDate: baseMonth ? `${baseMonth}-01` : null, baseDateSource: baseMonth ? "override_month" : null, baseMonth, levelZeroFrom: input.hireDate };
  }
  const baseDate = input.levelBaseDateOverride || input.hireDate;
  const baseDateSource = input.levelBaseDateOverride ? "override" : input.hireDate ? "hire_date" : null;
  return { baseDate, baseDateSource, baseMonth: null, levelZeroFrom: null };
}

function ineligible(
  reason: EmployeeLevelIneligibleReason,
  baseDate: string | null,
  baseDateSource: EmployeeLevelBaseMode | null,
  calculationDate: string | null,
  extra: { baseMonth?: string | null; salaryRaiseEnabled?: boolean } = {}
): EmployeeLevelInfo {
  return {
    eligible: false,
    reason,
    level: null,
    displayLabel: null,
    baseDate,
    baseDateSource,
    ...optionalLevelFields(extra.baseMonth ?? null, extra.salaryRaiseEnabled !== false),
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
  const { baseDate, baseDateSource, baseMonth, levelZeroFrom } = resolveLevelBase(input);
  const salaryRaiseEnabled = input.salaryRaiseEnabled !== false;
  const extra = { baseMonth, salaryRaiseEnabled };

  if (input.isSystemAccount) {
    return ineligible("SYSTEM_ACCOUNT", baseDate, baseDateSource, null, extra);
  }
  if (input.levelProgramEnabled === false) {
    return ineligible("PROGRAM_DISABLED", baseDate, baseDateSource, null, extra);
  }
  if (!isEmployeeLevelEligibleRole(input.role, input.levelProgramEnabled)) {
    return ineligible("ROLE_NOT_ELIGIBLE", baseDate, baseDateSource, null, extra);
  }
  if (!baseDate) {
    return ineligible("MISSING_BASE_DATE", null, null, null, { salaryRaiseEnabled });
  }

  const dates = [input.asOfDate, baseDate];
  if (input.terminationDate) dates.push(input.terminationDate);
  if (levelZeroFrom) dates.push(levelZeroFrom);
  if (dates.some((date) => !isEmployeeLevelDate(date))) {
    return ineligible("INVALID_DATE", null, null, null, { salaryRaiseEnabled });
  }

  const calculationDate = input.terminationDate && input.terminationDate < input.asOfDate
    ? input.terminationDate
    : input.asOfDate;
  if (calculationDate < baseDate) {
    // Month modes: employed before the base month starts (e.g. hired on the 16th+) = Lv.0.
    if (levelZeroFrom && calculationDate >= levelZeroFrom) {
      return {
        eligible: true,
        reason: null,
        level: 0,
        displayLabel: "Lv.0",
        baseDate,
        baseDateSource,
        ...optionalLevelFields(baseMonth, salaryRaiseEnabled),
        calculationDate,
        completedQuarterCount: 0,
        earnedRaiseCount: 0,
        raiseAmountPerStep: EMPLOYEE_LEVEL_RAISE_AMOUNT,
        cumulativeRaiseAmount: 0,
        nextLevelDate: addCalendarMonthsClamped(baseDate, EMPLOYEE_LEVEL_INTERVAL_MONTHS),
        negotiationEligibleAt: addCalendarMonthsClamped(baseDate, EMPLOYEE_LEVEL_NEGOTIATION_MONTHS),
        negotiationEligible: false,
      };
    }
    return ineligible("BEFORE_BASE_DATE", baseDate, baseDateSource, calculationDate, extra);
  }

  const completedMonths = completedCalendarMonths(baseDate, calculationDate);
  const completedQuarterCount = Math.floor(
    completedMonths / EMPLOYEE_LEVEL_INTERVAL_MONTHS
  );
  const level = Math.min(
    EMPLOYEE_LEVEL_MAX,
    completedQuarterCount
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
    displayLabel: negotiationEligible ? "Lv.7★" : `Lv.${level}`,
    baseDate,
    baseDateSource,
    ...optionalLevelFields(baseMonth, salaryRaiseEnabled),
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
