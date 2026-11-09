export const EMPLOYEE_LEVEL_INTERVAL_MONTHS = 3;
export const EMPLOYEE_LEVEL_MAX = 7;
export const EMPLOYEE_LEVEL_RAISE_AMOUNT = 500_000;
export const EMPLOYEE_LEVEL_MAX_RAISE_COUNT = 7;
export const EMPLOYEE_LEVEL_NEGOTIATION_MONTHS = 24;

export const EMPLOYEE_LEVEL_AUTOMATIC_ROLES = ["manager", "leader", "staff"] as const;
export const EMPLOYEE_LEVEL_MANUAL_ROLES = ["owner", "master"] as const;

export function isEmployeeLevelAutomaticRole(role: string | null | undefined) {
  return EMPLOYEE_LEVEL_AUTOMATIC_ROLES.some((automaticRole) => automaticRole === role);
}

export function isEmployeeLevelManualRole(role: string | null | undefined) {
  return EMPLOYEE_LEVEL_MANUAL_ROLES.some((manualRole) => manualRole === role);
}

export function isEmployeeLevelEligibleRole(
  role: string | null | undefined,
  levelProgramEnabled?: boolean | null
) {
  if (levelProgramEnabled === false) return false;
  return isEmployeeLevelAutomaticRole(role)
    || (isEmployeeLevelManualRole(role) && levelProgramEnabled === true);
}

export type EmployeeLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * hire_date / override: legacy date-based bases (kept for existing versions, never
 * rewritten). hire_month: base month derived from the hire date (1–15 -> hire month,
 * 16+ -> next month). override_month: admin-chosen base month stored as "YYYY-MM-01".
 */
export const EMPLOYEE_LEVEL_BASE_MODES = ["hire_date", "override", "hire_month", "override_month"] as const;
export type EmployeeLevelBaseMode = (typeof EMPLOYEE_LEVEL_BASE_MODES)[number];
export const EMPLOYEE_LEVEL_MONTH_BASE_MODES = ["hire_month", "override_month"] as const;

export function isEmployeeLevelBaseMode(value: unknown): value is EmployeeLevelBaseMode {
  return EMPLOYEE_LEVEL_BASE_MODES.some((mode) => mode === value);
}

export function isEmployeeLevelMonthBaseMode(value: unknown): value is "hire_month" | "override_month" {
  return value === "hire_month" || value === "override_month";
}

export type EmployeeLevelCalculationInput = {
  role: string | null;
  levelProgramEnabled?: boolean | null;
  hireDate: string | null;
  levelBaseDateOverride: string | null;
  /** Absent/null keeps the legacy behaviour (override date, else hire date). */
  levelBaseMode?: EmployeeLevelBaseMode | null;
  /** Level raise reaches pay only when true (default). Level itself is unaffected. */
  salaryRaiseEnabled?: boolean | null;
  terminationDate?: string | null;
  isSystemAccount?: boolean;
  asOfDate: string;
};

export type EmployeeLevelIneligibleReason =
  | "SYSTEM_ACCOUNT"
  | "PROGRAM_DISABLED"
  | "ROLE_NOT_ELIGIBLE"
  | "MISSING_BASE_DATE"
  | "BEFORE_BASE_DATE"
  | "INVALID_DATE";

export type EmployeeLevelInfo = {
  eligible: boolean;
  reason: EmployeeLevelIneligibleReason | null;
  level: EmployeeLevel | null;
  displayLabel: string | null;
  baseDate: string | null;
  baseDateSource: EmployeeLevelBaseMode | null;
  // The two fields below are present ONLY when non-default. Payroll hashes skip absent
  // keys, so legacy employees keep byte-identical level snapshots and calculation hashes.
  /** "YYYY-MM"; present only for month-based modes. */
  baseMonth?: string;
  /** Present (false) only when the level raise must not reach pay (shown as 0₫ applied). */
  salaryRaiseEnabled?: false;
  calculationDate: string | null;
  completedQuarterCount: number;
  earnedRaiseCount: number;
  raiseAmountPerStep: number;
  cumulativeRaiseAmount: number;
  nextLevelDate: string | null;
  negotiationEligibleAt: string | null;
  negotiationEligible: boolean;
};

export type EmployeeLevelProgramVersion = {
  id: number;
  enabled: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  baseDate: string | null;
  baseDateMode: EmployeeLevelBaseMode | null;
  /** Present (false) only when the version disables the level raise; absent = true. */
  salaryRaiseEnabled?: false;
  revision: number;
};

export type EmployeeLevelValidationCode =
  | "INVALID_DATE"
  | "MISSING_HIRE_DATE"
  | "BASE_DATE_BEFORE_HIRE_DATE"
  | "BASE_DATE_AFTER_TERMINATION_DATE"
  | "BASE_DATE_IN_FUTURE"
  | "SYSTEM_ACCOUNT_NOT_ELIGIBLE"
  | "INVALID_BASE_MONTH"
  | "BASE_MONTH_BEFORE_HIRE_MONTH"
  | "BASE_MONTH_AFTER_TERMINATION";

export type EmployeeLevelValidationResult = {
  valid: boolean;
  codes: EmployeeLevelValidationCode[];
};
