import { NextResponse } from "next/server";
import { getBusinessDate } from "@/lib/common/business-time";
import { recurringAutoSyncMonths, recurringMonthsNeedingSync, type RecurringPlanRow } from "@/lib/ledger/recurring-expenses";
import { authorizeCron } from "@/lib/pos/cukcuk/sales-sync-cron-shared";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Daily (Vietnam 03:25, after the 03:00 business-day cutoff). Books the monthly recurring
// expense recognitions (e.g. store rent: non-cash expense_recognition, no fund movement,
// no payable, no reserve) through the deployed ledger_sync_recurring_expenses_v2 — the same
// RPC the rent screen's 비용 인식 button calls. Only the current business month and the month
// before are checked, and the RPC is called only when an active plan has no recognition there,
// so recognized months are not touched. Exactly one row per plan and month: the RPC's per-month
// advisory lock + recurring:<plan>:<YYYY-MM> source key and the unique (source_type, source_key)
// index. Closed months are never written (RPC + month guard). A failed run returns 500 and the
// next daily run retries; there is no other state to clean up.
export async function GET(req: Request) {
  const guardResponse = authorizeCron(req);
  if (guardResponse) return guardResponse;

  const candidates = recurringAutoSyncMonths(getBusinessDate());
  try {
    const [planResult, recognitionResult, closureResult] = await Promise.all([
      supabaseServer.from("ledger_recurring_expense_plans")
        .select("id,name,category_id,amount,recognition_day,effective_from,effective_to,is_active,source_key_prefix").eq("is_active", true),
      supabaseServer.from("ledger_transactions").select("id,source_key,status,amount,recognition_month")
        .eq("source_type", "recurring_expense").in("status", ["confirmed", "cancelled"])
        .in("recognition_month", candidates.map(month => `${month}-01`)),
      supabaseServer.from("ledger_month_closures").select("month,status").in("month", candidates.map(month => `${month}-01`)),
    ]);
    if (planResult.error || recognitionResult.error || closureResult.error) {
      throw planResult.error ?? recognitionResult.error ?? closureResult.error;
    }
    const months = recurringMonthsNeedingSync((planResult.data ?? []) as RecurringPlanRow[],
      recognitionResult.data ?? [], closureResult.data ?? [], candidates);
    if (!months.length) return NextResponse.json({ ok: true, checked: candidates, synced: [] });

    const { data: owners, error: ownerError } = await supabaseServer.from("users").select("id,role")
      .in("role", ["owner", "master"]).eq("is_active", true).eq("app_login_enabled", true).order("id");
    if (ownerError) throw ownerError;
    const actor = (owners ?? []).find(row => String(row.role).toLowerCase() === "owner") ?? (owners ?? [])[0];
    if (!actor) return NextResponse.json({ ok: false, code: "NO_LEDGER_ACTOR" }, { status: 422 });

    const synced: { month: string; result: Record<string, unknown> }[] = [];
    for (const month of months) {
      const { data, error } = await supabaseServer.rpc("ledger_sync_recurring_expenses_v2", {
        p_month: `${month}-01`, p_actor_user_id: actor.id,
      });
      if (error) throw error;
      const result = data as Record<string, unknown>;
      if (result.status !== "ok") {
        console.error("[LEDGER_RECURRING_CRON_NOT_OK]", month, result.status);
        return NextResponse.json({ ok: false, code: "LEDGER_RECURRING_CRON_NOT_OK", month, result, synced }, { status: 500 });
      }
      synced.push({ month, result });
    }
    return NextResponse.json({ ok: true, checked: candidates, synced });
  } catch (error) {
    console.error("[LEDGER_RECURRING_CRON_FAILED]", error);
    return NextResponse.json({ ok: false, code: "LEDGER_RECURRING_CRON_FAILED" }, { status: 500 });
  }
}
