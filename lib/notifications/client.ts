// Browser-side notification summary store shared by the header bell and the notification center.
// - One request at a time (in-flight requests are shared, never duplicated).
// - State is keyed by the cached user id; a different user or a logout clears it.
// - A failed request keeps "unknown" (null), never 0, so a failure is not shown as "no unread".
// - The bell polls only while the page is visible (see NotificationBell).

export type NotificationSummaryState = {
  userKey: string | null;
  /** null = not known yet; false = notification DB not installed (feature hidden). */
  available: boolean | null;
  unreadCount: number | null;
  failed: boolean;
};

export const NOTIFICATION_POLL_MS = 120_000;
export const NOTIFICATIONS_CHANGED_EVENT = "baba_notifications_changed";

const EMPTY: NotificationSummaryState = { userKey: null, available: null, unreadCount: null, failed: false };
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

export function refreshNotificationSummary(): Promise<void> {
  const userKey = syncNotificationUser();
  if (!userKey) return Promise.resolve();
  if (inFlight && inFlight.userKey === userKey) return inFlight.promise;
  const controller = new AbortController();
  const promise = (async () => {
    try {
      const response = await fetch("/api/notifications/summary", { cache: "no-store", signal: controller.signal });
      const json = (await response.json().catch(() => null)) as
        | { ok?: boolean; available?: boolean; unreadCount?: unknown }
        | null;
      if (controller.signal.aborted || state.userKey !== userKey) return;
      if (response.ok && json?.ok === true && json.available === false) {
        emit({ userKey, available: false, unreadCount: null, failed: false });
        return;
      }
      if (response.ok && json?.ok === true && typeof json.unreadCount === "number") {
        emit({ userKey, available: true, unreadCount: json.unreadCount, failed: false });
        return;
      }
      // Keep the last known count, but mark it as failed.
      emit({ ...state, failed: true });
    } catch {
      if (!controller.signal.aborted && state.userKey === userKey) emit({ ...state, failed: true });
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
