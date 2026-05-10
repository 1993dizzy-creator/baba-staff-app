export const BUSINESS_TIME_ZONE = "Asia/Ho_Chi_Minh";
export const BUSINESS_TIMEZONE_OFFSET = "+07:00";
export const BUSINESS_DAY_START_HOUR = 16;
export const BUSINESS_DAY_END_HOUR = 3;

type VietnamDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const vietnamDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  hourCycle: "h23",
});

export function formatDateKey(date: Date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}`;
}

export function getVietnamDateParts(baseDate = new Date()): VietnamDateParts {
  const parts = vietnamDateTimeFormatter.formatToParts(baseDate);
  const partMap = new Map(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(partMap.get("year")),
    month: Number(partMap.get("month")),
    day: Number(partMap.get("day")),
    hour: Number(partMap.get("hour")),
    minute: Number(partMap.get("minute")),
    second: Number(partMap.get("second")),
  };
}

const formatVietnamDateKey = (parts: Pick<VietnamDateParts, "year" | "month" | "day">) => {
  const yyyy = String(parts.year);
  const mm = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}`;
};

const addDaysToBusinessDate = (dateKey: string, days: number) => {
  const date = new Date(`${dateKey}T12:00:00${BUSINESS_TIMEZONE_OFFSET}`);
  date.setUTCDate(date.getUTCDate() + days);

  return formatVietnamDateKey(getVietnamDateParts(date));
};

export function getBusinessDate(baseDate = new Date()) {
  const vietnamParts = getVietnamDateParts(baseDate);
  const dateKey = formatVietnamDateKey(vietnamParts);

  if (vietnamParts.hour < BUSINESS_DAY_END_HOUR) {
    return addDaysToBusinessDate(dateKey, -1);
  }

  return dateKey;
}

export function getBusinessWindowByBusinessDate(businessDate: string) {
  const nextBusinessDate = addDaysToBusinessDate(businessDate, 1);

  return {
    start: new Date(
      `${businessDate}T${String(BUSINESS_DAY_START_HOUR).padStart(2, "0")}:00:00${BUSINESS_TIMEZONE_OFFSET}`
    ),
    end: new Date(
      `${nextBusinessDate}T${String(BUSINESS_DAY_END_HOUR).padStart(2, "0")}:00:00${BUSINESS_TIMEZONE_OFFSET}`
    ),
  };
}

export function getBusinessWindow(baseDate = new Date()) {
  return getBusinessWindowByBusinessDate(getBusinessDate(baseDate));
}

export function isInCurrentBusinessDay(
  value?: string | null,
  baseDate = new Date()
) {
  if (!value) return false;

  const date = new Date(value);
  const { start, end } = getBusinessWindow(baseDate);

  return date >= start && date < end;
}

export function getSnapshotBusinessDate(baseDate = new Date()) {
  const vietnamParts = getVietnamDateParts(baseDate);
  return addDaysToBusinessDate(formatVietnamDateKey(vietnamParts), -1);
}
