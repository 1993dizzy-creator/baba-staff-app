export type PayrollOverviewPeriod = {
  month: string;
  asOfDate: string;
  calculationEndDate: string | null;
  future: boolean;
  levelAsOfDate: string;
};

const vietnamDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function getVietnamDateKey(now = new Date()) {
  return vietnamDateFormatter.format(now);
}

export function getPayrollOverviewPeriod(month: string, today = getVietnamDateKey()): PayrollOverviewPeriod {
  const [year, monthNumber] = month.split("-").map(Number);
  const monthEnd = `${month}-${String(new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()).padStart(2, "0")}`;
  const todayMonth = today.slice(0, 7);
  if (month > todayMonth) return { month, asOfDate: `${month}-01`, calculationEndDate: null, future: true, levelAsOfDate: today };
  if (month === todayMonth) return { month, asOfDate: today, calculationEndDate: today, future: false, levelAsOfDate: today };
  return { month, asOfDate: monthEnd, calculationEndDate: monthEnd, future: false, levelAsOfDate: monthEnd };
}
