import { notificationJson, notificationRpc, requireNotificationActor, rpcResponse } from "@/lib/notifications/server";
import { isNotificationFilter } from "@/lib/notifications/types";

export const dynamic = "force-dynamic";

// GET /api/notifications?filter=all|unread|open|resolved&before=<id>  (30 per page, newest first)
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const filter = url.searchParams.get("filter") ?? "all";
    const beforeRaw = url.searchParams.get("before");
    if (!isNotificationFilter(filter) || (beforeRaw !== null && !/^[1-9]\d{0,15}$/.test(beforeRaw))) {
      return notificationJson({ ok: false, code: "INVALID_INPUT" }, 400);
    }
    const auth = await requireNotificationActor();
    if (auth.response) return auth.response;
    const outcome = await notificationRpc.list(auth.actor.id, filter, beforeRaw === null ? null : Number(beforeRaw));
    return rpcResponse(outcome, (data) => ({ items: data.items, hasMore: data.hasMore === true, nextBeforeId: data.nextBeforeId ?? null }));
  } catch (error) {
    console.error("[NOTIFICATION_LIST_FAILED]", (error as Error)?.name);
    return notificationJson({ ok: false, code: "NOTIFICATIONS_UNAVAILABLE" }, 503);
  }
}
