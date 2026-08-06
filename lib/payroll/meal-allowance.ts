// 식대 현재·예상비용 계산의 순수 함수 모음.
//
// 이 파일은 tests/에서 "@/" 별칭 없는 Node 직접 실행(--experimental-strip-types)으로
// 상대 경로 임포트될 수 있으므로, "@/" 별칭 기반 cross-module import를 쓰지 않는다
// (lib/payroll/eligibility.ts, lib/payroll/payment-schedule.ts와 같은 제약).
// lib/attendance/time.ts는 그 자체가 alias-free leaf 모듈이라 상대 경로로만 가져온다.
//
// recognizedWorkdays(lib/payroll/monthly-run.ts)는 지각·조퇴·스케줄 정책이 반영된 급여
// 계산 전용 값이라 식대 기준("지각·조퇴와 무관, 퇴근 기록 없어도 발생")과 다르다 — 이 파일은
// 그 값을 재사용하지 않고 attendance_records를 독립적으로 집계한다.
// @ts-expect-error Node's test runner requires the explicit TypeScript extension.
import { addDaysToDateKey } from "../attendance/time.ts";

export type MealAllowancePolicyVersion = {
  id: number;
  dailyAmount: number;
  effectiveFrom: string;
  revision: number;
};

export type MealAllowanceEligibilityVersion = {
  id: number;
  userId: number;
  isEligible: boolean;
  effectiveFrom: string;
  revision: number;
};

export type MealAllowanceEmploymentWindow = {
  hireDate: string | null;
  terminationDate: string | null;
};

export type MealAllowanceAttendanceDay = {
  userId: number;
  workDate: string;
};

export type MealAllowanceContractPeriod = {
  effectiveFrom: string;
  effectiveTo: string | null;
  standardWorkdays: number | null;
};

export type MealAllowanceProjectionWarningCode = "STANDARD_WORKDAYS_MISSING";

function latestVersionAt<T extends { effectiveFrom: string; revision: number }>(
  versions: readonly T[],
  date: string,
): T | null {
  let best: T | null = null;
  for (const version of versions) {
    if (version.effectiveFrom > date) continue;
    if (
      !best ||
      version.effectiveFrom > best.effectiveFrom ||
      (version.effectiveFrom === best.effectiveFrom && version.revision > best.revision)
    ) {
      best = version;
    }
  }
  return best;
}

export function selectMealAllowancePolicyAt(
  versions: readonly MealAllowancePolicyVersion[],
  date: string,
): MealAllowancePolicyVersion | null {
  return latestVersionAt(versions, date);
}

export function selectMealAllowanceEligibilityAt(
  versions: readonly MealAllowanceEligibilityVersion[],
  date: string,
): boolean {
  return latestVersionAt(versions, date)?.isEligible === true;
}

function daysBetween(fromInclusive: string, toExclusive: string): number {
  const [fy, fm, fd] = fromInclusive.split("-").map(Number);
  const [ty, tm, td] = toExclusive.split("-").map(Number);
  const from = Date.UTC(fy, fm - 1, fd);
  const to = Date.UTC(ty, tm - 1, td);
  return Math.round((to - from) / 86_400_000);
}

// 현재 식대비용 = 실제 출근한 식대 대상 직원의 출근일별 식대 금액 합계.
//
// 호출자는 attendanceDays로 "check_in_at is not null인 attendance_records 행"만 넘긴다.
// 취소·삭제된 기록은 이 시스템에서 하드 삭제되므로(감사 로그만 남음) 애초에 목록에
// 존재하지 않고, 승인 휴무(check_in_at is null)도 자연히 빠진다 — 별도 status 필터 불필요.
export function calculateCurrentMealAllowanceCost(input: {
  attendanceDays: readonly MealAllowanceAttendanceDay[];
  users: ReadonlyMap<number, MealAllowanceEmploymentWindow>;
  eligibilityVersionsByUser: ReadonlyMap<number, readonly MealAllowanceEligibilityVersion[]>;
  policyVersions: readonly MealAllowancePolicyVersion[];
}): { totalAmount: number; byUser: Map<number, number> } {
  const seen = new Set<string>();
  let totalAmount = 0;
  const byUser = new Map<number, number>();

  for (const day of input.attendanceDays) {
    // 같은 user_id + work_date는 최대 1회만 인정한다(방어적 dedup — DB에서 이미
    // (user_id, work_date)당 1행이 보장되지만, 호출자가 실수로 중복을 넘겨도 안전하다).
    const key = `${day.userId}:${day.workDate}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const employment = input.users.get(day.userId);
    if (!employment) continue;
    if (employment.hireDate && day.workDate < employment.hireDate) continue;
    if (employment.terminationDate && day.workDate > employment.terminationDate) continue;

    const eligible = selectMealAllowanceEligibilityAt(
      input.eligibilityVersionsByUser.get(day.userId) ?? [],
      day.workDate,
    );
    if (!eligible) continue;

    const policy = selectMealAllowancePolicyAt(input.policyVersions, day.workDate);
    if (!policy) continue;

    totalAmount += policy.dailyAmount;
    byUser.set(day.userId, (byUser.get(day.userId) ?? 0) + policy.dailyAmount);
  }

  return { totalAmount, byUser };
}

// 예상 식대비용(직원 1명) = Σ(월 내 하위 기간) standardWorkdays × (하위 기간 일수 / 월 전체
// 일수) × 그 기간에 유효한 1일 식대.
//
// 이 비례식은 기존 급여 계산 코드베이스에 존재하지 않는다 — lib/payroll/overview-projection.ts의
// "예상" 합계는 월 중간 입사·퇴사·계약변경을 비례 계산하지 않고 계약 월환산액을 그대로 쓴다
// (재확인 결과, 재사용 가능한 기존 proration 함수가 없음 — 최종 보고서에 기재).
// 그래서 여기서는 달력일수 비율(하위 기간 일수 / 월 전체 일수)이라는 최소한의 새 비례 기준을
// 이 파일 안에서만 정의해 사용한다. 하위 기간은 재직기간·식대 대상 여부·공통 식대 금액·계약의
// standard_workdays 중 하나라도 바뀌는 날짜에서 나뉜다.
export function calculateProjectedMealAllowanceForEmployee(input: {
  userId: number;
  hireDate: string | null;
  terminationDate: string | null;
  monthStart: string;
  monthEndExclusive: string;
  contracts: readonly MealAllowanceContractPeriod[];
  eligibilityVersions: readonly MealAllowanceEligibilityVersion[];
  policyVersions: readonly MealAllowancePolicyVersion[];
}): { amount: number; warningCode: MealAllowanceProjectionWarningCode | null } {
  const empStart =
    input.hireDate && input.hireDate > input.monthStart ? input.hireDate : input.monthStart;
  const empEndExclusive =
    input.terminationDate && addDaysToDateKey(input.terminationDate, 1) < input.monthEndExclusive
      ? addDaysToDateKey(input.terminationDate, 1)
      : input.monthEndExclusive;

  if (empStart >= empEndExclusive) return { amount: 0, warningCode: null };

  const daysInMonth = daysBetween(input.monthStart, input.monthEndExclusive);

  const boundaries = new Set<string>([empStart, empEndExclusive]);
  for (const version of input.eligibilityVersions) {
    if (version.effectiveFrom > empStart && version.effectiveFrom < empEndExclusive) {
      boundaries.add(version.effectiveFrom);
    }
  }
  for (const version of input.policyVersions) {
    if (version.effectiveFrom > empStart && version.effectiveFrom < empEndExclusive) {
      boundaries.add(version.effectiveFrom);
    }
  }
  for (const contract of input.contracts) {
    if (contract.effectiveFrom > empStart && contract.effectiveFrom < empEndExclusive) {
      boundaries.add(contract.effectiveFrom);
    }
    if (contract.effectiveTo && contract.effectiveTo > empStart && contract.effectiveTo < empEndExclusive) {
      boundaries.add(contract.effectiveTo);
    }
  }
  const sortedBoundaries = [...boundaries].sort();

  // 구간별로 반올림하지 않고 소수 정밀도로 합산한 뒤, 직원별 월 합계에서 딱 한 번만 VND
  // 반올림한다(방식 B). 구간별로 먼저 반올림하면(방식 A) 월중 변경이 여러 번 있을 때 반올림
  // 오차가 누적돼 "전체를 한 번에 계산했을 때"와 다른 금액이 나올 수 있다 — 안전성
  // 재검토에서 실제로 1VND 차이가 재현되어 이 방식으로 수정한다.
  let rawAmount = 0;
  let sawMissingStandardWorkdays = false;

  for (let index = 0; index < sortedBoundaries.length - 1; index += 1) {
    const from = sortedBoundaries[index];
    const toExclusive = sortedBoundaries[index + 1];
    if (from >= toExclusive) continue;

    const eligible = selectMealAllowanceEligibilityAt(input.eligibilityVersions, from);
    if (!eligible) continue;

    const policy = selectMealAllowancePolicyAt(input.policyVersions, from);
    if (!policy) continue;

    const activeContracts = input.contracts.filter(
      (contract) => contract.effectiveFrom <= from && (!contract.effectiveTo || contract.effectiveTo > from),
    );
    const standardWorkdays = activeContracts.length === 1 ? activeContracts[0].standardWorkdays : null;
    if (!standardWorkdays || standardWorkdays <= 0) {
      sawMissingStandardWorkdays = true;
      continue;
    }

    const periodDays = daysBetween(from, toExclusive);
    rawAmount += standardWorkdays * (periodDays / daysInMonth) * policy.dailyAmount;
  }

  return { amount: Math.round(rawAmount), warningCode: sawMissingStandardWorkdays ? "STANDARD_WORKDAYS_MISSING" : null };
}
