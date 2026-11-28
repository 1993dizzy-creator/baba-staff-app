import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import { notificationJson } from "@/lib/notifications/server";
import { getPushConfig } from "@/lib/notifications/push/config";
import {
  isAllowedPushEndpoint, parsePushSubscription, PUSH_ENDPOINT_MAX_LENGTH, type PushSubscriptionInput,
} from "@/lib/notifications/push/endpoint";
import { isJsonRequest, isSameOriginRequest } from "@/lib/notifications/push/request";
import { pushDeviceMatchesSession, readPushDevice } from "@/lib/notifications/push/device";
import { pushRpc } from "@/lib/notifications/push/server";

export const dynamic = "force-dynamic";

// Device push registration for the signed-in staff member (01-B). The user id, role and part come
// from the server session only; the device row is bound to that session's iat and expiry.
// Responses never echo an endpoint or key.

async function authenticate() {
  let auth;
  try { auth = await getAuthenticatedActor(); }
  catch (error) {
    console.error("[PUSH_AUTH_ERROR]", (error as Error)?.name);
    return { response: notificationJson({ ok: false, code: "NOTIFICATIONS_UNAVAILABLE" }, 503) };
  }
  if (!auth.ok) return { response: notificationJson({ ok: false, code: auth.code }, auth.status) };
  return { auth };
}

// GET: is push usable on this server (global switch + VAPID + DB), the public key, my device count.
export async function GET() {
  try {
    const { auth, response } = await authenticate();
    if (response) return response;
    const status = await pushRpc.status(auth.actor.id);
    if (status.kind === "missing") return notificationJson({ ok: true, available: false, reason: "db_pending" });
    if (status.kind === "failed") return notificationJson({ ok: false, code: "NOTIFICATIONS_UNAVAILABLE" }, 503);
    if (status.data.status === "forbidden") return notificationJson({ ok: false, code: "FORBIDDEN" }, 403);
    const config = getPushConfig();
    return notificationJson({
      ok: true,
      available: config.ok,
      reason: config.ok ? null : config.reason,
      publicKey: config.ok ? config.publicKey : null,
      activeDevices: Number(status.data.activeDevices) || 0,
    });
  } catch (error) {
    console.error("[PUSH_STATUS_FAILED]", (error as Error)?.name);
    return notificationJson({ ok: false, code: "NOTIFICATIONS_UNAVAILABLE" }, 503);
  }
}

type Action =
  | { action: "subscribe"; subscription: PushSubscriptionInput; lang: "ko" | "vi" | null; oldEndpoint: string | null; expectUserId: number | null }
  | { action: "unsubscribe"; endpoint: string }
  | { action: "sync"; endpoint: string; lang: "ko" | "vi" | null };

function parseAction(body: unknown): Action | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.action === "subscribe") {
    if (keys.some((key) => !["action", "subscription", "lang", "oldEndpoint", "expectUserId"].includes(key))) return null;
    const subscription = parsePushSubscription(record.subscription);
    const lang = record.lang === undefined || record.lang === null ? null : record.lang;
    if (!subscription || (lang !== null && lang !== "ko" && lang !== "vi")) return null;
    const oldEndpoint = record.oldEndpoint ?? null;
    if (oldEndpoint !== null && (!isAllowedPushEndpoint(oldEndpoint) || oldEndpoint === subscription.endpoint)) return null;
    // A user registration names the account that clicked; only the worker's renewal (oldEndpoint,
    // bound to the same account + browser by the DB) may omit it.
    const expectUserId = record.expectUserId ?? null;
    if (expectUserId === null ? oldEndpoint === null : !(Number.isSafeInteger(expectUserId) && (expectUserId as number) > 0)) return null;
    return { action: "subscribe", subscription, lang: lang as "ko" | "vi" | null, oldEndpoint: oldEndpoint as string | null,
      expectUserId: expectUserId as number | null };
  }
  if (record.action === "unsubscribe" || record.action === "sync") {
    const allowed = record.action === "sync" ? ["action", "endpoint", "lang"] : ["action", "endpoint"];
    if (!keys.includes("endpoint") || keys.some((key) => !allowed.includes(key))) return null;
    // Unsubscribe/sync only look a row up; they still accept push-service URLs only.
    if (typeof record.endpoint !== "string" || record.endpoint.length > PUSH_ENDPOINT_MAX_LENGTH
      || !isAllowedPushEndpoint(record.endpoint)) return null;
    if (record.action === "unsubscribe") return { action: "unsubscribe", endpoint: record.endpoint };
    const lang = record.lang === undefined || record.lang === null ? null : record.lang;
    if (lang !== null && lang !== "ko" && lang !== "vi") return null;
    return { action: "sync", endpoint: record.endpoint, lang: lang as "ko" | "vi" | null };
  }
  return null;
}

// POST {action:"subscribe", subscription, lang?, oldEndpoint?} | {action:"unsubscribe", endpoint} | {action:"sync", endpoint}
export async function POST(request: Request) {
  try {
    if (!isSameOriginRequest(request)) return notificationJson({ ok: false, code: "FORBIDDEN" }, 403);
    if (!isJsonRequest(request) || Number(request.headers.get("content-length")) > 4096) {
      return notificationJson({ ok: false, code: "INVALID_INPUT" }, 400);
    }
    const text = await request.text();
    if (text.length > 4096) return notificationJson({ ok: false, code: "INVALID_INPUT" }, 400);
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { body = null; }
    const input = parseAction(body);
    if (!input) return notificationJson({ ok: false, code: "INVALID_INPUT" }, 400);

    const { auth, response } = await authenticate();
    if (response) return response;
    const session = auth.session;
    if (session.v !== 2) return notificationJson({ ok: false, code: "SESSION_REFRESH_REQUIRED" }, 409);
    const sessionRef = { iat: session.iat, exp: session.exp };

    if (input.action === "subscribe") {
      const config = getPushConfig();
      if (!config.ok) return notificationJson({ ok: true, available: false, reason: config.reason });
    }
    // Signed push device cookie (issued by login / logout / session check, never here). It must belong
    // to THIS session; otherwise the browser first refreshes it through /api/session (client retries
    // once). No push action runs without a device identity and generation.
    const device = readPushDevice(request);
    if (!pushDeviceMatchesSession(device, auth.actor.id, session.iat)) {
      return notificationJson({ ok: false, code: "PUSH_DEVICE_INIT" }, 409);
    }
    // Consent belongs to the account that clicked: the click-time account must be the session's.
    if (input.action === "subscribe" && input.expectUserId !== null && input.expectUserId !== auth.actor.id) {
      return notificationJson({ ok: false, code: "PUSH_USER_CHANGED" }, 409);
    }
    const outcome = input.action === "subscribe"
      ? await pushRpc.subscribe(auth.actor.id, sessionRef, input.subscription, input.lang, input.oldEndpoint, device)
      : input.action === "unsubscribe"
        ? await pushRpc.unsubscribe(auth.actor.id, sessionRef, input.endpoint, device)
        : await pushRpc.sync(auth.actor.id, sessionRef, input.endpoint, input.lang, device);
    if (outcome.kind === "missing") return notificationJson({ ok: true, available: false, reason: "db_pending" });
    if (outcome.kind === "failed") return notificationJson({ ok: false, code: "NOTIFICATIONS_UNAVAILABLE" }, 503);
    const status = outcome.data.status;
    if (status === "ok") {
      return notificationJson({
        ok: true, available: true,
        ...(input.action === "sync" ? { device: outcome.data.device } : {}),
        ...(input.action === "unsubscribe" ? { revoked: Number(outcome.data.revoked) || 0 } : {}),
      });
    }
    // session_revoked: this session/browser logged out; superseded: the request is older than this
    // browser's latest login/logout (or another browser identity owns the endpoint). Nothing changed.
    const errors: Record<string, [string, number]> = {
      forbidden: ["FORBIDDEN", 403], invalid_input: ["INVALID_INPUT", 400], not_found: ["NOT_FOUND", 404],
      session_revoked: ["PUSH_SESSION_REVOKED", 409], superseded: ["PUSH_SUPERSEDED", 409],
    };
    const [code, http] = errors[String(status)] ?? ["NOTIFICATIONS_UNAVAILABLE", 503];
    return notificationJson({ ok: false, code }, http);
  } catch (error) {
    console.error("[PUSH_DEVICE_FAILED]", (error as Error)?.name);
    return notificationJson({ ok: false, code: "NOTIFICATIONS_UNAVAILABLE" }, 503);
  }
}
