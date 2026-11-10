import { addCalendarMonthsClamped, calculateEmployeeLevel } from "./calculate.ts";
import { levelUserFieldsFromVersion } from "./version-selection.ts";
import type { EmployeeLevelProgramVersion } from "./types.ts";

export type LevelHistoryEmployee = {
  role: string | null;
  hire_date: string | null;
  termination_date: string | null;
  is_system_account: boolean;
};

export function levelVersionOnDate(versions: EmployeeLevelProgramVersion[], date: string) {
  return versions.filter(v => v.effectiveFrom <= date && (!v.effectiveTo || date < v.effectiveTo))
    .sort((a, b) => b.revision - a.revision)[0];
}

export function employeeLevelOnDate(user: LevelHistoryEmployee, versions: EmployeeLevelProgramVersion[], date: string) {
  const version = levelVersionOnDate(versions, date);
  // Unknown history is not reconstructed from today's mirror or today's base month.
  if (!version || !user.hire_date || date < user.hire_date || (user.termination_date && date > user.termination_date)) return null;
  const fields = levelUserFieldsFromVersion(version);
  return calculateEmployeeLevel({ role: user.role, hireDate: user.hire_date, terminationDate: user.termination_date,
    isSystemAccount: user.is_system_account, levelProgramEnabled: fields.level_program_enabled,
    levelBaseDateOverride: fields.level_base_date_override, levelBaseMode: fields.level_base_mode,
    levelHireDateBase: fields.level_hire_date_base, salaryRaiseEnabled: fields.level_salary_raise_enabled, asOfDate: date });
}

export function buildEmployeeLevelHistory(user: LevelHistoryEmployee, versions: EmployeeLevelProgramVersion[], today: string) {
  const dates = new Set<string>();
  for (const version of versions) {
    if (!version.baseDate || !version.enabled) continue;
    for (let count = 1; count <= 7; count++) {
      const date = addCalendarMonthsClamped(version.baseDate, count * 3);
      if (date) dates.add(date);
    }
  }
  const promotions: { date: string; level: number; versionId: number }[] = [];
  for (const date of [...dates].sort()) {
    const previous = new Date(`${date}T00:00:00Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    const priorDate = previous.toISOString().slice(0, 10);
    const version = levelVersionOnDate(versions, date);
    // A policy switch is a separate admin event, not an invented regular promotion.
    if (!version || levelVersionOnDate(versions, priorDate)?.id !== version.id) continue;
    const before = employeeLevelOnDate(user, versions, priorDate);
    const after = employeeLevelOnDate(user, versions, date);
    if (before?.level !== null && before && after?.level !== null && after && after.level > before.level) {
      promotions.push({ date, level: after.level, versionId: version.id });
    }
  }
  const future = promotions.filter(p => p.date > today);
  return {
    asOfDate: today,
    coverageFrom: versions.map(v => v.effectiveFrom).sort()[0] ?? null,
    current: employeeLevelOnDate(user, versions, today),
    promotions: promotions.filter(p => p.date <= today),
    next: future[0] ?? null,
    future,
    policies: [...versions].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom)).map(v => ({
      id: v.id, effectiveFrom: v.effectiveFrom, effectiveTo: v.effectiveTo, enabled: v.enabled,
      baseMonth: v.baseDate?.slice(0, 7) ?? null,
    })),
  };
}
