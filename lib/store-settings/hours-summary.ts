import type { StoreBusinessHour } from "./types";

export type HoursSummaryGroup = {
  weekdays: number[];
  isClosed: boolean;
  openTime: string | null;
  closeTime: string | null;
};

/**
 * Groups business hours into runs of consecutive weekdays (일=0..토=6) that
 * share the same open/close time, so a confirmation summary can show a
 * compact "일~토 16:00~01:00" line when every day matches, while still
 * showing each weekday's own value accurately when they differ.
 */
export function groupStoreHours(hours: StoreBusinessHour[]): HoursSummaryGroup[] {
  const byWeekday = new Map(hours.map((hour) => [hour.weekday, hour]));
  const groups: HoursSummaryGroup[] = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const hour = byWeekday.get(weekday);
    if (!hour) continue;
    const last = groups[groups.length - 1];
    if (
      last &&
      last.isClosed === hour.isClosed &&
      last.openTime === hour.openTime &&
      last.closeTime === hour.closeTime
    ) {
      last.weekdays.push(weekday);
    } else {
      groups.push({
        weekdays: [weekday],
        isClosed: hour.isClosed,
        openTime: hour.openTime,
        closeTime: hour.closeTime,
      });
    }
  }
  return groups;
}
