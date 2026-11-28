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
//      response, inside the same invocation) or awaits it explicitly. A dispatch failure never turns
//      the business API into a failure.
//   3. Claim (FOR UPDATE SKIP LOCKED + claim token) re-checks the full send gate, then each claimed
//      row is sent once and its result reported (accepted / retry / gone / failed).
//   4. Recovery: rows left pending (retry backoff) or sending (process died before reporting) are
//      re-claimed by the same claim RPC with no event filter. It runs via after() from the bell's
//      unread-count request (at most once a minute per server instance), so retries progress only
//      while someone has the app open. Without an open app nothing retries; rows then expire with
//      their 1 hour TTL. This is documented, deliberate (no new cron in 01-B).
//
// Never logged: endpoint, keys, VAPID values, payload text. Logs carry codes and counts only.

const RPC_TIMEOUT_MS = 5000;
const SEND_TIMEOUT_MS = 10_000;
const CLAIM_LEASE_SECONDS = 120;
const SEND_CONCURRENCY = 5;
const RECOVERY_INTERVAL_MS = 60_000;

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
    lang: "ko" | "vi" | null, oldEndpoint: string | null) => callPushRpc("notification_push_subscribe_v1", {
    p_actor_user_id: actorId, p_session_iat: session.iat, p_session_expires_at: iso(session.exp),
    p_endpoint: sub.endpoint, p_p256dh: sub.p256dh, p_auth: sub.auth, p_lang: lang, p_old_endpoint: oldEndpoint,
  }),
  unsubscribe: (actorId: number, endpoint: string) => callPushRpc("notification_push_unsubscribe_v1", {
    p_actor_user_id: actorId, p_endpoint: endpoint,
  }),
  sync: (actorId: number, session: { iat: number; exp: number }, endpoint: string) => callPushRpc("notification_push_sync_v1", {
    p_actor_user_id: actorId, p_session_iat: session.iat, p_session_expires_at: iso(session.exp), p_endpoint: endpoint,
  }),
  open: (actorId: number, notificationId: number) => callPushRpc("notification_push_open_v1", {
    p_actor_user_id: actorId, p_notification_id: notificationId,
  }),
};

// ---------------------------------------------------------------------------------------------
// Session lifecycle (logout / refresh). Never throws; never changes the session outcome.
// ---------------------------------------------------------------------------------------------

type SessionLike = { v: number; uid: string; iat?: number; exp: number };

/** Logout: awaited with a short timeout so the device stops receiving before the reply. */
export async function revokePushSession(session: SessionLike | null | undefined) {
  if (!session || session.v !== 2 || !session.iat) return { status: "skipped" as const };
  const outcome = await callPushRpc("notification_push_session_revoke_v1", {
    p_user_id: Number(session.uid), p_session_iat: session.iat,
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

export type PushReport = { outcome: "accepted" | "retry" | "gone" | "failed"; httpStatus: number | null; retryAfterSeconds: number | null; errorCode: string | null };

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

async function report(item: ClaimedDelivery, result: PushReport) {
  return callPushRpc("notification_push_report_v1", {
    p_delivery_id: item.deliveryId, p_claim_token: item.claimToken, p_outcome: result.outcome,
    p_http_status: result.httpStatus, p_retry_after_seconds: result.retryAfterSeconds, p_error_code: result.errorCode,
  });
}

async function sendOne(item: ClaimedDelivery, config: Extract<ReturnType<typeof getPushConfig>, { ok: true }>): Promise<PushReport> {
  if (!isAllowedPushEndpoint(item.endpoint)) {
    return { outcome: "failed", httpStatus: null, retryAfterSeconds: null, errorCode: "endpoint_rejected" };
  }
  const payload = buildPushPayload({ notificationId: item.notificationId, typeCode: item.typeCode, lang: item.lang, unreadCount: item.unreadCount });
  try {
    const response = await webpush.sendNotification(
      { endpoint: item.endpoint, keys: { p256dh: item.p256dh, auth: item.auth } },
      JSON.stringify(payload),
      {
        vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
        TTL: Math.max(1, Math.min(3600, Math.floor(item.ttlSeconds))),
        topic: pushTopic(item.notificationId),
        urgency: item.severity === "urgent" ? "high" : "normal",
        timeout: SEND_TIMEOUT_MS,
      },
    );
    return classifyPushResult(response);
  } catch (error) {
    return classifyPushResult(null, error);
  }
}

export type DispatchSummary =
  | { status: "disabled"; reason: string }
  | { status: "not_installed" | "failed" }
  | { status: "ok"; claimed: number; skipped: number; accepted: number; retry: number; gone: number; failed: number; unreported: number };

/** Claims and sends due deliveries: one event (after creation) or any event (recovery, null). */
export async function dispatchPushDeliveries(options: { notificationId: number | null; limit?: number }): Promise<DispatchSummary> {
  const config = getPushConfig();
  if (!config.ok) return { status: "disabled", reason: config.reason };
  const claim = await callPushRpc("notification_push_claim_v1", {
    p_notification_id: options.notificationId, p_limit: Math.max(1, Math.min(100, options.limit ?? 50)),
    p_lease_seconds: CLAIM_LEASE_SECONDS,
  });
  if (claim.kind === "missing") return { status: "not_installed" };
  if (claim.kind === "failed" || claim.data.status !== "ok" || !Array.isArray(claim.data.items)) return { status: "failed" };
  const items = claim.data.items as ClaimedDelivery[];
  const summary = { status: "ok" as const, claimed: items.length, skipped: Number(claim.data.skipped) || 0,
    accepted: 0, retry: 0, gone: 0, failed: 0, unreported: 0 };
  for (let index = 0; index < items.length; index += SEND_CONCURRENCY) {
    await Promise.all(items.slice(index, index + SEND_CONCURRENCY).map(async (item) => {
      const result = await sendOne(item, config);
      summary[result.outcome] += 1;
      // A lost report leaves the row "sending": it is re-claimed after the lease (possible duplicate,
      // suppressed on the device by the same Topic/tag).
      const recorded = await report(item, result);
      if (recorded.kind !== "ok" || recorded.data.status !== "ok") summary.unreported += 1;
    }));
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
/** Limited recovery, throttled per server instance; piggybacks on the bell's count request. */
export function schedulePushRecovery(now = Date.now()) {
  if (!getPushConfig().ok || now - lastRecoveryAt < RECOVERY_INTERVAL_MS) return false;
  lastRecoveryAt = now;
  try {
    after(() => dispatchPushDeliveries({ notificationId: null, limit: 20 }).then(() => undefined));
    return true;
  } catch {
    return false;
  }
}
