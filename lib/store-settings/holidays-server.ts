import "server-only";

import { supabaseServer } from "@/lib/supabase/server";

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
  /** BABA 내부 운영 지침 배율 — 법정 지급률이 아니다. null이면 200% 미적용. */
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

// /admin/settings/store 공휴일 탭 — 연도 단위 조회(owner/master/manager/leader).
// store_holidays를 store_holiday_operation_policies와 LEFT JOIN해 정책이 없는
// 날짜(200% 미적용)도 그대로 포함한 전체 법정공휴일 목록을 반환한다.
export async function loadHolidayCalendar(
  year: number
): Promise<{ calendar: StoreHolidayCalendar | null; holidays: StoreHoliday[] }> {
  const [calendarResult, holidaysResult] = await Promise.all([
    supabaseServer.from("store_holiday_calendars").select("year,country_code").eq("year", year).maybeSingle(),
    supabaseServer
      .from("store_holidays")
      .select(`${HOLIDAY_COLUMNS},store_holiday_operation_policies(internal_pay_multiplier)`)
      .eq("calendar_year", year)
      .order("holiday_date", { ascending: true }),
  ]);
  if (calendarResult.error) throw new Error(`Failed to load holiday calendar: ${calendarResult.error.message}`);
  if (holidaysResult.error) throw new Error(`Failed to load holidays: ${holidaysResult.error.message}`);
  return {
    calendar: calendarResult.data ? mapCalendar(calendarResult.data as CalendarRow) : null,
    holidays: ((holidaysResult.data ?? []) as HolidayRow[]).map(mapHoliday),
  };
}

export type ToggleHolidayOperationPolicyResult =
  | { status: "ok"; holidayId: number; selected: boolean; internalPayMultiplier: number | null }
  | { status: "forbidden" | "not_found" | "invalid_request" };

// owner/master만 호출(route에서 canMutateStoreSettings로 먼저 걸러도, RPC 자체도
// actor role을 다시 확인한다 — store_schedule_settings_v1과 동일한 이중 방어).
// 날짜 1개씩 즉시 저장하는 UX다 — store_holidays 원본은 절대 지우지 않고, 이
// 테이블의 정책 row만 추가/삭제한다.
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
// store_holidays를 store_holiday_operation_policies와 INNER JOIN해, BABA가 실제
// "매장 영업 + 200% 적용"으로 선택한 날짜만 서버 단계에서 걸러 반환한다 — 법정
// 공휴일 전체를 클라이언트로 보낸 뒤 필터링하지 않는다.
export async function loadHolidaysForMonth(month: string): Promise<StoreHoliday[]> {
  const start = `${month}-01`;
  const next = new Date(`${start}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const endExclusive = next.toISOString().slice(0, 10);
  const year = Number(month.slice(0, 4));

  const { data, error } = await supabaseServer
    .from("store_holidays")
    .select(`${HOLIDAY_COLUMNS},store_holiday_operation_policies!inner(internal_pay_multiplier)`)
    .eq("calendar_year", year)
    .gte("holiday_date", start)
    .lt("holiday_date", endExclusive)
    .order("holiday_date", { ascending: true });
  if (error) throw new Error(`Failed to load holidays for month: ${error.message}`);
  return ((data ?? []) as HolidayRow[]).map(mapHoliday);
}
