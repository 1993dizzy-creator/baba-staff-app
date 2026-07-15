export const KEEPING_EXPIRY_WARNING_DAYS = 14;
export const KEEPING_STORAGE_MONTHS = 3;
export const KEEPING_LIST_LIMIT = 20;
export const KEEPING_LIST_MAX_LIMIT = 50;
export const KEEPING_DETAIL_IMAGE_MAX_BYTES = 700 * 1024;
export const KEEPING_THUMBNAIL_MAX_BYTES = 120 * 1024;

export const KEEPING_CLOSE_REASONS = ["finished", "returned", "discarded", "expired", "other"] as const;
export const KEEPING_SORTS = ["recent_activity", "old_activity", "recent_created", "customer_name", "zone", "expiry_soon"] as const;
export type KeepingCloseReason = typeof KEEPING_CLOSE_REASONS[number];
export type KeepingSort = typeof KEEPING_SORTS[number];
export type KeepingStatus = "active" | "closed";

export const isKeepingCloseReason = (value: unknown): value is KeepingCloseReason =>
  typeof value === "string" && (KEEPING_CLOSE_REASONS as readonly string[]).includes(value);
export const isKeepingSort = (value: unknown): value is KeepingSort =>
  typeof value === "string" && (KEEPING_SORTS as readonly string[]).includes(value);

export function maskCustomerIdentifier(value: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length >= 7) return `···· ${digits.slice(-4)}`;
  return trimmed.length > 16 ? `${trimmed.slice(0, 16)}…` : trimmed;
}

export function keepingExpiryState(expiresAt: string | null, now = new Date()) {
  if (!expiresAt) return { isExpirySoon: false, isExpired: false };
  const end = new Date(`${expiresAt}T23:59:59+07:00`);
  const diffDays = (end.getTime() - now.getTime()) / 86_400_000;
  return { isExpired: diffDays < 0, isExpirySoon: diffDays >= 0 && diffDays <= KEEPING_EXPIRY_WARNING_DAYS };
}

export function vietnamToday() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function keepingRemainingDays(expiresAt: string, today = vietnamToday()) {
  const toDayNumber = (value: string) => {
    const [year, month, day] = value.slice(0, 10).split("-").map(Number);
    return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
  };
  return toDayNumber(expiresAt) - toDayNumber(today);
}

export function safeKeepingReturnPath(value: string | null | undefined) {
  if (!value || !/^\/bar\/keeping(?:\?[^#]*)?$/.test(value)) return "/bar/keeping";
  try {
    const url = new URL(value, "https://baba.local");
    return url.origin === "https://baba.local" && url.pathname === "/bar/keeping" ? `${url.pathname}${url.search}` : "/bar/keeping";
  } catch { return "/bar/keeping"; }
}
