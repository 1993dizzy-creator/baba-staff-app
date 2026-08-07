import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import {
  selectMealAllowanceEligibilityAt,
  selectMealAllowanceEligibilityDuringMonth,
  type MealAllowanceEligibilityVersion,
} from "@/lib/payroll/meal-allowance";

// 🍚 배지 판정 전용 조회 모음.
//
// lib/payroll/meal-allowance-server.ts(loadMealAllowanceCostSummary)는 /admin/payroll
// 비용표(현재·예상 식대비용) 집계용으로 정책·계약·출근기록까지 함께 읽는 무거운 경로다.
// 이 파일은 그 경로와 결합하지 않고, "이 직원이 식대 대상인가"만 판정하는 가벼운 별도
// 조회를 제공한다 — 표시(직원관리·급여관리) 경로와 지급/비용 집계 경로를 분리한 기존
// 설계를 그대로 따른다.
//
// 화면마다 "대상"의 기준 시점이 다르다:
//  - /admin/users: 오늘 이 순간의 상태 → loadMealAllowanceEligibilityAt(오늘)
//  - /admin/payroll, /admin/payroll/[runId]: 과거·미래 월을 자유롭게 넘나들며 조회하므로
//    "오늘"을 쓰면 과거 급여장부의 배지가 이후 eligibility 변경으로 바뀌어 버린다 →
//    loadMealAllowanceEligibilityDuringMonth(조회 중인 급여월)

function mapRow(row: Record<string, unknown>): MealAllowanceEligibilityVersion {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    isEligible: Boolean(row.is_eligible),
    effectiveFrom: String(row.effective_from),
    revision: Number(row.revision),
  };
}

function groupByUser(rows: readonly Record<string, unknown>[]): Map<number, MealAllowanceEligibilityVersion[]> {
  const versionsByUser = new Map<number, MealAllowanceEligibilityVersion[]>();
  for (const row of rows) {
    const version = mapRow(row);
    const list = versionsByUser.get(version.userId) ?? [];
    list.push(version);
    versionsByUser.set(version.userId, list);
  }
  return versionsByUser;
}

function nextMonthStart(monthStart: string) {
  const [year, month] = monthStart.split("-").map(Number);
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
}

// "오늘"(또는 임의의 특정 날짜) 시점의 식대 대상 여부 — /admin/users처럼 "지금 이 순간의
// 상태"를 보여줘야 하는 화면 전용. asOfDate 이후(effective_from > asOfDate)의 미래 예약
// 버전은 DB 조회 단계에서부터 제외한다.
export async function loadMealAllowanceEligibilityAt(
  userIds: number[],
  asOfDate: string,
): Promise<Map<number, boolean>> {
  const result = new Map<number, boolean>();
  if (userIds.length === 0) return result;

  const { data, error } = await supabaseServer
    .from("payroll_meal_allowance_eligibility_versions")
    .select("id,user_id,is_eligible,effective_from,revision")
    .in("user_id", userIds)
    .lte("effective_from", asOfDate);
  if (error) throw new Error(`MEAL_ALLOWANCE_ELIGIBILITY_READ_FAILED: ${error.message}`);

  const versionsByUser = groupByUser(data ?? []);
  for (const userId of userIds) {
    result.set(userId, selectMealAllowanceEligibilityAt(versionsByUser.get(userId) ?? [], asOfDate));
  }
  return result;
}

// 특정 급여월(payroll month) 동안 한 번이라도 식대 대상이었는지 — /admin/payroll(overview)·
// [runId] 급여장부처럼 과거·미래 월을 넘나들며 조회하는 화면 전용. "오늘" 날짜는 전혀 쓰지
// 않는다: 그 달 이후(effective_from >= monthEndExclusive)에 등록된 eligibility 변경은 DB
// 조회 단계에서부터 제외해, 나중에 생긴 변경이 과거 월 표시를 바꾸지 않는다.
export async function loadMealAllowanceEligibilityDuringMonth(
  userIds: number[],
  month: string,
): Promise<Map<number, boolean>> {
  const result = new Map<number, boolean>();
  if (userIds.length === 0) return result;

  const monthStart = `${month}-01`;
  const monthEndExclusive = nextMonthStart(monthStart);
  const { data, error } = await supabaseServer
    .from("payroll_meal_allowance_eligibility_versions")
    .select("id,user_id,is_eligible,effective_from,revision")
    .in("user_id", userIds)
    .lt("effective_from", monthEndExclusive);
  if (error) throw new Error(`MEAL_ALLOWANCE_ELIGIBILITY_READ_FAILED: ${error.message}`);

  const versionsByUser = groupByUser(data ?? []);
  for (const userId of userIds) {
    result.set(
      userId,
      selectMealAllowanceEligibilityDuringMonth(versionsByUser.get(userId) ?? [], monthStart, monthEndExclusive),
    );
  }
  return result;
}
