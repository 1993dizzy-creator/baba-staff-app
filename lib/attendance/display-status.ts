export type AttendanceDisplayStatus =
  | "normal"
  | "late"
  | "early_leave"
  | "approved_leave"
  | "none";

export type AttendanceStatusRecord = {
  status: string;
  late_minutes?: number | null;
  early_leave_minutes?: number | null;
  approval_status?: "pending" | "approved" | null;
};

export const ATTENDANCE_STATUS_COLORS: Record<Exclude<AttendanceDisplayStatus, "none">, string> = {
  normal: "#10b981",
  late: "#f59e0b",
  early_leave: "#ef4444",
  approved_leave: "#6b7280",
};

export function getAttendanceDisplayStatus(
  record: AttendanceStatusRecord | null | undefined
): AttendanceDisplayStatus {
  if (!record) return "none";

  if (Number(record.early_leave_minutes || 0) > 0 || record.status === "early_leave") {
    return "early_leave";
  }

  if (Number(record.late_minutes || 0) > 0) return "late";

  if (record.status === "leave") {
    return record.approval_status === "approved" ? "approved_leave" : "none";
  }

  return "normal";
}

const vietnamDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function getVietnamDateKey(now = new Date()) {
  const parts = vietnamDateFormatter.formatToParts(now);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function parseMonth(monthKey: string) {
  const [year, month] = monthKey.split("-").map(Number);
  if (!year || month < 1 || month > 12) throw new Error(`Invalid month: ${monthKey}`);
  return { year, month };
}

export function getRecentAttendanceDateKeys(monthKey: string, now = new Date()) {
  const { year, month } = parseMonth(monthKey);
  const vietnamToday = getVietnamDateKey(now);
  const endDay = vietnamToday.startsWith(`${monthKey}-`)
    ? Number(vietnamToday.slice(-2))
    : new Date(Date.UTC(year, month, 0)).getUTCDate();
  const endDate = new Date(Date.UTC(year, month - 1, endDay));

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(endDate);
    date.setUTCDate(endDate.getUTCDate() - (6 - index));
    return date.toISOString().slice(0, 10);
  });
}

export function getDateKeyWeekdayIndex(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}
