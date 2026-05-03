import { ATTENDANCE_STATUS } from "@/lib/attendance/status";

export const ATTENDANCE_BUSINESS_START_HOUR = 16;
export const ATTENDANCE_BUSINESS_END_HOUR = 3;
export const EARLY_LEAVE_STATUS_THRESHOLD_MINUTES = 90;
export const TIMEZONE_OFFSET = "+07:00";

export function normalizeTime(time?: string | null) {
  if (!time) return null;
  return String(time).slice(0, 5);
}

export function getMinutesDiff(startIso: string, endIso: string) {
  const diff = Math.floor(
    (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000
  );

  return Math.max(0, diff);
}

export function makeCheckInIso(workDate: string, time: string) {
  const safeTime = normalizeTime(time);
  if (!safeTime) throw new Error("invalid check-in time");

  return new Date(`${workDate}T${safeTime}:00${TIMEZONE_OFFSET}`).toISOString();
}

export function makeCheckOutIso(
  workDate: string,
  time: string,
  checkInIso: string
) {
  const safeTime = normalizeTime(time);
  if (!safeTime) throw new Error("invalid check-out time");

  const checkOut = new Date(`${workDate}T${safeTime}:00${TIMEZONE_OFFSET}`);
  const checkIn = new Date(checkInIso);

  if (checkOut.getTime() < checkIn.getTime()) {
    checkOut.setDate(checkOut.getDate() + 1);
  }

  return checkOut.toISOString();
}

export function getLateMinutes(
  checkInIso: string,
  workStartTime?: string | null
) {
  const safeWorkStartTime = normalizeTime(workStartTime);
  if (!safeWorkStartTime) return 0;

  const checkIn = new Date(checkInIso);
  const workDate = checkInIso.slice(0, 10);
  const standardStart = new Date(
    `${workDate}T${safeWorkStartTime}:00${TIMEZONE_OFFSET}`
  );

  const diff = Math.floor(
    (checkIn.getTime() - standardStart.getTime()) / 60000
  );

  return Math.max(0, diff);
}

export function getEarlyLeaveMinutes(
  checkInIso: string,
  checkOutIso: string,
  workEndTime?: string | null
) {
  const safeWorkEndTime = normalizeTime(workEndTime);
  if (!safeWorkEndTime) return 0;

  const checkIn = new Date(checkInIso);
  const checkOut = new Date(checkOutIso);
  const workDate = checkInIso.slice(0, 10);

  const standardEnd = new Date(
    `${workDate}T${safeWorkEndTime}:00${TIMEZONE_OFFSET}`
  );

  if (standardEnd.getTime() < checkIn.getTime()) {
    standardEnd.setDate(standardEnd.getDate() + 1);
  }

  const diff = Math.floor(
    (standardEnd.getTime() - checkOut.getTime()) / 60000
  );

  return Math.max(0, diff);
}

export function getStatusByMinutes(
  lateMinutes: number,
  earlyLeaveMinutes: number
): (typeof ATTENDANCE_STATUS)[keyof typeof ATTENDANCE_STATUS] {
  if (earlyLeaveMinutes >= EARLY_LEAVE_STATUS_THRESHOLD_MINUTES) {
    return ATTENDANCE_STATUS.EARLY_LEAVE;
  }

  if (lateMinutes > 0) {
    return ATTENDANCE_STATUS.LATE;
  }

  return ATTENDANCE_STATUS.DONE;
}

export function getAttendanceWorkDate(now = new Date()) {
  const vietnamTime = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" })
  );

  if (vietnamTime.getHours() < ATTENDANCE_BUSINESS_END_HOUR) {
    vietnamTime.setDate(vietnamTime.getDate() - 1);
  }

  const yyyy = vietnamTime.getFullYear();
  const mm = String(vietnamTime.getMonth() + 1).padStart(2, "0");
  const dd = String(vietnamTime.getDate()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}`;
}