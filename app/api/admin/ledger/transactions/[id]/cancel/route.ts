import { parseManualTransactionCancel } from "@/lib/ledger/manual-transaction-request";
import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";

// "삭제" of a plain manual income / expense / transfer: an audited cancel. The row and its
// movements stay; status becomes 'cancelled', so every confirmed-only total drops it once.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireLedgerActor();
  if (auth.response || !auth.actor) return auth.response;
  const { id: rawId } = await context.params;
  const transactionId = Number(rawId);
  const parsed = parseManualTransactionCancel(await request.json().catch(() => null));
  if (!Number.isSafeInteger(transactionId) || transactionId <= 0 || !parsed) return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
  try {
    const { data, error } = await supabaseServer.rpc("ledger_cancel_manual_transaction_v1", {
      p_transaction_id: transactionId, p_expected_updated_at: parsed.expectedUpdatedAt,
      p_reason: parsed.reason, p_actor_user_id: auth.actor.id,
    });
    if (error) throw error;
    const result = data as { status?: string };
    if (result.status === "cancelled") return ledgerJson({ ok: true, result });
    const status = result.status === "forbidden" ? 403 : result.status === "not_found" ? 404
      : result.status === "invalid_input" ? 400 : 409;
    return ledgerJson({ ok: false, code: String(result.status ?? "MANUAL_CANCEL_FAILED").toUpperCase(), result }, status);
  } catch (error) {
    console.error("[LEDGER_MANUAL_CANCEL_FAILED]", error);
    return ledgerJson({ ok: false, code: "MANUAL_CANCEL_FAILED" }, 500);
  }
}
