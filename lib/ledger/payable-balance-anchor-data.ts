import { supabaseServer } from "@/lib/supabase/server";
import type { PayableBalanceAnchor } from "@/lib/ledger/payables";

export function isMissingPayableBalanceAnchorTable(error: {code?:string;message?:string} | null) {
  return !!error && ["42P01", "PGRST205"].includes(error.code ?? "") &&
    /\bledger_payable_balance_anchors\b/.test(error.message ?? "");
}

// Old DB: no structure, no anchor, same existing accounting. Permission/network
// errors must fail visibly; they must never silently remove an active anchor.
export async function loadPayableBalanceAnchors() {
  const {data,error}=await supabaseServer.from("ledger_payable_balance_anchors")
    .select("id,party_id,business_date,owner_balance,app_balance,adjustment_amount,evidence_kind,source_unverified,evidence_reference,created_at")
    .order("id");
  if(isMissingPayableBalanceAnchorTable(error))return {data:[] as PayableBalanceAnchor[],error:null};
  return {data:(data??[]) as PayableBalanceAnchor[],error};
}
