// 공휴일 그룹(holiday_group)의 UI 표시용 짧은 이름 표.
//
// store_holidays.name_ko/name_vi는 날짜 하나하나의 공식 명칭("음력설 연휴",
// "베트남 국경일")이라 그룹 헤더("음력설 · 5일")로 쓰기엔 너무 길거나 날짜마다
// 달라질 수 있다. 이 표는 그 그룹 헤더 전용 짧은 라벨만 담는다 — holiday_group은
// DB에서 CHECK로 닫아두지 않은 열린 값이므로(향후 정부 발표로 새 그룹이 늘어날 수
// 있음), 여기 없는 그룹은 호출자가 그룹의 첫 번째 날짜 이름으로 대체 표시한다.
export const HOLIDAY_GROUP_LABELS: Record<string, { ko: string; vi: string }> = {
  TET: { ko: "음력설", vi: "Tết Nguyên Đán" },
  NATIONAL_DAY: { ko: "국경일", vi: "Quốc khánh" },
};

export function getHolidayGroupLabel(
  holidayGroup: string,
  lang: "ko" | "vi",
  fallback: string
): string {
  return HOLIDAY_GROUP_LABELS[holidayGroup]?.[lang] ?? fallback;
}
