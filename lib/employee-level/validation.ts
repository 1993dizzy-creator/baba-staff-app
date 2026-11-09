import { isEmployeeLevelDate } from "./calculate.ts";
import { hireMonthBase, isEmployeeLevelBaseMonth } from "./month.ts";
import type { EmployeeLevelValidationCode, EmployeeLevelValidationResult } from "./types";

/**
 * Month-based base validation (same rules as the DB RPC):
 * - hire_month needs a valid hire date (the month is derived, never typed).
 * - override_month needs "YYYY-MM", not before the actual hire month and not after the
 *   termination month. A future base month is allowed (Lv.0 until it starts).
 */
export function validateEmployeeLevelBaseMonth(input: {
  mode: "hire_month" | "override_month";
  baseMonth: string | null;
  hireDate: string | null;
  terminationDate?: string | null;
}): EmployeeLevelValidationResult {
  const codes: EmployeeLevelValidationCode[] = [];
  if (!input.hireDate) return result(["MISSING_HIRE_DATE"]);
  if (!isEmployeeLevelDate(input.hireDate) || (input.terminationDate && !isEmployeeLevelDate(input.terminationDate))) {
    return result(["INVALID_DATE"]);
  }
  if (input.mode === "hire_month") {
    return result(hireMonthBase(input.hireDate) ? [] : ["INVALID_DATE"]);
  }
  if (!isEmployeeLevelBaseMonth(input.baseMonth)) return result(["INVALID_BASE_MONTH"]);
  if (input.baseMonth < input.hireDate.slice(0, 7)) codes.push("BASE_MONTH_BEFORE_HIRE_MONTH");
  if (input.terminationDate && input.baseMonth > input.terminationDate.slice(0, 7)) codes.push("BASE_MONTH_AFTER_TERMINATION");
  return result(codes);
}

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
