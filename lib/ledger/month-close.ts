import "server-only";

import { createHash } from "node:crypto";
import { getBusinessMonthEndBoundary } from "@/lib/common/business-time";
import { calculateMonthCloseCardSnapshot } from "@/lib/ledger/month-close-card";
import { type CardDifferenceLine } from "@/lib/ledger/card-difference-attribution";
import { calculateMonthCloseOperatingSummary } from "@/lib/ledger/month-close-operating";
import { supabaseServer } from "@/lib/supabase/server";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const validCloseMonth = (value: unknown): value is string => typeof value === "string" && MONTH.test(value);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function snapshotHash(snapshot: unknown) {
  return createHash("sha256").update(canonical(snapshot)).digest("hex");
}

type Tx = { id:number; type:string; business_date:string; recognition_month:string|null; amount:number|string; economic_effect_sign:number; source_type:string; source_key:string|null; category:{name:string}|null; movements:Array<{fund_account_id:number;amount:number|string}> };

export async function buildMonthCloseSnapshot(month: string) {
  const monthStart = `${month}-01`, { businessDateExclusive: endExclusive, cutoffAt: endAt } = getBusinessMonthEndBoundary(month);
  const [transactionsResult, accountsResult, payableResult, allocationResult, cardResult, cardLineResult, cardFeeLineResult, reserveResult, reserveEntryResult, payrollResult, recurringResult, candidateResult,ownerCapacityResult,ownerInvestmentResult,ownerAllocationResult] = await Promise.all([
    supabaseServer.from("ledger_transactions").select("id,type,business_date,recognition_month,amount,economic_effect_sign,source_type,source_key,category:ledger_categories(name),movements:ledger_movements(fund_account_id,amount)").eq("status","confirmed").or(`recognition_month.eq.${monthStart},business_date.lt.${endExclusive}`),
    supabaseServer.from("ledger_fund_accounts").select("id,code,type,display_name,is_active").order("sort_order"),
    supabaseServer.from("ledger_payables").select("id,party_id,original_amount,status,expense:ledger_transactions!inner(business_date),party:ledger_parties(name)").neq("status","cancelled").lt("expense.business_date",endExclusive),
    supabaseServer.from("ledger_payable_allocations").select("payable_id,allocated_amount,payment:ledger_transactions!inner(business_date)").lt("payment.business_date",endExclusive),
    supabaseServer.from("ledger_card_reconciliations").select("id,status,deposit_date,deposit_amount,matched_gross_amount,difference_amount").lt("deposit_date",endExclusive),
    supabaseServer.from("ledger_card_reconciliation_lines").select("reconciliation_id,pos_card_transaction_id,allocated_gross_amount,reconciliation:ledger_card_reconciliations!inner(deposit_date,status)").eq("reconciliation.status","matched").lt("reconciliation.deposit_date",endExclusive),
    supabaseServer.from("ledger_card_reconciliation_lines").select("reconciliation_id,allocated_gross_amount,sale:ledger_transactions!inner(business_date),reconciliation:ledger_card_reconciliations!inner(status,matched_gross_amount,difference_amount)").eq("reconciliation.status","matched").order("id"),
    supabaseServer.from("ledger_reserve_plans").select("id,name,target_amount,target_date,is_active,fund_account_id,linked_recurring_plan:ledger_recurring_expense_plans(source_key_prefix)").eq("is_active",true),
    supabaseServer.from("ledger_reserve_entries").select("reserve_plan_id,entry_type,amount,occurred_at").lt("occurred_at",endAt),
    supabaseServer.from("payroll_payment_batches").select("id,payroll_month,status,actual_company_cost_total").eq("payroll_month",monthStart).maybeSingle(),
    supabaseServer.from("ledger_recurring_expense_plans").select("id,name,amount,effective_from,effective_to").eq("is_active",true).lte("effective_from",monthStart).or(`effective_to.is.null,effective_to.gte.${monthStart}`),
    supabaseServer.from("ledger_candidates").select("candidate_type,status").eq("proposed_recognition_month",monthStart),
    supabaseServer.rpc("ledger_owner_financial_capacity_v1",{p_through_month:monthStart}),
    supabaseServer.from("ledger_owner_investments").select("participant_id,signed_amount"),
    supabaseServer.from("ledger_owner_settlement_allocations").select("participant_id,recovery_amount,recovery_paid_amount,assigned_amount,paid_amount"),
  ]);
  const errors=[transactionsResult,accountsResult,payableResult,allocationResult,cardResult,cardLineResult,cardFeeLineResult,reserveResult,reserveEntryResult,payrollResult,recurringResult,candidateResult,ownerCapacityResult,ownerInvestmentResult,ownerAllocationResult].map(result=>result.error).filter(Boolean);
  if(errors.length) throw errors[0];
  const allCardFeeLines = [...(cardFeeLineResult.data ?? [])];
  for (let offset = allCardFeeLines.length; offset > 0 && offset % 1000 === 0; offset += 1000) {
    const page = await supabaseServer.from("ledger_card_reconciliation_lines").select("reconciliation_id,allocated_gross_amount,sale:ledger_transactions!inner(business_date),reconciliation:ledger_card_reconciliations!inner(status,matched_gross_amount,difference_amount)").eq("reconciliation.status","matched").order("id").range(offset,offset+999);
    if (page.error) throw page.error;
    allCardFeeLines.push(...(page.data ?? []));
    if ((page.data?.length ?? 0) < 1000) break;
  }
  const txs=(transactionsResult.data??[]) as unknown as Tx[];
  const recognized=txs.filter(tx=>tx.recognition_month===monthStart);
  const cardFeeLines = allCardFeeLines.map((line): CardDifferenceLine => {
    const sale = line.sale as unknown as {business_date:string};
    const reconciliation = line.reconciliation as unknown as {matched_gross_amount:number|string;difference_amount:number|string};
    return {reconciliationId:Number(line.reconciliation_id),businessDate:sale.business_date,allocatedGrossAmount:line.allocated_gross_amount,matchedGrossAmount:reconciliation.matched_gross_amount,differenceAmount:reconciliation.difference_amount};
  });
  const { revenue, expense, operatingResult } = calculateMonthCloseOperatingSummary(month, recognized, cardFeeLines);
  const signed=(tx:Tx)=>Number(tx.amount)*Number(tx.economic_effect_sign??1);
  const fundBalances=new Map<number,number>();for(const tx of txs.filter(tx=>tx.business_date<endExclusive))for(const movement of tx.movements??[])fundBalances.set(Number(movement.fund_account_id),(fundBalances.get(Number(movement.fund_account_id))??0)+Number(movement.amount));
  const accounts=(accountsResult.data??[]).map(account=>({...account,balance:fundBalances.get(Number(account.id))??0}));
  const allocationByPayable=new Map<number,number>();for(const row of allocationResult.data??[])allocationByPayable.set(Number(row.payable_id),(allocationByPayable.get(Number(row.payable_id))??0)+Number(row.allocated_amount));
  const payables=(payableResult.data??[]).map(row=>({partyId:row.party_id,partyName:(row.party as {name?:string}|null)?.name??"미지정",outstanding:Math.max(0,Number(row.original_amount)-(allocationByPayable.get(Number(row.id))??0))}));
  const payableParties=Object.values(payables.reduce<Record<string,{partyId:number|null;partyName:string;outstanding:number}>>((map,row)=>{const key=String(row.partyId);map[key]??={partyId:row.partyId,partyName:row.partyName,outstanding:0};map[key].outstanding+=row.outstanding;return map},{}));
  const reserveAmounts=new Map<number,number>();for(const entry of reserveEntryResult.data??[]){const sign=entry.entry_type==="allocate"?1:entry.entry_type==="release"||entry.entry_type==="consume"?-1:1;reserveAmounts.set(Number(entry.reserve_plan_id),(reserveAmounts.get(Number(entry.reserve_plan_id))??0)+sign*Number(entry.amount))}
  const reserves=(reserveResult.data??[]).map(plan=>({...plan,currentAmount:reserveAmounts.get(Number(plan.id))??0}));
  const protectedReserve=reserves.reduce((sum,row)=>sum+row.currentAmount,0),liquidFunds=accounts.filter(account=>["cash","bank","personal_custody"].includes(account.type)&&account.code!=="card_clearing").reduce((sum,row)=>sum+row.balance,0);
  const cards=cardResult.data??[],cardLines=cardLineResult.data??[];
  const cardSales=txs.filter(tx=>tx.source_type==="pos_sales_daily_payment"&&tx.source_key?.endsWith(":card")&&tx.business_date<endExclusive);
  const candidateCounts=(candidateResult.data??[]).reduce<Record<string,number>>((counts,row)=>{const key=`${row.candidate_type}:${row.status}`;counts[key]=(counts[key]??0)+1;return counts},{});
  const card=calculateMonthCloseCardSnapshot(cards,cardLines,cardSales,endExclusive);
  return {month,revenue,expense,operatingResult,funds:{accounts,liquidFunds,cardClearing:accounts.find(account=>account.code==="card_clearing")?.balance??0},payables:{byParty:payableParties,totalOutstanding:payableParties.reduce((sum,row)=>sum+row.outstanding,0)},card,reserve:{plans:reserves,totalProtectedReserve:protectedReserve,freeCash:liquidFunds-protectedReserve},payroll:payrollResult.data,recurring:(recurringResult.data??[]).map(plan=>({...plan,recognizedAmount:recognized.filter(tx=>tx.source_key===`recurring:${plan.id}:${month}`).reduce((sum,tx)=>sum+signed(tx),0)})),candidate:{counts:candidateCounts},owners:{capacity:ownerCapacityResult.data,investmentBasis:(ownerInvestmentResult.data??[]).reduce((sum,row)=>sum+Number(row.signed_amount),0),recoveryAllocated:(ownerAllocationResult.data??[]).reduce((sum,row)=>sum+Number(row.recovery_amount),0),recoveryPaid:(ownerAllocationResult.data??[]).reduce((sum,row)=>sum+Number(row.recovery_paid_amount),0),confirmedUnpaid:(ownerAllocationResult.data??[]).reduce((sum,row)=>sum+Number(row.assigned_amount)-Number(row.paid_amount),0)}};
}
