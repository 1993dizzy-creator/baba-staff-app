const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

// 시간 문자열 안전 변환 ("23:00:00" → "23:00")
export function normalizeTime(time?: string | null) {
  if (!time) return null;
  return String(time).slice(0, 5);
}

// ISO → 분 차이
export function getMinutesDiff(startIso: string, endIso: string) {
  const diff = Math.floor(
    (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000
  );

  return Math.max(0, diff);
}

// ISO 기준 베트남 날짜 추출
function getVietnamDateString(iso: string) {
  const date = new Date(new Date(iso).getTime() + VN_OFFSET_MS);

  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}`;
}

// 체크아웃 ISO 생성 (자정 넘김 포함)
export function makeCheckOutIso(
  workDate: string,
  time: string,
  checkInIso: string
) {
  const safeTime = normalizeTime(time);
  if (!safeTime) throw new Error("invalid time");

  const checkOut = new Date(`${workDate}T${safeTime}:00+07:00`);
  const checkIn = new Date(checkInIso);

  if (checkOut.getTime() <= checkIn.getTime()) {
    checkOut.setUTCDate(checkOut.getUTCDate() + 1);
  }

  return checkOut.toISOString();
}

// 체크인 ISO 생성
export function makeCheckInIso(workDate: string, time: string) {
  const safeTime = normalizeTime(time);
  if (!safeTime) throw new Error("invalid time");

  return new Date(`${workDate}T${safeTime}:00+07:00`).toISOString();
}

// 지각 계산 (베트남 시간 기준)
export function getLateMinutes(
  checkInIso: string,
  workStartTime?: string | null
) {
  if (!workStartTime) return 0;

  const safeStart = normalizeTime(workStartTime);
  if (!safeStart) return 0;

  const checkIn = new Date(checkInIso);
  const workDate = getVietnamDateString(checkInIso);

  const standardStart = new Date(`${workDate}T${safeStart}:00+07:00`);

  return Math.max(
    0,
    Math.floor((checkIn.getTime() - standardStart.getTime()) / 60000)
  );
}

// 조퇴 계산 (베트남 시간 기준 / 자정 넘김 대응)
export function getEarlyLeaveMinutes(
  checkInIso: string,
  checkOutIso: string,
  workEndTime?: string | null
) {
  if (!workEndTime) return 0;

  const safeEnd = normalizeTime(workEndTime);
  if (!safeEnd) return 0;

  const checkIn = new Date(checkInIso);
  const checkOut = new Date(checkOutIso);
  const workDate = getVietnamDateString(checkInIso);

  const standardEnd = new Date(`${workDate}T${safeEnd}:00+07:00`);

  if (standardEnd.getTime() <= checkIn.getTime()) {
    standardEnd.setUTCDate(standardEnd.getUTCDate() + 1);
  }

  return Math.max(
    0,
    Math.floor((standardEnd.getTime() - checkOut.getTime()) / 60000)
  );
}

// 상태 결정
export function getStatus(earlyLeaveMinutes: number) {
  if (earlyLeaveMinutes >= 90) return "early_leave";
  return "done";
}