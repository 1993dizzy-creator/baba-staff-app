import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";
import { withInventoryDisplay } from "@/lib/ledger/inventory-display";
import { calculatePayableBalances, calculatePurchaseSettlement, confirmedAllocationsThroughMonth, payableAllocationsForBalanceAnchors, payableDisplayAsOf, payableMonthBounds, sumPayableAmounts, type PayablePayment } from "@/lib/ledger/payables";
import { buildPaymentVerificationItems, isPaymentVerification } from "@/lib/ledger/payment-verification";
import { buildSettlementPeriods, type SettlementPolicyValue } from "@/lib/ledger/settlement-periods";
import { getBusinessDate } from "@/lib/common/business-time";
import { loadPayableBalanceAnchors } from "@/lib/ledger/payable-balance-anchor-data";

async function loadAll<T>(query:(from:number,to:number)=>PromiseLike<{data:T[]|null;error:unknown}>){
  const rows:T[]=[];
  for(let from=0;;from+=1000){const result=await query(from,from+999);if(result.error)return {data:rows,error:result.error};rows.push(...result.data??[]);if((result.data?.length??0)<1000)return {data:rows,error:null}}
}

export const dynamic = "force-dynamic";
async function getPayables(request: Request) {
  const auth = await requireLedgerActor(); if (auth.response) return auth.response;
  const url=new URL(request.url),month=url.searchParams.get("month"),historyPartyParam=url.searchParams.get("historyPartyId");
  const asOfDate=url.searchParams.get("asOf")??undefined;
  if(asOfDate&&(!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)||!Number.isFinite(Date.parse(asOfDate))||new Date(asOfDate).toISOString().slice(0,10)!==asOfDate||(month&&asOfDate.slice(0,7)!==month)))return ledgerJson({ok:false,code:"INVALID_AS_OF_DATE"},400);
  let bounds:ReturnType<typeof payableMonthBounds>|null=null;
  if(month!==null){try{bounds=payableMonthBounds(month)}catch{return ledgerJson({ok:false,code:"INVALID_MONTH"},400)}}
  // Historical month detail is read lazily, one party at a time (opened 월말 미납 상세);
  // the month view itself no longer builds every party's history.
  const historyPartyId=historyPartyParam===null?null:Number(historyPartyParam);
  if(historyPartyId!==null&&(month===null||!Number.isSafeInteger(historyPartyId)||historyPartyId<=0))return ledgerJson({ok:false,code:"INVALID_HISTORY_PARTY"},400);
  const emptyRows=Promise.resolve({data:[],error:null});
  const [payableResult,allocationResult,paymentResult,bridgeResult,partnerResult,anchorResult]=await Promise.all([
    loadAll((from,to)=>{let query=supabaseServer.from("ledger_payables")
      .select("id,party_id,original_amount,due_date,status,created_at,party:ledger_parties(name),expense:ledger_transactions!inner(id,type,source_type,source_key,business_date,status,memo,source_snapshot)")
      .neq("status","cancelled").eq("expense.status","confirmed");if(bounds)query=query.lt("expense.business_date",bounds.nextMonthStart);if(historyPartyId!==null)query=query.eq("party_id",historyPartyId);return query.order("created_at",{ascending:false}).order("id").range(from,to)}),
    // All confirmed allocations (no month cutoff): 결제 미확인 needs today's remaining; the month cutoff is applied in memory below.
    loadAll((from,to)=>supabaseServer.from("ledger_payable_allocations").select("id,payable_id,allocated_amount,created_at,payment:ledger_transactions!inner(id,type,source_type,source_key,source_snapshot,amount,economic_effect_sign,memo,business_date,status,movements:ledger_movements(amount))").eq("payment.status","confirmed").order("id").range(from,to)),
    historyPartyId!==null?emptyRows:loadAll((from,to)=>{let query=supabaseServer.from("ledger_transactions").select("id,party_id,business_date").eq("type","payable_payment").eq("status","confirmed");if(bounds)query=query.lt("business_date",bounds.nextMonthStart);return query.order("business_date",{ascending:false}).order("id").range(from,to)}),
    historyPartyId!==null?emptyRows:loadAll((from,to)=>supabaseServer.from("business_partner_ledger_parties").select("business_partner_id,ledger_party_id").order("ledger_party_id").range(from,to)),
    historyPartyId!==null?emptyRows:loadAll((from,to)=>supabaseServer.from("business_partners").select("id,partner_type,payment_mode,settlement_mode,settlement_rule,settlement_days,default_payment_term_days").order("id").range(from,to)),loadPayableBalanceAnchors()]);
  const loadError=payableResult.error??allocationResult.error??paymentResult.error??bridgeResult.error??partnerResult.error??anchorResult.error;
  if(loadError){console.error("[LEDGER_PAYABLES_GET_FAILED]",loadError);return ledgerJson({ok:false,code:"PAYABLES_LOAD_FAILED"},500)}
  // Supabase's untyped client infers embedded many-to-one relations as arrays.
  const sources=payableResult.data.map(row=>({...row,expense:row.expense as unknown as {id:number;type:string;source_type:string;source_key:string|null;business_date:string;status:string;memo:string|null;source_snapshot:Record<string,unknown>|null}|null,party:row.party as unknown as {name:string}|null})).filter(row=>!asOfDate||(row.expense&&row.expense.business_date<=asOfDate));
  const allConfirmedAllocations=payableAllocationsForBalanceAnchors(sources,allocationResult.data.map(row=>({...row,payment:row.payment as unknown as PayablePayment|null})),anchorResult.data).filter(a=>!asOfDate||(a.payment&&a.payment.business_date<=asOfDate));
  // Two contracts: 기타 · 결제 미확인 is a current action queue, so it uses every confirmed
  // allocation to date (an 8월 purchase paid on 9/4 is gone from the 8월 view too).
  // Ordinary payables/history/summary stay as-of the selected month end.
  const asOfAllocations=month===null?allConfirmedAllocations:confirmedAllocationsThroughMonth(allConfirmedAllocations,month);
  const ordinarySources=sources.filter(row=>!isPaymentVerification(row));
  if(historyPartyId!==null){
    // As-of history for one party: every payable recognized by month end with its
    // paid/partial/unpaid state as of that month end (a now-paid row still appears).
    const historySources=ordinarySources.filter(row=>row.status!=="cancelled"&&row.expense?.status==="confirmed"&&row.expense.business_date<bounds!.nextMonthStart);
    const historyAllocations=new Map<number,typeof asOfAllocations>();
    for(const allocation of asOfAllocations){const list=historyAllocations.get(Number(allocation.payable_id))??[];list.push(allocation);historyAllocations.set(Number(allocation.payable_id),list)}
    const historyExpenses=await withInventoryDisplay(historySources.flatMap(row=>row.expense?[row.expense]:[]));
    const historyExpenseById=new Map(historyExpenses.map(row=>[Number(row.id),row]));
    const historyPayables=historySources.map(row=>{
      const context={payableId:row.id,transactionId:row.expense?.id};
      const display=payableDisplayAsOf(row.original_amount,historyAllocations.get(Number(row.id))??[],month!,context);
      const purchaseSettlement=calculatePurchaseSettlement(row.original_amount,historyAllocations.get(Number(row.id))??[],context);
      const expense=row.expense?historyExpenseById.get(Number(row.expense.id))??{...row.expense,display_snapshot:null}:null;
      return {id:row.id,party_id:row.party_id,original_amount:row.original_amount,paidAmount:display.paidAmount,outstandingAmount:display.remainingAmount,settlementStatus:display.status,purchaseSettlement,expense:expense?{...expense,display_snapshot:expense.display_snapshot??null}:null};
    });
    const historyBalance=calculatePayableBalances(ordinarySources,allConfirmedAllocations,month!,anchorResult.data.filter(a=>a.party_id===historyPartyId),asOfDate);
    return ledgerJson({ok:true,month,partyId:historyPartyId,historyPayables,totalOutstanding:historyBalance.totalOutstanding,balanceAnchors:historyBalance.balanceAnchors??[]});
  }
  const verification=buildPaymentVerificationItems(sources,allConfirmedAllocations);
  const balances=calculatePayableBalances(ordinarySources,allConfirmedAllocations,month??undefined,anchorResult.data,asOfDate);
  const payables=balances.payables.map(row=>({...row,allocations:asOfAllocations.filter(item=>item.payable_id===row.id).map(item=>({allocated_amount:item.allocated_amount}))}));
  const recent=new Map<number,string>();for(const row of paymentResult.data??[])if(row.party_id&&!recent.has(Number(row.party_id)))recent.set(Number(row.party_id),row.business_date);
  const businessPartnerByLedgerParty=new Map((bridgeResult.data??[]).map(row=>[Number(row.ledger_party_id),Number(row.business_partner_id)]));
  const partnerTypeByBusinessPartner=new Map((partnerResult.data??[]).map(row=>[Number(row.id),row.partner_type]));
  const map=new Map<number,{partyId:number;partyName:string;partnerType:string|null;outstandingAmount:number;partialPaidAmount:number;totalOpenAmount:number;openCount:number;oldestDate:string;nearestDueDate:string|null;recentPaymentDate:string|null}>();
  for(const row of payables){const partyRelation=row.party as unknown as {name:string}|null;const partyId=Number(row.party_id);const expense=row.expense as unknown as {business_date:string}|null;const businessPartnerId=businessPartnerByLedgerParty.get(partyId);const current=map.get(partyId)??{partyId,partyName:partyRelation?.name??"-",partnerType:businessPartnerId===undefined?null:partnerTypeByBusinessPartner.get(businessPartnerId)??null,outstandingAmount:0,partialPaidAmount:0,totalOpenAmount:0,openCount:0,oldestDate:expense?.business_date??"",nearestDueDate:null,recentPaymentDate:recent.get(partyId)??null};current.outstandingAmount+=row.outstandingAmount;current.partialPaidAmount+=row.allocatedAmount;current.totalOpenAmount+=Number(row.original_amount);current.openCount+=1;if(expense?.business_date&&(!current.oldestDate||expense.business_date<current.oldestDate))current.oldestDate=expense.business_date;if(row.due_date&&(!current.nearestDueDate||row.due_date<current.nearestDueDate))current.nearestDueDate=row.due_date;map.set(partyId,current)}
  // Sum each party independently in thousandths, preserving exact 3-digit precision.
  for(const party of map.values()){const rows=payables.filter(row=>Number(row.party_id)===party.partyId);party.outstandingAmount=sumPayableAmounts(rows.map(row=>row.outstandingAmount));party.partialPaidAmount=sumPayableAmounts(rows.map(row=>row.allocatedAmount));party.totalOpenAmount=sumPayableAmounts(rows.map(row=>row.original_amount))}
  for(const anchor of balances.balanceAnchors??[]){
    if(anchor.settlement)continue;
    const source=ordinarySources.find(row=>Number(row.party_id)===anchor.party_id);
    const current=map.get(anchor.party_id)??{partyId:anchor.party_id,partyName:source?.party?.name??"Coca-Cola",partnerType:null,outstandingAmount:0,partialPaidAmount:0,totalOpenAmount:0,openCount:0,oldestDate:"",nearestDueDate:null,recentPaymentDate:recent.get(anchor.party_id)??null};
    current.outstandingAmount=sumPayableAmounts([current.outstandingAmount,anchor.adjustment_amount]);map.set(anchor.party_id,current);
  }
  const currentParties=[...map.values()];
  const parties=month===null?currentParties:(balances.partySummaries??[]).map(summary=>{
    const source=ordinarySources.find(row=>Number(row.party_id)===summary.partyId);
    const partyRelation=source?.party as unknown as {name:string}|null;
    const businessPartnerId=businessPartnerByLedgerParty.get(summary.partyId);
    const metadata=map.get(summary.partyId)??{partyId:summary.partyId,partyName:partyRelation?.name??"-",partnerType:businessPartnerId===undefined?null:partnerTypeByBusinessPartner.get(businessPartnerId)??null,partialPaidAmount:0,totalOpenAmount:0,openCount:0,oldestDate:"",nearestDueDate:null,recentPaymentDate:recent.get(summary.partyId)??null};
    return {...metadata,...summary,outstandingAmount:summary.closingOutstanding};
  });
  // Read-only settlement-period view (P0-2B): the linked partner terms group this party's
  // ordinary payables by 정산 기준 period, with the same as-of allocations as above. Payment
  // verification items stay excluded; nothing is written and due_date is never derived.
  const policyByBusinessPartner=new Map((partnerResult.data??[]).map(row=>[Number(row.id),{paymentMode:row.payment_mode,settlementMode:row.settlement_mode??null,settlementRule:row.settlement_rule??null,settlementDays:Array.isArray(row.settlement_days)?row.settlement_days.map(Number):null,defaultPaymentTermDays:row.default_payment_term_days==null?null:Number(row.default_payment_term_days)} satisfies SettlementPolicyValue]));
  const settlementAsOf=asOfDate??(bounds?new Date(Date.parse(bounds.nextMonthStart+"T00:00:00Z")-86400000).toISOString().slice(0,10):getBusinessDate());
  const allocationsByPayable=new Map<number,typeof asOfAllocations>();
  for(const allocation of asOfAllocations){const list=allocationsByPayable.get(Number(allocation.payable_id))??[];list.push(allocation);allocationsByPayable.set(Number(allocation.payable_id),list)}
  const sourcesByParty=new Map<number,typeof ordinarySources>();
  for(const row of ordinarySources){if(row.status==="cancelled"||row.expense?.status!=="confirmed"||(bounds&&row.expense.business_date>=bounds.nextMonthStart))continue;const list=sourcesByParty.get(Number(row.party_id))??[];list.push(row);sourcesByParty.set(Number(row.party_id),list)}
  const withSettlement=parties.map(party=>{
    const businessPartnerId=businessPartnerByLedgerParty.get(party.partyId);
    const settlementPolicy=businessPartnerId===undefined?null:policyByBusinessPartner.get(businessPartnerId)??null;
    const settlementPeriods=buildSettlementPeriods(settlementPolicy,(sourcesByParty.get(party.partyId)??[]).map(row=>{
      const settlement=calculatePurchaseSettlement(row.original_amount,allocationsByPayable.get(Number(row.id))??[],{payableId:row.id,transactionId:row.expense?.id});
      const ownerSettlement=row.expense?.type==="owner_payable_settlement";
      return {id:row.id,businessDate:row.expense?.business_date??null,originalAmount:ownerSettlement?0:row.original_amount,settlement:ownerSettlement?{...settlement,adjustmentAmount:Number(row.original_amount)}:settlement};
    }),settlementAsOf);
    return {...party,settlementPolicy,settlementPeriods,settlementAsOf,balanceAnchors:(balances.balanceAnchors??[]).filter(a=>a.party_id===party.partyId)};
  });
  return ledgerJson({ok:true,totalOutstanding:balances.totalOutstanding,verification,...(month!==null?{month,summary:balances.summary}:{}),payables,parties:withSettlement.sort((a,b)=>b.outstandingAmount-a.outstandingAmount)});
}

export async function GET(request:Request) {
  try{return await getPayables(request)}catch(error){
    const code=error instanceof Error&&error.message==="PAYABLE_BALANCE_ANCHOR_BASELINE_DRIFT"?error.message:"PAYABLES_LOAD_FAILED";
    console.error("[LEDGER_PAYABLES_GET_FAILED]",{code});
    return ledgerJson({ok:false,code},500);
  }
}
