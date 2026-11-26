import { notificationJson, notificationRpc, requireNotificationActor, rpcResponse } from "@/lib/notifications/server";
import { isNotificationId } from "@/lib/notifications/types";

export const dynamic = "force-dynamic";

// POST { id } marks one notification read; POST { all: true, upToId } marks every visible unread
// notification up to the newest id the client has shown. Read state only: never resolves anything.
export async function POST(request: Request) {
  try {
    if (Number(request.headers.get("content-length")) > 1024) return notificationJson({ ok: false, code: "INVALID_INPUT" }, 400);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : null;
    const single = keys?.length === 1 && keys[0] === "id" && isNotificationId(body?.id);
    const all = keys?.length === 2 && keys.includes("all") && keys.includes("upToId") && body?.all === true && isNotificationId(body?.upToId);
    if (!single && !all) return notificationJson({ ok: false, code: "INVALID_INPUT" }, 400);
    const auth = await requireNotificationActor();
    if (auth.response) return auth.response;
    if (single) {
      return rpcResponse(await notificationRpc.markRead(auth.actor.id, body!.id as number), (data) => ({ item: data.item }));
    }
    return rpcResponse(await notificationRpc.markAllRead(auth.actor.id, body!.upToId as number), (data) => ({ updated: data.updated }));
  } catch (error) {
    console.error("[NOTIFICATION_READ_FAILED]", (error as Error)?.name);
    return notificationJson({ ok: false, code: "NOTIFICATIONS_UNAVAILABLE" }, 503);
  }
}
