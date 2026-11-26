import "server-only";
import { NextResponse } from "next/server";
import { getAuthenticatedActor, type AuthenticatedActor } from "@/lib/auth/server-auth";
import { supabaseServer } from "@/lib/supabase/server";
import {
  NOTIFICATION_PAGE_SIZE,
  NOTIFICATION_SEVERITIES,
  isNotificationDedupeKey,
  isNotificationId,
  isNotificationTypeCode,
  isSafeInternalHref,
  type NotificationSeverity,
} from "./types.ts";

// Per-user data: never cached by shared caches.
const NO_STORE = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie" };
const RPC_TIMEOUT_MS = 5000;

export const notificationJson = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: NO_STORE });

type RpcError = { code?: string; message?: string } | null;
type RpcOutcome = { kind: "ok"; data: Record<string, unknown> } | { kind: "missing" } | { kind: "failed"; code: string };

/** The 01-A migration is not applied yet (function or schema missing). */
export function isNotificationDbMissing(error: RpcError) {
  return ["PGRST202", "42883", "3F000", "42P01"].includes(error?.code ?? "");
}

async function callRpc(fn: string, args: Record<string, unknown>): Promise<RpcOutcome> {
  try {
    const { data, error } = await supabaseServer.rpc(fn, args).abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS));
    if (error) {
      if (isNotificationDbMissing(error)) return { kind: "missing" };
      console.error("[NOTIFICATION_RPC_ERROR]", { fn, code: error.code });
      return { kind: "failed", code: "NOTIFICATIONS_UNAVAILABLE" };
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return { kind: "failed", code: "NOTIFICATIONS_UNAVAILABLE" };
    return { kind: "ok", data: data as Record<string, unknown> };
  } catch (error) {
    console.error("[NOTIFICATION_RPC_EXCEPTION]", { fn, name: (error as Error)?.name });
    return { kind: "failed", code: "NOTIFICATIONS_UNAVAILABLE" };
  }
}

type ActorResult = { actor: AuthenticatedActor; response?: undefined } | { actor?: undefined; response: Response };

/** Reuses the common server session; client-supplied ids/roles are never trusted. */
export async function requireNotificationActor(options: { policyAdmin?: boolean } = {}): Promise<ActorResult> {
  let auth;
  try { auth = await getAuthenticatedActor(); }
  catch (error) {
    console.error("[NOTIFICATION_AUTH_ERROR]", (error as Error)?.message);
    return { response: notificationJson({ ok: false, code: "NOTIFICATIONS_UNAVAILABLE" }, 503) };
  }
  if (!auth.ok) return { response: notificationJson({ ok: false, code: auth.code }, auth.status) };
  if (options.policyAdmin && !["owner", "master"].includes(auth.actor.role)) {
    return { response: notificationJson({ ok: false, code: "FORBIDDEN" }, 403) };
  }
  return { actor: auth.actor };
}

/** Maps an actor RPC outcome to the HTTP contract shared by every notification route. */
export function rpcResponse(outcome: RpcOutcome, map: (data: Record<string, unknown>) => unknown) {
  if (outcome.kind === "missing") return notificationJson({ ok: true, available: false });
  if (outcome.kind === "failed") return notificationJson({ ok: false, code: outcome.code }, 503);
  const status = outcome.data.status;
  if (status === "ok") return notificationJson({ ok: true, available: true, ...(map(outcome.data) as object) });
  const errors: Record<string, [string, number]> = {
    forbidden: ["FORBIDDEN", 403], invalid_input: ["INVALID_INPUT", 400], not_found: ["NOT_FOUND", 404],
    version_conflict: ["VERSION_CONFLICT", 409],
  };
  const [code, http] = errors[String(status)] ?? ["NOTIFICATIONS_UNAVAILABLE", 503];
  return notificationJson({ ok: false, code, latestRevision: outcome.data.latestRevision }, http);
}

export const notificationRpc = {
  unreadCount: (actorId: number) => callRpc("notification_unread_count_v1", { p_actor_user_id: actorId }),
  list: (actorId: number, filter: string, beforeId: number | null) => callRpc("notification_list_v1", {
    p_actor_user_id: actorId, p_filter: filter, p_before_id: beforeId, p_limit: NOTIFICATION_PAGE_SIZE,
  }),
  markRead: (actorId: number, id: number) => callRpc("notification_mark_read_v1", { p_actor_user_id: actorId, p_notification_id: id }),
  markAllRead: (actorId: number, upToId: number) => callRpc("notification_mark_all_read_v1", { p_actor_user_id: actorId, p_up_to_id: upToId }),
  policyList: (actorId: number) => callRpc("notification_policy_list_v1", { p_actor_user_id: actorId }),
  policyUpdate: (actorId: number, typeCode: string, expectedRevision: number, policy: unknown) => callRpc("notification_policy_update_v1", {
    p_actor_user_id: actorId, p_type_code: typeCode, p_expected_revision: expectedRevision, p_policy: policy,
  }),
};

// ---------------------------------------------------------------------------------------------
// Server-internal writer contract. No route handler exposes these to the browser; business
// modules (follow-up stages) call them after their own checks.
// ---------------------------------------------------------------------------------------------

export type NotificationWriteInput = {
  typeCode: string;
  /** Stable identity of the business event (e.g. "receipt:12345"). Same key + open = same event. */
  dedupeKey: string;
  severity?: NotificationSeverity;
  titleKo: string;
  titleVi: string;
  bodyKo?: string | null;
  bodyVi?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  /** Internal app path only (validated here and by the DB). */
  href?: string | null;
};
export type NotificationWriteResult =
  | { status: "created"; id: number; recipientCount: number }
  | { status: "observed"; id: number }
  | { status: "disabled" | "unknown_type" | "invalid_input" | "not_installed" | "failed" };

export async function upsertNotification(input: NotificationWriteInput): Promise<NotificationWriteResult> {
  if (!isNotificationTypeCode(input.typeCode) || !isNotificationDedupeKey(input.dedupeKey)
    || (input.severity !== undefined && !NOTIFICATION_SEVERITIES.includes(input.severity))
    || (input.href != null && !isSafeInternalHref(input.href))) return { status: "invalid_input" };
  const payload: Record<string, unknown> = { titleKo: input.titleKo, titleVi: input.titleVi };
  for (const key of ["severity", "bodyKo", "bodyVi", "subjectType", "subjectId", "href"] as const) {
    if (input[key] !== undefined) payload[key] = input[key];
  }
  const outcome = await callRpc("notification_upsert_v1", { p_type_code: input.typeCode, p_dedupe_key: input.dedupeKey, p_payload: payload });
  if (outcome.kind === "missing") return { status: "not_installed" };
  if (outcome.kind === "failed") return { status: "failed" };
  return outcome.data as NotificationWriteResult;
}

/**
 * Resolves ONE occurrence: pass the id returned by upsertNotification for the event whose source
 * business state the caller has just re-checked. A late or duplicate call for an earlier
 * occurrence returns already_resolved and never resolves a recurrence with the same key.
 */
export async function resolveNotification(input: {
  notificationId: number; typeCode: string; dedupeKey: string; reason: string; evidence?: Record<string, unknown> | null;
}) {
  if (!isNotificationId(input.notificationId) || !isNotificationTypeCode(input.typeCode)
    || !isNotificationDedupeKey(input.dedupeKey) || !/^[a-z][a-z0-9_]{0,59}$/.test(input.reason)) {
    return { status: "invalid_input" as const };
  }
  const outcome = await callRpc("notification_resolve_v1", {
    p_notification_id: input.notificationId, p_type_code: input.typeCode, p_dedupe_key: input.dedupeKey, p_reason: input.reason, p_evidence: input.evidence ?? null,
  });
  if (outcome.kind === "missing") return { status: "not_installed" as const };
  if (outcome.kind === "failed") return { status: "failed" as const };
  return outcome.data as
    | { status: "resolved"; id: number }
    | { status: "already_resolved"; id: number; resolvedAt: string }
    | { status: "not_found" | "invalid_input" };
}
