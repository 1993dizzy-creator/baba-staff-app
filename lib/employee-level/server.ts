import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { calculateEmployeeLevel } from "./calculate";
import type { EmployeeLevelBaseMode, EmployeeLevelInfo, EmployeeLevelProgramVersion } from "./types";
import {
  EMPLOYEE_LEVEL_VERSION_SELECT,
  levelUserFieldsFromVersion,
  selectEmployeeLevelProgramVersionsForDates,
  serializeEmployeeLevelProgramVersion,
  type EmployeeLevelProgramVersionRow,
} from "./version-selection";

export type EmployeeLevelUser = {
  role: string | null;
  hire_date: string | null;
  termination_date: string | null;
  is_system_account: boolean;
  level_program_enabled: boolean | null;
  level_base_date_override: string | null;
  /** Month-based mode mirror; absent/null = legacy date-based base. */
  level_base_mode?: EmployeeLevelBaseMode | string | null;
  /** From the effective level version; absent = true (previous behaviour). */
  level_salary_raise_enabled?: boolean | null;
  /** Legacy hire_date version's stored hire date; absent = no version (live hire date). */
  level_hire_date_base?: string | null;
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
    levelBaseMode: user.level_base_mode === "hire_month" || user.level_base_mode === "override_month" ? user.level_base_mode : null,
    salaryRaiseEnabled: user.level_salary_raise_enabled,
    levelHireDateBase: user.level_hire_date_base,
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

export async function loadEmployeeLevelProgramVersions(
  userIds: number[],
  asOfDate: string,
) {
  if (userIds.length === 0) return new Map<number, EmployeeLevelProgramVersion>();
  const { data, error } = await supabaseServer
    .from("employee_level_program_versions")
    .select(EMPLOYEE_LEVEL_VERSION_SELECT)
    .in("user_id", userIds)
    .lte("effective_from", asOfDate)
    .or(`effective_to.is.null,effective_to.gt.${asOfDate}`)
    .order("revision", { ascending: false });
  if (error) throw new Error(`EMPLOYEE_LEVEL_PROGRAM_READ_FAILED: ${error.message}`);
  const versions = new Map<number, EmployeeLevelProgramVersion>();
  for (const row of data ?? []) {
    const userId = Number(row.user_id);
    if (versions.has(userId)) continue;
    versions.set(userId, serializeEmployeeLevelProgramVersion(row as EmployeeLevelProgramVersionRow));
  }
  return versions;
}

export async function loadEmployeeLevelProgramVersionsForDates(
  userIds: number[],
  asOfDates: string[],
) {
  const dates = Array.from(new Set(asOfDates)).sort();
  const empty = new Map(
    dates.map((date) => [date, new Map<number, EmployeeLevelProgramVersion>()])
  );
  if (userIds.length === 0 || dates.length === 0) return empty;

  const minDate = dates[0];
  const maxDate = dates[dates.length - 1];
  const { data, error } = await supabaseServer
    .from("employee_level_program_versions")
    .select(EMPLOYEE_LEVEL_VERSION_SELECT)
    .in("user_id", userIds)
    .lte("effective_from", maxDate)
    .or(`effective_to.is.null,effective_to.gt.${minDate}`)
    .order("revision", { ascending: false });
  if (error) {
    throw new Error(`EMPLOYEE_LEVEL_PROGRAM_READ_FAILED: ${error.message}`);
  }

  return selectEmployeeLevelProgramVersionsForDates(
    (data ?? []) as EmployeeLevelProgramVersionRow[],
    dates,
  );
}

// Narrow variant for callers (currently only GET /api/admin/users) that need
// to start this read in parallel with their own users query, before any
// candidate user id list exists yet. Same columns, same min/max date bounds,
// same effective_to overlap logic, same revision ordering as
// loadEmployeeLevelProgramVersionsForDates above — the only difference is
// the absence of that function's candidate-user_id filter. Reuses the same
// pure selectEmployeeLevelProgramVersionsForDates selector, which already groups
// by whatever user_id appears in the rows and never required a pre-known
// candidate list. Callers MUST look up results only by ids from their own
// already-filtered user list — this function does not scope by
// is_system_account or any other user property, so unrelated rows (system
// accounts, other employees) can be present in the underlying read and must
// be ignored by never being looked up.
export async function loadEmployeeLevelProgramVersionsForDatesUnscoped(
  asOfDates: string[],
) {
  const dates = Array.from(new Set(asOfDates)).sort();
  const empty = new Map(
    dates.map((date) => [date, new Map<number, EmployeeLevelProgramVersion>()])
  );
  if (dates.length === 0) return empty;

  const minDate = dates[0];
  const maxDate = dates[dates.length - 1];
  const { data, error } = await supabaseServer
    .from("employee_level_program_versions")
    .select(EMPLOYEE_LEVEL_VERSION_SELECT)
    .lte("effective_from", maxDate)
    .or(`effective_to.is.null,effective_to.gt.${minDate}`)
    .order("revision", { ascending: false });
  if (error) {
    throw new Error(`EMPLOYEE_LEVEL_PROGRAM_READ_FAILED: ${error.message}`);
  }

  return selectEmployeeLevelProgramVersionsForDates(
    (data ?? []) as EmployeeLevelProgramVersionRow[],
    dates,
  );
}

export function applyEmployeeLevelProgramVersion<T extends EmployeeLevelUser>(
  user: T,
  version?: EmployeeLevelProgramVersion,
) {
  if (!version) return user;
  return {
    ...user,
    ...levelUserFieldsFromVersion(version),
    levelProgramVersion: version,
  };
}
