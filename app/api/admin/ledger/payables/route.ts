import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";
import { calculatePayableBalances, payableMonthBounds, sumPayableAmounts } from "@/lib/ledger/payables";

async function loadAll<T>(query:(from:number,to:number)=>PromiseLike<{data:T[]|null;error:unknown}>){
  const rows:T[]=[];
  for(let from=0;;from+=1000){const result=await query(from,from+999);if(result.error)return {data:rows,error:result.error};rows.push(...result.data??[]);if((result.data?.length??0)<1000)return {data:rows,error:null}}
}

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const auth = await requireLedgerActor(); if (auth.response) return auth.response;
  const month=new URL(request.url).searchParams.get("month");
  let bounds:ReturnType<typeof payableMonthBounds>|null=null;
  if(month!==null){try{bounds=payableMonthBounds(month)}catch{return ledgerJson({ok:false,code:"INVALID_MONTH"},400)}}
  const [payableResult,allocationResult,paymentResult,bridgeResult,partnerResult]=await Promise.all([
    loadAll((from,to)=>{let query=supabaseServer.from("ledger_payables")
      .select("id,party_id,original_amount,due_date,status,created_at,party:ledger_parties(name),expense:ledger_transactions!inner(business_date,status,memo,source_snapshot)")
      .neq("status","cancelled").eq("expense.status","confirmed");if(bounds)query=query.lt("expense.business_date",bounds.nextMonthStart);return query.order("created_at",{ascending:false}).order("id").range(from,to)}),
    loadAll((from,to)=>{let query=supabaseServer.from("ledger_payable_allocations").select("id,payable_id,allocated_amount,payment:ledger_transactions!inner(business_date,status)").eq("payment.status","confirmed");if(bounds)query=query.lt("payment.business_date",bounds.nextMonthStart);return query.order("id").range(from,to)}),
    loadAll((from,to)=>{let query=supabaseServer.from("ledger_transactions").select("id,party_id,business_date").eq("type","payable_payment").eq("status","confirmed");if(bounds)query=query.lt("business_date",bounds.nextMonthStart);return query.order("business_date",{ascending:false}).order("id").range(from,to)}),
    loadAll((from,to)=>supabaseServer.from("business_partner_ledger_parties").select("business_partner_id,ledger_party_id").order("ledger_party_id").range(from,to)),
    loadAll((from,to)=>supabaseServer.from("business_partners").select("id,partner_type").order("id").range(from,to))]);
  const loadError=payableResult.error??allocationResult.error??paymentResult.error??bridgeResult.error??partnerResult.error;
  if(loadError){console.error("[LEDGER_PAYABLES_GET_FAILED]",loadError);return ledgerJson({ok:false,code:"PAYABLES_LOAD_FAILED"},500)}
  // Supabase's untyped client infers embedded many-to-one relations as arrays.
  const sources=payableResult.data.map(row=>({...row,expense:row.expense as unknown as {business_date:string;status:string;memo:string|null;source_snapshot:unknown}|null}));
  const allocations=allocationResult.data.map(row=>({...row,payment:row.payment as unknown as {business_date:string;status:string}|null}));
  const balances=calculatePayableBalances(sources,allocations,month??undefined);
  const payables=balances.payables.map(row=>({...row,allocations:allocations.filter(item=>item.payable_id===row.id).map(item=>({allocated_amount:item.allocated_amount}))}));
  const recent=new Map<number,string>();for(const row of paymentResult.data??[])if(row.party_id&&!recent.has(Number(row.party_id)))recent.set(Number(row.party_id),row.business_date);
  const businessPartnerByLedgerParty=new Map((bridgeResult.data??[]).map(row=>[Number(row.ledger_party_id),Number(row.business_partner_id)]));
  const partnerTypeByBusinessPartner=new Map((partnerResult.data??[]).map(row=>[Number(row.id),row.partner_type]));
  const map=new Map<number,{partyId:number;partyName:string;partnerType:string|null;outstandingAmount:number;partialPaidAmount:number;totalOpenAmount:number;openCount:number;oldestDate:string;nearestDueDate:string|null;recentPaymentDate:string|null}>();
  for(const row of payables){const partyRelation=row.party as unknown as {name:string}|null;const partyId=Number(row.party_id);const expense=row.expense as unknown as {business_date:string}|null;const businessPartnerId=businessPartnerByLedgerParty.get(partyId);const current=map.get(partyId)??{partyId,partyName:partyRelation?.name??"-",partnerType:businessPartnerId===undefined?null:partnerTypeByBusinessPartner.get(businessPartnerId)??null,outstandingAmount:0,partialPaidAmount:0,totalOpenAmount:0,openCount:0,oldestDate:expense?.business_date??"",nearestDueDate:null,recentPaymentDate:recent.get(partyId)??null};current.outstandingAmount+=row.outstandingAmount;current.partialPaidAmount+=row.allocatedAmount;current.totalOpenAmount+=Number(row.original_amount);current.openCount+=1;if(expense?.business_date&&(!current.oldestDate||expense.business_date<current.oldestDate))current.oldestDate=expense.business_date;if(row.due_date&&(!current.nearestDueDate||row.due_date<current.nearestDueDate))current.nearestDueDate=row.due_date;map.set(partyId,current)}
  // Sum each party independently in thousandths, preserving exact 3-digit precision.
  for(const party of map.values()){const rows=payables.filter(row=>Number(row.party_id)===party.partyId);party.outstandingAmount=sumPayableAmounts(rows.map(row=>row.outstandingAmount));party.partialPaidAmount=sumPayableAmounts(rows.map(row=>row.allocatedAmount));party.totalOpenAmount=sumPayableAmounts(rows.map(row=>row.original_amount))}
  return ledgerJson({ok:true,totalOutstanding:balances.totalOutstanding,...(month!==null?{month,summary:balances.summary}:{}),payables,parties:[...map.values()].sort((a,b)=>b.outstandingAmount-a.outstandingAmount)});
}
