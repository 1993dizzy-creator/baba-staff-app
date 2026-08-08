-- 베트남 법정공휴일 관리 1차 기반.
--
-- 목적
--   /admin/settings/store에 "공휴일" 탭을 추가하고, /attendance/leave 월간 캘린더에
--   해당 월 법정공휴일을 표시하기 위한 독립 원본 데이터를 만든다.
--
-- 설계 원칙(중요)
--   공휴일은 store_setting_versions에 절대 합치지 않는다. store_setting_versions는
--   "특정 영업일부터 적용되는 매장 설정 버전"이고, 공휴일은 "연도별 실제 날짜 목록"이라
--   생명주기가 완전히 다르다. 그래서 이번 Migration은 새 테이블 2개와 새 RPC 1개만
--   추가하고, 기존 store_setting_versions/store_business_hours/store_attendance_policies/
--   store_get_settings_overview_v1/store_schedule_settings_v1은 전혀 건드리지 않는다.
--
--   공휴일 데이터는 attendance_records/직원 휴무 신청과 FK로 연결하지 않는다 —
--   "이 날짜는 베트남 법정공휴일이다"라는 매장 전체 공통 정보일 뿐, 매장 자동 휴점·
--   직원 자동 휴무·attendance status 자동 leave·급여 자동 가산·휴무 신청 자동 승인
--   중 어떤 의미도 갖지 않는다. 급여 계산·공휴일 근무수당 연결은 이번 단계에서 하지
--   않는다(1차 기반 전용).
--
--   흥왕기념일(2026-04-26, 일요일)처럼 법정공휴일이 주말과 겹쳐도 보상휴일을 자동
--   생성하지 않는다 — BABA 직원은 월~금 고정근무가 아니므로 대체공휴일 판단은 향후
--   근무 스케줄 정책과 함께 별도로 다룬다.
--
-- 테이블 구조
--   store_holiday_calendars — 연도 단위 관리/확정 정보. status는 그 해 사업주가 반드시
--     결정해야 하는 핵심 선택사항(tet_option, national_day_adjacent_date) 둘 다 채워졌을
--     때만 'confirmed'다 — RPC(store_set_holiday_tet_option_v1)가 매 호출마다 두 값을
--     함께 재계산하며, 클라이언트가 status를 임의로 지정하지 않는다. 별도 "확정" 버튼도
--     없다(1차 확정 UX 최소화) — 마지막 남은 선택을 채우는 행위 자체가 confirmed 전환이다.
--     draft는 "그 해 사업주 선택 항목이 아직 모두 완료되지 않음"만 의미하며, "그 해
--     공휴일 데이터가 전부 미확정/숨김"을 의미하지 않는다 — 이미 store_holidays에
--     존재하는 행(예: 신정·노동절처럼 사업주 선택이 필요 없는 고정 공휴일)은 calendar가
--     draft여도 /attendance/leave에 정상 표시된다(아래 "직원 read" 절 참고).
--   store_holidays — 실제 달력에 표시되는 날짜 원본. holiday_group/holiday_code는 향후
--     "정부 공식 발표 → candidate → 관리자 검토 → confirmed" 흐름에서 새 종류가 늘어날
--     수 있으므로 CHECK로 닫아두지 않는다(1차에서 실제로 쓰는 값은 주석으로 남긴다).
--
-- 직원 read(/api/attendance/holidays)
--   store_holidays에 실제 행으로 존재하는 날짜는 그 해 calendar.status가 draft여도
--   그대로 반환·표시한다 — calendar.status로 다시 거르지 않는다. 음력설은 관리자가
--   옵션을 고르기 전까지 애초에 행 자체가 없으므로, 이 규칙만으로 자연스럽게
--   "선택 전에는 표시되지 않고, 선택하면 표시된다"가 성립한다.
--
-- 음력설(Tết) 처리
--   2026년 음력설 5일은 BABA 선택이 아직 확정되지 않아 이번 Migration에서 confirmed
--   데이터로 심지 않는다. 실제 날짜 3개 옵션은 application 레이어
--   (lib/store-settings/holidays-data.ts)에 등록해 두고, 관리자가 옵션을 고르면
--   store_set_holiday_tet_option_v1이 그 날짜들을 한 트랜잭션으로 반영한다 — 음력
--   변환 로직을 SQL에 넣지 않고, 연도별 실제 날짜는 항상 application 레이어의 표에서
--   가져온다(새 연도가 필요하면 그 표에 항목만 추가하면 된다).
--
-- 2026 고정 확정 데이터(이번 Migration에서 seed)
--   01/01 NEW_YEAR, 04/26 HUNG_KINGS, 04/30 REUNIFICATION_DAY, 05/01 LABOR_DAY,
--   09/01·09/02 NATIONAL_DAY(BABA 선택: 9/2 국경일 + 전날 9/1 추가 휴일 —
--   national_day_adjacent_date='2026-09-01'로 함께 seed).
--   음력설은 seed하지 않는다(관리자 선택 대기, status='draft' — national day는 이미
--   채워져 있으므로 Tet 선택 즉시 confirmed로 전환된다).
--
-- created_by / created_source
--   이 Migration이 만드는 2026 bootstrap 데이터는 특정 owner가 수동으로 만든 것이
--   아니다 — 감사 기록을 거짓으로 만들지 않기 위해 created_by를 임의의 owner id에
--   귀속시키지 않는다. 대신 created_by를 nullable로 두고 created_source
--   ('system_seed' | 'manual')로 출처를 구분한다: system seed는
--   created_source='system_seed', created_by=null이고, 이후 관리자가
--   store_set_holiday_tet_option_v1을 실제로 호출해 만든 새 연도 row만
--   created_source='manual', created_by=실제 actor.id를 갖는다. 이미 존재하는(seed된)
--   연도 row에 대해 관리자가 이 RPC로 Tet을 선택해도 created_by/created_source는
--   최초 생성 시점의 값을 그대로 유지한다(그 행을 "누가 만들었는가"는 불변 사실이고,
--   "누가 마지막으로 바꿨는가"는 updated_by/updated_at이 별도로 기록한다).

begin;

-- ---------------------------------------------------------------------------
-- 0. Preflight — 의존 객체가 이미 존재하는지 확인
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.users') is null then
    raise exception 'preflight failed: missing dependency public.users';
  end if;
  if to_regclass('public.store_holiday_calendars') is not null
    or to_regclass('public.store_holidays') is not null
  then
    raise exception 'preflight failed: store_holiday_calendars/store_holidays already exist';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. store_holiday_calendars — 연도 단위 관리/확정 정보
-- ---------------------------------------------------------------------------

create table public.store_holiday_calendars (
  year integer primary key,
  country_code text not null default 'VN',
  status text not null default 'draft',
  -- 3개 값만 존재하는 닫힌 도메인(베트남 노동법 상 음력설 배치 패턴)이라 CHECK로 고정한다.
  tet_option text null,
  -- 국경일(9/2) 인접 선택일 — 2026은 9/1(전날). 향후 다른 연도에 9/2+다음날 선택도
  -- 지원할 수 있도록 실제 국경일 자체가 아니라 "추가로 붙인 인접일"만 기록한다.
  national_day_adjacent_date date null,
  source_url text null,
  source_published_at date null,
  confirmed_by bigint null references public.users(id) on delete restrict,
  confirmed_at timestamptz null,
  -- system seed(이 Migration이 만드는 bootstrap 데이터)는 특정 owner가 수동으로 만든
  -- 것이 아니므로 created_by를 임의의 owner id에 귀속시키지 않는다 — nullable로 두고
  -- created_source로 출처를 구분한다.
  created_by bigint null references public.users(id) on delete restrict,
  created_source text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_by bigint null references public.users(id) on delete restrict,
  updated_at timestamptz null,
  constraint store_holiday_calendars_year_check check (year between 2020 and 2100),
  constraint store_holiday_calendars_status_check check (status in ('draft', 'confirmed')),
  constraint store_holiday_calendars_tet_option_check check (
    tet_option is null
    or tet_option in ('one_before_four_after', 'two_before_three_after', 'three_before_two_after')
  ),
  -- confirmed면 누가/언제 확정했는지 반드시 남는다(draft는 둘 다 null).
  constraint store_holiday_calendars_confirmed_pair_check check (
    (status = 'draft' and confirmed_by is null and confirmed_at is null)
    or (status = 'confirmed' and confirmed_by is not null and confirmed_at is not null)
  ),
  -- system_seed는 created_by가 반드시 null(임의 owner 귀속 금지), manual은 반드시
  -- 실제 actor id를 갖는다.
  constraint store_holiday_calendars_created_source_check check (
    created_source in ('manual', 'system_seed')
    and (
      (created_source = 'system_seed' and created_by is null)
      or (created_source = 'manual' and created_by is not null)
    )
  )
);

alter table public.store_holiday_calendars enable row level security;

revoke all on table public.store_holiday_calendars from public, anon, authenticated, service_role;
grant select, insert, update on table public.store_holiday_calendars to service_role;

comment on table public.store_holiday_calendars is
  'Vietnam statutory holiday calendar, per year. Independent of store_setting_versions (different lifecycle: dated versions vs. yearly calendar dates). status is derived by store_set_holiday_tet_option_v1 and requires BOTH tet_option and national_day_adjacent_date to be non-null (confirmed only once every core yearly choice is made) — not a manual confirm workflow in phase 1. created_by is null for system-seeded years (created_source=''system_seed''); only rows actually created by an admin via the RPC (created_source=''manual'') carry a real actor id.';

-- ---------------------------------------------------------------------------
-- 2. store_holidays — 실제 달력에 표시되는 날짜 원본
-- ---------------------------------------------------------------------------

create table public.store_holidays (
  id bigint generated by default as identity primary key,
  calendar_year integer not null references public.store_holiday_calendars(year) on delete cascade,
  holiday_date date not null,
  -- 1차에서 실제로 쓰는 값: NEW_YEAR / TET / HUNG_KINGS / REUNIFICATION_DAY /
  -- LABOR_DAY / NATIONAL_DAY. 향후 정부 발표 반영 시 새 코드가 늘어날 수 있어
  -- CHECK로 닫아두지 않는다(holiday_group도 동일한 이유로 열어 둔다).
  holiday_code text not null,
  name_ko text not null,
  name_vi text not null,
  holiday_group text not null,
  is_paid_holiday boolean not null default true,
  -- 관리자가 "추가로 선택"한 인접일인지 여부(예: 2026-09-01) — 법정 고정일(9/2)은 false.
  is_employer_selected boolean not null default false,
  created_at timestamptz not null default now(),
  constraint store_holidays_unique unique (calendar_year, holiday_date, holiday_code)
);

create index store_holidays_year_date_idx
  on public.store_holidays (calendar_year, holiday_date);

alter table public.store_holidays enable row level security;

revoke all on table public.store_holidays from public, anon, authenticated, service_role;
revoke all on sequence public.store_holidays_id_seq from public, anon, authenticated, service_role;
grant select, insert, delete on table public.store_holidays to service_role;
grant usage, select on sequence public.store_holidays_id_seq to service_role;

comment on table public.store_holidays is
  'Individual Vietnam statutory holiday dates, sourced independently of attendance_records/employee leave requests. A holiday row means only "this date is a Vietnam statutory holiday" — it never implies store closure, automatic employee leave, automatic attendance status change, automatic payroll addition, or automatic leave-request approval. Payroll/holiday-pay integration is intentionally not connected in this phase.';

-- ---------------------------------------------------------------------------
-- 3. store_set_holiday_tet_option_v1 — 음력설 5일 선택을 한 트랜잭션으로 반영.
--    p_holiday_dates는 application 레이어(lib/store-settings/holidays-data.ts)의
--    연도별 표에서 서버가 미리 계산해 넘기는 신뢰된 값이다 — 이 함수 자체는 날짜
--    5개를 그대로 저장/치환할 뿐 음력 변환을 하지 않는다.
-- ---------------------------------------------------------------------------

create function public.store_set_holiday_tet_option_v1(
  p_year integer,
  p_tet_option text,
  p_holiday_dates date[],
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_date date;
begin
  perform pg_advisory_xact_lock(hashtext('store_holiday_calendar_v1:' || p_year::text));

  select role::text into v_role
  from public.users
  where id = p_actor_user_id and is_active = true;

  if lower(coalesce(v_role, '')) not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;

  if p_year is null or p_year not between 2020 and 2100 then
    return jsonb_build_object('status', 'invalid_year');
  end if;

  if p_tet_option not in ('one_before_four_after', 'two_before_three_after', 'three_before_two_after') then
    return jsonb_build_object('status', 'invalid_option');
  end if;

  if p_holiday_dates is null
    or array_length(p_holiday_dates, 1) <> 5
    or array_length(p_holiday_dates, 1) <> (select count(distinct d) from unnest(p_holiday_dates) d)
  then
    return jsonb_build_object('status', 'invalid_dates');
  end if;

  foreach v_date in array p_holiday_dates loop
    if extract(year from v_date)::integer <> p_year then
      return jsonb_build_object('status', 'invalid_dates');
    end if;
  end loop;

  -- 1) 연도 row가 없으면 bootstrap한다(예: 아직 seed되지 않은 미래 연도). 이 RPC는
  --    실제 관리자 행동이므로 새로 만드는 row는 항상 created_source='manual' +
  --    created_by=실제 actor다. 이미 존재하는(예: 2026 system seed) row는 on conflict
  --    분기에서 tet_option/updated_*만 갱신하고 created_by/created_source는 절대
  --    건드리지 않는다 — "누가 만들었는가"라는 이력을 사후에 덮어쓰지 않는다.
  insert into public.store_holiday_calendars (
    year, country_code, status, tet_option, created_source,
    created_by, updated_by, updated_at
  )
  values (
    p_year, 'VN', 'draft', p_tet_option, 'manual',
    p_actor_user_id, p_actor_user_id, now()
  )
  on conflict (year) do update set
    tet_option = excluded.tet_option,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  -- 2) confirmed는 그 해 핵심 선택사항(tet_option + national_day_adjacent_date) 둘 다
  --    채워졌을 때만 — 이 RPC는 national_day_adjacent_date를 직접 건드리지 않으므로,
  --    새로 bootstrap된 연도는 그 값이 항상 null이라 자연히 draft로 남는다. 이미
  --    national_day_adjacent_date가 채워진 연도(예: 2026 seed)만 tet_option을
  --    채우는 즉시 confirmed로 전환된다. 클라이언트는 status를 절대 직접 지정하지
  --    않는다 — 여기서 서버가 매 호출마다 다시 계산한다.
  update public.store_holiday_calendars
  set
    status = case
      when tet_option is not null and national_day_adjacent_date is not null then 'confirmed'
      else 'draft'
    end,
    confirmed_by = case
      when tet_option is not null and national_day_adjacent_date is not null then p_actor_user_id
      else null
    end,
    confirmed_at = case
      when tet_option is not null and national_day_adjacent_date is not null then now()
      else null
    end
  where year = p_year;

  delete from public.store_holidays
  where calendar_year = p_year and holiday_group = 'TET';

  insert into public.store_holidays (
    calendar_year, holiday_date, holiday_code, name_ko, name_vi, holiday_group,
    is_paid_holiday, is_employer_selected
  )
  select p_year, d, 'TET', '음력설 연휴', 'Nghỉ Tết Nguyên Đán', 'TET', true, false
  from unnest(p_holiday_dates) d;

  return jsonb_build_object(
    'status', 'ok',
    'calendar', (
      select jsonb_build_object(
        'year', c.year,
        'countryCode', c.country_code,
        'status', c.status,
        'tetOption', c.tet_option,
        'nationalDayAdjacentDate', to_char(c.national_day_adjacent_date, 'YYYY-MM-DD'),
        'confirmedBy', c.confirmed_by,
        'confirmedAt', c.confirmed_at,
        'createdBy', c.created_by,
        'createdSource', c.created_source,
        'updatedBy', c.updated_by,
        'updatedAt', c.updated_at
      )
      from public.store_holiday_calendars c
      where c.year = p_year
    ),
    'holidays', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', h.id,
        'holidayDate', to_char(h.holiday_date, 'YYYY-MM-DD'),
        'holidayCode', h.holiday_code,
        'nameKo', h.name_ko,
        'nameVi', h.name_vi,
        'holidayGroup', h.holiday_group,
        'isPaidHoliday', h.is_paid_holiday,
        'isEmployerSelected', h.is_employer_selected
      ) order by h.holiday_date), '[]'::jsonb)
      from public.store_holidays h
      where h.calendar_year = p_year
    )
  );
exception
  when check_violation or unique_violation or not_null_violation then
    return jsonb_build_object('status', 'invalid_dates');
end
$$;

revoke all on function public.store_set_holiday_tet_option_v1(integer, text, date[], bigint) from public;
revoke all on function public.store_set_holiday_tet_option_v1(integer, text, date[], bigint) from anon;
revoke all on function public.store_set_holiday_tet_option_v1(integer, text, date[], bigint) from authenticated;
grant execute on function public.store_set_holiday_tet_option_v1(integer, text, date[], bigint) to service_role;

-- ---------------------------------------------------------------------------
-- 4. 2026 고정 확정 데이터 seed — 음력설은 제외(status='draft'로 남긴다).
--    이 데이터는 특정 owner가 수동으로 만든 것이 아니므로 created_by를 임의의
--    owner id에 귀속시키지 않는다 — created_source='system_seed', created_by=null.
--    national_day_adjacent_date는 BABA가 이미 확정한 9/1(9/2 국경일의 전날)을
--    함께 심어 둔다 — Tet만 선택되면 이 값이 이미 있으므로 즉시 confirmed로
--    전환된다(RPC의 confirmed 판정 로직 참고).
-- ---------------------------------------------------------------------------

do $$
begin
  insert into public.store_holiday_calendars (
    year, country_code, status, tet_option, national_day_adjacent_date,
    created_source, created_by
  )
  values (
    2026, 'VN', 'draft', null, date '2026-09-01',
    'system_seed', null
  )
  on conflict (year) do nothing;

  insert into public.store_holidays (
    calendar_year, holiday_date, holiday_code, name_ko, name_vi, holiday_group,
    is_paid_holiday, is_employer_selected
  )
  values
    (2026, date '2026-01-01', 'NEW_YEAR', '신정', 'Tết Dương lịch', 'NEW_YEAR', true, false),
    (2026, date '2026-04-26', 'HUNG_KINGS', '흥왕기념일', 'Giỗ Tổ Hùng Vương', 'HUNG_KINGS', true, false),
    (2026, date '2026-04-30', 'REUNIFICATION_DAY', '통일기념일', 'Ngày Giải phóng miền Nam, thống nhất đất nước', 'REUNIFICATION_DAY', true, false),
    (2026, date '2026-05-01', 'LABOR_DAY', '노동절', 'Ngày Quốc tế Lao động', 'LABOR_DAY', true, false),
    (2026, date '2026-09-01', 'NATIONAL_DAY', '국경일 추가 휴일', 'Nghỉ lễ Quốc khánh', 'NATIONAL_DAY', true, true),
    (2026, date '2026-09-02', 'NATIONAL_DAY', '베트남 국경일', 'Quốc khánh Việt Nam', 'NATIONAL_DAY', true, false)
  on conflict (calendar_year, holiday_date, holiday_code) do nothing;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Postflight — 핵심 불변식 재확인
-- ---------------------------------------------------------------------------
do $$
begin
  if (select count(*) from public.store_holidays where calendar_year = 2026) <> 6 then
    raise exception 'postflight failed: expected exactly 6 seeded 2026 holiday rows (excluding Tet)';
  end if;
  if (select status from public.store_holiday_calendars where year = 2026) <> 'draft' then
    raise exception 'postflight failed: 2026 calendar must remain draft until Tet is chosen';
  end if;
  if exists (select 1 from public.store_holidays where calendar_year = 2026 and holiday_group = 'TET') then
    raise exception 'postflight failed: Tet rows must not be seeded as confirmed data';
  end if;
  if (select national_day_adjacent_date from public.store_holiday_calendars where year = 2026) <> date '2026-09-01' then
    raise exception 'postflight failed: 2026 national_day_adjacent_date must be seeded as 2026-09-01';
  end if;
  if exists (
    select 1 from public.store_holiday_calendars
    where year = 2026 and (created_source <> 'system_seed' or created_by is not null)
  ) then
    raise exception 'postflight failed: 2026 calendar row must be created_source=system_seed with created_by null (no arbitrary owner attribution)';
  end if;
end
$$;

commit;
