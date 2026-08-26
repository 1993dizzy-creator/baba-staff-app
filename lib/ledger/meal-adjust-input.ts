const AMOUNT = /^(0|[1-9]\d{0,12})(?:\.(\d{1,3}))?$/;

export function parseMealFinalAmount(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  if (!AMOUNT.test(normalized)) return null;
  return normalized;
}
