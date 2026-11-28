import { notificationJson, requireNotificationActor } from "@/lib/notifications/server";
import { pushRpc } from "@/lib/notifications/push/server";
import { isSafeInternalHref } from "@/lib/notifications/types";

export const dynamic = "force-dynamic";

// GET /api/notifications/push/open?id=<notification id>
// Push click target. Re-checks on the server that the signed-in user is a recipient of that event
// and is still allowed on a channel, then returns only its internal business path (validated
// again here). Never returns notification text; never redirects outside the app.
export async function GET(request: Request) {
  try {
    const raw = new URL(request.url).searchParams.get("id");
    if (!raw || !/^[1-9]\d{0,15}$/.test(raw)) return notificationJson({ ok: false, code: "INVALID_INPUT" }, 400);
    const auth = await requireNotificationActor();
    if (auth.response) return auth.response;
    const outcome = await pushRpc.open(auth.actor.id, Number(raw));
    if (outcome.kind === "missing") return notificationJson({ ok: true, available: false, href: null });
    if (outcome.kind === "failed") return notificationJson({ ok: false, code: "NOTIFICATIONS_UNAVAILABLE" }, 503);
    if (outcome.data.status === "forbidden") return notificationJson({ ok: false, code: "FORBIDDEN" }, 403);
    if (outcome.data.status !== "ok") return notificationJson({ ok: true, available: true, href: null });
    const href = outcome.data.href;
    return notificationJson({ ok: true, available: true, href: isSafeInternalHref(href) ? href : null });
  } catch (error) {
    console.error("[PUSH_OPEN_FAILED]", (error as Error)?.name);
    return notificationJson({ ok: false, code: "NOTIFICATIONS_UNAVAILABLE" }, 503);
  }
}
