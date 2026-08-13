import type { EmployeeLevelProgramVersion } from "./types";

export type EmployeeLevelProgramVersionRow = {
  id: number | string;
  user_id: number | string;
  enabled: boolean | null;
  effective_from: string;
  effective_to: string | null;
  base_date: string | null;
  base_date_mode: string | null;
  revision: number | string;
};

function serializeVersion(
  row: EmployeeLevelProgramVersionRow,
): EmployeeLevelProgramVersion {
  return {
    id: Number(row.id),
    enabled: Boolean(row.enabled),
    effectiveFrom: String(row.effective_from),
    effectiveTo: row.effective_to ? String(row.effective_to) : null,
    baseDate: row.base_date ? String(row.base_date) : null,
    baseDateMode:
      row.base_date_mode === "hire_date" || row.base_date_mode === "override"
        ? row.base_date_mode
        : null,
    revision: Number(row.revision),
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
