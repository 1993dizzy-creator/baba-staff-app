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
  user: EmploymentDates & {
    is_system_account?: boolean;
    attendance_tracking_enabled?: boolean;
  },
  month: string,
  actualAttendanceExists: boolean
) {
  if (user.is_system_account === true) return false;
  // 해당 월에 실제 근태 기록이 있으면 현재 attendance_tracking_enabled가 false여도
  // 과거 월 조회에서는 계속 표시한다. 기록이 없으면 근태 사용 직원만 재직기간 기준으로
  // 표시한다(신규 근태 처리 대상 판정과 동일한 규칙).
  if (actualAttendanceExists) return true;
  return (
    user.attendance_tracking_enabled === true &&
    employmentIntersectsMonth(user, month)
  );
}

export function validateEmploymentDates(user: EmploymentDates) {
  return !user.hire_date || !user.termination_date || user.termination_date >= user.hire_date;
}
