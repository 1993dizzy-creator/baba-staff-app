import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { countHolidayGroupSizes, isBabaPremiumHoliday } from "@/lib/store-settings/holidays-policy";

// 베트남 법정공휴일 1차 기반 — store_setting_versions와 완전히 분리된 독립 모듈이다.
// store_holidays(법정공휴일 원본, 절대 삭제하지 않음)와 store_holiday_operation_policies
// (BABA 내부 "매장 영업 + 200% 적용" 선택, 정책 row가 없으면 기본적으로 미적용) 두
// 테이블만 읽고 쓰며, 매장 운영시간/근태 설정 로직(server.ts)이나 payroll 계산에는
// 전혀 관여하지 않는다.
//
// store_holiday_calendars / store_set_holiday_tet_option_v1(202608080003)은 이전
// "음력설 날짜 묶음 선택" UX를 위한 것이었고, 이 파일은 더 이상 그것을 읽거나
// 호출하지 않는다 — 운영 DB에 이미 적용된 이력이라 테이블/RPC 자체는 남아있지만
// 활성 코드 경로에서는 완전히 빠졌다.
//
// 200% 적용 여부(effective)는 이 파일도, 관리자 UI(page.tsx)도 절대 각자 판정하지
// 않는다 — lib/store-settings/holidays-policy.ts의 순수 함수 하나만 쓴다(1일짜리는
// 자동 적용, 2일 이상 그룹은 실제 선택된 날짜만 적용).

export type StoreHolidayCalendar = {
  year: number;
  countryCode: string;
};

export type StoreHoliday = {
  id: number;
  holidayDate: string;
  holidayCode: string;
  nameKo: string;
  nameVi: string;
  holidayGroup: string;
  isPaidHoliday: boolean;
  isEmployerSelected: boolean;
  /** BABA 내부 운영 지침 배율 — 법정 지급률이 아니다. null이면 이 날짜에 대한 선택
   * row 자체가 없다는 뜻(2일 이상 그룹에서 미선택 상태). 1일짜리 공휴일은 이 값이
   * null이어도 holidays-policy.ts 판정상 자동으로 200% 적용된다. */
  internalPayMultiplier: number | null;
};

type CalendarRow = {
  year: number;
  country_code: string;
};

type PolicyEmbed = { internal_pay_multiplier: number } | { internal_pay_multiplier: number }[] | null;

type HolidayRow = {
  id: number;
  holiday_date: string;
  holiday_code: string;
  name_ko: string;
  name_vi: string;
  holiday_group: string;
  is_paid_holiday: boolean;
  is_employer_selected: boolean;
  store_holiday_operation_policies?: PolicyEmbed;
};

function mapCalendar(row: CalendarRow): StoreHolidayCalendar {
  return { year: Number(row.year), countryCode: row.country_code };
}

// PostgREST가 1:0..1 관계를 단일 객체로 임베드하든 배열로 임베드하든(카디널리티
// 감지 방식은 버전에 따라 달라질 수 있다) 항상 안전하게 처리한다.
function extractMultiplier(raw: PolicyEmbed | undefined): number | null {
  if (!raw) return null;
  const policy = Array.isArray(raw) ? raw[0] ?? null : raw;
  return policy ? Number(policy.internal_pay_multiplier) : null;
}

function mapHoliday(row: HolidayRow): StoreHoliday {
  return {
    id: Number(row.id),
    holidayDate: row.holiday_date,
    holidayCode: row.holiday_code,
    nameKo: row.name_ko,
    nameVi: row.name_vi,
    holidayGroup: row.holiday_group,
    isPaidHoliday: Boolean(row.is_paid_holiday),
    isEmployerSelected: Boolean(row.is_employer_selected),
    internalPayMultiplier: extractMultiplier(row.store_holiday_operation_policies),
  };
}

const HOLIDAY_COLUMNS =
  "id,holiday_date,holiday_code,name_ko,name_vi,holiday_group,is_paid_holiday,is_employer_selected";

// store_holidays를 store_holiday_operation_policies와 LEFT JOIN해 그 해 전체
// 법정공휴일을 반환한다(정책이 없는 날짜, 즉 200% 미적용 날짜도 그대로 포함) —
// loadHolidayCalendar(관리자 연도 조회)와 loadHolidaysForMonth(근태 월간 조회)가
// 공통으로 쓴다. 두 함수가 서로 다른 쿼리로 각자 필터링하면 판정이 어긋날 수
// 있으므로, effective 필터링은 항상 이 목록을 가져온 "다음" holidays-policy.ts로
// 한다.
async function loadYearHolidays(year: number): Promise<StoreHoliday[]> {
  const { data, error } = await supabaseServer
    .from("store_holidays")
    .select(`${HOLIDAY_COLUMNS},store_holiday_operation_policies(internal_pay_multiplier)`)
    .eq("calendar_year", year)
    .order("holiday_date", { ascending: true });
  if (error) throw new Error(`Failed to load holidays: ${error.message}`);
  return ((data ?? []) as HolidayRow[]).map(mapHoliday);
}

// /admin/settings/store 공휴일 탭 — 연도 단위 조회(owner/master/manager/leader).
// calendar가 null이면 그 연도가 아직 준비되지 않았다는 뜻이다(store_holidays는
// store_holiday_calendars(year)를 FK로 참조하므로 calendar가 없으면 holidays도
// 항상 빈 배열이다).
export async function loadHolidayCalendar(
  year: number
): Promise<{ calendar: StoreHolidayCalendar | null; holidays: StoreHoliday[] }> {
  const [calendarResult, holidays] = await Promise.all([
    supabaseServer.from("store_holiday_calendars").select("year,country_code").eq("year", year).maybeSingle(),
    loadYearHolidays(year),
  ]);
  if (calendarResult.error) throw new Error(`Failed to load holiday calendar: ${calendarResult.error.message}`);
  return {
    calendar: calendarResult.data ? mapCalendar(calendarResult.data as CalendarRow) : null,
    holidays,
  };
}

export type ToggleHolidayOperationPolicyResult =
  | { status: "ok"; holidayId: number; selected: boolean; internalPayMultiplier: number | null }
  | { status: "forbidden" | "not_found" | "invalid_request" };

// owner/master만 호출(route에서 canMutateStoreSettings로 먼저 걸러도, RPC 자체도
// actor role을 다시 확인한다 — store_schedule_settings_v1과 동일한 이중 방어).
// 날짜 1개씩 즉시 저장하는 UX다 — store_holidays 원본은 절대 지우지 않고, 이
// 테이블의 정책 row만 추가/삭제한다. 1일짜리 공휴일은 애초에 이 RPC를 호출할 UI
// 자체가 없다(자동 200%이므로 선택/해제 대상이 아니다).
export async function toggleHolidayOperationPolicy(
  holidayId: number,
  selected: boolean,
  actorUserId: number
): Promise<ToggleHolidayOperationPolicyResult> {
  const { data, error } = await supabaseServer.rpc("store_toggle_holiday_operation_policy_v1", {
    p_holiday_id: holidayId,
    p_selected: selected,
    p_actor_user_id: actorUserId,
  });
  if (error) throw new Error(`Failed to toggle holiday operation policy: ${error.message}`);
  const result = data as {
    status: string;
    holidayId?: number;
    selected?: boolean;
    internalPayMultiplier?: number | null;
  };
  if (result.status !== "ok") {
    return { status: result.status as "forbidden" | "not_found" | "invalid_request" };
  }
  return {
    status: "ok",
    holidayId: Number(result.holidayId),
    selected: Boolean(result.selected),
    internalPayMultiplier:
      result.internalPayMultiplier === null || result.internalPayMultiplier === undefined
        ? null
        : Number(result.internalPayMultiplier),
  };
}

// /attendance/holidays — 로그인한 정상 사용자 누구나 조회 가능한 가벼운 월간 읽기.
// 그 해 전체 공휴일을 가져온 뒤(그룹 크기를 알아야 판정할 수 있으므로) holidays-
// policy.ts의 공통 판정 함수로 "실제 200% 적용일"만 걸러내고, 마지막에 요청된
// 달로 좁힌다 — 클라이언트는 이 결과를 그대로 믿고 추가로 재판정하지 않는다.
export async function loadHolidaysForMonth(month: string): Promise<StoreHoliday[]> {
  const year = Number(month.slice(0, 4));
  const start = `${month}-01`;
  const next = new Date(`${start}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const endExclusive = next.toISOString().slice(0, 10);

  const yearHolidays = await loadYearHolidays(year);
  const groupSizes = countHolidayGroupSizes(yearHolidays);

  return yearHolidays.filter(
    (holiday) =>
      holiday.holidayDate >= start &&
      holiday.holidayDate < endExclusive &&
      isBabaPremiumHoliday(holiday, groupSizes.get(holiday.holidayGroup) ?? 0)
  );
}

export type PrepareHolidayCalendarInput = {
  year: number;
  hungKingsDate: string;
  tetDates: string[];
  nationalDayAdjacentDate: string;
  sourceUrl: string | null;
  sourcePublishedAt: string | null;
};

export type PrepareHolidayCalendarResult =
  | { status: "ok"; year: number }
  | {
      status:
        | "forbidden"
        | "invalid_year"
        | "year_already_exists"
        | "invalid_dates"
        | "invalid_national_day_adjacent";
    };

// 새 연도(예: 2027) 공휴일 원본을 코드/신규 seed Migration 없이 owner/master가
// 직접 만든다. 이미 존재하는 연도는 RPC가 절대 덮어쓰지 않고 year_already_exists를
// 반환한다 — store_holiday_operation_policies는 이 함수에서 전혀 생성하지 않는다
// (여러 날짜짜리 그룹은 준비 직후 전부 미선택 상태로 시작한다).
export async function prepareHolidayCalendar(
  input: PrepareHolidayCalendarInput,
  actorUserId: number
): Promise<PrepareHolidayCalendarResult> {
  const { data, error } = await supabaseServer.rpc("store_prepare_holiday_calendar_v1", {
    p_year: input.year,
    p_hung_kings_date: input.hungKingsDate,
    p_tet_dates: input.tetDates,
    p_national_day_adjacent_date: input.nationalDayAdjacentDate,
    p_source_url: input.sourceUrl,
    p_source_published_at: input.sourcePublishedAt,
    p_actor_user_id: actorUserId,
  });
  if (error) throw new Error(`Failed to prepare holiday calendar: ${error.message}`);
  const result = data as { status: string; year?: number };
  if (result.status !== "ok") {
    return {
      status: result.status as
        | "forbidden"
        | "invalid_year"
        | "year_already_exists"
        | "invalid_dates"
        | "invalid_national_day_adjacent",
    };
  }
  return { status: "ok", year: Number(result.year) };
}
