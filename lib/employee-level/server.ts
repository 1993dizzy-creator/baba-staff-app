import "server-only";

import { calculateEmployeeLevel } from "./calculate";
import type { EmployeeLevelInfo } from "./types";

export type EmployeeLevelUser = {
  role: string | null;
  hire_date: string | null;
  termination_date: string | null;
  is_system_account: boolean;
  level_program_enabled: boolean | null;
  level_base_date_override: string | null;
};

export function getEmployeeLevelInfo(
  user: EmployeeLevelUser,
  asOfDate: string
): EmployeeLevelInfo {
  return calculateEmployeeLevel({
    role: user.role,
    levelProgramEnabled: user.level_program_enabled,
    hireDate: user.hire_date,
    levelBaseDateOverride: user.level_base_date_override,
    terminationDate: user.termination_date,
    isSystemAccount: user.is_system_account,
    asOfDate,
  });
}

export function withEmployeeLevelInfo<T extends EmployeeLevelUser>(
  user: T,
  asOfDate: string
) {
  return { ...user, levelInfo: getEmployeeLevelInfo(user, asOfDate) };
}
