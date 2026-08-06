import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import {
  calculateCurrentMealAllowanceCost,
  calculateProjectedMealAllowanceForEmployee,
  type MealAllowanceContractPeriod,
  type MealAllowanceEligibilityVersion,
  type MealAllowanceEmploymentWindow,
  type MealAllowancePolicyVersion,
} from "@/lib/payroll/meal-allowance";

export type MealAllowanceCostSummary = {
  currentAmount: number;
  projectedAmount: number;
  /** 식대 정책 version이 한 건도 없음(회사 공통 설정 화면에서 "미설정"으로 보여야 함). */
  policyMissing: boolean;
};

function nextMonthStart(monthStart: string) {
  const [year, month] = monthStart.split("-").map(Number);
  const next = new Date(Date.UTC(year, month, 1));
  return next.toISOString().slice(0, 10);
}

function mapPolicyRow(row: Record<string, unknown>): MealAllowancePolicyVersion {
  return {
    id: Number(row.id),
    dailyAmount: Number(row.daily_amount),
    effectiveFrom: String(row.effective_from),
    revision: Number(row.revision),
  };
}

function mapEligibilityRow(row: Record<string, unknown>): MealAllowanceEligibilityVersion {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    isEligible: Boolean(row.is_eligible),
    effectiveFrom: String(row.effective_from),
    revision: Number(row.revision),
  };
}

// /admin/payroll 비용표(현재·예상 식대비용)용 집계.
//
// loadPayrollOverview(overview-server.ts)는 payroll_pay_employee_v1 지급 snapshot/hash를
// 만드는 데도 재사용되므로 절대 건드리지 않는다 — 이 함수는 그 경로와 완전히 분리된, 표시
// 전용 별도 조회다. N+1을 피하기 위해 대상 기간에 필요한 데이터를 유저별로 반복 조회하지
// 않고 한 번씩만 조회한다.
export async function loadMealAllowanceCostSummary(
  month: string,
  period: { calculationEndDate: string | null },
): Promise<MealAllowanceCostSummary> {
  const monthStart = `${month}-01`;
  const monthEndExclusive = nextMonthStart(monthStart);

  const { data: policyRows, error: policyError } = await supabaseServer
    .from("payroll_meal_allowance_policy_versions")
    .select("id,daily_amount,effective_from,revision")
    .lt("effective_from", monthEndExclusive)
    .order("effective_from", { ascending: false })
    .order("revision", { ascending: false });
  if (policyError) throw new Error("MEAL_ALLOWANCE_READ_FAILED");
  const policyVersions = (policyRows ?? []).map(mapPolicyRow);
  const policyMissing = policyVersions.length === 0;

  if (policyMissing) {
    return { currentAmount: 0, projectedAmount: 0, policyMissing: true };
  }

  const { data: eligibleUserRows, error: eligibleUserError } = await supabaseServer
    .from("payroll_meal_allowance_eligibility_versions")
    .select("user_id");
  if (eligibleUserError) throw new Error("MEAL_ALLOWANCE_READ_FAILED");
  const candidateUserIds = [...new Set((eligibleUserRows ?? []).map((row) => Number(row.user_id)))];

  if (candidateUserIds.length === 0) {
    return { currentAmount: 0, projectedAmount: 0, policyMissing: false };
  }

  const [
    { data: eligibilityRows, error: eligibilityError },
    { data: userRows, error: userError },
    { data: contractRows, error: contractError },
    { data: attendanceRows, error: attendanceError },
  ] = await Promise.all([
    supabaseServer
      .from("payroll_meal_allowance_eligibility_versions")
      .select("id,user_id,is_eligible,effective_from,revision")
      .in("user_id", candidateUserIds)
      .lt("effective_from", monthEndExclusive),
    supabaseServer.from("users").select("id,hire_date,termination_date").in("id", candidateUserIds),
    supabaseServer
      .from("payroll_contract_versions")
      .select("user_id,effective_from,effective_to,standard_workdays")
      .in("user_id", candidateUserIds)
      .lt("effective_from", monthEndExclusive)
      .or(`effective_to.is.null,effective_to.gt.${monthStart}`),
    period.calculationEndDate
      ? supabaseServer
          .from("attendance_records")
          .select("user_id,work_date")
          .in("user_id", candidateUserIds)
          .not("check_in_at", "is", null)
          .gte("work_date", monthStart)
          .lte("work_date", period.calculationEndDate)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (eligibilityError || userError || contractError || attendanceError) {
    throw new Error("MEAL_ALLOWANCE_READ_FAILED");
  }

  const eligibilityByUser = new Map<number, MealAllowanceEligibilityVersion[]>();
  for (const row of eligibilityRows ?? []) {
    const version = mapEligibilityRow(row as Record<string, unknown>);
    const list = eligibilityByUser.get(version.userId) ?? [];
    list.push(version);
    eligibilityByUser.set(version.userId, list);
  }

  const usersById = new Map<number, MealAllowanceEmploymentWindow>(
    (userRows ?? []).map((row) => [
      Number(row.id),
      {
        hireDate: row.hire_date ? String(row.hire_date) : null,
        terminationDate: row.termination_date ? String(row.termination_date) : null,
      },
    ]),
  );

  const contractsByUser = new Map<number, MealAllowanceContractPeriod[]>();
  for (const row of contractRows ?? []) {
    const userId = Number(row.user_id);
    const list = contractsByUser.get(userId) ?? [];
    list.push({
      effectiveFrom: String(row.effective_from),
      effectiveTo: row.effective_to ? String(row.effective_to) : null,
      standardWorkdays: row.standard_workdays === null ? null : Number(row.standard_workdays),
    });
    contractsByUser.set(userId, list);
  }

  const attendanceDays = (attendanceRows ?? []).map((row) => ({
    userId: Number(row.user_id),
    workDate: String(row.work_date),
  }));

  const current = calculateCurrentMealAllowanceCost({
    attendanceDays,
    users: usersById,
    eligibilityVersionsByUser: eligibilityByUser,
    policyVersions,
  });

  let projectedAmount = 0;
  for (const userId of candidateUserIds) {
    const user = usersById.get(userId);
    if (!user) continue;
    const result = calculateProjectedMealAllowanceForEmployee({
      userId,
      hireDate: user.hireDate,
      terminationDate: user.terminationDate,
      monthStart,
      monthEndExclusive,
      contracts: contractsByUser.get(userId) ?? [],
      eligibilityVersions: eligibilityByUser.get(userId) ?? [],
      policyVersions,
    });
    projectedAmount += result.amount;
  }

  return { currentAmount: current.totalAmount, projectedAmount, policyMissing: false };
}
