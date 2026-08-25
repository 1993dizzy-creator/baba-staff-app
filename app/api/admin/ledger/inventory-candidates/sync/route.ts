import { loadInventoryCandidateSource, LEDGER_MONTH } from "@/lib/ledger/inventory-candidates";
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
    const source = await loadInventoryCandidateSource(body.month);
    const { data: closure, error: closureError } = await supabaseServer.from("ledger_month_closures").select("id").eq("month", `${body.month}-01`).maybeSingle();
    if (closureError) throw closureError;
    if (closure) {
      let driftCount=0,unchangedCount=0;
      for(const row of source.rows){const sourceKey=String(row.sourceKey),{data:candidate,error:candidateError}=await supabaseServer.from("ledger_candidates").select("resolved_transaction_id,source_fingerprint,status").eq("source_type","inventory_purchase_log").eq("source_key",sourceKey).eq("status","confirmed").maybeSingle();if(candidateError)throw candidateError;if(!candidate?.resolved_transaction_id)continue;if(candidate.source_fingerprint===row.fingerprint){unchangedCount++;continue}const{data,error}=await supabaseServer.rpc("ledger_record_source_drift_v1",{p_original_transaction_id:candidate.resolved_transaction_id,p_new_fingerprint:row.fingerprint,p_new_amount:row.amount,p_new_snapshot:row.snapshot,p_actor_user_id:auth.actor.id});if(error)throw error;if((data as{status?:string}).status==="created")driftCount++}
      return ledgerJson({ok:true,month:body.month,status:"closed_month_drift_scan",createdCount:0,unchangedCount,driftCount,scannedLogs:source.scannedLogs,ignoredCount:source.ignoredCount});
    }
    const { data, error } = await supabaseServer.rpc("ledger_sync_inventory_candidates_v1", { p_rows: source.rows, p_actor_user_id: auth.actor.id });
    if (error) {
      const mapped = inventorySyncDbError(error);
      if (mapped) return ledgerJson({ ok: false, code: mapped.code }, mapped.status);
      throw error;
    }
    const result = data as Record<string, unknown>;
    if (result.status !== "ok") return ledgerJson({ ok: false, code: String(result.status ?? "SYNC_FAILED").toUpperCase() }, result.status === "forbidden" ? 403 : 400);
    return ledgerJson({ ok: true, month: body.month, ...result, scannedLogs: source.scannedLogs, ignoredCount: source.ignoredCount });
  } catch (error) {
    console.error("[LEDGER_INVENTORY_CANDIDATE_SYNC_FAILED]", error);
    return ledgerJson({ ok: false, code: "INVENTORY_CANDIDATE_SYNC_FAILED" }, 500);
  }
}

function inventorySyncDbError(error: unknown): { code: string; status: number } | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { message?: unknown; details?: unknown };
  const messages = [candidate.message, candidate.details];
  if (messages.includes("SOURCE_CHANGED_AFTER_POST")) {
    return { code: "SOURCE_CHANGED_AFTER_POST", status: 409 };
  }
  if (messages.includes("INVALID_ROWS")) return { code: "INVALID_ROWS", status: 400 };
  return null;
}
