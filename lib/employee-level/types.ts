export const EMPLOYEE_LEVEL_INTERVAL_MONTHS = 3;
export const EMPLOYEE_LEVEL_MAX = 8;
export const EMPLOYEE_LEVEL_RAISE_AMOUNT = 500_000;
export const EMPLOYEE_LEVEL_MAX_RAISE_COUNT = 7;
export const EMPLOYEE_LEVEL_NEGOTIATION_MONTHS = 24;

export type EmployeeLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type EmployeeLevelCalculationInput = {
  hireDate: string | null;
  levelBaseDateOverride: string | null;
  terminationDate?: string | null;
  isSystemAccount?: boolean;
  asOfDate: string;
};

export type EmployeeLevelIneligibleReason =
  | "SYSTEM_ACCOUNT"
  | "MISSING_BASE_DATE"
  | "BEFORE_BASE_DATE"
  | "INVALID_DATE";

export type EmployeeLevelInfo = {
  eligible: boolean;
  reason: EmployeeLevelIneligibleReason | null;
  level: EmployeeLevel | null;
  displayLabel: string | null;
  baseDate: string | null;
  baseDateSource: "hire_date" | "override" | null;
  calculationDate: string | null;
  completedQuarterCount: number;
  earnedRaiseCount: number;
  raiseAmountPerStep: number;
  cumulativeRaiseAmount: number;
  nextLevelDate: string | null;
  negotiationEligibleAt: string | null;
  negotiationEligible: boolean;
};

export type EmployeeLevelValidationCode =
  | "INVALID_DATE"
  | "MISSING_HIRE_DATE"
  | "BASE_DATE_BEFORE_HIRE_DATE"
  | "BASE_DATE_AFTER_TERMINATION_DATE"
  | "BASE_DATE_IN_FUTURE"
  | "SYSTEM_ACCOUNT_NOT_ELIGIBLE"
  | "INVALID_INCLUDED_RAISE_COUNT"
  | "INCLUDED_RAISE_COUNT_EXCEEDS_EARNED";

export type EmployeeLevelValidationResult = {
  valid: boolean;
  codes: EmployeeLevelValidationCode[];
};
