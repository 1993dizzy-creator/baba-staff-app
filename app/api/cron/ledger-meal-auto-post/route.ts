import { NextResponse } from "next/server";
import { getBusinessDate } from "@/lib/common/business-time";
import { loadMealCandidateSource } from "@/lib/ledger/employee-costs";
import { authorizeCron } from "@/lib/pos/cukcuk/sales-sync-cron-shared";
import { loadBusinessTimeAdapter } from "@/lib/store-settings/business-time-adapter";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Candidate = {
  id: number;
  status: string;
  proposed_amount: number | string;
  proposed_category_id: number | null;
  source_snapshot: Record<string, unknown>;
  resolved_transaction_id: number | null;
};

function jsonError(code: string, status = 500) {
  return NextResponse.json({ ok: false, code }, { status });
}

async function resolveBusinessDate() {
  try {
    return (await loadBusinessTimeAdapter(new Date())).databaseBusinessDate;
  } catch (error) {
    console.error("[LEDGER_MEAL_AUTO_POST_STORE_SETTING_LOOKUP_FAILED]", error);
    return getBusinessDate();
  }
}

async function loadLatestCandidate(sourceKey: string) {
  const { data, error } = await supabaseServer
    .from("ledger_candidates")
    .select("id,status,proposed_amount,proposed_category_id,source_snapshot,resolved_transaction_id")
    .eq("source_type", "attendance_meal_daily")
    .eq("source_key", sourceKey)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as Candidate | null;
}

export async function GET(req: Request) {
  const guardResponse = authorizeCron(req);
  if (guardResponse) return guardResponse;

  const businessDate = await resolveBusinessDate();
  const sourceKey = `meal:${businessDate}`;

  try {
    // A confirmed 18:00 snapshot is final. Never feed later attendance or policy
    // edits back through the sync RPC: managers correct the ledger manually.
    const existing = await loadLatestCandidate(sourceKey);
    if (existing?.status === "confirmed") {
      return NextResponse.json({ ok: true, businessDate, noOp: "already_confirmed" });
    }

    const source = await loadMealCandidateSource(businessDate.slice(0, 7));
    const row = source.rows.find((item) => item.businessDate === businessDate);
    if (!row || !row.active || row.amount <= 0) {
      return NextResponse.json({ ok: true, businessDate, noOp: "no_eligible_attendance" });
    }

    const employees = Array.isArray(row.snapshot.employees) ? row.snapshot.employees : [];
    const policyVersionIds = [
      ...new Set(
        employees
          .map((employee) =>
            employee && typeof employee === "object"
              ? Number((employee as Record<string, unknown>).policy_version_id)
              : NaN
          )
          .filter(Number.isFinite)
      ),
    ];
    if (policyVersionIds.length !== 1) return jsonError("MEAL_POLICY_SNAPSHOT_INVALID", 422);

    const { data: policy, error: policyError } = await supabaseServer
      .from("payroll_meal_allowance_policy_versions")
      .select("created_by")
      .eq("id", policyVersionIds[0])
      .maybeSingle();
    if (policyError) throw policyError;
    if (!policy?.created_by) return jsonError("MEAL_POLICY_ACTOR_NOT_FOUND", 422);

    const { data: actor, error: actorError } = await supabaseServer
      .from("users")
      .select("id,role,is_active,app_login_enabled")
      .eq("id", policy.created_by)
      .maybeSingle();
    if (actorError) throw actorError;
    if (
      !actor?.is_active ||
      !actor.app_login_enabled ||
      !["owner", "master"].includes(String(actor.role).toLowerCase())
    ) {
      return jsonError("MEAL_POLICY_ACTOR_INVALID", 422);
    }

    const { data: syncData, error: syncError } = await supabaseServer.rpc(
      "ledger_sync_candidates_v2",
      {
        p_candidate_type: "employee_meal",
        p_source_type: "attendance_meal_daily",
        p_rows: [row],
        p_actor_user_id: actor.id,
      }
    );
    if (syncError) throw syncError;
    const syncResult = syncData as Record<string, unknown>;
    if (syncResult.status !== "ok") {
      return jsonError(`MEAL_SYNC_${String(syncResult.status).toUpperCase()}`, 422);
    }

    const candidate = await loadLatestCandidate(sourceKey);
    if (!candidate) return jsonError("MEAL_CANDIDATE_NOT_FOUND", 500);
    if (candidate.status === "confirmed") {
      return NextResponse.json({ ok: true, businessDate, noOp: "already_confirmed" });
    }
    if (candidate.status !== "pending") return jsonError("MEAL_CANDIDATE_NOT_PENDING", 409);

    const categoryId = candidate.proposed_category_id ?? row.categoryId;
    if (!categoryId) return jsonError("MEAL_CATEGORY_NOT_CONFIGURED", 422);

    const { data: account, error: accountError } = await supabaseServer
      .from("ledger_fund_accounts")
      .select("id")
      .eq("code", "store_cash")
      .eq("is_active", true)
      .eq("is_business_fund", true)
      .lte("active_from", businessDate)
      .or(`active_to.is.null,active_to.gte.${businessDate}`)
      .maybeSingle();
    if (accountError) throw accountError;
    if (!account) return jsonError("STORE_CASH_NOT_ACTIVE", 422);

    const employeeCount = Number(row.snapshot.employee_count);
    const dailyAmount = employees.length
      ? Number((employees[0] as Record<string, unknown>).daily_amount)
      : 0;
    const memo = `직원 식대 · ${employeeCount.toLocaleString("en-US")}명 × ${dailyAmount.toLocaleString("en-US")}₫ · 18시 자동집계`;
    const { data: resolveData, error: resolveError } = await supabaseServer.rpc(
      "ledger_resolve_candidate_v2",
      {
        p_candidate_id: candidate.id,
        p_resolution: "immediate",
        p_category_id: categoryId,
        p_party_id: null,
        p_fund_account_id: account.id,
        p_due_date: null,
        p_memo: memo,
        p_reason: null,
        p_actor_user_id: actor.id,
      }
    );
    if (resolveError) throw resolveError;
    const resolveResult = resolveData as Record<string, unknown>;
    if (resolveResult.status === "already_resolved") {
      return NextResponse.json({ ok: true, businessDate, noOp: "already_confirmed" });
    }
    if (resolveResult.status !== "confirmed") {
      return jsonError(`MEAL_RESOLVE_${String(resolveResult.status).toUpperCase()}`, 422);
    }

    return NextResponse.json({
      ok: true,
      businessDate,
      employeeCount,
      amount: Number(candidate.proposed_amount),
      transactionId: resolveResult.transactionId,
    });
  } catch (error) {
    console.error("[LEDGER_MEAL_AUTO_POST_FAILED]", error);
    return jsonError("LEDGER_MEAL_AUTO_POST_FAILED");
  }
}
