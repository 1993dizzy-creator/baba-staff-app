import { isEmployeeLevelDate } from "./calculate";
import {
  EMPLOYEE_LEVEL_MAX_RAISE_COUNT,
  type EmployeeLevelValidationCode,
  type EmployeeLevelValidationResult,
} from "./types";

function result(codes: EmployeeLevelValidationCode[]): EmployeeLevelValidationResult {
  return { valid: codes.length === 0, codes: [...new Set(codes)] };
}

export function validateEmployeeLevelConfiguration(input: {
  hireDate: string | null;
  levelBaseDateOverride: string | null;
  terminationDate?: string | null;
  isSystemAccount?: boolean;
  today: string;
}): EmployeeLevelValidationResult {
  const codes: EmployeeLevelValidationCode[] = [];
  const presentDates = [
    input.today,
    input.hireDate,
    input.levelBaseDateOverride,
    input.terminationDate,
  ].filter((date): date is string => date !== null && date !== undefined);

  if (presentDates.some((date) => !isEmployeeLevelDate(date))) {
    codes.push("INVALID_DATE");
    return result(codes);
  }
  if (input.isSystemAccount) {
    codes.push("SYSTEM_ACCOUNT_NOT_ELIGIBLE");
  }
  if (!input.hireDate) {
    codes.push("MISSING_HIRE_DATE");
  }
  if (
    input.levelBaseDateOverride &&
    input.hireDate &&
    input.levelBaseDateOverride < input.hireDate
  ) {
    codes.push("BASE_DATE_BEFORE_HIRE_DATE");
  }
  if (
    input.levelBaseDateOverride &&
    input.terminationDate &&
    input.levelBaseDateOverride > input.terminationDate
  ) {
    codes.push("BASE_DATE_AFTER_TERMINATION_DATE");
  }
  if (input.levelBaseDateOverride && input.levelBaseDateOverride > input.today) {
    codes.push("BASE_DATE_IN_FUTURE");
  }
  return result(codes);
}

export function validateIncludedRaiseCount(
  includedRaiseCount: number | null,
  earnedRaiseCount: number
): EmployeeLevelValidationResult {
  const codes: EmployeeLevelValidationCode[] = [];
  if (includedRaiseCount === null) return result(codes);
  if (
    !Number.isInteger(includedRaiseCount) ||
    includedRaiseCount < 0 ||
    includedRaiseCount > EMPLOYEE_LEVEL_MAX_RAISE_COUNT
  ) {
    codes.push("INVALID_INCLUDED_RAISE_COUNT");
    return result(codes);
  }
  if (includedRaiseCount > earnedRaiseCount) {
    codes.push("INCLUDED_RAISE_COUNT_EXCEEDS_EARNED");
  }
  return result(codes);
}
