export type TetOption = "before1" | "before2" | "before3";
export type NationalDayOption = "before" | "after";

const VIETNAM_TIME_ZONE = 7;
const PI = Math.PI;

function integer(value: number) {
  return Math.floor(value);
}

function julianDay(day: number, month: number, year: number) {
  const a = integer((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  let result = day + integer((153 * m + 2) / 5) + 365 * y + integer(y / 4) - integer(y / 100) + integer(y / 400) - 32045;
  if (result < 2299161) result = day + integer((153 * m + 2) / 5) + 365 * y + integer(y / 4) - 32083;
  return result;
}

function dateFromJulianDay(jd: number): [number, number, number] {
  let a: number;
  let b: number;
  let c: number;
  if (jd > 2299160) {
    a = jd + 32044;
    b = integer((4 * a + 3) / 146097);
    c = a - integer((b * 146097) / 4);
  } else {
    b = 0;
    c = jd + 32082;
  }
  const d = integer((4 * c + 3) / 1461);
  const e = c - integer((1461 * d) / 4);
  const m = integer((5 * e + 2) / 153);
  const day = e - integer((153 * m + 2) / 5) + 1;
  const month = m + 3 - 12 * integer(m / 10);
  const year = b * 100 + d - 4800 + integer(m / 10);
  return [day, month, year];
}

function newMoon(k: number) {
  const t = k / 1236.85;
  const t2 = t * t;
  const t3 = t2 * t;
  const dr = PI / 180;
  let jd = 2415020.75933 + 29.53058868 * k + 0.0001178 * t2 - 0.000000155 * t3;
  jd += 0.00033 * Math.sin((166.56 + 132.87 * t - 0.009173 * t2) * dr);
  const m = 359.2242 + 29.10535608 * k - 0.0000333 * t2 - 0.00000347 * t3;
  const mp = 306.0253 + 385.81691806 * k + 0.0107306 * t2 + 0.00001236 * t3;
  const f = 21.2964 + 390.67050646 * k - 0.0016528 * t2 - 0.00000239 * t3;
  let correction = (0.1734 - 0.000393 * t) * Math.sin(m * dr) + 0.0021 * Math.sin(2 * m * dr);
  correction -= 0.4068 * Math.sin(mp * dr) + 0.0161 * Math.sin(2 * mp * dr);
  correction -= 0.0004 * Math.sin(3 * mp * dr);
  correction += 0.0104 * Math.sin(2 * f * dr) - 0.0051 * Math.sin((m + mp) * dr);
  correction -= 0.0074 * Math.sin((m - mp) * dr) + 0.0004 * Math.sin((2 * f + m) * dr);
  correction -= 0.0004 * Math.sin((2 * f - m) * dr) - 0.0006 * Math.sin((2 * f + mp) * dr);
  correction += 0.001 * Math.sin((2 * f - mp) * dr) + 0.0005 * Math.sin((2 * mp + m) * dr);
  const deltaT = t < -11
    ? 0.001 + 0.000839 * t + 0.0002261 * t2 - 0.00000845 * t3 - 0.000000081 * t * t3
    : -0.000278 + 0.000265 * t + 0.000262 * t2;
  return jd + correction - deltaT;
}

function newMoonDay(k: number) {
  return integer(newMoon(k) + 0.5 + VIETNAM_TIME_ZONE / 24);
}

function sunLongitude(jdn: number) {
  const t = (jdn - 2451545.5 - VIETNAM_TIME_ZONE / 24) / 36525;
  const t2 = t * t;
  const dr = PI / 180;
  const m = 357.5291 + 35999.0503 * t - 0.0001559 * t2 - 0.00000048 * t * t2;
  const l0 = 280.46645 + 36000.76983 * t + 0.0003032 * t2;
  let dl = (1.9146 - 0.004817 * t - 0.000014 * t2) * Math.sin(dr * m);
  dl += (0.019993 - 0.000101 * t) * Math.sin(2 * dr * m) + 0.00029 * Math.sin(3 * dr * m);
  let longitude = (l0 + dl) * dr;
  longitude -= PI * 2 * integer(longitude / (PI * 2));
  return integer(longitude / PI * 6);
}

function lunarMonth11(year: number) {
  const off = julianDay(31, 12, year) - 2415021;
  const k = integer(off / 29.530588853);
  let nm = newMoonDay(k);
  if (sunLongitude(nm) >= 9) nm = newMoonDay(k - 1);
  return nm;
}

function leapMonthOffset(a11: number) {
  const k = integer((a11 - 2415021.076998695) / 29.530588853 + 0.5);
  let last = 0;
  let i = 1;
  let arc = sunLongitude(newMoonDay(k + i));
  do {
    last = arc;
    i += 1;
    arc = sunLongitude(newMoonDay(k + i));
  } while (arc !== last && i < 14);
  return i - 1;
}

export function vietnameseLunarToSolar(lunarDay: number, lunarMonth: number, lunarYear: number, lunarLeap = false) {
  if (!Number.isInteger(lunarYear) || lunarYear < 2020 || lunarYear > 2100) throw new RangeError("Unsupported lunar year");
  let a11: number;
  let b11: number;
  if (lunarMonth < 11) {
    a11 = lunarMonth11(lunarYear - 1);
    b11 = lunarMonth11(lunarYear);
  } else {
    a11 = lunarMonth11(lunarYear);
    b11 = lunarMonth11(lunarYear + 1);
  }
  const k = integer(0.5 + (a11 - 2415021.076998695) / 29.530588853);
  let off = lunarMonth - 11;
  if (off < 0) off += 12;
  if (b11 - a11 > 365) {
    const leapOff = leapMonthOffset(a11);
    let leapMonth = leapOff - 2;
    if (leapMonth < 0) leapMonth += 12;
    if (lunarLeap && lunarMonth !== leapMonth) throw new RangeError("Invalid lunar leap month");
    if (lunarLeap || off >= leapOff) off += 1;
  }
  const monthStart = newMoonDay(k + off);
  const [day, month, year] = dateFromJulianDay(monthStart + lunarDay - 1);
  return dateKey(year, month, day);
}

function dateKey(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function addCalendarDays(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function getVietnamHolidayChoices(year: number) {
  if (!Number.isSafeInteger(year) || year < 2020 || year > 2100) throw new RangeError("Unsupported holiday year");
  const tetDay = vietnameseLunarToSolar(1, 1, year);
  const hungKingsDate = vietnameseLunarToSolar(10, 3, year);
  const tetOptions = ([1, 2, 3] as const).map((daysBefore) => {
    const start = addCalendarDays(tetDay, -daysBefore);
    return {
      id: `before${daysBefore}` as TetOption,
      daysBefore,
      dates: Array.from({ length: 5 }, (_, index) => addCalendarDays(start, index)),
    };
  });
  return {
    year,
    tetDay,
    hungKingsDate,
    fixedDates: {
      newYear: `${year}-01-01`,
      reunificationDay: `${year}-04-30`,
      laborDay: `${year}-05-01`,
      nationalDay: `${year}-09-02`,
    },
    tetOptions,
    nationalDayOptions: [
      { id: "before" as const, dates: [`${year}-09-01`, `${year}-09-02`] },
      { id: "after" as const, dates: [`${year}-09-02`, `${year}-09-03`] },
    ],
  };
}

export function resolveVietnamHolidayPreparation(year: number, tetOption: TetOption, nationalDayOption: NationalDayOption) {
  const choices = getVietnamHolidayChoices(year);
  const tet = choices.tetOptions.find((option) => option.id === tetOption);
  const national = choices.nationalDayOptions.find((option) => option.id === nationalDayOption);
  if (!tet || !national) throw new RangeError("Invalid holiday option");
  return {
    hungKingsDate: choices.hungKingsDate,
    tetDates: [...tet.dates],
    nationalDayAdjacentDate: national.dates.find((date) => date !== choices.fixedDates.nationalDay)!,
  };
}
