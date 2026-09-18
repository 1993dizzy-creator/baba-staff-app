import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";
import { withInventoryDisplay } from "@/lib/ledger/inventory-display";
import { calculatePayableBalances, payableDisplayAsOf, payableMonthBounds, sumPayableAmounts } from "@/lib/ledger/payables";

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
      .select("id,party_id,original_amount,due_date,status,created_at,party:ledger_parties(name),expense:ledger_transactions!inner(id,business_date,status,memo,source_snapshot)")
      .neq("status","cancelled").eq("expense.status","confirmed");if(bounds)query=query.lt("expense.business_date",bounds.nextMonthStart);return query.order("created_at",{ascending:false}).order("id").range(from,to)}),
    loadAll((from,to)=>{let query=supabaseServer.from("ledger_payable_allocations").select("id,payable_id,allocated_amount,payment:ledger_transactions!inner(business_date,status)").eq("payment.status","confirmed");if(bounds)query=query.lt("payment.business_date",bounds.nextMonthStart);return query.order("id").range(from,to)}),
    loadAll((from,to)=>{let query=supabaseServer.from("ledger_transactions").select("id,party_id,business_date").eq("type","payable_payment").eq("status","confirmed");if(bounds)query=query.lt("business_date",bounds.nextMonthStart);return query.order("business_date",{ascending:false}).order("id").range(from,to)}),
    loadAll((from,to)=>supabaseServer.from("business_partner_ledger_parties").select("business_partner_id,ledger_party_id").order("ledger_party_id").range(from,to)),
    loadAll((from,to)=>supabaseServer.from("business_partners").select("id,partner_type").order("id").range(from,to))]);
  const loadError=payableResult.error??allocationResult.error??paymentResult.error??bridgeResult.error??partnerResult.error;
  if(loadError){console.error("[LEDGER_PAYABLES_GET_FAILED]",loadError);return ledgerJson({ok:false,code:"PAYABLES_LOAD_FAILED"},500)}
  // Supabase's untyped client infers embedded many-to-one relations as arrays.
  const sources=payableResult.data.map(row=>({...row,expense:row.expense as unknown as {id:number;business_date:string;status:string;memo:string|null;source_snapshot:Record<string,unknown>|null}|null}));
  const allocations=allocationResult.data.map(row=>({...row,payment:row.payment as unknown as {business_date:string;status:string}|null}));
  const balances=calculatePayableBalances(sources,allocations,month??undefined);
  const payables=balances.payables.map(row=>({...row,allocations:allocations.filter(item=>item.payable_id===row.id).map(item=>({allocated_amount:item.allocated_amount}))}));
  const historySources=month===null?[]:sources.filter(row=>row.status!=="cancelled"&&row.expense?.status==="confirmed"&&row.expense.business_date<bounds!.nextMonthStart);
  const historyAllocations=new Map<number,typeof allocations>();
  for(const allocation of allocations){const list=historyAllocations.get(Number(allocation.payable_id))??[];list.push(allocation);historyAllocations.set(Number(allocation.payable_id),list)}
  const historyExpenses=await withInventoryDisplay(historySources.flatMap(row=>row.expense?[row.expense]:[]));
  const historyExpenseById=new Map(historyExpenses.map(row=>[Number(row.id),row]));
  const historyPayables=historySources.map(row=>{
    const display=payableDisplayAsOf(row.original_amount,historyAllocations.get(Number(row.id))??[],month!);
    const expense=row.expense?historyExpenseById.get(Number(row.expense.id))??{...row.expense,display_snapshot:null}:null;
    return {id:row.id,party_id:row.party_id,original_amount:row.original_amount,paidAmount:display.paidAmount,outstandingAmount:display.remainingAmount,settlementStatus:display.status,expense:expense?{...expense,display_snapshot:expense.display_snapshot??null}:null};
  });
  const recent=new Map<number,string>();for(const row of paymentResult.data??[])if(row.party_id&&!recent.has(Number(row.party_id)))recent.set(Number(row.party_id),row.business_date);
  const businessPartnerByLedgerParty=new Map((bridgeResult.data??[]).map(row=>[Number(row.ledger_party_id),Number(row.business_partner_id)]));
  const partnerTypeByBusinessPartner=new Map((partnerResult.data??[]).map(row=>[Number(row.id),row.partner_type]));
  const map=new Map<number,{partyId:number;partyName:string;partnerType:string|null;outstandingAmount:number;partialPaidAmount:number;totalOpenAmount:number;openCount:number;oldestDate:string;nearestDueDate:string|null;recentPaymentDate:string|null}>();
  for(const row of payables){const partyRelation=row.party as unknown as {name:string}|null;const partyId=Number(row.party_id);const expense=row.expense as unknown as {business_date:string}|null;const businessPartnerId=businessPartnerByLedgerParty.get(partyId);const current=map.get(partyId)??{partyId,partyName:partyRelation?.name??"-",partnerType:businessPartnerId===undefined?null:partnerTypeByBusinessPartner.get(businessPartnerId)??null,outstandingAmount:0,partialPaidAmount:0,totalOpenAmount:0,openCount:0,oldestDate:expense?.business_date??"",nearestDueDate:null,recentPaymentDate:recent.get(partyId)??null};current.outstandingAmount+=row.outstandingAmount;current.partialPaidAmount+=row.allocatedAmount;current.totalOpenAmount+=Number(row.original_amount);current.openCount+=1;if(expense?.business_date&&(!current.oldestDate||expense.business_date<current.oldestDate))current.oldestDate=expense.business_date;if(row.due_date&&(!current.nearestDueDate||row.due_date<current.nearestDueDate))current.nearestDueDate=row.due_date;map.set(partyId,current)}
  // Sum each party independently in thousandths, preserving exact 3-digit precision.
  for(const party of map.values()){const rows=payables.filter(row=>Number(row.party_id)===party.partyId);party.outstandingAmount=sumPayableAmounts(rows.map(row=>row.outstandingAmount));party.partialPaidAmount=sumPayableAmounts(rows.map(row=>row.allocatedAmount));party.totalOpenAmount=sumPayableAmounts(rows.map(row=>row.original_amount))}
  const currentParties=[...map.values()];
  const parties=month===null?currentParties:(balances.partySummaries??[]).map(summary=>{
    const source=sources.find(row=>Number(row.party_id)===summary.partyId);
    const partyRelation=source?.party as unknown as {name:string}|null;
    const businessPartnerId=businessPartnerByLedgerParty.get(summary.partyId);
    const metadata=map.get(summary.partyId)??{partyId:summary.partyId,partyName:partyRelation?.name??"-",partnerType:businessPartnerId===undefined?null:partnerTypeByBusinessPartner.get(businessPartnerId)??null,partialPaidAmount:0,totalOpenAmount:0,openCount:0,oldestDate:"",nearestDueDate:null,recentPaymentDate:recent.get(summary.partyId)??null};
    return {...metadata,...summary,outstandingAmount:summary.closingOutstanding};
  });
  return ledgerJson({ok:true,totalOutstanding:balances.totalOutstanding,...(month!==null?{month,summary:balances.summary,historyPayables}:{}),payables,parties:parties.sort((a,b)=>b.outstandingAmount-a.outstandingAmount)});
}
