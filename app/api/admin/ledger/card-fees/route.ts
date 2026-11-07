import { buildCardFeeMonthState, type CardFeeClosure } from "@/lib/ledger/card-fee-closures";
import { buildCardFeeEstimate, CARD_FEE_EXPENSE_CATEGORY_NAME } from "@/lib/ledger/card-fee-estimate";
import { buildCardFeeHistory } from "@/lib/ledger/card-fee-history";
import { CARD_FEE_ESTIMATE_EXCEPTION_ACTION, parseCardFeeEstimateExceptions } from "@/lib/ledger/card-fee-exception";
import { loadCardAllocationLines, loadCardRows, loadCardSales } from "@/lib/ledger/card-settlement-data";
import { sumCardMoney, type CardReconciliation } from "@/lib/ledger/card-settlements";
import { loadPosLedgerParity } from "@/lib/ledger/pos-sales";
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
    const [sales, lines, reconciliations, closures, closedMonths, manualFeeRows, exceptionRows] = await Promise.all([
      loadCardSales(),
      loadCardAllocationLines(),
      loadCardRows((from, to) => supabaseServer.from("ledger_card_reconciliations").select("id,deposit_date,deposit_amount,matched_gross_amount,difference_amount,status").order("id").range(from, to)),
      loadCardRows((from, to) => supabaseServer.from("ledger_card_fee_closures").select("id,fee_month,fee_amount,status,expense_transaction_id,confirmed_at,confirmed_by,finalization_business_date,cancelled_at,cancel_reason,memo").order("id").range(from, to)),
      loadCardRows((from, to) => supabaseServer.from("ledger_month_closures").select("month,status").eq("status", "closed").order("month").range(from, to)),
      // Manual expenses booked as a card fee (provisional estimates), every month: the selected month is
      // shown in the analysis and every month feeds the deposit preview. Never re-booked here.
      loadCardRows((from, to) => supabaseServer.from("ledger_transactions").select("id,amount,economic_effect_sign,memo,recognition_month,category:ledger_categories!inner(name)")
        .eq("status", "confirmed").eq("source_type", "manual").eq("category.name", CARD_FEE_EXPENSE_CATEGORY_NAME).order("id").range(from, to)),
      // One-off estimate-exception closings (append-only audit rows, e.g. October 2026).
      loadCardRows((from, to) => supabaseServer.from("ledger_audit_logs").select("id,after_snapshot,reason,created_at")
        .eq("action", CARD_FEE_ESTIMATE_EXCEPTION_ACTION).order("id").range(from, to)),
    ]);
    const exceptions = parseCardFeeEstimateExceptions(exceptionRows as { id: number; after_snapshot: unknown; reason: string | null; created_at: string }[]);
    const exceptionMonths = new Set(exceptions.map(row => row.month));
    const manualFees = (manualFeeRows as { id: number; amount: number | string; economic_effect_sign: number | null; memo: string | null; recognition_month: string }[])
      .map(row => ({ id: row.id, month: row.recognition_month.slice(0, 7), amount: Number(row.amount) * (row.economic_effect_sign === -1 ? -1 : 1), memo: row.memo ? row.memo.slice(0, 80) : null }));
    const provisionalFees: Record<string, number> = {};
    for (const row of manualFees) provisionalFees[row.month] = sumCardMoney([provisionalFees[row.month] ?? 0, row.amount]);
    const now = currentMonth();
    const closed = new Set((closedMonths as { month: string }[]).map(row => row.month.slice(0, 7)));
    const stateFor = (target: string) => buildCardFeeMonthState({
      month: target, currentMonth: now, closedMonths: closed,
      sales, lines, reconciliations: reconciliations as CardReconciliation[], closures: closures as CardFeeClosure[], provisionalFees,
      estimateExceptionMonths: exceptionMonths,
    });
    const state = stateFor(month);
    // Historical rates by sale month from the same month state (matched differences + closure).
    const saleMonths = [...new Set(sales.map(sale => sale.business_date.slice(0, 7)))].filter(saleMonth => saleMonth < now).sort();
    const feeHistory = buildCardFeeHistory({
      currentMonth: now,
      months: saleMonths.map(saleMonth => {
        const row = saleMonth === month ? state : stateFor(saleMonth);
        return {
          month: saleMonth, gross: row.monthCardGross, historicalConfirmedFee: row.historicalConfirmedFee, monthEndFee: row.monthEndFee,
          hasClosure: Boolean(row.closure), currentOutstanding: row.currentOutstanding, monthClosed: row.monthClosed,
          provisionalFee: provisionalFees[saleMonth] ?? 0, estimateException: exceptionMonths.has(saleMonth),
          saleDays: new Set(sales.filter(sale => sale.business_date.startsWith(saleMonth) && Number(sale.amount) > 0).map(sale => sale.business_date)).size,
        };
      }),
    });
    const estimate = buildCardFeeEstimate({
      monthCardGross: state.monthCardGross, currentOutstanding: state.currentOutstanding, historicalConfirmedFee: state.historicalConfirmedFee,
      monthEndFee: state.monthEndFee, hasClosure: Boolean(state.closure),
      manualExpenses: manualFees.filter(row => row.month === month).map(({ id, amount, memo }) => ({ id, amount, memo })),
    });
    const estimateException = exceptions.find(row => row.month === month) ?? null;
    return ledgerJson({ ok: true, ...state, estimate, feeHistory, estimateException, history: (closures as CardFeeClosure[]).filter(row => row.fee_month.slice(0, 7) === month) });
  } catch (error) {
    console.error("[LEDGER_CARD_FEES_GET_FAILED]", error);
    return ledgerJson({ ok: false, code: "CARD_FEES_LOAD_FAILED" }, 500);
  }
}

export async function POST(request: Request) {
  const auth = await requireLedgerActor();
  if (auth.response || !auth.actor) return auth.response;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  // Card payment settlement after the month's last deposit. The fee amount is never accepted from the
  // client: the RPC books the month's actual remainder under lock, once.
  // The admin must explicitly confirm the month's final deposit and the exact amount shown to them.
  if (!body || Object.keys(body).some(key => !["month", "memo", "lastDepositConfirmed", "confirmedFee"].includes(key)) || typeof body.month !== "string" || !MONTH.test(body.month)
    || (body.memo !== undefined && body.memo !== null && typeof body.memo !== "string")
    || body.lastDepositConfirmed !== true || typeof body.confirmedFee !== "number" || !Number.isFinite(body.confirmedFee) || body.confirmedFee <= 0
    || Math.round(body.confirmedFee * 1000) / 1000 !== body.confirmedFee) {
    return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
  }
  try {
    // Cancellations, refunds or edits after sync would make the remainder something other than a fee.
    let parity: Awaited<ReturnType<typeof loadPosLedgerParity>>;
    try { parity = await loadPosLedgerParity(body.month); }
    catch (cause) { console.error("[LEDGER_CARD_SETTLEMENT_POS_SOURCE_FAILED]", cause); return ledgerJson({ ok: false, code: "POS_SOURCE_UNAVAILABLE" }, 409); }
    if (parity.sales.card !== parity.ledger.card) {
      return ledgerJson({ ok: false, code: "POS_LEDGER_CARD_MISMATCH", posCard: parity.sales.card, ledgerCard: parity.ledger.card }, 409);
    }
    const { data, error } = await supabaseServer.rpc("ledger_complete_card_month_v1", {
      p_month: `${body.month}-01`, p_last_deposit_confirmed: true, p_confirmed_fee: body.confirmedFee,
      p_memo: typeof body.memo === "string" ? body.memo : null, p_actor_user_id: auth.actor.id,
    });
    if (error) throw error;
    const result = data as { status?: string };
    if (result.status !== "confirmed") {
      const status = String(result.status ?? "CARD_FEE_CONFIRM_FAILED");
      const httpStatus = status === "forbidden" ? 403
        : ["current_month", "future_month", "month_closed", "already_confirmed", "provisional_fee_exists", "legacy_unallocated_deposits", "earlier_month_unconfirmed", "insufficient_card_pending", "no_card_sales", "nothing_to_settle", "no_settlement_deposit", "confirmed_fee_mismatch"].includes(status) ? 409
          : 400;
      return ledgerJson({ ok: false, code: status.toUpperCase(), result }, httpStatus);
    }
    return ledgerJson({ ok: true, result }, 201);
  } catch (error) {
    console.error("[LEDGER_CARD_FEE_CONFIRM_FAILED]", error);
    return ledgerJson({ ok: false, code: "CARD_FEE_CONFIRM_FAILED" }, 500);
  }
}
