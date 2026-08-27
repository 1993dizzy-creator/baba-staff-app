import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Confirm (runs ledger_create_reserve_entry_v1 'allocate') or skip a pending proposal.
export async function POST(request: Request, context: { params: Promise<{ scheduleId: string }> }) {
  const auth = await requireLedgerActor();
  if (auth.response || !auth.actor) return auth.response;
  const { scheduleId: raw } = await context.params;
  const id = Number(raw);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!Number.isSafeInteger(id) || id < 1 || !body) return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
  const action = String(body.action);
  if (action !== "confirm" && action !== "skip") return ledgerJson({ ok: false, code: "INVALID_ACTION" }, 400);
  try {
    const { data, error } = action === "confirm"
      ? await supabaseServer.rpc("ledger_confirm_reserve_schedule_v1", {
          p_schedule_id: id, p_actor_user_id: auth.actor.id,
        })
      : await supabaseServer.rpc("ledger_skip_reserve_schedule_v1", {
          p_schedule_id: id, p_reason: body.reason || null, p_actor_user_id: auth.actor.id,
        });
    if (error) throw error;
    const result = data as { status?: string };
    const ok = result.status === "confirmed" || result.status === "skipped"
      || result.status === "target_reached" || result.status === "already_fulfilled";
    return ok
      ? ledgerJson({ ok: true, result })
      : ledgerJson({ ok: false, code: String(result.status).toUpperCase(), result }, result.status === "forbidden" ? 403 : 400);
  } catch (error) {
    console.error("[LEDGER_RESERVE_SCHEDULE_RESOLVE_FAILED]", error);
    return ledgerJson({ ok: false, code: "RESERVE_SCHEDULE_RESOLVE_FAILED" }, 500);
  }
}
