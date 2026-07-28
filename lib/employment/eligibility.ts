const DATE_KEY = /^\d{4}-(0[1-9]|1[0-2])-([012]\d|3[01])$/;

export type EmploymentDates = {
  hire_date: string | null;
  termination_date: string | null;
};

export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_KEY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isEmployedOn(user: EmploymentDates, date: string) {
  return (!user.hire_date || user.hire_date <= date) &&
    (!user.termination_date || user.termination_date >= date);
}

export function employmentIntersectsMonth(user: EmploymentDates, month: string) {
  const first = `${month}-01`;
  const next = new Date(`${first}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  next.setUTCDate(0);
  const last = next.toISOString().slice(0, 10);
  return Boolean(user.hire_date) && user.hire_date! <= last &&
    (!user.termination_date || user.termination_date >= first);
}

export function shouldIncludeMonthlyEmployee(
  user: EmploymentDates & { is_system_account?: boolean },
  month: string,
  actualAttendanceExists: boolean
) {
  if (user.is_system_account === true) return false;
  return actualAttendanceExists || employmentIntersectsMonth(user, month);
}

export function validateEmploymentDates(user: EmploymentDates) {
  return !user.hire_date || !user.termination_date || user.termination_date >= user.hire_date;
}
