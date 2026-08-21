import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";

const MONTH=/^\d{4}-(0[1-9]|1[0-2])-01$/;
export async function POST(request:Request){
 const auth=await requireLedgerActor();if(auth.response||!auth.actor)return auth.response;
 const body=await request.json().catch(()=>null)as Record<string,unknown>|null;
 const allowed=new Set(["originalTransactionId","economicDelta","movementAdjustments","occurredAt","recognitionMonth","reason","sourceDriftCandidateId"]);
 if(!body||Object.keys(body).some(key=>!allowed.has(key))||!Number.isSafeInteger(Number(body.originalTransactionId))||typeof body.reason!=="string"||!body.reason.trim()||typeof body.occurredAt!=="string"||(body.recognitionMonth!=null&&!MONTH.test(String(body.recognitionMonth)))||!Array.isArray(body.movementAdjustments??[]))return ledgerJson({ok:false,code:"INVALID_BODY"},400);
 try{const{data,error}=await supabaseServer.rpc("ledger_create_correction_v1",{p_original_transaction_id:Number(body.originalTransactionId),p_economic_delta:body.economicDelta??"0",p_movement_adjustments:body.movementAdjustments??[],p_occurred_at:body.occurredAt,p_recognition_month:body.recognitionMonth??null,p_reason:body.reason,p_source_drift_candidate_id:body.sourceDriftCandidateId?Number(body.sourceDriftCandidateId):null,p_actor_user_id:auth.actor.id});if(error)throw error;const result=data as Record<string,unknown>;if(result.status!=="created")return ledgerJson({ok:false,code:String(result.status).toUpperCase()},result.status==="forbidden"?403:result.status==="drift_already_resolved"?409:400);return ledgerJson({ok:true,result},201)}catch(error){console.error("[LEDGER_CORRECTION_POST_FAILED]",error);return ledgerJson({ok:false,code:"CORRECTION_FAILED"},500)}
}
