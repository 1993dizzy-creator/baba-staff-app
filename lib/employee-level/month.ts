// Month-based level base ("기준월") helpers. A base month is "YYYY-MM"; Lv.0 starts on its
// first day and each promotion lands on the 1st of base month +3, +6, +9 ... months, which
// is exactly what the existing date engine yields for a base date of "YYYY-MM-01".

const BASE_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE_KEY = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Hire day 1–15 counts from the hire month; day 16 to month end from the next month. */
export const EMPLOYEE_LEVEL_HIRE_MONTH_CUTOFF_DAY = 15;

export function isEmployeeLevelBaseMonth(value: unknown): value is string {
  return typeof value === "string" && BASE_MONTH.test(value);
}

export function addMonthsToBaseMonth(month: string, months: number) {
  const match = BASE_MONTH.exec(month);
  if (!match || !Number.isInteger(months)) return null;
  const index = Number(match[1]) * 12 + (Number(match[2]) - 1) + months;
  const year = Math.floor(index / 12);
  return `${String(year).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
}

export function baseMonthStartDate(month: string) {
  return isEmployeeLevelBaseMonth(month) ? `${month}-01` : null;
}

/** "YYYY-MM-01" -> "YYYY-MM"; any other day is not a month-start value. */
export function baseMonthFromStartDate(date: string | null | undefined) {
  const match = typeof date === "string" ? DATE_KEY.exec(date) : null;
  return match && match[3] === "01" ? `${match[1]}-${match[2]}` : null;
}

/** Automatic base month from the hire date (1–15 -> hire month, 16+ -> next month). */
export function hireMonthBase(hireDate: string | null | undefined) {
  const match = typeof hireDate === "string" ? DATE_KEY.exec(hireDate) : null;
  if (!match) return null;
  const hireMonth = `${match[1]}-${match[2]}`;
  return Number(match[3]) <= EMPLOYEE_LEVEL_HIRE_MONTH_CUTOFF_DAY ? hireMonth : addMonthsToBaseMonth(hireMonth, 1);
}

/** Promotion month (YYYY-MM) for each level 1..7 from a base month. */
export function levelPromotionMonths(baseMonth: string, intervalMonths = 3, maxLevel = 7) {
  if (!isEmployeeLevelBaseMonth(baseMonth)) return [];
  return Array.from({ length: maxLevel }, (_, i) => addMonthsToBaseMonth(baseMonth, intervalMonths * (i + 1)) as string);
}
