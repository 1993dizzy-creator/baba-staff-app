import { parseReserveEntryRequest } from "@/lib/ledger/reserve-entry-request";
import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";

// Manual reserve entry (v2): extra top-up, restore of an earlier release, release or consume.
// Always booked now, in the open current month; a retried requestKey returns the first result.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireLedgerActor();
  if (auth.response || !auth.actor) return auth.response;
  const { id: raw } = await context.params;
  const id = Number(raw);
  const parsed = parseReserveEntryRequest(await request.json().catch(() => null));
  if (!Number.isSafeInteger(id) || id < 1 || !parsed) return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
  try {
    const { data, error } = await supabaseServer.rpc("ledger_create_reserve_entry_v2", {
      p_reserve_plan_id: id, p_kind: parsed.kind, p_amount: parsed.amount,
      p_restores_entry_id: parsed.restoresEntryId, p_memo: parsed.memo,
      p_request_key: parsed.requestKey, p_actor_user_id: auth.actor.id,
    });
    if (error) throw error;
    const result = data as { status?: string };
    if (result.status === "created" || result.status === "duplicate") return ledgerJson({ ok: true, result }, result.status === "created" ? 201 : 200);
    return ledgerJson({ ok: false, code: String(result.status).toUpperCase(), result }, result.status === "forbidden" ? 403 : 400);
  } catch (error) {
    console.error("[LEDGER_RESERVE_ENTRY_FAILED]", error);
    return ledgerJson({ ok: false, code: "RESERVE_ENTRY_FAILED" }, 500);
  }
}
