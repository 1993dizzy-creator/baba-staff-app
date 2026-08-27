import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// Manually trigger schedule generation for a month. Unlike the cron, this works for any
// plan with a valid recurring rule regardless of recurring_auto_generate or the due day.
export async function POST(request: Request) {
  const auth = await requireLedgerActor();
  if (auth.response || !auth.actor) return auth.response;
  const body = await request.json().catch(() => null) as { month?: string } | null;
  if (!body?.month || !MONTH.test(body.month)) return ledgerJson({ ok: false, code: "INVALID_MONTH" }, 400);
  try {
    const { data, error } = await supabaseServer.rpc("ledger_generate_reserve_schedule_v1", {
      p_month: `${body.month}-01`,
      p_require_auto_generate: false,
      p_actor_user_id: auth.actor.id,
    });
    if (error) throw error;
    const result = data as { status?: string };
    return result.status === "ok"
      ? ledgerJson({ ok: true, result })
      : ledgerJson({ ok: false, code: String(result.status).toUpperCase() }, result.status === "forbidden" ? 403 : 400);
  } catch (error) {
    console.error("[LEDGER_RESERVE_SCHEDULE_GENERATE_FAILED]", error);
    return ledgerJson({ ok: false, code: "RESERVE_SCHEDULE_GENERATE_FAILED" }, 500);
  }
}
