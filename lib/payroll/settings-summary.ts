// 급여설정 직원 탭의 "선택 직원 급여설정 요약" 전용 판정. 각 설정 카드가 이미 조회한 버전 이력을
// 그대로 받아, 급여 계산과 같은 선택 규칙(select* 함수)으로 기준 월/일에 유효한 버전을 고른다.
// 새 API 조회나 저장은 하지 않는다.
import { selectInsuranceSetting, type PayrollInsuranceSettingVersion } from "./insurance.ts";
import { selectEmployeeTaxSetting, type PayrollTaxSettingVersion } from "./tax.ts";
import { selectAttendanceBonusEligibilityAt, type AttendanceBonusEligibilityVersion } from "./attendance-bonus.ts";
import { selectMealAllowanceEligibilityVersionAt, type MealAllowanceEligibilityVersion } from "./meal-allowance.ts";
import { schedulesActiveOn } from "./work-schedule.ts";
import type { WorkScheduleVersion } from "./types.ts";

/** 설정 카드 → 요약으로 전달하는 조회 상태. error는 "미설정"과 구분된다. */
export type SettingHistoryState<V> = { status: "loading" | "ready" | "error"; history: V[] };

export type SummaryReferenceKind = "current" | "past" | "future";
export type SummaryReference = {
  /** YYYY-MM */
  month: string;
  /** 일 단위 버전(계약·근무시간·식대) 판정 기준일 */
  date: string;
  kind: SummaryReferenceKind;
  /** 급여관리에서 월을 전달받았는가 */
  fromPayrollMonth: boolean;
};

function lastDayOfMonth(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return `${month}-${String(new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()).padStart(2, "0")}`;
}

// 기준: 현재 월 → 오늘 / 과거 월 → 그 달 말일(그 달에 마지막으로 유효했던 설정) / 미래 월 → 그 달 1일.
export function resolveSettingsSummaryReference(monthParam: string | null, today: string): SummaryReference {
  const currentMonth = today.slice(0, 7);
  const valid = typeof monthParam === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam);
  const month = valid ? monthParam! : currentMonth;
  if (month === currentMonth) return { month, date: today, kind: "current", fromPayrollMonth: valid };
  if (month < currentMonth) return { month, date: lastDayOfMonth(month), kind: "past", fromPayrollMonth: valid };
  return { month, date: `${month}-01`, kind: "future", fromPayrollMonth: valid };
}

export type VersionPick<V> = {
  /** 기준 시점에 유효한 버전(없으면 null = 해당 시점 설정 없음) */
  applied: V | null;
  /** 기준 시점 이후 예약된 가장 가까운 버전 */
  scheduled: V | null;
};

type ContractLike = { effectiveFrom: string; effectiveTo: string | null };

export function pickContract<C extends ContractLike>(contracts: readonly C[], reference: SummaryReference): VersionPick<C> & { overlap: boolean } {
  const active = contracts.filter((contract) => contract.effectiveFrom <= reference.date && (!contract.effectiveTo || contract.effectiveTo > reference.date));
  const scheduled = contracts.filter((contract) => contract.effectiveFrom > reference.date).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0] ?? null;
  return { applied: active.length === 1 ? active[0] : null, scheduled, overlap: active.length > 1 };
}

export function pickWorkSchedule(schedules: readonly WorkScheduleVersion[], reference: SummaryReference): VersionPick<WorkScheduleVersion> & { overlap: boolean } {
  const active = schedulesActiveOn([...schedules], reference.date);
  const scheduled = schedules.filter((schedule) => schedule.effectiveFrom > reference.date).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0] ?? null;
  return { applied: active.length === 1 ? active[0] : null, scheduled, overlap: active.length > 1 };
}

function nextMonthly<V extends { effectiveMonth: string; revision: number }>(versions: readonly V[], afterMonthKey: string) {
  return versions.filter((version) => version.effectiveMonth > afterMonthKey)
    .sort((a, b) => a.effectiveMonth.localeCompare(b.effectiveMonth) || b.revision - a.revision)[0] ?? null;
}

export function pickInsurance(history: readonly PayrollInsuranceSettingVersion[], reference: SummaryReference): VersionPick<PayrollInsuranceSettingVersion> {
  // insurance.effectiveMonth는 YYYY-MM-01 (selectInsuranceSetting과 같은 비교 키)
  return { applied: selectInsuranceSetting([...history], reference.month), scheduled: nextMonthly(history, `${reference.month}-01`) };
}

export function pickTax(history: readonly PayrollTaxSettingVersion[], reference: SummaryReference): VersionPick<PayrollTaxSettingVersion> & { requiresReview: boolean } {
  const applied = selectEmployeeTaxSetting(history, reference.month);
  // 급여 계산(calculateEmployeePit)의 직원 프로필 기준과 같다: 프로필 없음 → 확인 필요,
  // 과세 대상인데 회계 명의 없음 → 확인 필요. TNCN 정책(회사 공통) 상태는 여기서 판정하지 않는다.
  const requiresReview = !applied || (applied.taxMode === "resident_progressive" && !applied.accountingName?.trim());
  return { applied, scheduled: nextMonthly(history, `${reference.month}-01`), requiresReview };
}

type MealEligibilityVersion = { isEligible: boolean; effectiveFrom: string; revision: number };
export function pickMealAllowance<V extends MealEligibilityVersion>(history: readonly V[], reference: SummaryReference): VersionPick<V> {
  const applied = selectMealAllowanceEligibilityVersionAt(history as unknown as readonly MealAllowanceEligibilityVersion[], reference.date) as V | null;
  const scheduled = history.filter((version) => version.effectiveFrom > reference.date)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || b.revision - a.revision)[0] ?? null;
  return { applied, scheduled };
}

type BonusEligibilityVersion = { isEligible: boolean; effectiveMonth: string; revision: number };
export function pickAttendanceBonus<V extends BonusEligibilityVersion>(history: readonly V[], reference: SummaryReference): VersionPick<V> {
  // attendance bonus effectiveMonth는 YYYY-MM (selectAttendanceBonusEligibilityAt과 같은 비교 키)
  return { applied: selectAttendanceBonusEligibilityAt(history as unknown as readonly AttendanceBonusEligibilityVersion[], reference.month) as unknown as V | null, scheduled: nextMonthly(history, reference.month) };
}
