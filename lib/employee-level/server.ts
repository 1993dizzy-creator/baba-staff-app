import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { calculateEmployeeLevel } from "./calculate";
import type { EmployeeLevelInfo, EmployeeLevelProgramVersion } from "./types";

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

export async function loadEmployeeLevelProgramVersions(
  userIds: number[],
  asOfDate: string,
) {
  if (userIds.length === 0) return new Map<number, EmployeeLevelProgramVersion>();
  const { data, error } = await supabaseServer
    .from("employee_level_program_versions")
    .select("id,user_id,enabled,effective_from,effective_to,base_date,base_date_mode,revision")
    .in("user_id", userIds)
    .lte("effective_from", asOfDate)
    .or(`effective_to.is.null,effective_to.gt.${asOfDate}`)
    .order("revision", { ascending: false });
  if (error) throw new Error(`EMPLOYEE_LEVEL_PROGRAM_READ_FAILED: ${error.message}`);
  const versions = new Map<number, EmployeeLevelProgramVersion>();
  for (const row of data ?? []) {
    const userId = Number(row.user_id);
    if (versions.has(userId)) continue;
    versions.set(userId, {
      id: Number(row.id),
      enabled: Boolean(row.enabled),
      effectiveFrom: String(row.effective_from),
      effectiveTo: row.effective_to ? String(row.effective_to) : null,
      baseDate: row.base_date ? String(row.base_date) : null,
      baseDateMode: row.base_date_mode === "hire_date" || row.base_date_mode === "override" ? row.base_date_mode : null,
      revision: Number(row.revision),
    });
  }
  return versions;
}

export function applyEmployeeLevelProgramVersion<T extends EmployeeLevelUser>(
  user: T,
  version?: EmployeeLevelProgramVersion,
) {
  if (!version) return user;
  return {
    ...user,
    level_program_enabled: version.enabled,
    level_base_date_override: version.baseDateMode === "override" ? version.baseDate : null,
    levelProgramVersion: version,
  };
}
