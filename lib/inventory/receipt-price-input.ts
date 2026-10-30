// Keep the decimal text (including a trailing dot/zeros) intact while grouping
// only the integer part. Scientific notation remains valid as in type=number.
export function formatReceiptPriceInput(value: string): string | null {
  const raw = value.replace(/[,\s]/g, "");
  if (!/^\d*(?:\.\d*)?(?:[eE][+-]?\d*)?$/.test(raw)) return null;
  const [mantissa, exponent] = raw.split(/(?=[eE])/);
  const [integer, fraction] = mantissa.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return grouped + (fraction === undefined ? "" : `.${fraction}`) + (exponent ?? "");
}

export function receiptPriceCaret(value: string, offset: number, formatted: string): number {
  const count = value.slice(0, offset).replace(/[,\s]/g, "").length;
  let cursor = 0, seen = 0;
  while (cursor < formatted.length && seen < count) {
    if (formatted[cursor] !== ",") seen++;
    cursor++;
  }
  return cursor;
}
