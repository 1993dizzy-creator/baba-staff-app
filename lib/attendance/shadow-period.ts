export const MAX_ATTENDANCE_SHADOW_DAYS = 31;

function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function addUtcDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function enumerateBusinessDates(start: string, end: string) {
  const dates: string[] = [];
  for (let date = start; date <= end; date = addUtcDays(date, 1)) {
    dates.push(date);
    if (dates.length > MAX_ATTENDANCE_SHADOW_DAYS) break;
  }
  return dates;
}

export function getCompletedBusinessDateRange(
  currentBusinessDate: string,
  days = 7
) {
  const endBusinessDate = addUtcDays(currentBusinessDate, -1);
  return {
    startBusinessDate: addUtcDays(endBusinessDate, -(days - 1)),
    endBusinessDate,
  };
}

export function parseAttendanceShadowRange(body: Record<string, unknown>) {
  const hasSingle = body.businessDate !== undefined;
  const hasRange =
    body.startBusinessDate !== undefined || body.endBusinessDate !== undefined;
  if (hasSingle === hasRange) return null;
  const start = hasSingle ? body.businessDate : body.startBusinessDate;
  const end = hasSingle ? body.businessDate : body.endBusinessDate;
  if (!isDateKey(start) || !isDateKey(end) || start > end) return null;
  const dates = enumerateBusinessDates(start, end);
  if (dates.length === 0 || dates.length > MAX_ATTENDANCE_SHADOW_DAYS) {
    return null;
  }
  return {
    startBusinessDate: start,
    endBusinessDate: end,
    businessDates: dates,
    singleDate: hasSingle,
  };
}
