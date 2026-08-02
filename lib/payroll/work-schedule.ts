import type { WorkScheduleVersion } from "./types";

const TIME_PATTERN = /^(\d{2}):(\d{2})(?::\d{2})?$/;

export function timeOfDayMinutes(value: string) {
  const match = TIME_PATTERN.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}

export function scheduledMinutesPerDay(startTime: string, endTime: string, unpaidBreakMinutes = 0) {
  const start = timeOfDayMinutes(startTime);
  const end = timeOfDayMinutes(endTime);
  if (start === null || end === null || !Number.isInteger(unpaidBreakMinutes) || unpaidBreakMinutes < 0) return null;
  const elapsed = (end - start + 1440) % 1440;
  const result = elapsed - unpaidBreakMinutes;
  return elapsed > 0 && result > 0 && result <= 1440 ? result : null;
}

export function schedulesActiveOn(rows: WorkScheduleVersion[], effectiveFrom: string) {
  return rows.filter((row) => row.effectiveFrom <= effectiveFrom && (!row.effectiveTo || row.effectiveTo > effectiveFrom));
}

export function formatScheduleTime(value: string) {
  return value.slice(0, 5);
}
