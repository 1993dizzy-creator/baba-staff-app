import { LEDGER_MONTH } from "@/lib/ledger/inventory-candidates";
import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await requireLedgerActor();
  if (auth.response || !auth.actor) return auth.response;
  const body = await request.json().catch(() => null) as { month?: unknown } | null;
  if (!body || Object.keys(body).some((key) => key !== "month") || typeof body.month !== "string" || !LEDGER_MONTH.test(body.month)) {
    return ledgerJson({ ok: false, code: "INVALID_MONTH" }, 400);
  }
  try {
    const { data, error } = await supabaseServer.rpc("ledger_reconcile_inventory_month_v1", {
      p_month: `${body.month}-01`, p_request_actor_user_id: auth.actor.id,
    });
    if (error) throw error;
    const result = data as Record<string, unknown>;
    if (result.status !== "ok") return ledgerJson({ ok: false, code: String(result.status ?? "SYNC_FAILED").toUpperCase() }, result.status === "forbidden" ? 403 : 400);
    return ledgerJson({ ok: true, month: body.month, ...result });
  } catch (error) {
    console.error("[LEDGER_INVENTORY_CANDIDATE_SYNC_FAILED]", error);
    return ledgerJson({ ok: false, code: "INVENTORY_CANDIDATE_SYNC_FAILED" }, 500);
  }
}
