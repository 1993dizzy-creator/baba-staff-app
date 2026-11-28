import { notificationJson, notificationRpc, requireNotificationActor, rpcResponse } from "@/lib/notifications/server";
import { isValidRules } from "@/lib/notifications/rules";
import { isNotificationTypeCode } from "@/lib/notifications/types";

export const dynamic = "force-dynamic";

// Owner/master only (checked here and again inside the RPC from users.role).
export async function GET() {
  try {
    const auth = await requireNotificationActor({ policyAdmin: true });
    if (auth.response) return auth.response;
    return rpcResponse(await notificationRpc.policyList(auth.actor.id), (data) => ({ types: data.types, staff: data.staff, audit: data.audit }));
  } catch (error) {
    console.error("[NOTIFICATION_SETTINGS_GET_FAILED]", (error as Error)?.name);
    return notificationJson({ ok: false, code: "NOTIFICATIONS_UNAVAILABLE" }, 503);
  }
}

// PUT { typeCode, expectedRevision, enabled, inAppEnabled, rules, pushEnabled? }
// pushEnabled (01-B) is optional: omitted = the stored value is kept (older clients keep working).
export async function PUT(request: Request) {
  try {
    if (Number(request.headers.get("content-length")) > 16384) return notificationJson({ ok: false, code: "INVALID_INPUT" }, 400);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const allowed = new Set(["typeCode", "expectedRevision", "enabled", "inAppEnabled", "rules", "pushEnabled"]);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !allowed.has(key))
      || !isNotificationTypeCode(body.typeCode) || !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1
      || typeof body.enabled !== "boolean" || typeof body.inAppEnabled !== "boolean" || !isValidRules(body.rules)
      || (body.pushEnabled !== undefined && typeof body.pushEnabled !== "boolean")) {
      return notificationJson({ ok: false, code: "INVALID_INPUT" }, 400);
    }
    const auth = await requireNotificationActor({ policyAdmin: true });
    if (auth.response) return auth.response;
    const outcome = await notificationRpc.policyUpdate(auth.actor.id, body.typeCode, body.expectedRevision as number,
      { enabled: body.enabled, inAppEnabled: body.inAppEnabled, rules: body.rules,
        ...(typeof body.pushEnabled === "boolean" ? { pushEnabled: body.pushEnabled } : {}) });
    if (outcome.kind === "missing") return notificationJson({ ok: false, code: "NOTIFICATIONS_DB_PENDING" }, 503);
    return rpcResponse(outcome, (data) => ({ revision: data.revision, rules: data.rules }));
  } catch (error) {
    console.error("[NOTIFICATION_SETTINGS_PUT_FAILED]", (error as Error)?.name);
    return notificationJson({ ok: false, code: "NOTIFICATIONS_UNAVAILABLE" }, 503);
  }
}
