import { ATTENDANCE_STATUS } from "@/lib/attendance/status";

export const ATTENDANCE_BUSINESS_START_HOUR = 16;
export const ATTENDANCE_BUSINESS_END_HOUR = 3;
export const EARLY_LEAVE_STATUS_THRESHOLD_MINUTES = 90;
export const LONG_SHIFT_WARNING_MINUTES = 16 * 60;
export const TIMEZONE_OFFSET = "+07:00";
// 손님이 없어 정규 영업 종료(01:00)보다 일찍 마감하는 날, 이 시각 이후 퇴근은
// 개인 예정 퇴근시간과 무관하게 조퇴로 처리하지 않는다.
export const NORMAL_EARLY_CLOSE_TIME = "23:30";

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
  workStartTime: string | null | undefined,
  workDate: string
) {
  const safeWorkStartTime = normalizeTime(workStartTime);
  if (!safeWorkStartTime) return 0;

  const checkIn = new Date(checkInIso);
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
  workEndTime: string | null | undefined,
  workDate: string
) {
  const safeWorkEndTime = normalizeTime(workEndTime);
  if (!safeWorkEndTime) return 0;

  const checkIn = new Date(checkInIso);
  const checkOut = new Date(checkOutIso);

  const normalCloseFloor = new Date(
    `${workDate}T${NORMAL_EARLY_CLOSE_TIME}:00${TIMEZONE_OFFSET}`
  );

  if (checkOut.getTime() >= normalCloseFloor.getTime()) {
    return 0;
  }

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

// 실제 출근·퇴근 datetime 차이가 기준(16시간)을 넘는지 판단하는 공통 함수.
// 미퇴근(check_out_at 없음) 기록은 장시간 근무가 아니라 별도의 미처리 상태로 취급한다.
export function isLongShiftRecord(
  checkInIso?: string | null,
  checkOutIso?: string | null
) {
  if (!checkInIso || !checkOutIso) return false;
  return getMinutesDiff(checkInIso, checkOutIso) > LONG_SHIFT_WARNING_MINUTES;
}

// datetime-local input 값("YYYY-MM-DDTHH:MM")을 베트남 현지시각 기준 ISO로 변환한다.
// 관리자 보정에서 날짜와 시각을 명확하게 함께 입력받기 위해 사용한다.
export function makeIsoFromLocalDateTime(localDateTime: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localDateTime)) {
    throw new Error("invalid datetime");
  }

  const date = new Date(`${localDateTime}:00${TIMEZONE_OFFSET}`);

  if (Number.isNaN(date.getTime())) {
    throw new Error("invalid datetime");
  }

  return date.toISOString();
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

// "YYYY-MM-DD" 날짜 키에 순수 달력 일수를 더한다. 시간대 계산과 무관하게
// UTC 정오를 기준점으로 삼아 DST 등의 영향 없이 날짜만 이동시킨다.
export function addDaysToDateKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);

  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}`;
}

// BABA 매장의 정상 마감시각(영업일 다음 날 01:00)을 ISO로 계산한다.
// 자동보정 및 "근무 중" ↔ "퇴근 미처리" 판정에 공통으로 사용한다.
export function getShiftAutoCloseIso(workDate: string) {
  const nextDate = addDaysToDateKey(workDate, 1);
  return new Date(`${nextDate}T01:00:00${TIMEZONE_OFFSET}`).toISOString();
}

// 현재 영업일의 미퇴근 기록은 마감시각(다음 날 01:00) 전까지는 "근무 중"으로 보고,
// 이전 영업일이거나 마감시각이 지난 기록만 "퇴근 미처리"로 판단하는 공통 함수.
export function isOpenRecordUnresolved(
  record: { check_in_at?: string | null; check_out_at?: string | null; work_date: string },
  now = new Date()
) {
  if (!record.check_in_at || record.check_out_at) return false;

  const currentBusinessDate = getAttendanceWorkDate(now);

  if (record.work_date !== currentBusinessDate) {
    return true;
  }

  return now.getTime() >= new Date(getShiftAutoCloseIso(record.work_date)).getTime();
}

// 과거 근무일을 보정할 때, 비어 있는 출근/퇴근 datetime-local 입력의 기본값을
// 브라우저의 "오늘 날짜"가 아니라 관리자가 선택한 근무일 기준으로 만든다.
// 00:00~02:59 시간은 영업일 경계(ATTENDANCE_BUSINESS_END_HOUR)를 넘는 야간 근무이므로
// 다음 날짜를 사용한다.
export function getDefaultShiftDateTimeValue(workDate: string, timeHHMM: string) {
  const safeTime = normalizeTime(timeHHMM) || "00:00";
  const hour = Number(safeTime.slice(0, 2));
  const dateKey =
    hour < ATTENDANCE_BUSINESS_END_HOUR ? addDaysToDateKey(workDate, 1) : workDate;

  return `${dateKey}T${safeTime}`;
}