import { notificationJson, notificationRpc, requireNotificationActor, rpcResponse } from "@/lib/notifications/server";
import { schedulePushRecovery } from "@/lib/notifications/push/server";

export const dynamic = "force-dynamic";

// Bell badge: unread count only (capped at 100). available=false while the DB is not installed.
export async function GET() {
  try {
    const auth = await requireNotificationActor();
    if (auth.response) return auth.response;
    const outcome = await notificationRpc.unreadCount(auth.actor.id);
    // 01-B limited push recovery (throttled, after the response; no-op while push is off).
    try { schedulePushRecovery(); } catch { /* never affects the count */ }
    return rpcResponse(outcome, (data) => ({ unreadCount: data.unreadCount, capped: data.capped === true }));
  } catch (error) {
    console.error("[NOTIFICATION_SUMMARY_FAILED]", (error as Error)?.name);
    return notificationJson({ ok: false, code: "NOTIFICATIONS_UNAVAILABLE" }, 503);
  }
}
