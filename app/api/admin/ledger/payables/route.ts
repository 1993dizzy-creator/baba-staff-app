import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export async function GET() {
  const auth = await requireLedgerActor(); if (auth.response) return auth.response;
  const [payableResult,paymentResult]=await Promise.all([supabaseServer.from("ledger_payables")
    .select("id,party_id,original_amount,due_date,status,created_at,party:ledger_parties(name),expense:ledger_transactions(business_date,memo,source_snapshot),allocations:ledger_payable_allocations(allocated_amount)")
    .neq("status", "cancelled").order("created_at", { ascending: false }),supabaseServer.from("ledger_transactions").select("party_id,business_date").eq("type","payable_payment").eq("status","confirmed").order("business_date",{ascending:false})]);
  if(payableResult.error||paymentResult.error){console.error("[LEDGER_PAYABLES_GET_FAILED]",payableResult.error??paymentResult.error);return ledgerJson({ok:false,code:"PAYABLES_LOAD_FAILED"},500)}
  const payables=(payableResult.data??[]).map(row=>{const allocated=(row.allocations??[]).reduce((sum,item)=>sum+Number(item.allocated_amount),0);return{...row,allocatedAmount:allocated,outstandingAmount:Math.max(0,Number(row.original_amount)-allocated)}}).filter(row=>row.outstandingAmount>0);
  const recent=new Map<number,string>();for(const row of paymentResult.data??[])if(row.party_id&&!recent.has(Number(row.party_id)))recent.set(Number(row.party_id),row.business_date);
  const map=new Map<number,{partyId:number;partyName:string;outstandingAmount:number;openCount:number;oldestDate:string;nearestDueDate:string|null;recentPaymentDate:string|null}>();
  for(const row of payables){const partyRelation=row.party as unknown as {name:string}|null;const partyId=Number(row.party_id);const expense=row.expense as unknown as {business_date:string}|null;const current=map.get(partyId)??{partyId,partyName:partyRelation?.name??"-",outstandingAmount:0,openCount:0,oldestDate:expense?.business_date??"",nearestDueDate:null,recentPaymentDate:recent.get(partyId)??null};current.outstandingAmount+=row.outstandingAmount;current.openCount+=1;if(expense?.business_date&&(!current.oldestDate||expense.business_date<current.oldestDate))current.oldestDate=expense.business_date;if(row.due_date&&(!current.nearestDueDate||row.due_date<current.nearestDueDate))current.nearestDueDate=row.due_date;map.set(partyId,current)}
  return ledgerJson({ok:true,totalOutstanding:payables.reduce((sum,item)=>sum+item.outstandingAmount,0),payables,parties:[...map.values()].sort((a,b)=>b.outstandingAmount-a.outstandingAmount)});
}
