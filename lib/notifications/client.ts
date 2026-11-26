// Browser-side notification summary store shared by the header bell and the notification center.
// - One request at a time (in-flight requests are shared, never duplicated).
// - State is keyed by the cached user id; a different user or a logout clears it.
// - A failed request keeps "unknown" (null), never 0, so a failure is not shown as "no unread".
// - The bell polls only while the page is visible (see NotificationBell). Poll, resume and manual
//   refreshes advance `tick`, which the notification center follows to re-read its list.
// - 401/403 drop the cached count: a denied user never keeps seeing earlier data.

export type NotificationSummaryState = {
  userKey: string | null;
  /** null = not known yet; false = notification DB not installed (feature hidden). */
  available: boolean | null;
  unreadCount: number | null;
  failed: boolean;
  /** Advances on every poll / resume / manual refresh (success or not). */
  tick: number;
};

export type NotificationRefreshReason = "poll" | "resume" | "manual" | "change";

export const NOTIFICATION_POLL_MS = 120_000;
export const NOTIFICATIONS_CHANGED_EVENT = "baba_notifications_changed";

const EMPTY: NotificationSummaryState = { userKey: null, available: null, unreadCount: null, failed: false, tick: 0 };
let state: NotificationSummaryState = EMPTY;
let inFlight: { userKey: string; promise: Promise<void>; controller: AbortController } | null = null;
const listeners = new Set<() => void>();

export function readCachedUserKey(): string | null {
  try {
    const raw = window.localStorage.getItem("baba_user");
    if (!raw) return null;
    const id = (JSON.parse(raw) as { id?: unknown })?.id;
    return typeof id === "number" || typeof id === "string" ? String(id) : null;
  } catch {
    return null;
  }
}

function emit(next: NotificationSummaryState) {
  state = next;
  for (const listener of listeners) listener();
}

export function subscribeNotificationSummary(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getNotificationSummary(): NotificationSummaryState {
  return state;
}

export function getServerNotificationSummary(): NotificationSummaryState {
  return EMPTY;
}

/** Drops cached counts and aborts a pending request (logout, user switch). */
export function resetNotificationSummary() {
  inFlight?.controller.abort();
  inFlight = null;
  if (state !== EMPTY) emit(EMPTY);
}

/** Ensures the store belongs to the currently cached user; resets it otherwise. */
export function syncNotificationUser() {
  const userKey = typeof window === "undefined" ? null : readCachedUserKey();
  if (userKey !== state.userKey) {
    inFlight?.controller.abort();
    inFlight = null;
    emit({ ...EMPTY, userKey });
  }
  return userKey;
}

export function refreshNotificationSummary(reason: NotificationRefreshReason = "change"): Promise<void> {
  const userKey = syncNotificationUser();
  if (!userKey) return Promise.resolve();
  const advance = reason !== "change";
  if (inFlight && inFlight.userKey === userKey) {
    // Share the request; still let the center know a periodic/manual refresh happened.
    return advance ? inFlight.promise.then(() => { if (state.userKey === userKey) emit({ ...state, tick: state.tick + 1 }); }) : inFlight.promise;
  }
  const tickOf = () => state.tick + (advance ? 1 : 0);
  const controller = new AbortController();
  const promise = (async () => {
    try {
      const response = await fetch("/api/notifications/summary", { cache: "no-store", signal: controller.signal });
      const json = (await response.json().catch(() => null)) as
        | { ok?: boolean; available?: boolean; unreadCount?: unknown }
        | null;
      if (controller.signal.aborted || state.userKey !== userKey) return;
      if (response.ok && json?.ok === true && json.available === false) {
        emit({ userKey, available: false, unreadCount: null, failed: false, tick: tickOf() });
        return;
      }
      if (response.ok && json?.ok === true && typeof json.unreadCount === "number") {
        emit({ userKey, available: true, unreadCount: json.unreadCount, failed: false, tick: tickOf() });
        return;
      }
      if (response.status === 401 || response.status === 403) {
        emit({ ...state, unreadCount: null, failed: true, tick: tickOf() });
        return;
      }
      // Transient failure: keep the last known count, but mark it as failed.
      emit({ ...state, failed: true, tick: tickOf() });
    } catch {
      if (!controller.signal.aborted && state.userKey === userKey) emit({ ...state, failed: true, tick: tickOf() });
    } finally {
      if (inFlight?.controller === controller) inFlight = null;
    }
  })();
  inFlight = { userKey, promise, controller };
  return promise;
}

/** Called after the center changes read state so the bell refreshes immediately. */
export function announceNotificationsChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
}
