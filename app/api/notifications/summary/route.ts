import { notificationJson, notificationRpc, requireNotificationActor, rpcResponse } from "@/lib/notifications/server";

export const dynamic = "force-dynamic";

// Bell badge: unread count only (capped at 100). available=false while the DB is not installed.
export async function GET() {
  try {
    const auth = await requireNotificationActor();
    if (auth.response) return auth.response;
    const outcome = await notificationRpc.unreadCount(auth.actor.id);
    return rpcResponse(outcome, (data) => ({ unreadCount: data.unreadCount, capped: data.capped === true }));
  } catch (error) {
    console.error("[NOTIFICATION_SUMMARY_FAILED]", (error as Error)?.name);
    return notificationJson({ ok: false, code: "NOTIFICATIONS_UNAVAILABLE" }, 503);
  }
}
