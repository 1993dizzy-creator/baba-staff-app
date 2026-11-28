import "server-only";
import { after } from "next/server";
import webpush from "web-push";
import { supabaseServer } from "@/lib/supabase/server";
import { getPushConfig } from "./config.ts";
import { isAllowedPushEndpoint } from "./endpoint.ts";
import { buildPushPayload, pushTopic } from "./messages.ts";

// Web Push sender + device storage access (01-B).
//
// Delivery architecture (no cron, no queue service, no in-memory queue):
//   1. notification_upsert_v1 creates the event; a DB trigger enqueues one push_deliveries row per
//      (recipient x active device) in the SAME transaction when the type is enabled + push_enabled.
//   2. The writer schedules dispatchPushDeliveries(id) with Next.js after() (runs after the business
//      response, inside the same invocation). A dispatch failure never turns the business API into a
//      failure.
//   3. Just-in-time rounds: each round claims only what is sent at once (5 rows, FOR UPDATE SKIP
//      LOCKED + claim token; the claim RPC re-checks the full send gate and returns immediately, so
//      no DB transaction or lock is open while the push service is contacted). Right before each
//      send the claim age and the remaining TTL are re-checked; every send is bounded (12 s) and so is
//      its report (5 s), far below the 90 s lease, so a live claim is never re-claimed (no
//      preventable duplicate). A round is reported before the next one is claimed. One dispatch is
//      bounded too (20 s, 10 rounds); anything left waits for recovery.
//   4. Recovery: rows left pending (retry backoff) or sending (process died before reporting) are
//      re-claimed by the same claim RPC with no event filter: one round, scheduled via after() from
//      the bell's unread-count request (instance throttle 60 s) and passed through a DB-wide gate
//      (one scan per 60 s for all instances; an empty queue costs two index probes and no write).
//      Retries progress only while someone has the app open; otherwise rows expire with their 1 hour
//      TTL. Deliberate: no new cron in 01-B.
//
// Inherent duplicate (documented, not preventable): the push service accepted but the report was
// lost (process died / report RPC failed) or a send passed its 12 s bound and was still accepted.
// The row is sent again after the lease or retry; the same Topic/tag replaces it on the device.
//
// Never logged: endpoint, keys, VAPID values, payload text. Logs carry codes and counts only.

const RPC_TIMEOUT_MS = 5000;
export const PUSH_LIMITS = {
  /** Rows claimed per round = rows sent in parallel right after the claim. */
  batch: 5,
  /** Claim lease; must stay far above sendDeadlineMs + report timeout (12 s + 5 s). */
  leaseSeconds: 90,
  /** Socket inactivity timeout given to web-push. */
  sendTimeoutMs: 10_000,
  /** Hard bound on one send, whatever the socket does. */
  sendDeadlineMs: 12_000,
  /** A claim older than this is released without sending (defense in depth). */
  maxClaimAgeMs: 20_000,
  /** Never send with less TTL left than this. */
  minTtlMs: 5_000,
  /** One event dispatch: time budget and rounds. */
  dispatchBudgetMs: 20_000,
  dispatchMaxRounds: 10,
  recoveryIntervalMs: 60_000,
} as const;

type RpcOutcome = { kind: "ok"; data: Record<string, unknown> } | { kind: "missing" } | { kind: "failed" };

const DB_MISSING = new Set(["PGRST202", "42883", "3F000", "42P01", "42703"]);

export async function callPushRpc(fn: string, args: Record<string, unknown>, timeoutMs = RPC_TIMEOUT_MS): Promise<RpcOutcome> {
  try {
    const { data, error } = await supabaseServer.rpc(fn, args).abortSignal(AbortSignal.timeout(timeoutMs));
    if (error) {
      if (DB_MISSING.has(error.code ?? "")) return { kind: "missing" };
      console.error("[PUSH_RPC_ERROR]", { fn, code: error.code });
      return { kind: "failed" };
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return { kind: "failed" };
    return { kind: "ok", data: data as Record<string, unknown> };
  } catch (error) {
    console.error("[PUSH_RPC_EXCEPTION]", { fn, name: (error as Error)?.name });
    return { kind: "failed" };
  }
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

export const pushRpc = {
  status: (actorId: number) => callPushRpc("notification_push_status_v1", { p_actor_user_id: actorId }),
  subscribe: (actorId: number, session: { iat: number; exp: number }, sub: { endpoint: string; p256dh: string; auth: string },
    lang: "ko" | "vi" | null, oldEndpoint: string | null, deviceHash: string) => callPushRpc("notification_push_subscribe_v1", {
    p_actor_user_id: actorId, p_session_iat: session.iat, p_session_expires_at: iso(session.exp),
    p_endpoint: sub.endpoint, p_p256dh: sub.p256dh, p_auth: sub.auth, p_lang: lang, p_old_endpoint: oldEndpoint,
    p_device_hash: deviceHash,
  }),
  unsubscribe: (actorId: number, endpoint: string) => callPushRpc("notification_push_unsubscribe_v1", {
    p_actor_user_id: actorId, p_endpoint: endpoint,
  }),
  sync: (actorId: number, session: { iat: number; exp: number }, endpoint: string, lang: "ko" | "vi" | null, deviceHash: string) =>
    callPushRpc("notification_push_sync_v1", {
      p_actor_user_id: actorId, p_session_iat: session.iat, p_session_expires_at: iso(session.exp), p_endpoint: endpoint,
      p_lang: lang, p_device_hash: deviceHash,
    }),
  open: (actorId: number, notificationId: number) => callPushRpc("notification_push_open_v1", {
    p_actor_user_id: actorId, p_notification_id: notificationId,
  }),
};

// ---------------------------------------------------------------------------------------------
// Session lifecycle (logout / refresh). Never throws; never changes the session outcome.
// ---------------------------------------------------------------------------------------------

type SessionLike = { v: number; uid: string; iat?: number; exp: number };

/**
 * Logout: awaited with a short timeout so the device stops receiving before the reply. Records the
 * revocation (this device when its push cookie is known, else the whole session), so a registration
 * request still in flight is refused when it arrives.
 */
export async function revokePushSession(session: SessionLike | null | undefined, deviceHash: string | null = null) {
  if (!session || session.v !== 2 || !session.iat) return { status: "skipped" as const };
  const outcome = await callPushRpc("notification_push_session_revoke_v1", {
    p_user_id: Number(session.uid), p_session_iat: session.iat, p_device_hash: deviceHash,
  }, 2000);
  return { status: outcome.kind };
}

/** Normal session refresh: device rows of that session follow the new idle expiry. */
export function schedulePushSessionTouch(session: { uid: string; iat: number; exp: number }) {
  const run = () => callPushRpc("notification_push_session_touch_v1", {
    p_user_id: Number(session.uid), p_session_iat: session.iat, p_session_expires_at: iso(session.exp),
  }).then(() => undefined);
  try { after(run); } catch { /* outside a request scope: the next refresh retries */ }
}

// ---------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------

type ClaimedDelivery = {
  deliveryId: number; claimToken: string; notificationId: number; typeCode: string; severity: string;
  lang: string; attempt: number; ttlSeconds: number; unreadCount: number;
  endpoint: string; p256dh: string; auth: string;
};
/** Local clock of the claim answer: claim age and remaining TTL are measured from it. */
type Claimed = ClaimedDelivery & { claimedAtMs: number };

export type PushReport = {
  outcome: "accepted" | "retry" | "gone" | "failed" | "expired";
  httpStatus: number | null; retryAfterSeconds: number | null; errorCode: string | null;
};

function retryAfterSeconds(headers: unknown): number | null {
  const raw = headers && typeof headers === "object" ? (headers as Record<string, unknown>)["retry-after"] : undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !value.trim()) return null;
  if (/^\d{1,6}$/.test(value.trim())) return Number(value.trim());
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : null;
}

/** Maps a push service answer (or a transport error) to the delivery state machine. */
export function classifyPushResult(result: { statusCode?: number; headers?: unknown } | null, error?: unknown): PushReport {
  const status = result?.statusCode ?? (error as { statusCode?: number } | undefined)?.statusCode;
  const headers = result?.headers ?? (error as { headers?: unknown } | undefined)?.headers;
  if (typeof status !== "number") return { outcome: "retry", httpStatus: null, retryAfterSeconds: null, errorCode: "network_error" };
  if (status >= 200 && status < 300) return { outcome: "accepted", httpStatus: status, retryAfterSeconds: null, errorCode: null };
  if (status === 404 || status === 410) return { outcome: "gone", httpStatus: status, retryAfterSeconds: null, errorCode: "subscription_gone" };
  if (status === 429) return { outcome: "retry", httpStatus: status, retryAfterSeconds: retryAfterSeconds(headers), errorCode: "rate_limited" };
  if (status >= 500) return { outcome: "retry", httpStatus: status, retryAfterSeconds: retryAfterSeconds(headers), errorCode: "push_service_error" };
  if (status === 401 || status === 403) return { outcome: "failed", httpStatus: status, retryAfterSeconds: null, errorCode: "vapid_rejected" };
  if (status === 413) return { outcome: "failed", httpStatus: status, retryAfterSeconds: null, errorCode: "payload_too_large" };
  return { outcome: "failed", httpStatus: status, retryAfterSeconds: null, errorCode: "request_rejected" };
}

async function report(item: Claimed, result: PushReport) {
  return callPushRpc("notification_push_report_v1", {
    p_delivery_id: item.deliveryId, p_claim_token: item.claimToken, p_outcome: result.outcome,
    p_http_status: result.httpStatus, p_retry_after_seconds: result.retryAfterSeconds, p_error_code: result.errorCode,
  });
}

const SEND_DEADLINE = Symbol("send_deadline");

async function sendOne(item: Claimed, config: Extract<ReturnType<typeof getPushConfig>, { ok: true }>, now: () => number): Promise<PushReport> {
  if (!isAllowedPushEndpoint(item.endpoint)) {
    return { outcome: "failed", httpStatus: null, retryAfterSeconds: null, errorCode: "endpoint_rejected" };
  }
  // Right before the network call: a stale claim is released unsent; an exhausted TTL is never sent.
  const age = now() - item.claimedAtMs;
  if (age > PUSH_LIMITS.maxClaimAgeMs) {
    return { outcome: "retry", httpStatus: null, retryAfterSeconds: null, errorCode: "claim_too_old" };
  }
  const remainingMs = item.ttlSeconds * 1000 - age;
  if (remainingMs < PUSH_LIMITS.minTtlMs) {
    return { outcome: "expired", httpStatus: null, retryAfterSeconds: null, errorCode: "ttl_expired" };
  }
  const payload = buildPushPayload({ notificationId: item.notificationId, typeCode: item.typeCode, lang: item.lang, unreadCount: item.unreadCount });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      webpush.sendNotification(
        { endpoint: item.endpoint, keys: { p256dh: item.p256dh, auth: item.auth } },
        JSON.stringify(payload),
        {
          vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
          TTL: Math.max(1, Math.min(3600, Math.floor(remainingMs / 1000))),
          topic: pushTopic(item.notificationId),
          urgency: item.severity === "urgent" ? "high" : "normal",
          timeout: PUSH_LIMITS.sendTimeoutMs,
        },
      ),
      new Promise<typeof SEND_DEADLINE>((resolve) => { timer = setTimeout(() => resolve(SEND_DEADLINE), PUSH_LIMITS.sendDeadlineMs); }),
    ]);
    // The push service may still accept after the bound: inherent duplicate risk (same Topic/tag).
    if (response === SEND_DEADLINE) return { outcome: "retry", httpStatus: null, retryAfterSeconds: null, errorCode: "send_timeout" };
    return classifyPushResult(response);
  } catch (error) {
    return classifyPushResult(null, error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type DispatchSummary =
  | { status: "disabled"; reason: string }
  | { status: "not_installed" | "failed" }
  | { status: "ok"; rounds: number; claimed: number; skipped: number; accepted: number; retry: number; gone: number;
      failed: number; expired: number; unreported: number; throttled: boolean };

/**
 * Claims and sends due deliveries in just-in-time rounds: one event (after creation, within the
 * dispatch budget) or any event (recovery, null: a single round).
 */
export async function dispatchPushDeliveries(options: { notificationId: number | null; now?: () => number }): Promise<DispatchSummary> {
  const config = getPushConfig();
  if (!config.ok) return { status: "disabled", reason: config.reason };
  const now = options.now ?? Date.now;
  const started = now();
  const summary = { status: "ok" as const, rounds: 0, claimed: 0, skipped: 0, accepted: 0, retry: 0, gone: 0, failed: 0,
    expired: 0, unreported: 0, throttled: false };
  const maxRounds = options.notificationId === null ? 1 : PUSH_LIMITS.dispatchMaxRounds;
  while (summary.rounds < maxRounds && now() - started < PUSH_LIMITS.dispatchBudgetMs) {
    summary.rounds += 1;
    const claim = await callPushRpc("notification_push_claim_v1", {
      p_notification_id: options.notificationId, p_limit: PUSH_LIMITS.batch, p_lease_seconds: PUSH_LIMITS.leaseSeconds,
    });
    if (claim.kind === "missing") return { status: "not_installed" };
    if (claim.kind === "failed" || claim.data.status !== "ok" || !Array.isArray(claim.data.items)) {
      return summary.claimed || summary.skipped ? summary : { status: "failed" };
    }
    const claimedAtMs = now();
    const items: Claimed[] = (claim.data.items as ClaimedDelivery[]).map((item) => ({ ...item, claimedAtMs }));
    const skipped = Number(claim.data.skipped) || 0;
    summary.claimed += items.length;
    summary.skipped += skipped;
    summary.throttled ||= claim.data.throttled === true;
    await Promise.all(items.map(async (item) => {
      const result = await sendOne(item, config, now);
      summary[result.outcome] += 1;
      const recorded = await report(item, result);
      if (recorded.kind !== "ok" || recorded.data.status !== "ok") summary.unreported += 1;
    }));
    if (items.length + skipped < PUSH_LIMITS.batch) break;
  }
  if (summary.claimed || summary.skipped) {
    console.info("[PUSH_DISPATCH]", { scope: options.notificationId === null ? "recovery" : "event", ...summary });
  }
  return summary;
}

/** After an event is created: send in after() so the business response is never delayed or failed. */
export function schedulePushDispatch(notificationId: number) {
  if (!getPushConfig().ok) return false;
  try {
    after(() => dispatchPushDeliveries({ notificationId }).then(() => undefined));
    return true;
  } catch {
    // Outside a request scope (e.g. a script): the recovery entry point picks the rows up.
    return false;
  }
}

let lastRecoveryAt = 0;
/**
 * Limited recovery piggybacking on the bell's count request (after the response): nothing while push
 * is off or not configured, at most once a minute per instance, and the claim RPC adds a DB-wide
 * gate across instances (an empty queue: two index probes, no write).
 */
export function schedulePushRecovery(now = Date.now()) {
  if (!getPushConfig().ok || now - lastRecoveryAt < PUSH_LIMITS.recoveryIntervalMs) return false;
  lastRecoveryAt = now;
  try {
    after(() => dispatchPushDeliveries({ notificationId: null }).then(() => undefined));
    return true;
  } catch {
    return false;
  }
}
