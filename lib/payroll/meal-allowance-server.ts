import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import type { AttendanceRow, PayrollSnapshotUserRow } from "@/lib/payroll/monthly-run";
import type { PayrollContract } from "@/lib/payroll/types";
import {
  calculateCurrentMealAllowanceCost,
  calculateProjectedMealAllowanceForEmployee,
  selectMealAllowanceEligibilityDuringMonth,
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
  /** payrollUserIds 중 그 달에 한 번이라도 식대 대상이었던 user id 목록(배지 전용). */
  eligibleUserIds: number[];
};

// loadPayrollMonthSnapshot(monthly-run.ts)가 이미 읽어 둔 users/contracts/attendance를
// 그대로 재사용하기 위한 입력. sourceSnapshot/payment snapshot·hash 입력과는 무관한, 표시·
// 회사비용 집계 전용 원본이다 — 이 타입 자체가 그 재사용 계약을 명시한다.
export type MealAllowanceOverviewInput = {
  calculationEndDate: string | null;
  users: readonly PayrollSnapshotUserRow[];
  contracts: readonly PayrollContract[];
  attendance: readonly AttendanceRow[];
  /** 배지(eligibleUserIds) 판정 대상 — 보통 overview.employees의 userId 목록. */
  payrollUserIds: readonly number[];
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

// /admin/payroll 비용표(현재·예상 식대비용)와 배지(eligibleUserIds) 겸용 집계.
//
// loadPayrollOverview(overview-server.ts)는 payroll_pay_employee_v1 지급 snapshot/hash를
// 만드는 데도 재사용되므로 절대 건드리지 않는다 — 이 함수는 그 경로와 완전히 분리된, 표시
// 전용 별도 조회다. users/contracts/attendance는 loadPayrollMonthSnapshot()이 같은 달에
// 대해 이미 동일한 조건(같은 날짜 창)으로 읽어 둔 원본을 그대로 넘겨받아 재사용하고, DB에서는
// 이 함수 전용인 payroll_meal_allowance_policy_versions/payroll_meal_allowance_eligibility_versions
// 두 테이블만 새로 읽는다. eligibility는 user_id로 미리 거르지 않고 그 달에 유효한 버전을
// 한 번에 읽어 candidate user 목록과 eligibility map을 모두 메모리에서 만든 뒤, 같은 맵을
// 비용 계산과 배지 판정(payrollUserIds) 양쪽에 재사용한다 — user_id 후보 조회 → 상세 조회로
// 이어지던 2단계 조회, 그리고 배지용 별도 조회를 각각 없앤다.
export async function loadMealAllowanceCostSummary(
  month: string,
  input: MealAllowanceOverviewInput,
): Promise<MealAllowanceCostSummary> {
  const monthStart = `${month}-01`;
  const monthEndExclusive = nextMonthStart(monthStart);

  const [
    { data: policyRows, error: policyError },
    { data: eligibilityRows, error: eligibilityError },
  ] = await Promise.all([
    supabaseServer
      .from("payroll_meal_allowance_policy_versions")
      .select("id,daily_amount,effective_from,revision")
      .lt("effective_from", monthEndExclusive)
      .order("effective_from", { ascending: false })
      .order("revision", { ascending: false }),
    // 배지(eligibleUserIds)는 policyMissing 여부와 무관하게 판정해야 하므로, 정책 유무와
    // 상관없이 항상 이 한 번의 조회로 candidate/eligibility map을 함께 만든다.
    supabaseServer
      .from("payroll_meal_allowance_eligibility_versions")
      .select("id,user_id,is_eligible,effective_from,revision")
      .lt("effective_from", monthEndExclusive),
  ]);
  if (policyError || eligibilityError) throw new Error("MEAL_ALLOWANCE_READ_FAILED");

  const policyVersions = (policyRows ?? []).map(mapPolicyRow);
  const policyMissing = policyVersions.length === 0;

  const eligibilityByUser = new Map<number, MealAllowanceEligibilityVersion[]>();
  for (const row of eligibilityRows ?? []) {
    const version = mapEligibilityRow(row as Record<string, unknown>);
    const list = eligibilityByUser.get(version.userId) ?? [];
    list.push(version);
    eligibilityByUser.set(version.userId, list);
  }
  const candidateUserIds = [...eligibilityByUser.keys()];
  const eligibleUserIds = input.payrollUserIds.filter((userId) =>
    selectMealAllowanceEligibilityDuringMonth(
      eligibilityByUser.get(userId) ?? [],
      monthStart,
      monthEndExclusive,
    ),
  );

  if (policyMissing) {
    return { currentAmount: 0, projectedAmount: 0, policyMissing: true, eligibleUserIds };
  }
  if (candidateUserIds.length === 0) {
    return { currentAmount: 0, projectedAmount: 0, policyMissing: false, eligibleUserIds };
  }

  const candidateSet = new Set(candidateUserIds);

  const usersById = new Map<number, MealAllowanceEmploymentWindow>();
  for (const user of input.users) {
    if (!candidateSet.has(user.id)) continue;
    usersById.set(user.id, { hireDate: user.hire_date, terminationDate: user.termination_date });
  }

  const contractsByUser = new Map<number, MealAllowanceContractPeriod[]>();
  for (const contract of input.contracts) {
    if (!candidateSet.has(contract.userId)) continue;
    const list = contractsByUser.get(contract.userId) ?? [];
    list.push({
      effectiveFrom: contract.effectiveFrom,
      effectiveTo: contract.effectiveTo,
      standardWorkdays: contract.standardWorkdays,
    });
    contractsByUser.set(contract.userId, list);
  }

  // input.attendance는 loadPayrollMonthSnapshot()이 이미 [monthStart, calculationEndDate]
  // 범위로 읽어 둔 것과 정확히 같은 창이므로(overview route가 같은 calculationEndDate를
  // 그대로 넘긴다) 날짜로 다시 거를 필요가 없다 — check_in_at/candidate 필터만 메모리에서 적용한다.
  const attendanceDays = input.attendance
    .filter((row) => row.check_in_at !== null && candidateSet.has(Number(row.user_id)))
    .map((row) => ({ userId: Number(row.user_id), workDate: row.work_date }));

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

  return { currentAmount: current.totalAmount, projectedAmount, policyMissing: false, eligibleUserIds };
}
