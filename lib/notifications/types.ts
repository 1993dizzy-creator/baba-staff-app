// Common notification contracts (01-A in-app center; 01-B Web Push reuses ids, recipients,
// type codes, dedupe keys and the internal href contract).

export const NOTIFICATION_SEVERITIES = ["urgent", "warning", "normal"] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export const NOTIFICATION_FILTERS = ["all", "unread", "open", "resolved"] as const;
export type NotificationFilter = (typeof NOTIFICATION_FILTERS)[number];

export const NOTIFICATION_DOMAINS = [
  "attendance", "inventory", "sales", "pos", "tables", "reservations", "payroll", "ledger", "system",
] as const;
export type NotificationDomain = (typeof NOTIFICATION_DOMAINS)[number];

export const NOTIFICATION_PAGE_SIZE = 30;
export const NOTIFICATION_UNREAD_CAP = 100;

export type NotificationItem = {
  id: number;
  typeCode: string;
  domain: NotificationDomain | string;
  severity: NotificationSeverity;
  titleKo: string;
  titleVi: string;
  bodyKo: string | null;
  bodyVi: string | null;
  subjectType: string | null;
  subjectId: string | null;
  href: string | null;
  status: "open" | "resolved";
  firstObservedAt: string;
  lastObservedAt: string;
  resolvedAt: string | null;
  readAt: string | null;
};

export type NotificationTypePolicy = {
  code: string;
  domain: string;
  accessRoles: string[];
  defaultSeverity: NotificationSeverity;
  enabled: boolean;
  inAppEnabled: boolean;
  rules: { groups: Array<{ roles: string[]; positions: string[]; parts: string[] }>; userIds: number[] };
  revision: number;
  updatedAt: string;
  updatedByName: string | null;
  matchedUserIds: number[];
};

export type NotificationStaff = {
  id: number;
  name: string;
  role: string | null;
  position: string | null;
  part: string | null;
};

export type NotificationPolicyAudit = {
  id: number;
  typeCode: string;
  revision: number;
  changedAt: string;
  actorName: string | null;
};

const TYPE_CODE = /^[a-z][a-z0-9_]{0,39}(\.[a-z][a-z0-9_]{0,59})+$/;
const DEDUPE_KEY = /^[A-Za-z0-9:_./-]{1,200}$/;
const HREF = /^\/[A-Za-z0-9/_.~%=&?#-]*$/;

export const isNotificationTypeCode = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 100 && TYPE_CODE.test(value);
export const isNotificationDedupeKey = (value: unknown): value is string =>
  typeof value === "string" && DEDUPE_KEY.test(value);
export const isNotificationFilter = (value: unknown): value is NotificationFilter =>
  NOTIFICATION_FILTERS.includes(value as NotificationFilter);
export const isNotificationId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * Internal app path only (same rule as the DB check constraint): starts with a single "/",
 * no scheme/host, no "//", no "..", no backslash or whitespace, at most 300 characters.
 */
export function isSafeInternalHref(value: unknown): value is string {
  return typeof value === "string" && value.length <= 300 && HREF.test(value)
    && !value.includes("//") && !value.includes("..");
}

/** Count shown on the bell: hidden at 0, "99+" from 100 (the server caps at 100). */
export function formatUnreadBadge(count: number | null | undefined) {
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return null;
  return count > 99 ? "99+" : String(Math.floor(count));
}
