import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireLedgerActor();
  if (auth.response || !auth.actor) return auth.response;
  const { id: raw } = await context.params;
  const id = Number(raw);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!Number.isSafeInteger(id) || id < 1 || !body) return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
  try {
    let fundAccountId = body.fundAccountId || null;
    if (!Object.hasOwn(body, "fundAccountId")) {
      const existing = await supabaseServer.from("ledger_reserve_plans").select("fund_account_id").eq("id", id).maybeSingle();
      if (existing.error) throw existing.error;
      fundAccountId = existing.data?.fund_account_id ?? null;
    }
    const { data, error } = await supabaseServer.rpc("ledger_update_reserve_plan_v2", {
      p_reserve_plan_id: id, p_target_amount: body.targetAmount, p_target_date: body.targetDate || null,
      p_fund_account_id: fundAccountId, p_memo: body.memo || null, p_actor_user_id: auth.actor.id,
    });
    if (error) throw error;
    const result = data as { status?: string };
    return result.status === "updated" ? ledgerJson({ ok: true, result }) : ledgerJson({ ok: false, code: String(result.status).toUpperCase() }, result.status === "forbidden" ? 403 : 400);
  } catch (error) {
    console.error("[LEDGER_RESERVE_UPDATE_FAILED]", error);
    return ledgerJson({ ok: false, code: "RESERVE_UPDATE_FAILED" }, 500);
  }
}
