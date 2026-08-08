// BABA 내부 "매장 영업 + 200% 적용" 여부를 판정하는 순수 함수 모음.
//
// 관리자 UI(app/(protected)/admin/settings/store/page.tsx)와 근태 API
// (lib/store-settings/holidays-server.ts의 loadHolidaysForMonth)가 서로 다른
// 기준으로 "이 날짜가 200% 적용일인가"를 판단하지 않도록, 판정 로직을 이 파일
// 하나로만 둔다 — 서버 코드와 클라이언트 코드가 모두 이 함수를 그대로 import해서
// 쓴다(재구현하지 않는다). DB 접근이 전혀 없는 순수 함수라 양쪽에서 안전하게
// 공유할 수 있다.
//
// 정책(확정, 2026-08-09):
//   - 해당 연도 동일 holiday_group의 날짜가 1개뿐이면 → 관리자 선택 없이 자동 200% 적용.
//     예: NEW_YEAR, HUNG_KINGS, REUNIFICATION_DAY, LABOR_DAY.
//   - 동일 holiday_group이 2일 이상이면 → store_holiday_operation_policies에서
//     실제로 선택된(internal_pay_multiplier=2) 날짜만 200% 적용.
//     예: TET(5일), NATIONAL_DAY(2일).
//
// 이름에 "법정 지급률"을 암시하는 단어(statutory/legal)를 쓰지 않는다 — 이 200%는
// 어디까지나 BABA 내부 운영 지침이다.

export type HolidayPolicyInput = {
  holidayGroup: string;
  internalPayMultiplier: number | null;
};

// 그룹 크기는 "그 해에 실제로 존재하는 같은 holiday_group 날짜 수"다. 호출자가
// 연도 전체 holiday 목록에서 미리 계산해 전달한다(이 함수 자체는 목록을 다시
// 조회하지 않는다).
export function countHolidayGroupSizes<T extends { holidayGroup: string }>(
  holidays: readonly T[]
): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const holiday of holidays) {
    sizes.set(holiday.holidayGroup, (sizes.get(holiday.holidayGroup) ?? 0) + 1);
  }
  return sizes;
}

export function isBabaPremiumHoliday(
  holiday: HolidayPolicyInput,
  groupSize: number
): boolean {
  if (groupSize === 1) return true;
  if (groupSize >= 2 && holiday.internalPayMultiplier === 2) return true;
  return false;
}

// 적용되지 않으면 null — "몇 배인지 모른다"가 아니라 "적용 자체가 안 됐다"는
// 뜻이다(기본값 1.0을 반환하지 않는다 — 이 필드는 언제나 "적용 여부 + 배율"을
// 함께 표현한다).
export function getEffectiveHolidayMultiplier(
  holiday: HolidayPolicyInput,
  groupSize: number
): number | null {
  return isBabaPremiumHoliday(holiday, groupSize) ? 2 : null;
}
