import { getAttendanceDisplayStatus, type AttendanceDisplayStatus, type AttendanceStatusRecord } from "./display-status";

export type AttendanceCalendarStatus = AttendanceDisplayStatus | "working" | "pending" | "future";
type CalendarRecord = AttendanceStatusRecord & { check_in_at?: string | null; check_out_at?: string | null };

// Calendar presentation only: no missing-day attendance verdict is inferred.
export function getAttendanceCalendarStatus(record: CalendarRecord | null | undefined, date: string, today: string): AttendanceCalendarStatus {
  if (!record) return date > today ? "future" : "none";
  if (record.status === "leave" && record.approval_status !== "approved") return "pending";
  const status = getAttendanceDisplayStatus(record);
  if (status === "normal" && record.check_in_at && !record.check_out_at) return "working";
  return status;
}

export function getAttendanceMonthCells(month: string): (string | null)[] {
  const [year, monthNumber] = month.split("-").map(Number);
  const firstWeekday = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const cellCount = Math.max(35, Math.ceil((firstWeekday + days) / 7) * 7);
  return Array.from({ length: cellCount }, (_, index) => {
    const day = index - firstWeekday + 1;
    return day >= 1 && day <= days ? `${month}-${String(day).padStart(2, "0")}` : null;
  });
}
