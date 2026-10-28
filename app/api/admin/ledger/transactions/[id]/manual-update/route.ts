import { parseManualTransactionUpdate } from "@/lib/ledger/manual-transaction-request";
import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";

// Full edit of a plain manual income / expense / transfer: only the changed fields, against
// the version the user saw (expectedUpdatedAt). ledger_update_manual_transaction_v2 checks
// role, closed months (old and new), linked rows and writes the before/after audit row.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireLedgerActor();
  if (auth.response || !auth.actor) return auth.response;
  const { id: rawId } = await context.params;
  const transactionId = Number(rawId);
  const parsed = parseManualTransactionUpdate(await request.json().catch(() => null));
  if (!Number.isSafeInteger(transactionId) || transactionId <= 0 || !parsed) return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
  try {
    const { data, error } = await supabaseServer.rpc("ledger_update_manual_transaction_v2", {
      p_transaction_id: transactionId, p_expected_updated_at: parsed.expectedUpdatedAt,
      p_changes: parsed.changes, p_reason: parsed.reason, p_actor_user_id: auth.actor.id,
    });
    if (error) throw error;
    const result = data as { status?: string };
    if (result.status === "updated") return ledgerJson({ ok: true, result });
    return ledgerJson({ ok: false, code: String(result.status ?? "MANUAL_UPDATE_FAILED").toUpperCase(), result }, manualStatusCode(result.status));
  } catch (error) {
    console.error("[LEDGER_MANUAL_UPDATE_FAILED]", error);
    return ledgerJson({ ok: false, code: "MANUAL_UPDATE_FAILED" }, 500);
  }
}

function manualStatusCode(status: string | undefined) {
  if (status === "forbidden") return 403;
  if (status === "not_found") return 404;
  return ["month_closed", "unchanged", "stale", "already_cancelled", "already_corrected", "linked_transaction", "special_transaction", "unsupported_transaction", "invalid_movements"].includes(status ?? "") ? 409 : 400;
}
