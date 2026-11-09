import { authorizeCron } from "@/lib/pos/cukcuk/sales-sync-cron-shared";
import { openOrdersSyncEnabled, runCentralOpenOrderSync } from "@/lib/pos/cukcuk/open-orders-sync-server";
import {
  evaluateOpenOrdersCronWindow,
  mapOpenOrdersSyncResult,
  openOrdersCronErrorCode,
} from "@/lib/pos/cukcuk/open-orders-cron-policy";

// Central CUKCUK open-order collection trigger. vercel.json: "2-57/5 10-19 * * *" (UTC) =
// every 5 minutes 17:02–02:57 (+07); the window below lets 17:32–02:52 through.
// Order: cron auth -> POS_OPEN_ORDERS_SYNC_ENABLED -> 17:30–02:54:59 (+07) window -> the
// existing runCentralOpenOrderSync (its DB claim is the only lock; business date comes
// from the store-settings RPC). Collection is bounded to 150s inside a 3-minute lease.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function GET(req: Request) {
  const denied = authorizeCron(req);
  if (denied) return denied;

  if (!openOrdersSyncEnabled()) {
    return Response.json({ ok: true, outcome: "skipped_disabled" });
  }

  const now = new Date();
  const window = evaluateOpenOrdersCronWindow(now);
  if (!window.allowed) {
    return Response.json({ ok: true, outcome: "skipped_outside_hours", vietnamTime: window.vietnamTime });
  }

  try {
    const { status, body } = mapOpenOrdersSyncResult(await runCentralOpenOrderSync(now));
    if (!body.ok) console.error("[POS_OPEN_ORDERS_CRON_FAILED]", body.code);
    return Response.json(body, { status });
  } catch (error) {
    const code = openOrdersCronErrorCode(error);
    console.error("[POS_OPEN_ORDERS_CRON_FAILED]", code);
    return Response.json({ ok: false, outcome: "failed", code }, { status: 500 });
  }
}
