import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireLedgerActor(); if (auth.response || !auth.actor) return auth.response;
  const { id } = await context.params; const candidateId = Number(id);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const allowed = new Set(["resolution", "categoryId", "partyId", "fundAccountId", "dueDate", "memo", "reason"]);
  if (!Number.isInteger(candidateId) || candidateId <= 0 || !body || Object.keys(body).some((key) => !allowed.has(key)) || !["immediate", "payable", "dismiss"].includes(String(body.resolution))) return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
  const {data:candidate,error:candidateError}=await supabaseServer.from("ledger_candidates").select("candidate_type").eq("id",candidateId).maybeSingle();
  if(candidateError)return ledgerJson({ok:false,code:"CANDIDATE_LOAD_FAILED"},500);
  const rpcName=candidate?.candidate_type==="inventory_purchase"?"ledger_resolve_inventory_candidate_v1":"ledger_resolve_candidate_v2";
  const { data, error } = await supabaseServer.rpc(rpcName, {
    p_candidate_id: candidateId, p_resolution: body.resolution, p_category_id: body.categoryId || null,
    p_party_id: body.partyId || null, p_fund_account_id: body.fundAccountId || null, p_due_date: body.dueDate || null,
    p_memo: body.memo || null, p_reason: body.reason || null, p_actor_user_id: auth.actor.id,
  });
  if (error) { console.error("[LEDGER_CANDIDATE_RESOLVE_FAILED]", error); return ledgerJson({ ok: false, code: "CANDIDATE_RESOLVE_FAILED" }, 500); }
  const result = data as { status?: string };
  if (!["confirmed", "dismissed"].includes(String(result.status))) return ledgerJson({ ok: false, code: String(result.status ?? "RESOLVE_FAILED").toUpperCase() }, result.status === "forbidden" ? 403 : result.status === "not_found" ? 404 : result.status === "already_resolved" ? 409 : 400);
  return ledgerJson({ ok: true, result });
}
