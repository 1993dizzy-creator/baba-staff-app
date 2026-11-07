import { buildCardFeeMonthState, type CardFeeClosure } from "@/lib/ledger/card-fee-closures";
import { buildCardFeeEstimate, CARD_FEE_EXPENSE_CATEGORY_NAME } from "@/lib/ledger/card-fee-estimate";
import { loadCardAllocationLines, loadCardRows, loadCardSales } from "@/lib/ledger/card-settlement-data";
import type { CardReconciliation } from "@/lib/ledger/card-settlements";
import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";
export const dynamic = "force-dynamic";
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const currentMonth = () => new Date(Date.now() + 4 * 3600000).toISOString().slice(0,7);

export async function GET(request: Request) {
  const auth = await requireLedgerActor(); if (auth.response) return auth.response;
  const month = new URL(request.url).searchParams.get("month") ?? "";
  if (!MONTH.test(month)) return ledgerJson({ ok: false, code: "INVALID_MONTH" }, 400);
  try {
    // All sales/lines: earlier open months with outstanding gross block confirmation (FIFO order).
    const [sales, lines, reconciliations, closures, closedMonths, manualFeeRows] = await Promise.all([
      loadCardSales(),
      loadCardAllocationLines(),
      loadCardRows((from, to) => supabaseServer.from("ledger_card_reconciliations").select("id,deposit_date,deposit_amount,matched_gross_amount,difference_amount,status").order("id").range(from, to)),
      loadCardRows((from, to) => supabaseServer.from("ledger_card_fee_closures").select("id,fee_month,fee_amount,status,expense_transaction_id,confirmed_at,confirmed_by,finalization_business_date,cancelled_at,cancel_reason,memo").order("id").range(from, to)),
      loadCardRows((from, to) => supabaseServer.from("ledger_month_closures").select("month,status").eq("status", "closed").order("month").range(from, to)),
      // Manual expenses already booked as this month's card fee (e.g. a provisional estimate). Shown, never re-booked.
      loadCardRows((from, to) => supabaseServer.from("ledger_transactions").select("id,amount,economic_effect_sign,memo,category:ledger_categories!inner(name)")
        .eq("status", "confirmed").eq("source_type", "manual").eq("recognition_month", `${month}-01`).eq("category.name", CARD_FEE_EXPENSE_CATEGORY_NAME).order("id").range(from, to)),
    ]);
    const state = buildCardFeeMonthState({
      month, currentMonth: currentMonth(),
      closedMonths: new Set((closedMonths as { month: string }[]).map(row => row.month.slice(0, 7))),
      sales, lines, reconciliations: reconciliations as CardReconciliation[], closures: closures as CardFeeClosure[],
    });
    const estimate = buildCardFeeEstimate({
      monthCardGross: state.monthCardGross, currentOutstanding: state.currentOutstanding, historicalConfirmedFee: state.historicalConfirmedFee,
      monthEndFee: state.monthEndFee, hasClosure: Boolean(state.closure),
      manualExpenses: (manualFeeRows as { id: number; amount: number | string; economic_effect_sign: number | null; memo: string | null }[])
        .map(row => ({ id: row.id, amount: Number(row.amount) * (row.economic_effect_sign === -1 ? -1 : 1), memo: row.memo ? row.memo.slice(0, 80) : null })),
    });
    return ledgerJson({ ok: true, ...state, estimate, history: (closures as CardFeeClosure[]).filter(row => row.fee_month.slice(0, 7) === month) });
  } catch (error) {
    console.error("[LEDGER_CARD_FEES_GET_FAILED]", error);
    return ledgerJson({ ok: false, code: "CARD_FEES_LOAD_FAILED" }, 500);
  }
}

export async function POST(request: Request) {
  const auth = await requireLedgerActor();
  if (auth.response || !auth.actor) return auth.response;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  // The fee amount is never accepted from the client; the RPC recomputes it under lock.
  if (!body || Object.keys(body).some(key => !["month", "memo"].includes(key)) || typeof body.month !== "string" || !MONTH.test(body.month)
    || (body.memo !== undefined && body.memo !== null && typeof body.memo !== "string")) {
    return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
  }
  try {
    const { data, error } = await supabaseServer.rpc("ledger_confirm_card_fee_month_v1", {
      p_month: `${body.month}-01`, p_memo: typeof body.memo === "string" ? body.memo : null, p_actor_user_id: auth.actor.id,
    });
    if (error) throw error;
    const result = data as { status?: string };
    if (result.status !== "confirmed") {
      const status = String(result.status ?? "CARD_FEE_CONFIRM_FAILED");
      const httpStatus = status === "forbidden" ? 403
        : ["current_month", "future_month", "month_closed", "already_confirmed", "legacy_unallocated_deposits", "earlier_month_unconfirmed", "insufficient_card_pending", "no_card_sales"].includes(status) ? 409
          : 400;
      return ledgerJson({ ok: false, code: status.toUpperCase(), result }, httpStatus);
    }
    return ledgerJson({ ok: true, result }, 201);
  } catch (error) {
    console.error("[LEDGER_CARD_FEE_CONFIRM_FAILED]", error);
    return ledgerJson({ ok: false, code: "CARD_FEE_CONFIRM_FAILED" }, 500);
  }
}
