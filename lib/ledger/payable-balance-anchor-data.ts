import { supabaseServer } from "@/lib/supabase/server";
import type { PayableBalanceAnchor } from "@/lib/ledger/payables";

export function isMissingPayableBalanceAnchorTable(error: {code?:string;message?:string} | null) {
  return !!error && ["42P01", "PGRST205"].includes(error.code ?? "") &&
    /\bledger_payable_balance_anchors\b/.test(error.message ?? "");
}

// Old DB: no structure, no anchor, same existing accounting. Permission/network
// errors must fail visibly; they must never silently remove an active anchor.
export async function loadPayableBalanceAnchors() {
  const [{data,error},settlements]=await Promise.all([supabaseServer.from("ledger_payable_balance_anchors")
    .select("id,party_id,business_date,owner_balance,app_balance,adjustment_amount,evidence_kind,source_unverified,evidence_reference,created_at")
    .order("id"),supabaseServer.from("ledger_payable_anchor_settlements").select("anchor_id,payable_id,transaction_id").order("anchor_id")]);
  const missingSettlementTable=settlements.error&&["42P01","PGRST205"].includes(settlements.error.code??"")&&/\bledger_payable_anchor_settlements\b/.test(settlements.error.message??"");
  if(settlements.error&&!missingSettlementTable)return {data:[] as PayableBalanceAnchor[],error:settlements.error};
  if(isMissingPayableBalanceAnchorTable(error))return {data:[] as PayableBalanceAnchor[],error:null};
  const links=missingSettlementTable?[]:settlements.data??[];
  if(links.some(link=>!(data??[]).some(a=>Number(a.id)===Number(link.anchor_id))))return {data:[] as PayableBalanceAnchor[],error:{code:"OWNER_PAYABLE_SETTLEMENT_INVALID"}};
  return {data:(data??[]).map(anchor=>{const link=links.find(l=>Number(l.anchor_id)===Number(anchor.id));return {...anchor,...(link?{settlement:{payable_id:Number(link.payable_id),transaction_id:Number(link.transaction_id)}}:{})}}) as PayableBalanceAnchor[],error};
}
