export function minutesToHoursInput(minutes: number) {
  return Number.isFinite(minutes) ? String(minutes / 60) : "";
}

export function hoursInputToMinutes(value: string) {
  const hours = Number(value);
  const minutes = hours * 60;
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 || !Number.isInteger(minutes)) {
    return null;
  }
  return minutes;
}

export function integerInputDigits(value: string) {
  return value.replace(/\D/g, "");
}

export function formatIntegerInput(value: string) {
  return integerInputDigits(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function signedAmount(value: number, vi: boolean) {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  const amount = Math.abs(value).toLocaleString("en-US");
  return vi ? `${sign}${amount}₫` : `${sign}${amount}동`;
}

export function currencyAmount(value: number, vi: boolean) {
  const amount = Math.max(0, value).toLocaleString("en-US");
  return vi ? `${amount}₫` : `${amount}동`;
}

export function resolveFixedRaiseReason(currentAmount: number, nextAmount: number, reason: unknown) {
  const changed = currentAmount !== nextAmount;
  const normalized = typeof reason === "string" ? reason.trim() : "";
  return {
    changed,
    valid: !changed || normalized.length > 0,
    note: changed && normalized ? normalized : null,
  };
}

export function isMonthFirstDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])-01$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
