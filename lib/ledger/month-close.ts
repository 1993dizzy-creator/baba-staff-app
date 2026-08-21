import "server-only";

import { createHash } from "node:crypto";
import { supabaseServer } from "@/lib/supabase/server";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const validCloseMonth = (value: unknown): value is string => typeof value === "string" && MONTH.test(value);

function nextMonth(month: string) {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
}

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
  const monthStart = `${month}-01`, endExclusive = nextMonth(month), endAt = `${endExclusive}T03:00:00+07:00`;
  const [transactionsResult, accountsResult, payableResult, allocationResult, cardResult, cardLineResult, reserveResult, reserveEntryResult, payrollResult, recurringResult, candidateResult,ownerCapacityResult,ownerInvestmentResult,ownerAllocationResult] = await Promise.all([
    supabaseServer.from("ledger_transactions").select("id,type,business_date,recognition_month,amount,economic_effect_sign,source_type,source_key,category:ledger_categories(name),movements:ledger_movements(fund_account_id,amount)").eq("status","confirmed").or(`recognition_month.eq.${monthStart},business_date.lt.${endExclusive}`),
    supabaseServer.from("ledger_fund_accounts").select("id,code,type,display_name,is_active").order("sort_order"),
    supabaseServer.from("ledger_payables").select("id,party_id,original_amount,status,expense:ledger_transactions!inner(business_date),party:ledger_parties(name)").neq("status","cancelled").lt("expense.business_date",endExclusive),
    supabaseServer.from("ledger_payable_allocations").select("payable_id,allocated_amount,payment:ledger_transactions!inner(business_date)").lt("payment.business_date",endExclusive),
    supabaseServer.from("ledger_card_reconciliations").select("id,status,deposit_date,deposit_amount,matched_gross_amount,difference_amount,confirmed_at").lt("deposit_date",endExclusive),
    supabaseServer.from("ledger_card_reconciliation_lines").select("reconciliation_id,pos_card_transaction_id,allocated_gross_amount,reconciliation:ledger_card_reconciliations!inner(confirmed_at,status)").eq("reconciliation.status","matched").lt("reconciliation.confirmed_at",endAt),
    supabaseServer.from("ledger_reserve_plans").select("id,name,target_amount,target_date,is_active").eq("is_active",true),
    supabaseServer.from("ledger_reserve_entries").select("reserve_plan_id,entry_type,amount,occurred_at").lt("occurred_at",endAt),
    supabaseServer.from("payroll_payment_batches").select("id,payroll_month,status,actual_company_cost_total").eq("payroll_month",monthStart).maybeSingle(),
    supabaseServer.from("ledger_recurring_expense_plans").select("id,name,amount,effective_from,effective_to").lte("effective_from",monthStart).or(`effective_to.is.null,effective_to.gte.${monthStart}`),
    supabaseServer.from("ledger_candidates").select("candidate_type,status").eq("proposed_recognition_month",monthStart),
    supabaseServer.rpc("ledger_owner_financial_capacity_v1",{p_through_month:monthStart}),
    supabaseServer.from("ledger_owner_investments").select("participant_id,signed_amount"),
    supabaseServer.from("ledger_owner_settlement_allocations").select("participant_id,recovery_amount,recovery_paid_amount,assigned_amount,paid_amount"),
  ]);
  const errors=[transactionsResult,accountsResult,payableResult,allocationResult,cardResult,cardLineResult,reserveResult,reserveEntryResult,payrollResult,recurringResult,candidateResult,ownerCapacityResult,ownerInvestmentResult,ownerAllocationResult].map(result=>result.error).filter(Boolean);
  if(errors.length) throw errors[0];
  const txs=(transactionsResult.data??[]) as unknown as Tx[];
  const recognized=txs.filter(tx=>tx.recognition_month===monthStart);
  const signed=(tx:Tx)=>Number(tx.amount)*Number(tx.economic_effect_sign??1);
  const posRows=recognized.filter(tx=>tx.type==="sales"&&tx.source_type==="pos_sales_daily_payment");
  const revenueBuckets={cash:0,transfer:0,card:0,other:0};
  for(const tx of posRows){const bucket=tx.source_key?.split(":").at(-1) as keyof typeof revenueBuckets;if(bucket in revenueBuckets)revenueBuckets[bucket]+=signed(tx)}
  const revenue=Object.values(revenueBuckets).reduce((sum,value)=>sum+value,0);
  const expenseRows=recognized.filter(tx=>tx.type==="expense"||tx.type==="expense_recognition");
  const categoryExpenses:Record<string,number>={};for(const tx of expenseRows){const name=tx.category?.name??"미분류";categoryExpenses[name]=(categoryExpenses[name]??0)+signed(tx)}
  const totalExpenses=Object.values(categoryExpenses).reduce((sum,value)=>sum+value,0);
  const fundBalances=new Map<number,number>();for(const tx of txs.filter(tx=>tx.business_date<endExclusive))for(const movement of tx.movements??[])fundBalances.set(Number(movement.fund_account_id),(fundBalances.get(Number(movement.fund_account_id))??0)+Number(movement.amount));
  const accounts=(accountsResult.data??[]).map(account=>({...account,balance:fundBalances.get(Number(account.id))??0}));
  const allocationByPayable=new Map<number,number>();for(const row of allocationResult.data??[])allocationByPayable.set(Number(row.payable_id),(allocationByPayable.get(Number(row.payable_id))??0)+Number(row.allocated_amount));
  const payables=(payableResult.data??[]).map(row=>({partyId:row.party_id,partyName:(row.party as {name?:string}|null)?.name??"미지정",outstanding:Math.max(0,Number(row.original_amount)-(allocationByPayable.get(Number(row.id))??0))}));
  const payableParties=Object.values(payables.reduce<Record<string,{partyId:number|null;partyName:string;outstanding:number}>>((map,row)=>{const key=String(row.partyId);map[key]??={partyId:row.partyId,partyName:row.partyName,outstanding:0};map[key].outstanding+=row.outstanding;return map},{}));
  const reserveAmounts=new Map<number,number>();for(const entry of reserveEntryResult.data??[]){const sign=entry.entry_type==="allocate"?1:entry.entry_type==="release"||entry.entry_type==="consume"?-1:1;reserveAmounts.set(Number(entry.reserve_plan_id),(reserveAmounts.get(Number(entry.reserve_plan_id))??0)+sign*Number(entry.amount))}
  const reserves=(reserveResult.data??[]).map(plan=>({...plan,currentAmount:reserveAmounts.get(Number(plan.id))??0}));
  const protectedReserve=reserves.reduce((sum,row)=>sum+row.currentAmount,0),liquidFunds=accounts.filter(account=>["cash","bank","personal_custody"].includes(account.type)&&account.code!=="card_clearing").reduce((sum,row)=>sum+row.balance,0);
  const cards=cardResult.data??[],matched=cards.filter(row=>row.status==="matched"&&row.confirmed_at!=null&&String(row.confirmed_at)<endAt),cardLines=cardLineResult.data??[];
  const allocatedBySale=new Map<number,number>();for(const line of cardLines)allocatedBySale.set(Number(line.pos_card_transaction_id),(allocatedBySale.get(Number(line.pos_card_transaction_id))??0)+Number(line.allocated_gross_amount));
  const cardSales=txs.filter(tx=>tx.source_type==="pos_sales_daily_payment"&&tx.source_key?.endsWith(":card")&&tx.business_date<endExclusive);
  const candidateCounts=(candidateResult.data??[]).reduce<Record<string,number>>((counts,row)=>{const key=`${row.candidate_type}:${row.status}`;counts[key]=(counts[key]??0)+1;return counts},{});
  const asOfMatchedIds=new Set(matched.map(row=>Number(row.id)));
  return {month,revenue:{...revenueBuckets,total:revenue},expense:{byCategory:categoryExpenses,total:totalExpenses},operatingResult:{revenue,expense:totalExpenses,operatingProfit:revenue-totalExpenses},funds:{accounts,liquidFunds,cardClearing:accounts.find(account=>account.code==="card_clearing")?.balance??0},payables:{byParty:payableParties,totalOutstanding:payableParties.reduce((sum,row)=>sum+row.outstanding,0)},card:{unsettledGross:cardSales.reduce((sum,row)=>sum+Math.max(0,Number(row.amount)-(allocatedBySale.get(row.id)??0)),0),unmatchedDeposits:cards.filter(row=>!asOfMatchedIds.has(Number(row.id))).reduce((sum,row)=>sum+Number(row.deposit_amount),0),completedGross:matched.reduce((sum,row)=>sum+Number(row.matched_gross_amount),0),settlementDifference:matched.reduce((sum,row)=>sum+Number(row.difference_amount),0)},reserve:{plans:reserves,totalProtectedReserve:protectedReserve,freeCash:liquidFunds-protectedReserve},payroll:payrollResult.data,recurring:(recurringResult.data??[]).map(plan=>({...plan,recognizedAmount:recognized.filter(tx=>tx.source_key===`recurring:${plan.id}:${month}`).reduce((sum,tx)=>sum+signed(tx),0)})),candidate:{counts:candidateCounts},owners:{capacity:ownerCapacityResult.data,investmentBasis:(ownerInvestmentResult.data??[]).reduce((sum,row)=>sum+Number(row.signed_amount),0),recoveryAllocated:(ownerAllocationResult.data??[]).reduce((sum,row)=>sum+Number(row.recovery_amount),0),recoveryPaid:(ownerAllocationResult.data??[]).reduce((sum,row)=>sum+Number(row.recovery_paid_amount),0),confirmedUnpaid:(ownerAllocationResult.data??[]).reduce((sum,row)=>sum+Number(row.assigned_amount)-Number(row.paid_amount),0)}};
}
