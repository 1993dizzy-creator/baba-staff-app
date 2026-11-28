// Browser side of device Web Push (01-B). Everything is feature-detected; nothing here runs on an
// unsupported browser, and nothing registers a service worker or asks for permission unless the
// staff member clicks "turn on" (enablePushOnThisDevice).
//
// Account safety on a shared device:
// - The server binds a device row to the session that registered it; logout revokes that session's
//   rows (server) and unsubscribes the browser (local).
// - On every app start / user switch, syncPushDevice() reports the browser's existing subscription:
//   if another account owned it, the server revokes that row and this code unsubscribes locally, so
//   the new user never receives the previous user's alerts.
// - A registration answer that arrives after the cached user changed is undone immediately.

import { readCachedUserKey } from "./client.ts";

export type PushSupport = "supported" | "unsupported" | "needs_install";
export type PushServerState = { available: boolean; reason: string | null; publicKey: string | null; activeDevices: number };

const OPT_IN_KEY = "baba_push_opt_in";
const SW_URL = "/sw.js";

function isIos() {
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
}

function isStandalone() {
  try {
    return window.matchMedia?.("(display-mode: standalone)").matches === true
      || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

export function detectPushSupport(): PushSupport {
  if (typeof window === "undefined" || typeof navigator === "undefined") return "unsupported";
  // iOS/iPadOS 16.4+: Web Push exists only for a web app added to the Home Screen.
  if (isIos() && !isStandalone()) return "needs_install";
  if (!window.isSecureContext || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return isIos() ? "needs_install" : "unsupported";
  }
  return "supported";
}

export function currentPermission(): NotificationPermission | "unsupported" {
  return typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported";
}

const withTimeout = <T,>(promise: Promise<T>, ms: number) => Promise.race([
  promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
]);

async function existingSubscription(): Promise<PushSubscription | null> {
  if (detectPushSupport() !== "supported") return null;
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    return (await registration?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

function readOptIn() {
  try { return window.localStorage.getItem(OPT_IN_KEY); } catch { return null; }
}
function writeOptIn(userKey: string | null) {
  try {
    if (userKey) window.localStorage.setItem(OPT_IN_KEY, userKey);
    else window.localStorage.removeItem(OPT_IN_KEY);
  } catch {
    // storage unavailable: the server row remains the source of truth
  }
}

async function rawPost(body: Record<string, unknown>) {
  const response = await fetch("/api/notifications/push", {
    method: "POST", cache: "no-store", credentials: "same-origin",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: response.status, json };
}

/**
 * The server acts only when the signed push device cookie belongs to the current session. A browser
 * whose cookie predates this session gets it from /api/session, then retries once.
 * `stillCurrent` is checked right before EVERY POST (first try and retry): an operation started for
 * an earlier account / superseded by a newer operation never sends anything with the browser's
 * current cookies. The body also names the expected account (expectUserId), which the server checks.
 */
async function postDevice(body: Record<string, unknown>, stillCurrent: () => boolean) {
  const skipped = { status: 0, json: null as Record<string, unknown> | null, skipped: true };
  if (!stillCurrent()) return skipped;
  let result = { ...(await rawPost(body)), skipped: false };
  if (result.status === 409 && result.json?.code === "PUSH_DEVICE_INIT") {
    await fetch("/api/session", { cache: "no-store", credentials: "same-origin" }).catch(() => null);
    if (!stillCurrent()) return skipped;
    result = { ...(await rawPost(body)), skipped: false };
  }
  return result;
}

export async function fetchPushServerState(signal?: AbortSignal): Promise<PushServerState | "denied" | "error"> {
  try {
    const response = await fetch("/api/notifications/push", { cache: "no-store", signal });
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (response.status === 401 || response.status === 403) return "denied";
    if (!response.ok || json?.ok !== true) return "error";
    return {
      available: json.available === true,
      reason: typeof json.reason === "string" ? json.reason : null,
      publicKey: typeof json.publicKey === "string" ? json.publicKey : null,
      activeDevices: Number(json.activeDevices) || 0,
    };
  } catch {
    return "error";
  }
}

function keyBytes(base64Url: string) {
  const padded = base64Url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64Url.length / 4) * 4, "=");
  const raw = atob(padded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function sameKey(subscription: PushSubscription, expected: Uint8Array) {
  const current = subscription.options?.applicationServerKey;
  if (!current) return true; // not exposed by this browser: keep it
  const bytes = new Uint8Array(current);
  return bytes.length === expected.length && bytes.every((value, index) => value === expected[index]);
}

export type EnableResult = "on" | "denied" | "unsupported" | "needs_install" | "unavailable" | "user_changed" | "error";

// Cross-tab operation stamp: enable/disable change it. A passive sync that started before may not
// unsubscribe the browser afterwards (it could drop a subscription another tab just turned on).
const OP_KEY = "baba_push_op";
function readOpStamp() {
  try { return window.localStorage.getItem(OP_KEY) ?? ""; } catch { return ""; }
}
function bumpOpStamp() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try { window.localStorage.setItem(OP_KEY, stamp); } catch { /* single-tab fallback below */ }
  localOpStamp = stamp;
  return stamp;
}
let localOpStamp = "";
const currentOpStamp = () => readOpStamp() || localOpStamp;

/**
 * Must be called directly from a click handler: the permission prompt comes first (Safari requires
 * it inside the user gesture), then the worker registration, subscription and server registration.
 * The account that clicked is sent as expectUserId: if the session changed to another account while
 * the prompt or worker registration was pending, the server refuses (consent is never inherited).
 * A late or refused answer never unsubscribes the browser: it may already serve the next account.
 */
export async function enablePushOnThisDevice(options: { publicKey: string; lang: "ko" | "vi" }): Promise<EnableResult> {
  const support = detectPushSupport();
  if (support !== "supported") return support;
  const userKey = readCachedUserKey();
  const expectUserId = Number(userKey);
  if (!userKey || !Number.isSafeInteger(expectUserId) || expectUserId < 1) return "error";
  const op = bumpOpStamp();
  let permission: NotificationPermission;
  try { permission = await Notification.requestPermission(); } catch { return "error"; }
  if (permission !== "granted") return "denied";
  const stillMine = () => readCachedUserKey() === userKey && currentOpStamp() === op;
  try {
    const registration = await navigator.serviceWorker.register(SW_URL, { scope: "/", updateViaCache: "none" });
    await withTimeout(navigator.serviceWorker.ready, 15000);
    if (!stillMine()) return "user_changed";
    const key = keyBytes(options.publicKey);
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !sameKey(subscription, key)) {
      // Signed for an old server key: unusable for anyone.
      await subscription.unsubscribe().catch(() => false);
      subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    if (!stillMine()) return "user_changed";
    const { status, json } = await postDevice({ action: "subscribe", subscription: subscription.toJSON(), lang: options.lang, expectUserId }, stillMine);
    if (readCachedUserKey() !== userKey || (status === 409 && json?.code === "PUSH_USER_CHANGED")) return "user_changed";
    if (status === 200 && json?.ok === true && json.available === false) return "unavailable";
    if (status !== 200 || json?.ok !== true || json.available !== true) return "error";
    writeOptIn(userKey);
    writeSyncMark(null);
    return "on";
  } catch {
    return "error";
  }
}

export async function disablePushOnThisDevice(): Promise<"off" | "error"> {
  const userKey = readCachedUserKey();
  const op = bumpOpStamp();
  const subscription = await existingSubscription();
  writeOptIn(null);
  writeSyncMark(null);
  if (!subscription) return "off";
  let ok = true;
  try {
    const stillMine = () => !!userKey && readCachedUserKey() === userKey && currentOpStamp() === op;
    const { status, json } = await postDevice({ action: "unsubscribe", endpoint: subscription.endpoint, expectUserId: Number(userKey) }, stillMine);
    ok = status === 200 && json?.ok === true;
  } catch {
    ok = false;
  }
  // Same account and no newer operation: the local unsubscribe also makes the push service reject
  // any later send (404/410 -> revoked).
  if (readCachedUserKey() !== userKey || currentOpStamp() !== op) return ok ? "off" : "error";
  const unsubscribed = await subscription.unsubscribe().catch(() => false);
  return ok || unsubscribed ? "off" : "error";
}

export type DeviceState = "on" | "off";
let syncing: Promise<DeviceState> | null = null;
let syncingKey: string | null = null;

// Cross-tab de-duplication: the result of the last successful sync for (user, language, endpoint)
// is reused for SYNC_REUSE_MS, so tabs, page loads and baba_user refreshes do not repeat it.
const SYNC_MARK_KEY = "baba_push_synced";
const SYNC_REUSE_MS = 10 * 60 * 1000;
type SyncMark = { key: string; state: DeviceState; at: number };

function readSyncMark(key: string): DeviceState | null {
  try {
    const mark = JSON.parse(window.localStorage.getItem(SYNC_MARK_KEY) ?? "null") as SyncMark | null;
    return mark && mark.key === key && Date.now() - mark.at < SYNC_REUSE_MS && (mark.state === "on" || mark.state === "off") ? mark.state : null;
  } catch {
    return null;
  }
}
function writeSyncMark(key: string | null, state?: DeviceState) {
  try {
    if (key && state) window.localStorage.setItem(SYNC_MARK_KEY, JSON.stringify({ key, state, at: Date.now() } satisfies SyncMark));
    else window.localStorage.removeItem(SYNC_MARK_KEY);
  } catch {
    // storage unavailable: sync simply runs again
  }
}

/**
 * Reconciles this browser's subscription with the signed-in user (no prompt, no new worker) and
 * keeps the device language in step with the app language. No subscription = no request.
 * force skips the reuse window (e.g. the user just changed something).
 */
export function syncPushDevice(lang: "ko" | "vi", force = false): Promise<DeviceState> {
  const userKey = typeof window === "undefined" ? null : readCachedUserKey();
  if (!userKey) return Promise.resolve("off");
  const runKey = `${userKey}:${lang}`;
  if (syncing && syncingKey === runKey) return syncing;
  syncingKey = runKey;
  const run = (async (): Promise<DeviceState> => {
    const op = currentOpStamp();
    const subscription = await existingSubscription();
    if (!subscription) return "off";
    const markKey = `${runKey}:${subscription.endpoint}`;
    const reused = force ? null : readSyncMark(markKey);
    if (reused) return reused;
    try {
      const stillMine = () => readCachedUserKey() === userKey && currentOpStamp() === op;
      const { status, json } = await postDevice({ action: "sync", endpoint: subscription.endpoint, lang, expectUserId: Number(userKey) }, stillMine);
      if (readCachedUserKey() !== userKey) return "off";
      if (status !== 200 || json?.ok !== true || json.available !== true) return "off";
      if (json.device === "registered") { writeSyncMark(markKey, "on"); return "on"; }
      // This request is older than the browser's latest login/logout: change nothing.
      if (json.device === "superseded") return "off";
      // Destructive local steps only if nothing newer happened (account, enable/disable in any tab).
      if (readCachedUserKey() !== userKey || currentOpStamp() !== op) return "off";
      if (json.device === "foreign" || readOptIn() !== userKey || currentPermission() !== "granted") {
        // Previous account's (or an abandoned) subscription: drop it locally.
        await subscription.unsubscribe().catch(() => false);
        if (json.device === "foreign") writeOptIn(null);
        writeSyncMark(null);
        return "off";
      }
      // Same user opted in on this device but the row is gone (renewed endpoint / expiry): re-register.
      const again = await postDevice({ action: "subscribe", subscription: subscription.toJSON(), lang, expectUserId: Number(userKey) }, stillMine);
      const state: DeviceState = again.status === 200 && again.json?.ok === true && again.json.available === true ? "on" : "off";
      if (state === "on") writeSyncMark(markKey, "on");
      return state;
    } catch {
      return "off";
    }
  })();
  syncing = run;
  void run.finally(() => { if (syncing === run) { syncing = null; syncingKey = null; } });
  return run;
}

/** Logout: local unsubscribe + opt-in flag + badge (the server revoke runs in /api/logout). */
export async function cleanupPushOnLogout() {
  writeOptIn(null);
  writeSyncMark(null);
  syncing = null;
  syncingKey = null;
  setAppBadgeCount(null);
  try {
    const subscription = await withTimeout(existingSubscription(), 3000);
    if (subscription) await withTimeout(subscription.unsubscribe(), 3000);
  } catch {
    // offline / slow: the server row was revoked (or expires with the session) and is re-checked per send
  }
}

/** Home-screen icon badge where supported; null/0 clears it. Never marks anything read. */
export function setAppBadgeCount(count: number | null) {
  if (typeof navigator === "undefined") return;
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  try {
    if (typeof count === "number" && count > 0 && nav.setAppBadge) void nav.setAppBadge(Math.min(99, Math.floor(count))).catch(() => undefined);
    else if (nav.clearAppBadge) void nav.clearAppBadge().catch(() => undefined);
  } catch {
    // optional API
  }
}
