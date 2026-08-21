import { buildMonthCloseSnapshot, snapshotHash, validCloseMonth } from "@/lib/ledger/month-close";
import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth=await requireLedgerActor();if(auth.response||!auth.actor)return auth.response;
  const month=new URL(request.url).searchParams.get("month");if(!validCloseMonth(month))return ledgerJson({ok:false,code:"INVALID_MONTH"},400);
  try{
    const [{data:closure,error:closureError},{data:preflight,error:preflightError}]=await Promise.all([
      supabaseServer.from("ledger_month_closures").select("id,month,status,closed_at,closed_by,preflight_snapshot,summary_snapshot,snapshot_hash,warning_snapshot").eq("month",`${month}-01`).maybeSingle(),
      supabaseServer.rpc("ledger_close_preflight_v1",{p_month:`${month}-01`,p_actor_user_id:auth.actor.id}),
    ]);
    if(closureError||preflightError)throw closureError??preflightError;
    if(closure){const currentRecalculation=await buildMonthCloseSnapshot(month),currentHash=snapshotHash(currentRecalculation);return ledgerJson({ok:true,month,state:"closed",closure,currentRecalculation,currentHash,snapshotDrift:currentHash!==closure.snapshot_hash});}
    const summary=await buildMonthCloseSnapshot(month);
    return ledgerJson({ok:true,month,state:"open",preflight,summary,snapshotHash:snapshotHash(summary)});
  }catch(error){console.error("[LEDGER_MONTH_CLOSE_GET_FAILED]",error);return ledgerJson({ok:false,code:"MONTH_CLOSE_LOAD_FAILED"},500)}
}

export async function POST(request:Request){
  const auth=await requireLedgerActor();if(auth.response||!auth.actor)return auth.response;
  const body=await request.json().catch(()=>null)as{month?:unknown;expectedPreflightHash?:unknown}|null;
  if(!body||!validCloseMonth(body.month)||typeof body.expectedPreflightHash!=="string")return ledgerJson({ok:false,code:"INVALID_BODY"},400);
  try{
    const {data:preflight,error:preflightError}=await supabaseServer.rpc("ledger_close_preflight_v1",{p_month:`${body.month}-01`,p_actor_user_id:auth.actor.id});if(preflightError)throw preflightError;
    const check=preflight as Record<string,unknown>;if(check.preflightHash!==body.expectedPreflightHash)return ledgerJson({ok:false,code:"LEDGER_CLOSE_PREFLIGHT_STALE"},409);
    if(!check.canClose)return ledgerJson({ok:false,code:"MONTH_CLOSE_BLOCKED",blockers:check.blockers},409);
    const summary=await buildMonthCloseSnapshot(body.month),hash=snapshotHash(summary);
    const{data,error}=await supabaseServer.rpc("ledger_close_month_v1",{p_month:`${body.month}-01`,p_expected_preflight_hash:body.expectedPreflightHash,p_preflight_snapshot:check,p_summary_snapshot:summary,p_snapshot_hash:hash,p_actor_user_id:auth.actor.id});if(error)throw error;
    const result=data as Record<string,unknown>;if(result.status!=="closed")return ledgerJson({ok:false,code:result.code??String(result.status).toUpperCase(),result},result.status==="preflight_stale"||result.status==="already_closed"?409:400);
    return ledgerJson({ok:true,result},201);
  }catch(error){console.error("[LEDGER_MONTH_CLOSE_POST_FAILED]",error);return ledgerJson({ok:false,code:"MONTH_CLOSE_FAILED"},500)}
}
