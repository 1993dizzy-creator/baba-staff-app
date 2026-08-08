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

// "연도 준비" 모달(HolidaysTab)의 미리보기 전용 공통 정의 — 실제 DB에 심는 값은
// supabase/migrations/202608090001_add_store_prepare_holiday_calendar_rpc.sql의
// store_prepare_holiday_calendar_v1 안에 리터럴로 들어 있다(SQL 함수는 TS 상수를
// import할 수 없으므로). 두 곳의 문구는 반드시 같아야 한다 — 한쪽만 고치면
// 미리보기와 실제 저장 결과가 어긋난다. 2026 seed(202608080003)의 문구를 그대로
// 재사용한다.
export type FixedHolidayDefinition = {
  code: string;
  nameKo: string;
  nameVi: string;
  // target year 기준 "MM-DD" — 매년 같은 날짜인 고정 공휴일만 여기 있다.
  monthDay: string;
};

export const FIXED_HOLIDAY_DEFINITIONS: FixedHolidayDefinition[] = [
  { code: "NEW_YEAR", nameKo: "신정", nameVi: "Tết Dương lịch", monthDay: "01-01" },
  {
    code: "REUNIFICATION_DAY",
    nameKo: "통일기념일",
    nameVi: "Ngày Giải phóng miền Nam, thống nhất đất nước",
    monthDay: "04-30",
  },
  { code: "LABOR_DAY", nameKo: "노동절", nameVi: "Ngày Quốc tế Lao động", monthDay: "05-01" },
  { code: "NATIONAL_DAY", nameKo: "베트남 국경일", nameVi: "Quốc khánh Việt Nam", monthDay: "09-02" },
];

// 매년 날짜가 바뀌는(관리자가 입력하는) 공휴일의 이름만 — 날짜는 UI에서 입력받는다.
export const HUNG_KINGS_HOLIDAY_NAME = { ko: "흥왕기념일", vi: "Giỗ Tổ Hùng Vương" } as const;
export const TET_HOLIDAY_NAME = { ko: "음력설 연휴", vi: "Nghỉ Tết Nguyên Đán" } as const;
export const NATIONAL_DAY_ADJACENT_HOLIDAY_NAME = {
  ko: "국경일 추가 휴일",
  vi: "Nghỉ lễ Quốc khánh",
} as const;
