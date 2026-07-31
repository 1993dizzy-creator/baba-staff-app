export function vietnamCurrentMonthStart(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const value = (type: "year" | "month") =>
    parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-01`;
}
