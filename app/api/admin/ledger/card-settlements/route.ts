import { calculateCardGross, calculateCardDepositSummary, calculateMonthlySettlementDifference, sumCardMoney } from "@/lib/ledger/card-settlements";
import { loadCardRows, loadCardSales, loadCardAllocationLines } from "@/lib/ledger/card-settlement-data";
import {ledgerJson,requireLedgerActor} from "@/lib/ledger/server";
import {supabaseServer} from "@/lib/supabase/server";
export const dynamic="force-dynamic";
const MONTH=/^\d{4}-(0[1-9]|1[0-2])$/;

export async function GET(request: Request) {
  const auth = await requireLedgerActor(); if (auth.response) return auth.response;
  const month = new URL(request.url).searchParams.get("month") ?? "";
  if (!MONTH.test(month)) return ledgerJson({ ok: false, code: "INVALID_MONTH" }, 400);
  try {
    const start = month + "-01", next = new Date(start + "T00:00:00Z");
    next.setUTCMonth(next.getUTCMonth() + 1);
    const end = next.toISOString().slice(0, 10);
    const [accounts, saleRows, reconciliations, lines] = await Promise.all([
      loadCardRows((from, to) => supabaseServer.from("ledger_fund_accounts").select("id,code,display_name,type,is_active").order("sort_order").order("id").range(from, to)),
      loadCardSales(),
      loadCardRows((from, to) => supabaseServer.from("ledger_card_reconciliations").select("id,deposit_transaction_id,deposit_date,destination_fund_account_id,deposit_amount,matched_gross_amount,difference_amount,status,confirmed_at,confirmed_by,cancelled_at,cancelled_by,cancel_reason,memo,destination:ledger_fund_accounts(display_name)").order("deposit_date", { ascending: false }).order("id").range(from, to)),
      loadCardAllocationLines(),
    ]);
    const clearing = accounts.find(account => account.code === "card_clearing");
    const movements = clearing ? await loadCardRows((from, to) => supabaseServer.from("ledger_movements").select("id,amount,transaction:ledger_transactions!inner(status)").eq("fund_account_id", clearing.id).eq("transaction.status", "confirmed").order("id").range(from, to)) : [];
    const gross = calculateCardGross(saleRows, lines, start, end);
    const deposits = calculateCardDepositSummary(reconciliations, start, end);
    return ledgerJson({
      ok: true, month, accounts: accounts.filter(account => account.is_active),
      reconciliations: reconciliations.filter(row => row.deposit_date >= start && row.deposit_date < end),
      totalReconciliationCount: reconciliations.filter(row => row.status !== "cancelled").length,
      totalHistoryCount: reconciliations.length,
      totalCancelledCount: reconciliations.filter(row => row.status === "cancelled").length,
      sales: gross.sales.filter(sale => sale.outstandingGrossAmount > 0),
      monthlySales: gross.sales.filter(sale => sale.business_date >= start && sale.business_date < end),
      priorUnreconciledSales: gross.sales.filter(sale => sale.business_date < start && sale.outstandingGrossAmount > 0),
      summary: {
        monthlyCardGross: gross.monthlyCardGross,
        monthlyReconciledGross: gross.monthlyReconciledGross,
        monthlySettledGross: gross.monthlySettledGross,
        monthlyUnreconciledGross: gross.monthlyUnreconciledGross,
        monthlySettlementDifference: calculateMonthlySettlementDifference(saleRows, lines, reconciliations, start, end),
        totalUnreconciledGross: gross.totalUnreconciledGross,
        cardPendingBalance: sumCardMoney(movements.map(row => row.amount)),
        ...deposits,
        // Preserve original response fields for existing consumers.
        unsettledCardGross: gross.totalUnreconciledGross,
        unmatchedDeposits: deposits.monthlyUnmatchedDeposits,
        completedGross: deposits.monthlyCompletedGross,
        completedDeposit: deposits.monthlyCompletedDeposit,
        completedDifference: deposits.monthlyCompletedDifference,
      },
    });
  } catch (error) {
    console.error("[LEDGER_CARD_SETTLEMENTS_GET_FAILED]", error);
    return ledgerJson({ ok: false, code: "CARD_SETTLEMENTS_LOAD_FAILED" }, 500);
  }
}

export async function POST(request:Request){const auth=await requireLedgerActor();if(auth.response||!auth.actor)return auth.response;const body=await request.json().catch(()=>null)as Record<string,unknown>|null,allowed=new Set(["depositAt","amount","destinationAccountId","reference","memo"]);if(!body||Object.keys(body).some(k=>!allowed.has(k))||!body.depositAt||!Number.isInteger(Number(body.destinationAccountId))||Number(body.amount)<=0)return ledgerJson({ok:false,code:"INVALID_BODY"},400);try{const{data,error}=await supabaseServer.rpc("ledger_create_card_deposit_v1",{p_deposit_at:body.depositAt,p_amount:body.amount,p_destination_account_id:body.destinationAccountId,p_reference:body.reference||null,p_memo:body.memo||null,p_actor_user_id:auth.actor.id});if(error)throw error;const result=data as{status?:string};if(result.status!=="created"){const status=result.status;return ledgerJson({ok:false,code:String(status??"CARD_DEPOSIT_FAILED").toUpperCase(),result},status==="forbidden"?403:status==="month_closed"?409:400)}return ledgerJson({ok:true,result},201)}catch(error){console.error("[LEDGER_CARD_DEPOSIT_FAILED]",error);return ledgerJson({ok:false,code:"CARD_DEPOSIT_FAILED"},500)}}
