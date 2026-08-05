const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const VIETNAM_TIMEZONE = "Asia/Ho_Chi_Minh";
const VIETNAM_OFFSET = "+07:00";

export type AttendancePolicyStatus =
  | "working"
  | "done"
  | "late"
  | "early_leave";

export type AttendancePolicyInput = {
  businessDate: string;
  timezone: string;
  businessDayCutoffTime: string;
  settingsRevision: number | null;
  scheduledStartTime: string | null;
  scheduledEndTime: string | null;
  storeOpenTime: string | null;
  storeCloseTime: string | null;
  lateGraceMinutes: number;
  earlyLeaveGraceMinutes: number;
  missingCheckoutGraceMinutes: number;
  overrideCloseTime: string | null;
  checkInAt: string | null;
  checkOutAt: string | null;
  now?: string;
};

export type AttendancePolicyResult = {
  businessDate: string;
  rawLateMinutes: number;
  lateMinutes: number;
  rawEarlyLeaveMinutes: number;
  earlyLeaveMinutes: number;
  status: AttendancePolicyStatus;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  /** 기준 퇴근시간 = min(직원 예정 퇴근시간, 실제 매장 마감시간[특별 조기마감 우선]). */
  normalCheckoutThresholdAt: string | null;
  /** normalCheckoutThresholdAt - earlyLeaveGraceMinutes. */
  earlyLeaveThresholdAt: string | null;
  scheduledStoreCloseAt: string | null;
  overrideCloseAt: string | null;
  effectiveStoreCloseAt: string | null;
  unresolvedAt: string | null;
  unresolved: boolean;
  source: {
    settingsRevision: number | null;
    close: "override" | "configured" | "fallback";
  };
};

function assertDateKey(value: string) {
  if (!DATE_KEY_RE.test(value)) throw new Error("Invalid business date");
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error("Invalid business date");
  }
}

function assertTime(value: string, name: string) {
  if (!TIME_RE.test(value)) throw new Error(`Invalid ${name}`);
}

function timeMinutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function addDateDays(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function instantAt(
  businessDate: string,
  time: string | null,
  cutoff: string
) {
  if (time === null) return null;
  assertTime(time, "time");
  const calendarDate =
    timeMinutes(time) < timeMinutes(cutoff)
      ? addDateDays(businessDate, 1)
      : businessDate;
  return new Date(`${calendarDate}T${time}:00${VIETNAM_OFFSET}`).toISOString();
}

function minutesBetween(start: string | null, end: string | null) {
  if (!start || !end) return 0;
  const value = Math.floor(
    (new Date(end).getTime() - new Date(start).getTime()) / 60_000
  );
  return Math.max(0, value);
}

function earlierInstant(left: string | null, right: string | null) {
  if (!left) return right;
  if (!right) return left;
  return new Date(left).getTime() <= new Date(right).getTime() ? left : right;
}

export function calculateAttendanceBusinessDate(input: {
  timestamp: string | Date;
  timezone: string;
  cutoffTime: string;
}) {
  if (input.timezone !== VIETNAM_TIMEZONE) {
    throw new Error("Unsupported attendance timezone");
  }
  assertTime(input.cutoffTime, "cutoff time");
  const value =
    input.timestamp instanceof Date
      ? input.timestamp
      : new Date(input.timestamp);
  if (!Number.isFinite(value.getTime())) throw new Error("Invalid timestamp");

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: input.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value);
  const dateKey = `${part("year")}-${String(part("month")).padStart(2, "0")}-${String(part("day")).padStart(2, "0")}`;
  const currentMinutes = part("hour") * 60 + part("minute");

  return currentMinutes < timeMinutes(input.cutoffTime)
    ? addDateDays(dateKey, -1)
    : dateKey;
}

export function evaluateAttendancePolicy(
  input: AttendancePolicyInput
): AttendancePolicyResult {
  assertDateKey(input.businessDate);
  if (input.timezone !== VIETNAM_TIMEZONE) {
    throw new Error("Unsupported attendance timezone");
  }
  assertTime(input.businessDayCutoffTime, "cutoff time");
  if (
    !Number.isInteger(input.lateGraceMinutes) ||
    input.lateGraceMinutes < 0 ||
    input.lateGraceMinutes > 180
  ) {
    throw new Error("Invalid late grace minutes");
  }
  if (
    !Number.isInteger(input.earlyLeaveGraceMinutes) ||
    input.earlyLeaveGraceMinutes < 0 ||
    input.earlyLeaveGraceMinutes > 180
  ) {
    throw new Error("Invalid early leave grace minutes");
  }
  if (
    !Number.isInteger(input.missingCheckoutGraceMinutes) ||
    input.missingCheckoutGraceMinutes < 0 ||
    input.missingCheckoutGraceMinutes > 360
  ) {
    throw new Error("Invalid missing checkout grace minutes");
  }

  const scheduledStartAt = instantAt(
    input.businessDate,
    input.scheduledStartTime,
    input.businessDayCutoffTime
  );
  const scheduledEndAt = instantAt(
    input.businessDate,
    input.scheduledEndTime,
    input.businessDayCutoffTime
  );
  const scheduledStoreCloseAt = instantAt(
    input.businessDate,
    input.storeCloseTime,
    input.businessDayCutoffTime
  );
  const overrideCloseAt = instantAt(
    input.businessDate,
    input.overrideCloseTime,
    input.businessDayCutoffTime
  );
  // 특별 조기마감이 있으면 그 시각이 실제 매장 마감시간이 되고, 없으면 요일별
  // 매장 마감시간을 쓴다. default_normal_checkout_time은 더 이상 참조하지 않는다.
  const effectiveStoreCloseAt = overrideCloseAt ?? scheduledStoreCloseAt;
  // 기준 퇴근시간 = 직원 예정 퇴근시간과 실제 매장 마감시간 중 더 이른 시간.
  const normalCheckoutThresholdAt = earlierInstant(
    scheduledEndAt,
    effectiveStoreCloseAt
  );
  const earlyLeaveThresholdAt = normalCheckoutThresholdAt
    ? new Date(
        new Date(normalCheckoutThresholdAt).getTime() -
          input.earlyLeaveGraceMinutes * 60_000
      ).toISOString()
    : null;
  const unresolvedAt = normalCheckoutThresholdAt
    ? new Date(
        new Date(normalCheckoutThresholdAt).getTime() +
          input.missingCheckoutGraceMinutes * 60_000
      ).toISOString()
    : null;

  const rawLateMinutes = minutesBetween(scheduledStartAt, input.checkInAt);
  const lateMinutes =
    rawLateMinutes > input.lateGraceMinutes ? rawLateMinutes : 0;
  const rawEarlyLeaveMinutes =
    input.checkOutAt && normalCheckoutThresholdAt
      ? minutesBetween(input.checkOutAt, normalCheckoutThresholdAt)
      : 0;
  // 조퇴 유예는 판정 threshold가 아니라 공제되는 허용 시간이다: 유예분을 raw 조기
  // 퇴근분에서 제외한 나머지만 조퇴로 인정한다(예: raw 90분, 유예 60분 → 조퇴 30분).
  const earlyLeaveMinutes = Math.max(
    0,
    rawEarlyLeaveMinutes - input.earlyLeaveGraceMinutes
  );

  let status: AttendancePolicyStatus;
  if (!input.checkOutAt) status = "working";
  else if (earlyLeaveMinutes > 0) status = "early_leave";
  else if (lateMinutes > 0) status = "late";
  else status = "done";

  const now = input.now ? new Date(input.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid now");
  const unresolved = Boolean(
    input.checkInAt &&
      !input.checkOutAt &&
      unresolvedAt &&
      now.getTime() >= new Date(unresolvedAt).getTime()
  );

  return {
    businessDate: input.businessDate,
    rawLateMinutes,
    lateMinutes,
    rawEarlyLeaveMinutes,
    earlyLeaveMinutes,
    status,
    scheduledStartAt,
    scheduledEndAt,
    normalCheckoutThresholdAt,
    earlyLeaveThresholdAt,
    scheduledStoreCloseAt,
    overrideCloseAt,
    effectiveStoreCloseAt,
    unresolvedAt,
    unresolved,
    source: {
      settingsRevision: input.settingsRevision,
      close: input.overrideCloseTime
        ? "override"
        : input.storeCloseTime
          ? "configured"
          : "fallback",
    },
  };
}
