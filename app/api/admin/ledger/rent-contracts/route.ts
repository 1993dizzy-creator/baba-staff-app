import { getBusinessDate } from "@/lib/common/business-time";
import { calculateOperatingResidual, monthNewReserve, monthRentRecognized } from "@/lib/ledger/operating-residual";
import { reserveCurrentAmount } from "@/lib/ledger/reserve-balances";
import { buildRentUsageSchedule, parseRentContractPayload, rentPaymentSummary, rentReserveOutlook, type RentContract, type RentPayment, type RentRecognition } from "@/lib/ledger/rent-contracts";
import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
// Recurring plans of the store rent (all versions share the prefix). Used only when no
// contract links a recurring plan yet.
const DEFAULT_RENT_PREFIX = "store-rent";

// Rent management: contracts, actual payments, monthly usage, the next-lease reserve and
// the month's 운영상 잔여이익 inputs. Read only.
export async function GET(request: Request) {
  const auth = await requireLedgerActor();
  if (auth.response) return auth.response;
  const currentMonth = getBusinessDate().slice(0, 7);
  const month = new URL(request.url).searchParams.get("month") ?? currentMonth;
  if (!MONTH.test(month)) return ledgerJson({ ok: false, code: "INVALID_MONTH" }, 400);
  try {
    const [contractResult, paymentResult, planResult, recognitionResult, openingResult, reservePlanResult, reserveEntryResult, scheduleResult, closureResult, accountResult] = await Promise.all([
      supabaseServer.from("ledger_rent_contracts").select("*").order("period_start"),
      supabaseServer.from("ledger_rent_contract_payments")
        .select("id,contract_id,source,payment_transaction_id,pre_ledger_reference,paid_on,amount,fund_account_id,memo,transaction:ledger_transactions(id,business_date,amount,status,memo)")
        .order("paid_on"),
      supabaseServer.from("ledger_recurring_expense_plans").select("id,name,amount,effective_from,effective_to,is_active,source_key_prefix").order("effective_from"),
      supabaseServer.from("ledger_transactions").select("id,recognition_month,amount,economic_effect_sign,source_key")
        .eq("status", "confirmed").eq("type", "expense_recognition").eq("source_type", "recurring_expense").order("id"),
      supabaseServer.from("ledger_transactions").select("business_date").eq("type", "opening").eq("status", "confirmed").order("business_date").limit(1),
      supabaseServer.from("ledger_reserve_plans").select("id,name,target_amount,target_date,is_active,fund_account_id,recurring_monthly_amount,recurring_start_month").order("id"),
      supabaseServer.from("ledger_reserve_entries").select("id,reserve_plan_id,entry_type,amount,occurred_at,allocation_kind,attribution_month,restores_entry_id").order("id"),
      supabaseServer.from("ledger_reserve_scheduled_allocations").select("reserve_plan_id,scheduled_month,status").eq("scheduled_month", `${currentMonth}-01`),
      supabaseServer.from("ledger_month_closures").select("status,revision,summary_snapshot").eq("month", `${month}-01`).maybeSingle(),
      supabaseServer.from("ledger_fund_accounts").select("id,code,display_name"),
    ]);
    const failed = [contractResult, paymentResult, planResult, recognitionResult, openingResult, reservePlanResult, reserveEntryResult, scheduleResult, closureResult, accountResult].find(result => result.error);
    if (failed) throw failed.error;

    const plans = planResult.data ?? [];
    const accounts = new Map((accountResult.data ?? []).map(row => [Number(row.id), { code: row.code, displayName: row.display_name }]));
    const recognitionsByPlan = new Map<number, RentRecognition[]>();
    for (const row of recognitionResult.data ?? []) {
      const planId = Number(String(row.source_key ?? "").split(":")[1]);
      if (!Number.isSafeInteger(planId)) continue;
      recognitionsByPlan.set(planId, [...(recognitionsByPlan.get(planId) ?? []), row as RentRecognition]);
    }
    const prefixOf = (planId: number | null) => plans.find(plan => Number(plan.id) === planId)?.source_key_prefix ?? null;
    const recognitionsForPrefix = (prefix: string | null) => prefix === null ? [] : plans
      .filter(plan => plan.source_key_prefix === prefix)
      .flatMap(plan => recognitionsByPlan.get(Number(plan.id)) ?? []);
    const ledgerStart = openingResult.data?.[0]?.business_date ?? null;
    const ledgerStartMonth = ledgerStart ? String(ledgerStart).slice(0, 7) : null;
    const entries = reserveEntryResult.data ?? [];
    const reservePlans = (reservePlanResult.data ?? []).map(plan => {
      const planEntries = entries.filter(entry => Number(entry.reserve_plan_id) === Number(plan.id));
      const currentAmount = reserveCurrentAmount(planEntries);
      const currentMonthDone = (scheduleResult.data ?? []).some(row => Number(row.reserve_plan_id) === Number(plan.id) && row.status !== "pending" && row.status !== "superseded");
      return {
        id: Number(plan.id), name: plan.name, isActive: plan.is_active, targetAmount: Number(plan.target_amount), targetDate: plan.target_date,
        monthlyAmount: plan.recurring_monthly_amount == null ? null : Number(plan.recurring_monthly_amount), startMonth: plan.recurring_start_month,
        fundAccount: plan.fund_account_id == null ? null : accounts.get(Number(plan.fund_account_id)) ?? null,
        currentAmount,
        outlook: rentReserveOutlook({ targetAmount: Number(plan.target_amount), currentAmount, monthlyAmount: plan.recurring_monthly_amount == null ? null : Number(plan.recurring_monthly_amount), targetDate: plan.target_date, currentMonth, currentMonthDone }),
      };
    });

    const contracts = ((contractResult.data ?? []) as RentContract[]).map(contract => {
      const payments = (paymentResult.data ?? []).filter(row => Number(row.contract_id) === Number(contract.id)) as unknown as Array<RentPayment & { transaction: { id: number; business_date: string; amount: number; status: string; memo: string | null } | null }>;
      const recurringPlan = plans.find(plan => Number(plan.id) === Number(contract.recurring_plan_id)) ?? null;
      return {
        ...contract,
        recurringPlan,
        reservePlan: reservePlans.find(plan => plan.id === Number(contract.reserve_plan_id)) ?? null,
        payments: payments.map(row => ({ ...row, fundAccount: row.fund_account_id == null ? null : accounts.get(Number(row.fund_account_id)) ?? null })),
        paymentSummary: rentPaymentSummary(contract, payments),
        usage: buildRentUsageSchedule({ contract, recognitions: recognitionsForPrefix(prefixOf(contract.recurring_plan_id == null ? null : Number(contract.recurring_plan_id))), ledgerStartMonth, currentMonth }),
      };
    });

    const rentPrefixes = new Set(contracts.map(contract => prefixOf(contract.recurring_plan_id == null ? null : Number(contract.recurring_plan_id))).filter((prefix): prefix is string => prefix !== null));
    if (!rentPrefixes.size) rentPrefixes.add(DEFAULT_RENT_PREFIX);
    const rentRecognized = monthRentRecognized([...rentPrefixes].flatMap(recognitionsForPrefix), month);
    const newReserve = monthNewReserve(entries, month);
    const closure = closureResult.data?.status === "closed" ? closureResult.data : null;
    const closedOperatingProfit = closure ? Number((closure.summary_snapshot as { operatingResult?: { operatingProfit?: number } } | null)?.operatingResult?.operatingProfit) : null;
    return ledgerJson({
      ok: true, month, currentMonth, ledgerStart,
      contracts,
      reservePlans,
      residual: {
        month, rentRecognized, newReserve,
        closed: closure ? { revision: closure.revision, operatingProfit: closedOperatingProfit, ...calculateOperatingResidual({ operatingProfit: closedOperatingProfit, rentRecognized, newReserve }) } : null,
      },
    });
  } catch (error) {
    console.error("[LEDGER_RENT_CONTRACTS_GET_FAILED]", error);
    return ledgerJson({ ok: false, code: "RENT_CONTRACTS_LOAD_FAILED" }, 500);
  }
}

// action=save | link | pre_ledger. Each runs one validated RPC; none books a ledger
// transaction or movement.
export async function POST(request: Request) {
  const auth = await requireLedgerActor();
  if (auth.response || !auth.actor) return auth.response;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.action !== "string") return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
  const id = (value: unknown) => value == null || value === "" ? null : Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : NaN;
  const contractId = id(body.contractId);
  if (Number.isNaN(contractId)) return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
  const memo = typeof body.memo === "string" && body.memo.trim() ? body.memo.trim().slice(0, 500) : null;
  try {
    let rpc: PromiseLike<{ data: unknown; error: unknown }>;
    let success: string;
    if (body.action === "save") {
      const payload = parseRentContractPayload(body.contract);
      if (!payload) return ledgerJson({ ok: false, code: "INVALID_CONTRACT" }, 400);
      rpc = supabaseServer.rpc("ledger_save_rent_contract_v1", { p_contract_id: contractId, p_payload: payload, p_actor_user_id: auth.actor.id });
      success = "saved";
    } else if (body.action === "link") {
      const transactionId = id(body.transactionId), replacesPaymentId = id(body.replacesPaymentId);
      if (contractId === null || transactionId === null || Number.isNaN(transactionId) || Number.isNaN(replacesPaymentId)) return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
      rpc = supabaseServer.rpc("ledger_link_rent_payment_v1", { p_contract_id: contractId, p_payment_transaction_id: transactionId, p_replaces_payment_id: replacesPaymentId, p_memo: memo, p_actor_user_id: auth.actor.id });
      success = replacesPaymentId === null ? "linked" : "converted";
    } else if (body.action === "pre_ledger") {
      const reference = typeof body.reference === "string" ? body.reference.trim() : "";
      const paidOn = typeof body.paidOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.paidOn) ? body.paidOn : null;
      const amount = typeof body.amount === "number" && Number.isFinite(body.amount) && body.amount > 0 ? body.amount : null;
      const fundAccountId = id(body.fundAccountId);
      if (contractId === null || !reference || reference.length > 200 || !paidOn || amount === null || Number.isNaN(fundAccountId)) return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
      rpc = supabaseServer.rpc("ledger_record_pre_ledger_rent_payment_v1", { p_contract_id: contractId, p_reference: reference, p_paid_on: paidOn, p_amount: amount, p_fund_account_id: fundAccountId, p_memo: memo, p_actor_user_id: auth.actor.id });
      success = "recorded";
    } else {
      return ledgerJson({ ok: false, code: "INVALID_ACTION" }, 400);
    }
    const { data, error } = await rpc;
    if (error) throw error;
    const result = data as { status?: string };
    return result.status === success
      ? ledgerJson({ ok: true, result })
      : ledgerJson({ ok: false, code: String(result.status).toUpperCase(), result }, result.status === "forbidden" ? 403 : result.status === "already_linked" || result.status === "already_recorded" ? 409 : 400);
  } catch (error) {
    console.error("[LEDGER_RENT_CONTRACTS_POST_FAILED]", error);
    return ledgerJson({ ok: false, code: "RENT_CONTRACT_SAVE_FAILED" }, 500);
  }
}
