-- 다음 연도 베트남 법정공휴일을 코드 수정/신규 seed Migration 없이 owner/master가
-- 앱에서 직접 준비할 수 있게 하는 RPC를 추가한다.
--
-- 배경
--   지금까지는 새 연도 공휴일이 필요할 때마다(예: 2027년) 이번 Migration처럼 seed
--   Migration을 새로 작성해야 했다. 이 RPC 하나만 추가하면, 이후 연도는 관리자가
--   /admin/settings/store 공휴일 탭에서 직접 그 해 데이터를 만들 수 있다.
--
-- 무엇을 자동/입력으로 나누는가
--   자동(매년 같은 날짜, target year에 맞춰 계산만 함):
--     01/01 NEW_YEAR, 04/30 REUNIFICATION_DAY, 05/01 LABOR_DAY, 09/02 NATIONAL_DAY(고정).
--   관리자 입력(매년 날짜가 바뀜):
--     흥왕기념일(날짜 1개), 음력설 5일, 국경일 추가 휴일(target year-09-01 또는 -09-03 중 택1).
--   이름(name_ko/name_vi)은 2026 seed(202608080003)와 정확히 같은 문구를
--   리터럴로 재사용한다 — UI 미리보기용 동일 문구는
--   lib/store-settings/holidays-data.ts의 FIXED_HOLIDAY_DEFINITIONS /
--   HUNG_KINGS_HOLIDAY_NAME / TET_HOLIDAY_NAME / NATIONAL_DAY_ADJACENT_HOLIDAY_NAME에
--   있다 — SQL 함수가 TS 상수를 직접 import할 수 없어 리터럴을 중복 유지한다.
--   두 곳의 문구를 바꿀 때는 반드시 함께 바꾼다.
--
-- 202608080003/202608080004와의 관계 — 중요
--   이미 운영 반영된 두 Migration은 이번 변경에서 전혀 건드리지 않는다. 이 RPC는
--   store_holiday_calendars/store_holidays에 새 row를 추가만 할 뿐, 두 파일이
--   만든 테이블/컬럼/RPC/기존 데이터를 변경하지 않는다. store_toggle_holiday_
--   operation_policy_v1(202608080004)과 store_holiday_operation_policies 테이블도
--   이 RPC에서 전혀 건드리지 않는다 — 연도를 새로 준비한 직후에는 여러 날짜짜리
--   그룹(TET/NATIONAL_DAY)에 대해 아직 아무 날짜도 BABA 200%로 선택되지 않은
--   상태다(1일짜리 공휴일만 lib/store-settings/holidays-policy.ts의 판정 규칙에
--   따라 자동으로 200% 적용된다 — 별도 policy row가 필요 없다).
--
-- 과거 데이터 보호
--   이미 존재하는 연도(store_holiday_calendars에 해당 year row가 있음)는 절대
--   덮어쓰지 않는다 — preflight에서 존재 여부를 먼저 확인하고, 있으면
--   'year_already_exists'를 반환할 뿐 어떤 insert/update도 실행하지 않는다.
--   다른 연도의 데이터는 이 함수가 아예 참조하지 않으므로 손댈 수 없다.
--
-- status/tet_option/confirmed_by/confirmed_at 컬럼
--   202608080004에서 이미 "묶음 선택 확정" UX 자체를 폐기했다고 기록했다. 이 RPC가
--   새로 만드는 연도 row도 그 폐기된 개념을 다시 쓰지 않는다 — status는 항상
--   'draft'로 남기고 confirmed_by/confirmed_at/tet_option은 채우지 않는다(테이블의
--   CHECK 제약은 draft일 때 confirmed_by/confirmed_at이 둘 다 null이기만 하면 되므로
--   문제없다). national_day_adjacent_date/source_url/source_published_at은 실제로
--   쓰는 메타데이터라 이 RPC가 정상적으로 채운다.

begin;

-- ---------------------------------------------------------------------------
-- 0. Preflight
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.store_holiday_calendars') is null
    or to_regclass('public.store_holidays') is null
  then
    raise exception 'preflight failed: missing dependency store_holiday_calendars/store_holidays';
  end if;
  if to_regclass('public.users') is null then
    raise exception 'preflight failed: missing dependency public.users';
  end if;
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'store_prepare_holiday_calendar_v1'
  ) then
    raise exception 'preflight failed: store_prepare_holiday_calendar_v1 already exists';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. store_prepare_holiday_calendar_v1 — 새 연도 하나를 한 트랜잭션으로 생성한다.
--    이미 존재하는 연도는 절대 건드리지 않고 'year_already_exists'만 반환한다.
--    store_holiday_operation_policies는 생성하지 않는다.
-- ---------------------------------------------------------------------------

create function public.store_prepare_holiday_calendar_v1(
  p_year integer,
  p_hung_kings_date date,
  p_tet_dates date[],
  p_national_day_adjacent_date date,
  p_source_url text,
  p_source_published_at date,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_new_year_date date;
  v_reunification_date date;
  v_labor_date date;
  v_national_day_date date;
  v_all_dates date[];
  v_date date;
begin
  perform pg_advisory_xact_lock(hashtext('store_holiday_calendar_prep_v1:' || p_year::text));

  select role::text into v_role
  from public.users
  where id = p_actor_user_id and is_active = true;

  if lower(coalesce(v_role, '')) not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;

  if p_year is null or p_year not between 2020 and 2100 then
    return jsonb_build_object('status', 'invalid_year');
  end if;

  -- 이미 존재하는 연도는 절대 덮어쓰지 않는다 — 여기서 끝낸다.
  if exists (select 1 from public.store_holiday_calendars where year = p_year) then
    return jsonb_build_object('status', 'year_already_exists');
  end if;

  v_new_year_date := make_date(p_year, 1, 1);
  v_reunification_date := make_date(p_year, 4, 30);
  v_labor_date := make_date(p_year, 5, 1);
  v_national_day_date := make_date(p_year, 9, 2);

  if p_national_day_adjacent_date is distinct from make_date(p_year, 9, 1)
    and p_national_day_adjacent_date is distinct from make_date(p_year, 9, 3)
  then
    return jsonb_build_object('status', 'invalid_national_day_adjacent');
  end if;

  if p_hung_kings_date is null or extract(year from p_hung_kings_date)::integer <> p_year then
    return jsonb_build_object('status', 'invalid_dates');
  end if;

  if p_tet_dates is null or array_length(p_tet_dates, 1) <> 5 then
    return jsonb_build_object('status', 'invalid_dates');
  end if;

  foreach v_date in array p_tet_dates loop
    if v_date is null or extract(year from v_date)::integer <> p_year then
      return jsonb_build_object('status', 'invalid_dates');
    end if;
  end loop;

  -- 국경일 고정일(9/2)과 추가 휴일, 흥왕기념일, 음력설 5일, 나머지 고정 공휴일까지
  -- 전부 합쳐 날짜 중복이 없는지 한 번에 확인한다(다른 code끼리도 같은 날짜면 거부).
  v_all_dates := array[
    v_new_year_date, p_hung_kings_date, v_reunification_date, v_labor_date,
    v_national_day_date, p_national_day_adjacent_date
  ] || p_tet_dates;

  if array_length(v_all_dates, 1) <> (select count(distinct d) from unnest(v_all_dates) d) then
    return jsonb_build_object('status', 'invalid_dates');
  end if;

  insert into public.store_holiday_calendars (
    year, country_code, status, national_day_adjacent_date, source_url, source_published_at,
    created_source, created_by, updated_by, updated_at
  )
  values (
    p_year, 'VN', 'draft', p_national_day_adjacent_date, p_source_url, p_source_published_at,
    'manual', p_actor_user_id, p_actor_user_id, now()
  );

  insert into public.store_holidays (
    calendar_year, holiday_date, holiday_code, name_ko, name_vi, holiday_group,
    is_paid_holiday, is_employer_selected
  )
  values
    (p_year, v_new_year_date, 'NEW_YEAR', '신정', 'Tết Dương lịch', 'NEW_YEAR', true, false),
    (p_year, p_hung_kings_date, 'HUNG_KINGS', '흥왕기념일', 'Giỗ Tổ Hùng Vương', 'HUNG_KINGS', true, false),
    (p_year, v_reunification_date, 'REUNIFICATION_DAY', '통일기념일', 'Ngày Giải phóng miền Nam, thống nhất đất nước', 'REUNIFICATION_DAY', true, false),
    (p_year, v_labor_date, 'LABOR_DAY', '노동절', 'Ngày Quốc tế Lao động', 'LABOR_DAY', true, false),
    (p_year, v_national_day_date, 'NATIONAL_DAY', '베트남 국경일', 'Quốc khánh Việt Nam', 'NATIONAL_DAY', true, false),
    (p_year, p_national_day_adjacent_date, 'NATIONAL_DAY', '국경일 추가 휴일', 'Nghỉ lễ Quốc khánh', 'NATIONAL_DAY', true, true);

  insert into public.store_holidays (
    calendar_year, holiday_date, holiday_code, name_ko, name_vi, holiday_group,
    is_paid_holiday, is_employer_selected
  )
  select p_year, d, 'TET', '음력설 연휴', 'Nghỉ Tết Nguyên Đán', 'TET', true, false
  from unnest(p_tet_dates) d;

  return jsonb_build_object('status', 'ok', 'year', p_year);
exception
  when check_violation or unique_violation or not_null_violation then
    return jsonb_build_object('status', 'invalid_dates');
end
$$;

revoke all on function public.store_prepare_holiday_calendar_v1(integer, date, date[], date, text, date, bigint) from public;
revoke all on function public.store_prepare_holiday_calendar_v1(integer, date, date[], date, text, date, bigint) from anon;
revoke all on function public.store_prepare_holiday_calendar_v1(integer, date, date[], date, text, date, bigint) from authenticated;
grant execute on function public.store_prepare_holiday_calendar_v1(integer, date, date[], date, text, date, bigint) to service_role;

comment on function public.store_prepare_holiday_calendar_v1(integer, date, date[], date, text, date, bigint) is
  'Creates one new year of Vietnam statutory holiday source data (store_holiday_calendars + store_holidays) in a single transaction, owner/master only. Never overwrites an existing year (returns year_already_exists instead). Never creates store_holiday_operation_policies rows — multi-day groups (TET/NATIONAL_DAY) start fully unselected for the BABA-internal 200% policy; single-day holidays are automatically effective per lib/store-settings/holidays-policy.ts without needing a policy row.';

-- ---------------------------------------------------------------------------
-- 2. Postflight — 이 Migration 자체는 어떤 연도도 새로 만들지 않는다(RPC 정의만
--    추가). 함수가 정확히 한 번만 존재하는지만 재확인한다.
-- ---------------------------------------------------------------------------
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'store_prepare_holiday_calendar_v1';

  if v_count <> 1 then
    raise exception 'postflight failed: expected exactly 1 store_prepare_holiday_calendar_v1 function, found %', v_count;
  end if;
end
$$;

commit;
