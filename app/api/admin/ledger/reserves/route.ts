import { isReserveEligibleFundAccount, reserveCurrentAmount } from "@/lib/ledger/reserve-balances";
import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireLedgerActor();
  if (auth.response) return auth.response;
  try {
    const [planResult, accountResult, movementResult, scheduleResult] = await Promise.all([
      supabaseServer.from("ledger_reserve_plans")
        .select("id,name,target_amount,target_date,is_active,memo,linked_recurring_plan_id,fund_account_id,recurring_monthly_amount,recurring_day,recurring_start_month,recurring_end_month,recurring_auto_generate,entries:ledger_reserve_entries(id,entry_type,amount,occurred_at,memo)")
        .eq("is_active", true).order("id"),
      supabaseServer.from("ledger_fund_accounts").select("id,type,code,display_name,is_active,is_business_fund,sort_order").eq("is_active", true).order("sort_order"),
      supabaseServer.from("ledger_movements").select("fund_account_id,amount,transaction:ledger_transactions!inner(status)").eq("transaction.status", "confirmed"),
      supabaseServer.from("ledger_reserve_scheduled_allocations")
        .select("id,reserve_plan_id,scheduled_month,scheduled_date,planned_amount,status,skip_reason,reserve_entry_id,resolved_at")
        .order("scheduled_month", { ascending: false }).order("id", { ascending: false }).limit(120),
    ]);
    if (planResult.error || accountResult.error || movementResult.error || scheduleResult.error) throw planResult.error ?? accountResult.error ?? movementResult.error ?? scheduleResult.error;
    const accountById = new Map((accountResult.data ?? []).map((account) => [Number(account.id), account]));
    const schedulesByPlan = new Map<number, Array<Record<string, unknown>>>();
    for (const row of scheduleResult.data ?? []) {
      const list = schedulesByPlan.get(Number(row.reserve_plan_id)) ?? [];
      list.push(row);
      schedulesByPlan.set(Number(row.reserve_plan_id), list);
    }
    const plans = (planResult.data ?? []).map((plan) => {
      const currentAmount = reserveCurrentAmount(plan.entries ?? []);
      const targetAmount = Number(plan.target_amount);
      const remainingAmount = Math.max(0, targetAmount - currentAmount);
      let remainingMonths: number | null = null;
      let monthlyRequired: number | null = null;
      if (plan.target_date) {
        const now = new Date(), target = new Date(`${plan.target_date}T00:00:00Z`);
        remainingMonths = Math.max(0, (target.getUTCFullYear() - now.getUTCFullYear()) * 12 + target.getUTCMonth() - now.getUTCMonth());
        monthlyRequired = remainingMonths > 0 ? remainingAmount / remainingMonths : null;
      }
      const linked = plan.fund_account_id == null ? null : accountById.get(Number(plan.fund_account_id)) ?? null;
      const fundAccount = linked
        ? { id: Number(linked.id), code: linked.code, displayName: linked.display_name }
        : null;
      const entries = [...(plan.entries ?? [])].sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)));
      const recurring = plan.recurring_monthly_amount == null ? null : {
        monthlyAmount: Number(plan.recurring_monthly_amount),
        recurringDay: Number(plan.recurring_day),
        startMonth: plan.recurring_start_month,
        endMonth: plan.recurring_end_month,
        autoGenerate: Boolean(plan.recurring_auto_generate),
      };
      const schedules = (schedulesByPlan.get(Number(plan.id)) ?? []).map((row) => ({
        id: Number(row.id),
        scheduledMonth: row.scheduled_month,
        scheduledDate: row.scheduled_date,
        plannedAmount: Number(row.planned_amount),
        status: row.status,
        skipReason: row.skip_reason ?? null,
        reserveEntryId: row.reserve_entry_id == null ? null : Number(row.reserve_entry_id),
        resolvedAt: row.resolved_at ?? null,
      }));
      const pendingSchedule = schedules
        .filter((row) => row.status === "pending")
        .sort((a, b) => String(a.scheduledMonth).localeCompare(String(b.scheduledMonth)))[0] ?? null;
      const targetReached = currentAmount >= targetAmount;
      return { ...plan, entries, currentAmount, remainingAmount, remainingMonths, monthlyRequired, fundAccount, recurring, pendingSchedule, recentSchedules: schedules.slice(0, 6), targetReached };
    });
    const eligibleAccounts = (accountResult.data ?? [])
      .filter((account) => isReserveEligibleFundAccount(account))
      .map((account) => ({ id: Number(account.id), code: account.code, displayName: account.display_name, type: account.type }));
    const liquidIds = new Set((accountResult.data ?? [])
      .filter((account) => ["cash", "bank", "personal_custody"].includes(account.type) && account.is_business_fund && account.code !== "card_clearing")
      .map((account) => Number(account.id)));
    const liquidFunds = (movementResult.data ?? [])
      .filter((movement) => liquidIds.has(Number(movement.fund_account_id)))
      .reduce((sum, movement) => sum + Number(movement.amount), 0);
    const activeReserve = plans.reduce((sum, plan) => sum + plan.currentAmount, 0);
    return ledgerJson({ ok: true, plans, eligibleAccounts, liquidFunds, activeReserve, freeCash: liquidFunds - activeReserve });
  } catch (error) {
    console.error("[LEDGER_RESERVES_GET_FAILED]", error);
    return ledgerJson({ ok: false, code: "RESERVES_LOAD_FAILED" }, 500);
  }
}

export async function POST(request: Request) {
  const auth = await requireLedgerActor();
  if (auth.response || !auth.actor) return auth.response;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
  try {
    const { data, error } = await supabaseServer.rpc("ledger_create_reserve_plan_v2", {
      p_name: body.name, p_target_amount: body.targetAmount, p_target_date: body.targetDate || null,
      p_linked_plan_id: body.linkedRecurringPlanId || null, p_fund_account_id: body.fundAccountId || null,
      p_memo: body.memo || null, p_actor_user_id: auth.actor.id,
    });
    if (error) throw error;
    const result = data as { status?: string };
    return result.status === "created" ? ledgerJson({ ok: true, result }, 201) : ledgerJson({ ok: false, code: String(result.status).toUpperCase() }, result.status === "forbidden" ? 403 : 400);
  } catch (error) {
    console.error("[LEDGER_RESERVE_PLAN_FAILED]", error);
    return ledgerJson({ ok: false, code: "RESERVE_PLAN_FAILED" }, 500);
  }
}
