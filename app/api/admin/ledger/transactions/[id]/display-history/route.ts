import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { projectManualDisplayHistory, type ManualDisplayHistoryEntry } from "@/lib/ledger/manual-display-history";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 500;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireLedgerActor();
  if (auth.response || !auth.actor) return auth.response;

  const { id: rawId } = await context.params;
  const transactionId = Number(rawId);
  if (!Number.isSafeInteger(transactionId) || transactionId < 1) {
    return ledgerJson({ ok: false, code: "INVALID_TRANSACTION_ID" }, 400);
  }

  try {
    const { data: transaction, error: transactionError } = await supabaseServer
      .from("ledger_transactions")
      .select("id,type,status,source_type,correction_of_id")
      .eq("id", transactionId)
      .maybeSingle();
    if (transactionError) throw transactionError;
    if (!transaction || transaction.source_type !== "manual" ||
        transaction.status !== "confirmed" ||
        !["income", "expense", "transfer"].includes(transaction.type) ||
        transaction.correction_of_id != null) {
      return ledgerJson({ ok: false, code: "NOT_FOUND" }, 404);
    }

    const history: ManualDisplayHistoryEntry[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabaseServer
        .from("ledger_audit_logs")
        .select("id,created_at,reason,before_snapshot,after_snapshot,actor:users!ledger_audit_logs_actor_user_id_fkey(name,full_name,username)")
        .eq("entity_type", "transaction")
        .eq("entity_id", transactionId)
        .eq("action", "manual_transaction_display_edited")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      history.push(...(data ?? []).map(projectManualDisplayHistory));
      if ((data?.length ?? 0) < PAGE_SIZE) break;
    }
    return ledgerJson({ ok: true, history });
  } catch (error) {
    console.error("[LEDGER_MANUAL_DISPLAY_HISTORY_FAILED]", error);
    return ledgerJson({ ok: false, code: "MANUAL_DISPLAY_HISTORY_FAILED" }, 500);
  }
}

