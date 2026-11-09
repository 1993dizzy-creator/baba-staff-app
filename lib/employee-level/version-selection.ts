import { isEmployeeLevelBaseMode, type EmployeeLevelBaseMode, type EmployeeLevelProgramVersion } from "./types.ts";

export const EMPLOYEE_LEVEL_VERSION_SELECT =
  "id,user_id,enabled,effective_from,effective_to,base_date,base_date_mode,salary_raise_enabled,revision";

export type EmployeeLevelProgramVersionRow = {
  id: number | string;
  user_id: number | string;
  enabled: boolean | null;
  effective_from: string;
  effective_to: string | null;
  base_date: string | null;
  base_date_mode: string | null;
  salary_raise_enabled?: boolean | null;
  revision: number | string;
};

export function serializeEmployeeLevelProgramVersion(
  row: EmployeeLevelProgramVersionRow,
): EmployeeLevelProgramVersion {
  return {
    id: Number(row.id),
    enabled: Boolean(row.enabled),
    effectiveFrom: String(row.effective_from),
    effectiveTo: row.effective_to ? String(row.effective_to) : null,
    baseDate: row.base_date ? String(row.base_date) : null,
    baseDateMode: isEmployeeLevelBaseMode(row.base_date_mode) ? row.base_date_mode : null,
    ...(row.salary_raise_enabled === false ? { salaryRaiseEnabled: false as const } : {}),
    revision: Number(row.revision),
  };
}
const serializeVersion = serializeEmployeeLevelProgramVersion;

/**
 * The user-level fields a version implies for one day. Legacy modes give exactly the
 * previous values (override date only for "override"). Month modes carry the mode and
 * the base month stored on the version (hire_month included), so history stays fixed.
 */
export function levelUserFieldsFromVersion(version: EmployeeLevelProgramVersion): {
  level_program_enabled: boolean;
  level_base_date_override: string | null;
  level_base_mode: EmployeeLevelBaseMode | null;
  level_salary_raise_enabled: boolean;
} {
  const mode = version.baseDateMode;
  return {
    level_program_enabled: version.enabled,
    level_base_date_override: mode === "override" || mode === "override_month" || mode === "hire_month" ? version.baseDate : null,
    level_base_mode: mode === "hire_month" || mode === "override_month" ? mode : null,
    level_salary_raise_enabled: version.salaryRaiseEnabled !== false,
  };
}

export function selectEmployeeLevelProgramVersionsForDates(
  rows: EmployeeLevelProgramVersionRow[],
  asOfDates: string[],
) {
  const versionsByDate = new Map<
    string,
    Map<number, EmployeeLevelProgramVersion>
  >();

  for (const date of asOfDates) {
    const versions = new Map<number, EmployeeLevelProgramVersion>();
    for (const row of rows) {
      if (
        row.effective_from > date ||
        (row.effective_to !== null && row.effective_to <= date)
      ) {
        continue;
      }

      const userId = Number(row.user_id);
      const candidate = serializeVersion(row);
      const current = versions.get(userId);
      if (!current || candidate.revision > current.revision) {
        versions.set(userId, candidate);
      }
    }
    versionsByDate.set(date, versions);
  }

  return versionsByDate;
}
