import { supabaseServer } from "@/lib/supabase/server";
import { payrollJson, requirePayrollActor } from "@/lib/payroll/server";
import { syncMealCandidateMonths } from "@/lib/ledger/employee-costs";
import { mealCandidateSyncMonths } from "@/lib/ledger/meal-source-sync-period";
import {
  calculateProjectedMealAllowanceForEmployee,
  selectMealAllowancePolicyAt,
  type MealAllowanceContractPeriod,
  type MealAllowanceEligibilityVersion,
  type MealAllowancePolicyVersion,
} from "@/lib/payroll/meal-allowance";

export const dynamic = "force-dynamic";
const FIELDS = "id,user_id,is_eligible,effective_from,revision,created_by,created_at,note";

function validId(value: unknown) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function map(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    isEligible: Boolean(row.is_eligible),
    effectiveFrom: String(row.effective_from),
    revision: Number(row.revision),
    createdBy: row.created_by === null || row.created_by === undefined ? null : Number(row.created_by),
    createdAt: row.created_at ? String(row.created_at) : null,
    note: row.note ? String(row.note) : null,
  };
}

function selectCurrent<T extends { effectiveFrom: string; revision: number }>(versions: T[], date: string) {
  return (
    versions
      .filter((version) => version.effectiveFrom <= date)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.revision - a.revision)[0] ?? null
  );
}

function vietnamToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function currentVietnamMonth() {
  return vietnamToday().slice(0, 7);
}

export async function GET(request: Request) {
  const auth = await requirePayrollActor();
  if (auth.response) return auth.response;
  const userId = validId(new URL(request.url).searchParams.get("userId"));
  if (!userId) return payrollJson({ ok: false, code: "INVALID_USER_ID" }, 400);

  const today = vietnamToday();
  const monthStart = `${today.slice(0, 7)}-01`;
  const nextMonth = new Date(`${monthStart}T00:00:00Z`);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const monthEndExclusive = nextMonth.toISOString().slice(0, 10);

  const [
    { data: user, error: userError },
    { data: historyRows, error: historyError },
    { data: policyRows, error: policyError },
    { data: contractRows, error: contractError },
  ] = await Promise.all([
    supabaseServer
      .from("users")
      .select("id,username,hire_date,termination_date,attendance_tracking_enabled")
      .eq("id", userId)
      .eq("is_system_account", false)
      .maybeSingle(),
    supabaseServer
      .from("payroll_meal_allowance_eligibility_versions")
      .select(FIELDS)
      .eq("user_id", userId)
      .order("effective_from", { ascending: false })
      .order("revision", { ascending: false }),
    supabaseServer
      .from("payroll_meal_allowance_policy_versions")
      .select("id,daily_amount,effective_from,revision")
      .lt("effective_from", monthEndExclusive)
      .order("effective_from", { ascending: false })
      .order("revision", { ascending: false }),
    supabaseServer
      .from("payroll_contract_versions")
      .select("effective_from,effective_to,standard_workdays")
      .eq("user_id", userId)
      .lt("effective_from", monthEndExclusive)
      .or(`effective_to.is.null,effective_to.gt.${monthStart}`),
  ]);
  if (userError || historyError || policyError || contractError) {
    return payrollJson({ ok: false, code: "MEAL_ALLOWANCE_ELIGIBILITY_READ_FAILED" }, 500);
  }
  if (!user) return payrollJson({ ok: false, code: "USER_NOT_FOUND" }, 404);

  const history = (historyRows ?? []).map(map);
  const current = selectCurrent(history, today);
  const policyVersions: MealAllowancePolicyVersion[] = (policyRows ?? []).map((row) => ({
    id: Number(row.id),
    dailyAmount: Number(row.daily_amount),
    effectiveFrom: String(row.effective_from),
    revision: Number(row.revision),
  }));
  const currentPolicy = selectMealAllowancePolicyAt(policyVersions, today);
  const contracts: MealAllowanceContractPeriod[] = (contractRows ?? []).map((row) => ({
    effectiveFrom: String(row.effective_from),
    effectiveTo: row.effective_to ? String(row.effective_to) : null,
    standardWorkdays: row.standard_workdays === null ? null : Number(row.standard_workdays),
  }));
  const eligibilityVersions: MealAllowanceEligibilityVersion[] = history.map((version) => ({
    id: version.id,
    userId: version.userId,
    isEligible: version.isEligible,
    effectiveFrom: version.effectiveFrom,
    revision: version.revision,
  }));
  const projected = calculateProjectedMealAllowanceForEmployee({
    userId,
    hireDate: user.hire_date ? String(user.hire_date) : null,
    terminationDate: user.termination_date ? String(user.termination_date) : null,
    monthStart,
    monthEndExclusive,
    contracts,
    eligibilityVersions,
    policyVersions,
  });

  return payrollJson({
    ok: true,
    current,
    history,
    attendanceTrackingEnabled: user.attendance_tracking_enabled !== false,
    standardWorkdays: contracts.length === 1 ? contracts[0].standardWorkdays : null,
    dailyAmount: currentPolicy?.dailyAmount ?? null,
    projectedMealAllowance: { amount: projected.amount, warningCode: projected.warningCode },
  });
}

export async function POST(request: Request) {
  const auth = await requirePayrollActor();
  if (auth.response || !auth.actor) return auth.response;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const userId = validId(body?.userId);
  const isEligible = body?.isEligible;
  const effectiveFrom = String(body?.effectiveFrom ?? "");
  if (!body || !userId || typeof isEligible !== "boolean" || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    return payrollJson({ ok: false, code: "INVALID_MEAL_ALLOWANCE_ELIGIBILITY" }, 400);
  }

  // 근태 미사용 직원은 새로 식대 대상으로 켤 수 없다 — RPC도 같은 조건을 최종 방어선으로
  // 다시 검증하지만, 여기서 먼저 확인해 전용 오류 코드로 즉시 응답한다.
  if (isEligible) {
    const { data: target, error: targetError } = await supabaseServer
      .from("users")
      .select("id,attendance_tracking_enabled")
      .eq("id", userId)
      .eq("is_system_account", false)
      .maybeSingle();
    if (targetError) return payrollJson({ ok: false, code: "MEAL_ALLOWANCE_ELIGIBILITY_READ_FAILED" }, 500);
    if (!target) return payrollJson({ ok: false, code: "USER_NOT_FOUND" }, 404);
    if (target.attendance_tracking_enabled === false) {
      return payrollJson({ ok: false, code: "MEAL_ALLOWANCE_REQUIRES_ATTENDANCE_TRACKING" }, 409);
    }
  }

  const { data, error } = await supabaseServer.rpc("payroll_create_meal_allowance_eligibility_version_v1", {
    p_user_id: userId,
    p_is_eligible: isEligible,
    p_effective_from: effectiveFrom,
    p_actor_user_id: auth.actor.id,
    p_note: typeof body.note === "string" ? body.note.trim() || null : null,
  });
  if (error) {
    const status = error.message.includes("PAYROLL_FORBIDDEN")
      ? 403
      : error.message.includes("USER_NOT_FOUND")
        ? 404
        : error.message.includes("MEAL_ALLOWANCE_REQUIRES_ATTENDANCE_TRACKING")
          ? 409
          : 400;
    const code =
      status === 403
        ? "FORBIDDEN"
        : status === 404
          ? "USER_NOT_FOUND"
          : status === 409
            ? "MEAL_ALLOWANCE_REQUIRES_ATTENDANCE_TRACKING"
            : "INVALID_MEAL_ALLOWANCE_ELIGIBILITY";
    return payrollJson({ ok: false, code }, status);
  }
  const syncMonths = mealCandidateSyncMonths(effectiveFrom, currentVietnamMonth());
  let sourceSync = { attemptedMonths: syncMonths, failedMonths: [] as string[] };
  if (syncMonths.length > 0) {
    try {
      const result = await syncMealCandidateMonths(syncMonths, auth.actor.id);
      sourceSync = { attemptedMonths: syncMonths, failedMonths: result.failedMonths };
      if (result.failedMonths.length > 0) {
        console.error("[MEAL_ALLOWANCE_SOURCE_SYNC_PARTIAL_FAILED]", { failedMonths: result.failedMonths });
      }
    } catch (syncError) {
      console.error("[MEAL_ALLOWANCE_SOURCE_SYNC_FAILED]", syncError);
      sourceSync = { attemptedMonths: syncMonths, failedMonths: syncMonths };
    }
  }
  return payrollJson({ ok: true, eligibility: map(data as Record<string, unknown>), sourceSync }, 201);
}
