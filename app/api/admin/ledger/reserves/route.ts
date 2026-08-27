import { isReserveEligibleFundAccount, reserveCurrentAmount } from "@/lib/ledger/reserve-balances";
import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireLedgerActor();
  if (auth.response) return auth.response;
  try {
    const [planResult, accountResult, movementResult] = await Promise.all([
      supabaseServer.from("ledger_reserve_plans")
        .select("id,name,target_amount,target_date,is_active,memo,linked_recurring_plan_id,fund_account_id,entries:ledger_reserve_entries(id,entry_type,amount,occurred_at,memo)")
        .eq("is_active", true).order("id"),
      supabaseServer.from("ledger_fund_accounts").select("id,type,code,display_name,is_active,is_business_fund,sort_order").eq("is_active", true).order("sort_order"),
      supabaseServer.from("ledger_movements").select("fund_account_id,amount,transaction:ledger_transactions!inner(status)").eq("transaction.status", "confirmed"),
    ]);
    if (planResult.error || accountResult.error || movementResult.error) throw planResult.error ?? accountResult.error ?? movementResult.error;
    const accountById = new Map((accountResult.data ?? []).map((account) => [Number(account.id), account]));
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
      return { ...plan, entries, currentAmount, remainingAmount, remainingMonths, monthlyRequired, fundAccount };
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
