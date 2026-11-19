import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";
import { withInventoryDisplay } from "@/lib/ledger/inventory-display";
import { calculatePayableBalances, calculatePurchaseSettlement, payableAllocationsForBalanceAnchors, type PayablePayment } from "@/lib/ledger/payables";
import { loadPayableBalanceAnchors } from "@/lib/ledger/payable-balance-anchor-data";

export async function GET(_request:Request,context:{params:Promise<{partyId:string}>}) {
  const auth=await requireLedgerActor();if(auth.response)return auth.response;
  const {partyId:raw}=await context.params,partyId=Number(raw);
  if(!Number.isInteger(partyId)||partyId<=0)return ledgerJson({ok:false,code:"INVALID_PARTY"},400);
  try {
    const [partyResult,payableResult,paymentResult,anchorResult]=await Promise.all([
      supabaseServer.from("ledger_parties").select("id,name,memo,default_payment_term_days").eq("id",partyId).maybeSingle(),
      supabaseServer.from("ledger_payables").select("id,party_id,original_amount,due_date,status,created_at,expense:ledger_transactions(id,type,source_type,source_key,business_date,status,memo,source_snapshot),allocations:ledger_payable_allocations(allocated_amount,payment_transaction_id,created_at,payment:ledger_transactions!payment_transaction_id(id,type,source_type,source_key,source_snapshot,amount,economic_effect_sign,memo,business_date,status,movements:ledger_movements(amount)))").eq("party_id",partyId).neq("status","cancelled").order("created_at"),
      supabaseServer.from("ledger_transactions").select("id,business_date,occurred_at,amount,memo,movements:ledger_movements(amount,fund_account:ledger_fund_accounts(display_name)),allocations:ledger_payable_allocations(payable_id,allocated_amount)").eq("party_id",partyId).eq("type","payable_payment").eq("status","confirmed").order("business_date",{ascending:false}),
      loadPayableBalanceAnchors(),
    ]);
    if(partyResult.error||payableResult.error||paymentResult.error||anchorResult.error)throw new Error("PAYABLE_DETAIL_LOAD_FAILED");
    if(!partyResult.data)return ledgerJson({ok:false,code:"PARTY_NOT_FOUND"},404);
    const sources=(payableResult.data??[]).map(row=>({...row,expense:row.expense as unknown as {id:number;type:string;source_type:string;source_key:string;business_date:string;status:string;source_snapshot:Record<string,unknown>}|null}))
      .filter(row=>row.expense?.status==="confirmed"&&row.expense.source_snapshot?.paymentVerification!=="pending");
    const anchors=anchorResult.data.filter(a=>a.party_id===partyId);
    const allocations=payableAllocationsForBalanceAnchors(sources,sources.flatMap(row=>(row.allocations??[]).map(a=>({...a,payable_id:row.id,payment:a.payment as unknown as PayablePayment|null}))),anchors);
    const balances=calculatePayableBalances(sources,allocations,undefined,anchors);
    const displays=new Map((await withInventoryDisplay(sources.flatMap(row=>row.expense?[row.expense]:[]))).map(row=>[row.id,row]));
    // Only real payable rows enter the date/partial-payment selector.
    const payables=sources.map(row=>{
      const purchaseSettlement=calculatePurchaseSettlement(row.original_amount,allocations.filter(a=>a.payable_id===row.id),{payableId:row.id,transactionId:row.expense?.id});
      return {...row,expense:row.expense?displays.get(row.expense.id)??row.expense:null,paidAmount:purchaseSettlement.cashPaidAmount,purchaseSettlement,outstandingAmount:purchaseSettlement.remainingAmount};
    });
    const ordinaryIds=new Set(payables.map(row=>Number(row.id)));
    const payments=(paymentResult.data??[]).filter(row=>(row.allocations??[]).some(a=>ordinaryIds.has(Number(a.payable_id))));
    return ledgerJson({ok:true,party:partyResult.data,payables,payments,totalOutstanding:balances.totalOutstanding,balanceAnchors:balances.balanceAnchors??[]});
  } catch(error) {
    const code=error instanceof Error&&error.message==="PAYABLE_BALANCE_ANCHOR_BASELINE_DRIFT"?error.message:"PAYABLE_DETAIL_LOAD_FAILED";
    console.error("[LEDGER_PAYABLE_PARTY_GET_FAILED]",{code});
    return ledgerJson({ok:false,code},500);
  }
}
