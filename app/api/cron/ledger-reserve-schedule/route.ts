import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/pos/cukcuk/sales-sync-cron-shared";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Daily (Vietnam ~03:00+). Proposes this month's pending reserve allocations for every
// plan with recurring_auto_generate = true. Generation only — never confirms. Idempotent
// via ledger_reserve_sched_live_unique; catches up when a run is missed. A failure here
// is isolated: it returns an error but never throws into other Ledger flows.
export async function GET(req: Request) {
  const guardResponse = authorizeCron(req);
  if (guardResponse) return guardResponse;

  const month = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
  }).format(new Date()).slice(0, 7);

  try {
    const { data: owners, error: ownerError } = await supabaseServer
      .from("users")
      .select("id,role")
      .in("role", ["owner", "master"])
      .eq("is_active", true)
      .eq("app_login_enabled", true)
      .order("id");
    if (ownerError) throw ownerError;
    const actor = (owners ?? []).find((row) => String(row.role).toLowerCase() === "owner")
      ?? (owners ?? [])[0];
    if (!actor) {
      return NextResponse.json({ ok: false, code: "NO_LEDGER_ACTOR" }, { status: 422 });
    }

    const { data, error } = await supabaseServer.rpc("ledger_generate_reserve_schedule_v1", {
      p_month: `${month}-01`,
      p_require_auto_generate: true,
      p_actor_user_id: actor.id,
    });
    if (error) throw error;
    const result = data as { status?: string };
    if (result.status !== "ok") {
      // month_closed / forbidden / invalid_month: nothing to do, not a hard failure.
      return NextResponse.json({ ok: true, month, noOp: result.status, result });
    }
    return NextResponse.json({ ok: true, month, result });
  } catch (error) {
    console.error("[LEDGER_RESERVE_SCHEDULE_CRON_FAILED]", error);
    return NextResponse.json({ ok: false, code: "LEDGER_RESERVE_SCHEDULE_CRON_FAILED" }, { status: 500 });
  }
}
