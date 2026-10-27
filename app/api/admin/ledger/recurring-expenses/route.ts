import { getBusinessDate } from "@/lib/common/business-time";
import {
  buildRecurringMonthStatuses,
  conflictingCategoryPlan,
  monthRange,
  parseCreatePlanBody,
  shiftMonth,
  validRecurringMonth,
  type RecurringPlanRow,
} from "@/lib/ledger/recurring-expenses";
import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const PLAN_SELECT = "id,name,category_id,amount,recognition_day,effective_from,effective_to,is_active,source_key_prefix,memo";

// Plans, eligible categories and the per-month recognition status (read only).
export async function GET(request: Request) {
  const auth = await requireLedgerActor();
  if (auth.response) return auth.response;
  const currentMonth = getBusinessDate().slice(0, 7);
  const through = new URL(request.url).searchParams.get("through") ?? currentMonth;
  if (!validRecurringMonth(through) || through > currentMonth) return ledgerJson({ ok: false, code: "INVALID_MONTH" }, 400);
  try {
    const [planResult, categoryResult, recognitionResult, closureResult] = await Promise.all([
      supabaseServer.from("ledger_recurring_expense_plans").select(PLAN_SELECT).order("effective_from").order("id"),
      supabaseServer.from("ledger_categories").select("id,name,parent_id").eq("kind", "expense").eq("is_active", true).order("name"),
      supabaseServer.from("ledger_transactions").select("id,source_key,status,amount,recognition_month")
        .eq("source_type", "recurring_expense").in("status", ["confirmed", "cancelled"]).order("id"),
      supabaseServer.from("ledger_month_closures").select("month,status").order("month"),
    ]);
    if (planResult.error || categoryResult.error || recognitionResult.error || closureResult.error) {
      throw planResult.error ?? categoryResult.error ?? recognitionResult.error ?? closureResult.error;
    }
    const plans = (planResult.data ?? []) as RecurringPlanRow[];
    const firstMonth = plans.filter(plan => plan.is_active).map(plan => plan.effective_from.slice(0, 7)).sort()[0] ?? through;
    const months = buildRecurringMonthStatuses(plans, recognitionResult.data ?? [], closureResult.data ?? [], monthRange(firstMonth, through));
    return ledgerJson({ ok: true, currentMonth, through, plans, categories: categoryResult.data ?? [], months });
  } catch (error) {
    console.error("[LEDGER_RECURRING_GET_FAILED]", error);
    return ledgerJson({ ok: false, code: "RECURRING_LOAD_FAILED" }, 500);
  }
}

// action=create_plan → ledger_create_recurring_plan_version_v1 (records a plan only).
// action=sync → ledger_sync_recurring_expenses_v2 for one month (no fund movement).
export async function POST(request: Request) {
  const auth = await requireLedgerActor();
  if (auth.response || !auth.actor) return auth.response;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || (body.action !== "create_plan" && body.action !== "sync")) return ledgerJson({ ok: false, code: "INVALID_ACTION" }, 400);
  const currentMonth = getBusinessDate().slice(0, 7);

  if (body.action === "sync") {
    if (Object.keys(body).some(key => key !== "action" && key !== "month") || !validRecurringMonth(body.month)) {
      return ledgerJson({ ok: false, code: "INVALID_MONTH" }, 400);
    }
    // A future month would book its cost before it is incurred.
    if (body.month > currentMonth) return ledgerJson({ ok: false, code: "FUTURE_MONTH" }, 400);
    try {
      const { data, error } = await supabaseServer.rpc("ledger_sync_recurring_expenses_v2", {
        p_month: `${body.month}-01`, p_actor_user_id: auth.actor.id,
      });
      if (error) throw error;
      const result = data as Record<string, unknown>;
      if (result.status === "forbidden") return ledgerJson({ ok: false, code: "FORBIDDEN" }, 403);
      if (result.status !== "ok") return ledgerJson({ ok: false, code: String(result.status ?? "SYNC_FAILED").toUpperCase(), result }, 400);
      // The RPC never books into a closed month; reopen the month first.
      if (result.closedMonth === true) return ledgerJson({ ok: false, code: "MONTH_CLOSED", result }, 409);
      return ledgerJson({ ok: true, month: body.month, result });
    } catch (error) {
      console.error("[LEDGER_RECURRING_SYNC_FAILED]", error);
      return ledgerJson({ ok: false, code: "RECURRING_SYNC_FAILED" }, 500);
    }
  }

  const allowed = new Set(["action", "name", "categoryId", "amount", "recognitionDay", "effectiveFrom", "sourceKeyPrefix", "memo"]);
  if (Object.keys(body).some(key => !allowed.has(key))) return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
  const parsed = parseCreatePlanBody(body);
  if (!parsed.ok) return ledgerJson({ ok: false, code: parsed.code }, 400);
  if (parsed.value.effectiveFrom > shiftMonth(currentMonth, 12)) return ledgerJson({ ok: false, code: "INVALID_EFFECTIVE_FROM" }, 400);
  try {
    const { data: existing, error: existingError } = await supabaseServer.from("ledger_recurring_expense_plans").select(PLAN_SELECT).eq("is_active", true);
    if (existingError) throw existingError;
    const conflict = conflictingCategoryPlan((existing ?? []) as RecurringPlanRow[], parsed.value);
    if (conflict) return ledgerJson({ ok: false, code: "CATEGORY_PLAN_EXISTS", planId: Number(conflict.id) }, 409);
    const { data, error } = await supabaseServer.rpc("ledger_create_recurring_plan_version_v1", {
      p_name: parsed.value.name, p_category_id: parsed.value.categoryId, p_amount: parsed.value.amount,
      p_recognition_day: parsed.value.recognitionDay, p_effective_from: `${parsed.value.effectiveFrom}-01`,
      p_party_id: null, p_source_key_prefix: parsed.value.sourceKeyPrefix, p_memo: parsed.value.memo,
      p_actor_user_id: auth.actor.id,
    });
    if (error) throw error;
    const result = data as Record<string, unknown>;
    if (result.status === "created") return ledgerJson({ ok: true, result }, 201);
    const status = String(result.status ?? "CREATE_FAILED");
    return ledgerJson({ ok: false, code: status.toUpperCase() }, status === "forbidden" ? 403 : 400);
  } catch (error) {
    console.error("[LEDGER_RECURRING_CREATE_FAILED]", error);
    return ledgerJson({ ok: false, code: "RECURRING_CREATE_FAILED" }, 500);
  }
}
