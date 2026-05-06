export const BUSINESS_DAY_START_HOUR = 16;
export const BUSINESS_DAY_END_HOUR = 3;

const getDateString = (date: Date) => {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}`;
};

const getVietnamDate = (baseDate = new Date()) => {
  return new Date(
    baseDate.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" })
  );
};

const getVietnamDateString = (baseDate = new Date(), offsetDays = 0) => {
  const date = getVietnamDate(baseDate);
  date.setDate(date.getDate() + offsetDays);

  return getDateString(date);
};

export const getBusinessWindow = (baseDate = new Date()) => {
  const start = new Date(baseDate);
  const end = new Date(baseDate);

  if (baseDate.getHours() < BUSINESS_DAY_END_HOUR) {
    start.setDate(start.getDate() - 1);
    start.setHours(BUSINESS_DAY_START_HOUR, 0, 0, 0);

    end.setHours(BUSINESS_DAY_END_HOUR, 0, 0, 0);
  } else {
    start.setHours(BUSINESS_DAY_START_HOUR, 0, 0, 0);

    end.setDate(end.getDate() + 1);
    end.setHours(BUSINESS_DAY_END_HOUR, 0, 0, 0);
  }

  return { start, end };
};

export const isInCurrentBusinessDay = (value?: string | null) => {
  if (!value) return false;

  const date = new Date(value);
  const { start, end } = getBusinessWindow();

  return date >= start && date < end;
};

export const getBusinessDate = (baseDate = new Date()) => {
  const date = new Date(baseDate);

  if (date.getHours() < BUSINESS_DAY_END_HOUR) {
    date.setDate(date.getDate() - 1);
  }

  return getDateString(date);
};

export const getSnapshotDate = (baseDate = new Date()) => {
  return getVietnamDateString(baseDate, -1);
};
