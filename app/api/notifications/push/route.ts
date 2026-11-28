import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import { notificationJson } from "@/lib/notifications/server";
import { getPushConfig } from "@/lib/notifications/push/config";
import {
  isAllowedPushEndpoint, parsePushSubscription, PUSH_ENDPOINT_MAX_LENGTH, type PushSubscriptionInput,
} from "@/lib/notifications/push/endpoint";
import { isJsonRequest, isSameOriginRequest } from "@/lib/notifications/push/request";
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
  | { action: "subscribe"; subscription: PushSubscriptionInput; lang: "ko" | "vi" | null; oldEndpoint: string | null }
  | { action: "unsubscribe"; endpoint: string }
  | { action: "sync"; endpoint: string };

function parseAction(body: unknown): Action | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.action === "subscribe") {
    if (keys.some((key) => !["action", "subscription", "lang", "oldEndpoint"].includes(key))) return null;
    const subscription = parsePushSubscription(record.subscription);
    const lang = record.lang === undefined || record.lang === null ? null : record.lang;
    if (!subscription || (lang !== null && lang !== "ko" && lang !== "vi")) return null;
    const oldEndpoint = record.oldEndpoint ?? null;
    if (oldEndpoint !== null && (!isAllowedPushEndpoint(oldEndpoint) || oldEndpoint === subscription.endpoint)) return null;
    return { action: "subscribe", subscription, lang: lang as "ko" | "vi" | null, oldEndpoint: oldEndpoint as string | null };
  }
  if (record.action === "unsubscribe" || record.action === "sync") {
    if (keys.length !== 2 || !keys.includes("endpoint")) return null;
    // Unsubscribe/sync only look a row up; they still accept push-service URLs only.
    if (typeof record.endpoint !== "string" || record.endpoint.length > PUSH_ENDPOINT_MAX_LENGTH
      || !isAllowedPushEndpoint(record.endpoint)) return null;
    return { action: record.action, endpoint: record.endpoint };
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
    const outcome = input.action === "subscribe"
      ? await pushRpc.subscribe(auth.actor.id, sessionRef, input.subscription, input.lang, input.oldEndpoint)
      : input.action === "unsubscribe"
        ? await pushRpc.unsubscribe(auth.actor.id, input.endpoint)
        : await pushRpc.sync(auth.actor.id, sessionRef, input.endpoint);
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
    const errors: Record<string, [string, number]> = {
      forbidden: ["FORBIDDEN", 403], invalid_input: ["INVALID_INPUT", 400], not_found: ["NOT_FOUND", 404],
    };
    const [code, http] = errors[String(status)] ?? ["NOTIFICATIONS_UNAVAILABLE", 503];
    return notificationJson({ ok: false, code }, http);
  } catch (error) {
    console.error("[PUSH_DEVICE_FAILED]", (error as Error)?.name);
    return notificationJson({ ok: false, code: "NOTIFICATIONS_UNAVAILABLE" }, 503);
  }
}
