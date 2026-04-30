// 시간 문자열 안전 변환 ("23:00:00" → "23:00")
export function normalizeTime(time?: string | null) {
  if (!time) return null;
  return String(time).slice(0, 5);
}

// ISO → 분 차이 (자정 넘김 보정)
export function getMinutesDiff(startIso: string, endIso: string) {
  let diff = Math.floor(
    (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000
  );

  if (diff < 0) diff += 24 * 60;

  return Math.max(0, diff);
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
    checkOut.setDate(checkOut.getDate() + 1);
  }

  return checkOut.toISOString();
}

// 체크인 ISO 생성
export function makeCheckInIso(workDate: string, time: string) {
  const safeTime = normalizeTime(time);
  if (!safeTime) throw new Error("invalid time");

  return new Date(`${workDate}T${safeTime}:00+07:00`).toISOString();
}

// 지각 계산
export function getLateMinutes(
  checkInIso: string,
  workStartTime?: string | null
) {
  if (!workStartTime) return 0;

  const safeStart = normalizeTime(workStartTime);
  if (!safeStart) return 0;

  const checkIn = new Date(checkInIso);

  const standardStart = new Date(checkIn);
  const [h, m] = safeStart.split(":").map(Number);

  standardStart.setHours(h, m, 0, 0);

  if (standardStart.getTime() > checkIn.getTime()) {
    standardStart.setDate(standardStart.getDate() - 1);
  }

  return Math.max(
    0,
    Math.floor((checkIn.getTime() - standardStart.getTime()) / 60000)
  );
}

// 조퇴 계산 (핵심)
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

  const [h, m] = safeEnd.split(":").map(Number);

  const standardEnd = new Date(checkIn);
  standardEnd.setHours(h, m, 0, 0);

  if (standardEnd.getTime() <= checkIn.getTime()) {
    standardEnd.setDate(standardEnd.getDate() + 1);
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