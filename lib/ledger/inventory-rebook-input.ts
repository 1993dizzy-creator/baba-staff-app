const DATE = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT = /^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/;

export function isLedgerCalendarDate(value: string) {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

export function parseInventoryRebookAmount(value: unknown) {
  const text = typeof value === "number"
    ? String(value)
    : typeof value === "string" ? value.trim() : "";
  if (!AMOUNT.test(text) || /^0(?:\.0{1,3})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  const integer = BigInt(whole);
  if (integer > max || (integer === max && /[1-9]/.test(fraction))) return null;
  return text;
}
