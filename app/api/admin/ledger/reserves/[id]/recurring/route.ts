import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Set (or clear, when monthlyAmount is null) a reserve plan's monthly recurring rule.
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireLedgerActor();
  if (auth.response || !auth.actor) return auth.response;
  const { id: raw } = await context.params;
  const id = Number(raw);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!Number.isSafeInteger(id) || id < 1 || !body) return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
  const clear = body.monthlyAmount == null;
  try {
    const { data, error } = await supabaseServer.rpc("ledger_set_reserve_recurring_v1", {
      p_reserve_plan_id: id,
      p_monthly_amount: clear ? null : body.monthlyAmount,
      p_recurring_day: clear ? null : body.recurringDay,
      p_start_month: clear ? null : (body.startMonth || null),
      p_end_month: clear ? null : (body.endMonth || null),
      p_auto_generate: clear ? false : Boolean(body.autoGenerate),
      p_actor_user_id: auth.actor.id,
    });
    if (error) throw error;
    const result = data as { status?: string };
    return result.status === "updated" || result.status === "cleared"
      ? ledgerJson({ ok: true, result })
      : ledgerJson({ ok: false, code: String(result.status).toUpperCase() }, result.status === "forbidden" ? 403 : 400);
  } catch (error) {
    console.error("[LEDGER_RESERVE_RECURRING_SET_FAILED]", error);
    return ledgerJson({ ok: false, code: "RESERVE_RECURRING_SET_FAILED" }, 500);
  }
}
