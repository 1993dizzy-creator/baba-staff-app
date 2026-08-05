-- 급여 대상, 근태 대상, 앱 로그인 가능 여부를 서로 독립적으로 관리하기 위한 컬럼과
-- RPC를 추가한다. 청소·설거지(근태 사용, 로그인 사용)와 프리랜서 회계·마케팅(근태 미사용,
-- 로그인 최초 미사용) 4명을 안전하게 등록할 수 있는 토대만 만든다 — 이 Migration은 실제
-- 직원·계약·schedule을 생성하지 않는다.
--
-- 기존 RPC(employee_create_with_schedule_v1/v3, employee_update_profile_and_level_v2/
-- v3/v4/v5/v6)는 그대로 두고 삭제하지 않는다. 새 조건부 schedule 처리가 필요한 지점만
-- 새 버전(v4/v5, v7/v8/v9)으로 분리해 기존 호출자와의 롤백 호환성을 유지한다.

begin;

-- ---------------------------------------------------------------------------
-- 1. 신규 컬럼
-- ---------------------------------------------------------------------------

alter table public.users
  add column if not exists attendance_tracking_enabled boolean not null default true,
  add column if not exists app_login_enabled boolean not null default true;

comment on column public.users.attendance_tracking_enabled is
  '근태(출퇴근·휴무 신청) 신규 처리 대상 여부. false여도 과거 근태 기록·schedule 이력은 보존되며 열린 기록의 퇴근·보정·취소는 계속 허용된다. 현재 상태값이며 이력형 컬럼으로 확장하지 않는다.';
comment on column public.users.app_login_enabled is
  '앱 로그인 허용 여부. is_active는 재직/활성 상태를, 이 컬럼은 로그인 가능 여부만 담당한다. false면 로그인 API가 거부하고, 이미 발급된 서버 세션도 다음 API 요청부터 RELOGIN_REQUIRED로 차단된다.';

-- 두 컬럼 모두 not null default true이므로 ALTER TABLE 시점에 기존 행 전체가 자동으로
-- true를 갖는다(별도 backfill UPDATE 불필요) — 기존 직원·오너/마스터 계정·POS 시스템
-- 계정 모두 이번 Migration 적용 직후에는 동작 변화가 없다.

-- ---------------------------------------------------------------------------
-- 2. 무결성 제약 (NOT VALID로 추가 — 기존 데이터 검증은 별도로 수행)
-- ---------------------------------------------------------------------------
-- 이 세션에는 운영 DB 조회 도구가 없어 기존 행 중 attendance_tracking_enabled=true
-- (=신규 컬럼 기본값)이면서 work_start_time 또는 work_end_time이 null인 행이 있는지
-- 확인하지 못했다. 특히 POS 시스템 계정은 employee_create_with_schedule_v1 RPC를 거치지
-- 않고 만들어진 것으로 보여(202607280001 Migration에서 사후 UPDATE로 is_system_account만
-- 표시) work_start_time/work_end_time이 애초에 없을 가능성이 있다.
--
-- 그래서 이 제약은 NOT VALID로만 추가한다: 앞으로의 모든 INSERT/UPDATE에는 즉시
-- 적용되지만, 기존 행을 즉시 스캔해 실패시키지 않는다. 아래 VALIDATE CONSTRAINT는
-- 운영 적용 담당자가 먼저
--   select id, username, is_system_account, attendance_tracking_enabled,
--          work_start_time, work_end_time
--   from public.users
--   where attendance_tracking_enabled = true
--     and (work_start_time is null or work_end_time is null);
-- 로 위반 행이 없는지 확인한 뒤(있다면 attendance_tracking_enabled를 false로 바꾸거나
-- 근무시간을 채운 뒤) 별도로 실행해야 한다.

alter table public.users
  drop constraint if exists users_attendance_tracking_requires_work_time;
alter table public.users
  add constraint users_attendance_tracking_requires_work_time
  check (
    attendance_tracking_enabled = false
    or (work_start_time is not null and work_end_time is not null)
  ) not valid;

-- alter table public.users validate constraint users_attendance_tracking_requires_work_time;

-- ---------------------------------------------------------------------------
-- 3. 신규 직원 생성 RPC — 조건부 schedule 생성
-- ---------------------------------------------------------------------------
-- employee_create_with_schedule_v1(하위)을 대체하는 v4: attendance_tracking_enabled가
-- false면 근무시간을 요구하지 않고 employee_work_schedule_versions도 만들지 않는다.
-- true면 기존 v1과 동일하게 근무시간을 필수로 요구하고 revision 1을 생성한다.

create or replace function public.employee_create_with_schedule_v4(
  p_employee jsonb,
  p_actor_id bigint,
  p_actor_username text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.users%rowtype;
  v_created public.users%rowtype;
  v_attendance_tracking_enabled boolean :=
    coalesce((p_employee ->> 'attendance_tracking_enabled')::boolean, true);
  v_app_login_enabled boolean :=
    coalesce((p_employee ->> 'app_login_enabled')::boolean, true);
  v_start_time text := nullif(p_employee ->> 'work_start_time', '');
  v_end_time text := nullif(p_employee ->> 'work_end_time', '');
begin
  select * into v_actor from public.users
  where id = p_actor_id and username = p_actor_username and is_active = true
  for share;
  if not found or v_actor.role not in ('owner', 'master') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if v_attendance_tracking_enabled and (v_start_time is null or v_end_time is null) then
    raise exception 'WORK_SCHEDULE_TIMES_REQUIRED' using errcode = '22023';
  end if;
  if not v_attendance_tracking_enabled then
    -- 근태 미사용 직원은 근무시간을 저장하지 않는다.
    v_start_time := null;
    v_end_time := null;
  end if;

  insert into public.users(
    username, password, name, full_name, role, part, position, gender,
    birth_date, hire_date, termination_date, work_start_time, work_end_time,
    is_active, is_system_account, attendance_tracking_enabled, app_login_enabled
  ) values (
    p_employee ->> 'username', p_employee ->> 'password', p_employee ->> 'name',
    nullif(p_employee ->> 'full_name', ''), p_employee ->> 'role',
    nullif(p_employee ->> 'part', ''), p_employee ->> 'position',
    nullif(p_employee ->> 'gender', ''), nullif(p_employee ->> 'birth_date', '')::date,
    nullif(p_employee ->> 'hire_date', '')::date, null,
    v_start_time, v_end_time, coalesce((p_employee ->> 'is_active')::boolean, true), false,
    v_attendance_tracking_enabled, v_app_login_enabled
  ) returning * into v_created;

  if v_attendance_tracking_enabled then
    insert into public.employee_work_schedule_versions(
      user_id, start_time, end_time, unpaid_break_minutes,
      effective_from, effective_to, revision, created_by, change_reason
    ) values (
      v_created.id, v_start_time::time, v_end_time::time, 0,
      (now() at time zone 'Asia/Ho_Chi_Minh')::date, null, 1,
      p_actor_id, 'employee_profile_create'
    );
  end if;

  return to_jsonb(v_created) - 'password';
end;
$$;

revoke all on function public.employee_create_with_schedule_v4(jsonb,bigint,text)
  from public, anon, authenticated;
grant execute on function public.employee_create_with_schedule_v4(jsonb,bigint,text)
  to service_role;

comment on function public.employee_create_with_schedule_v4(jsonb,bigint,text) is
  'employee_create_with_schedule_v1과 동일하나, attendance_tracking_enabled=false인 직원은 근무시간 없이 생성하고 초기 schedule revision을 만들지 않는다. attendance_tracking_enabled/app_login_enabled를 함께 저장한다.';

-- employee_create_with_schedule_v3(상위)을 대체하는 v5: v1 대신 v4를 호출하는 것만 다르다.

create or replace function public.employee_create_with_schedule_v5(
  p_employee jsonb, p_level_program_enabled boolean, p_change_reason text,
  p_actor_id bigint, p_actor_username text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_created public.users%rowtype;
  v_hire_date date := nullif(p_employee ->> 'hire_date', '')::date;
  v_effective_from date;
begin
  if nullif(btrim(p_change_reason), '') is null then
    raise exception 'CHANGE_REASON_REQUIRED' using errcode = '22023';
  end if;

  select * into v_created from jsonb_populate_record(
    null::public.users,
    public.employee_create_with_schedule_v4(p_employee, p_actor_id, p_actor_username)
  );
  if v_created.is_system_account and p_level_program_enabled then
    raise exception 'SYSTEM_ACCOUNT_NOT_ELIGIBLE' using errcode = '22023';
  end if;
  if not v_created.is_system_account and v_hire_date is null then
    raise exception 'HIRE_DATE_REQUIRED' using errcode = '22023';
  end if;
  v_effective_from := coalesce(date_trunc('month', v_hire_date)::date,
    date_trunc('month', now() at time zone 'Asia/Ho_Chi_Minh')::date);

  update public.users
  set level_program_enabled = p_level_program_enabled,
      level_base_date_override = null
  where id = v_created.id returning * into v_created;

  insert into public.employee_level_program_versions (
    user_id, enabled, effective_from, effective_to, base_date, base_date_mode, revision,
    change_reason, created_by, created_by_username
  ) values (
    v_created.id, p_level_program_enabled, v_effective_from, null, v_hire_date,
    case when v_created.is_system_account then null else 'hire_date' end, 1,
    btrim(p_change_reason), p_actor_id, p_actor_username
  );

  return to_jsonb(v_created) - 'password';
end;
$$;

revoke all on function public.employee_create_with_schedule_v5(jsonb,boolean,text,bigint,text)
  from public, anon, authenticated;
grant execute on function public.employee_create_with_schedule_v5(jsonb,boolean,text,bigint,text)
  to service_role;

comment on function public.employee_create_with_schedule_v5(jsonb,boolean,text,bigint,text) is
  'employee_create_with_schedule_v3과 동일하나 내부적으로 employee_create_with_schedule_v4를 호출해 근태 미사용 직원을 schedule 없이 생성할 수 있다. API는 이제 이 함수를 호출한다.';

-- ---------------------------------------------------------------------------
-- 4. 직원 수정 RPC — 근태 사용 토글에 따른 조건부 schedule 처리
-- ---------------------------------------------------------------------------
-- employee_update_profile_and_level_v3(최하위 프로필 갱신)을 대체하는 v7:
-- attendance_tracking_enabled/app_login_enabled를 허용 update key와 SET절에 추가한
-- 것 외에는 v3과 완전히 동일하다.

create or replace function public.employee_update_profile_and_level_v7(
  p_user_id bigint,
  p_updates jsonb,
  p_level_program_enabled boolean,
  p_base_date_override date,
  p_actor_id bigint,
  p_actor_username text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.users%rowtype;
  v_before public.users%rowtype;
  v_after public.users%rowtype;
  v_hire_date date;
  v_termination_date date;
  v_role text;
  v_level_program_enabled boolean;
  v_base_date_override date;
  v_action text;
  v_next_attendance_tracking_enabled boolean;
begin
  if p_updates is null or jsonb_typeof(p_updates) <> 'object' then
    raise exception 'INVALID_EMPLOYEE_UPDATES' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_object_keys(p_updates) as keys(key_name)
    where key_name not in (
      'name', 'full_name', 'role', 'part', 'position', 'gender',
      'birth_date', 'hire_date', 'termination_date',
      'work_start_time', 'work_end_time', 'is_active',
      'payroll_eligible_override', 'attendance_tracking_enabled', 'app_login_enabled'
    )
  ) then
    raise exception 'INVALID_EMPLOYEE_UPDATE_KEY' using errcode = '22023';
  end if;

  select * into v_actor
  from public.users
  where id = p_actor_id
    and username = p_actor_username
    and is_active = true
  for share;
  if not found or v_actor.role not in ('owner', 'master') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_before
  from public.users
  where id = p_user_id
  for update;
  if not found then
    raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0002';
  end if;

  v_role := case
    when p_updates ? 'role' then nullif(btrim(p_updates ->> 'role'), '')
    else v_before.role
  end;
  v_level_program_enabled := case
    when v_role in ('owner', 'master') and p_level_program_enabled is true then true
    when v_role in ('owner', 'master') then null
    else v_before.level_program_enabled
  end;
  v_base_date_override := case
    when v_role in ('owner', 'master')
      and v_level_program_enabled is distinct from true then null
    else p_base_date_override
  end;

  if v_before.is_system_account and v_level_program_enabled is true then
    raise exception 'SYSTEM_ACCOUNT_NOT_ELIGIBLE' using errcode = '22023';
  end if;
  if v_before.is_system_account
    and v_before.level_base_date_override is distinct from v_base_date_override
    and v_base_date_override is not null then
    raise exception 'SYSTEM_ACCOUNT_NOT_ELIGIBLE' using errcode = '22023';
  end if;
  if v_before.termination_date is not null
    and (
      v_before.level_program_enabled is distinct from v_level_program_enabled
      or v_before.level_base_date_override is distinct from v_base_date_override
    ) then
    raise exception 'TERMINATED_EMPLOYEE_READ_ONLY' using errcode = '22023';
  end if;

  v_hire_date := case
    when p_updates ? 'hire_date' then nullif(p_updates ->> 'hire_date', '')::date
    else v_before.hire_date
  end;
  v_termination_date := case
    when p_updates ? 'termination_date' then nullif(p_updates ->> 'termination_date', '')::date
    else v_before.termination_date
  end;

  if not v_before.is_system_account
    and (v_role in ('manager', 'leader', 'staff') or v_level_program_enabled is true)
    and v_hire_date is null then
    raise exception 'HIRE_DATE_REQUIRED' using errcode = '22023';
  end if;
  if v_termination_date is not null and v_termination_date < v_hire_date then
    raise exception 'TERMINATION_DATE_BEFORE_HIRE_DATE' using errcode = '22023';
  end if;
  if v_base_date_override is not null and v_base_date_override < v_hire_date then
    raise exception 'BASE_DATE_BEFORE_HIRE_DATE' using errcode = '22023';
  end if;
  if v_base_date_override is not null
    and v_base_date_override > (now() at time zone 'Asia/Ho_Chi_Minh')::date then
    raise exception 'BASE_DATE_IN_FUTURE' using errcode = '22023';
  end if;
  if v_base_date_override is not null
    and v_termination_date is not null
    and v_base_date_override > v_termination_date then
    raise exception 'BASE_DATE_AFTER_TERMINATION_DATE' using errcode = '22023';
  end if;

  -- 근태 사용을 true→false로 끄려는 요청인데, 아직 퇴근되지 않은 열린 출근 기록이
  -- 있으면 프로필 update 전에 거부한다. v_before는 이미 FOR UPDATE로 잠긴 상태이므로
  -- 동시 요청이 들어와도 이 판정과 update가 하나의 트랜잭션으로 원자적으로 처리된다.
  -- attendance_tracking_enabled가 이번 요청에 없으면(=변경 없음) v_before 값을 그대로
  -- 쓰므로, 이미 근태 미사용인 직원의 다른 필드 수정은 이 검사로 막히지 않는다.
  v_next_attendance_tracking_enabled := case
    when p_updates ? 'attendance_tracking_enabled'
      then coalesce((p_updates ->> 'attendance_tracking_enabled')::boolean, true)
    else v_before.attendance_tracking_enabled
  end;
  if v_before.attendance_tracking_enabled = true
    and v_next_attendance_tracking_enabled = false
    and exists (
      select 1
      from public.attendance_records
      where user_id = p_user_id
        and check_in_at is not null
        and check_out_at is null
    ) then
    raise exception 'ATTENDANCE_OPEN_RECORD_EXISTS' using errcode = '55000';
  end if;

  update public.users
  set
    name = case when p_updates ? 'name' then nullif(btrim(p_updates ->> 'name'), '') else v_before.name end,
    full_name = case when p_updates ? 'full_name' then nullif(btrim(p_updates ->> 'full_name'), '') else v_before.full_name end,
    role = v_role,
    part = case when p_updates ? 'part' then nullif(btrim(p_updates ->> 'part'), '') else v_before.part end,
    position = case when p_updates ? 'position' then nullif(btrim(p_updates ->> 'position'), '') else v_before.position end,
    gender = case when p_updates ? 'gender' then nullif(btrim(p_updates ->> 'gender'), '') else v_before.gender end,
    birth_date = case when p_updates ? 'birth_date' then nullif(p_updates ->> 'birth_date', '')::date else v_before.birth_date end,
    hire_date = v_hire_date,
    termination_date = v_termination_date,
    work_start_time = case when p_updates ? 'work_start_time' then nullif(p_updates ->> 'work_start_time', '') else v_before.work_start_time end,
    work_end_time = case when p_updates ? 'work_end_time' then nullif(p_updates ->> 'work_end_time', '') else v_before.work_end_time end,
    is_active = case when p_updates ? 'is_active' then (p_updates ->> 'is_active')::boolean else v_before.is_active end,
    payroll_eligible_override = case
      when not (p_updates ? 'payroll_eligible_override') then v_before.payroll_eligible_override
      when jsonb_typeof(p_updates -> 'payroll_eligible_override') = 'null' then null
      else (p_updates ->> 'payroll_eligible_override')::boolean
    end,
    attendance_tracking_enabled = v_next_attendance_tracking_enabled,
    app_login_enabled = case
      when p_updates ? 'app_login_enabled'
        then coalesce((p_updates ->> 'app_login_enabled')::boolean, true)
      else v_before.app_login_enabled
    end,
    level_program_enabled = v_level_program_enabled,
    level_base_date_override = v_base_date_override
  where id = p_user_id
  returning * into v_after;

  if not v_before.is_system_account
    and (
      v_before.level_program_enabled is distinct from v_after.level_program_enabled
      or v_before.level_base_date_override is distinct from v_after.level_base_date_override
    ) then
    v_action := case
      when v_before.level_program_enabled is distinct from true
        and v_after.level_program_enabled is true then 'level_program_enabled'
      when v_before.level_program_enabled is true
        and v_after.level_program_enabled is distinct from true then 'level_program_disabled'
      when v_before.level_base_date_override is not null
        and v_after.level_base_date_override is null then 'level_base_date_reset_to_hire_date'
      else 'level_base_date_changed'
    end;

    insert into public.employee_level_audit_logs(
      user_id, action, previous_enabled, next_enabled,
      previous_base_date_override, next_base_date_override,
      previous_effective_base_date, next_effective_base_date,
      previous_level, next_level, actor_id, actor_username, change_reason
    ) values (
      p_user_id, v_action, v_before.level_program_enabled, v_after.level_program_enabled,
      v_before.level_base_date_override, v_after.level_base_date_override,
      coalesce(v_before.level_base_date_override, v_before.hire_date),
      coalesce(v_after.level_base_date_override, v_after.hire_date),
      null, null, p_actor_id, p_actor_username, 'employee_profile_save'
    );
  end if;

  return to_jsonb(v_after) - 'password';
end;
$$;

revoke all on function public.employee_update_profile_and_level_v7(bigint,jsonb,boolean,date,bigint,text)
  from public, anon, authenticated;
grant execute on function public.employee_update_profile_and_level_v7(bigint,jsonb,boolean,date,bigint,text)
  to service_role;

comment on function public.employee_update_profile_and_level_v7(bigint,jsonb,boolean,date,bigint,text) is
  'employee_update_profile_and_level_v3과 동일하나 attendance_tracking_enabled/app_login_enabled를 허용 update key로 받아 저장하고, 열린 출근 기록(check_in_at is not null and check_out_at is null)이 있는 직원의 attendance_tracking_enabled true→false 전환은 ATTENDANCE_OPEN_RECORD_EXISTS로 거부한다.';

-- employee_update_profile_and_level_v4(schedule 처리)를 대체하는 v8: 결과 행의
-- attendance_tracking_enabled가 false면 근무시간을 요구하지 않고 schedule 이력에도
-- 손대지 않는다. true면 기존 v4와 동일하게 동작한다(근무시간 필수, 변경 시에만 새
-- revision 생성).

create or replace function public.employee_update_profile_and_level_v8(
  p_user_id bigint,
  p_updates jsonb,
  p_level_program_enabled boolean,
  p_base_date_override date,
  p_actor_id bigint,
  p_actor_username text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb;
  v_attendance_tracking_enabled boolean;
  v_start_time text;
  v_end_time text;
  v_effective_date date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_current public.employee_work_schedule_versions%rowtype;
  v_revision bigint;
begin
  -- v7이 actor 검증과 프로필 업데이트를 담당한다. 실패 시 이 트랜잭션 전체가 롤백된다.
  v_result := public.employee_update_profile_and_level_v7(
    p_user_id, p_updates, p_level_program_enabled, p_base_date_override,
    p_actor_id, p_actor_username
  );

  v_attendance_tracking_enabled :=
    coalesce((v_result ->> 'attendance_tracking_enabled')::boolean, true);
  if not v_attendance_tracking_enabled then
    -- 근태 미사용 상태에서는 근무시간을 요구하지 않고 기존 schedule 이력도 건드리지
    -- 않는다(삭제·종료·변경 없음). work_start_time/work_end_time은 v7이 이미 기존 값을
    -- 보존했거나 요청대로 반영했다.
    return v_result;
  end if;

  v_start_time := nullif(v_result ->> 'work_start_time', '');
  v_end_time := nullif(v_result ->> 'work_end_time', '');

  if v_start_time is null or v_end_time is null then
    raise exception 'WORK_SCHEDULE_TIMES_REQUIRED' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(-p_user_id);
  select * into v_current
  from public.employee_work_schedule_versions
  where user_id = p_user_id and effective_to is null
  order by effective_from desc, revision desc
  limit 1
  for update;

  if v_current.id is null
    or v_current.start_time::text is distinct from v_start_time
    or v_current.end_time::text is distinct from v_end_time then
    if v_current.id is not null then
      if v_current.effective_from > v_effective_date then
        raise exception 'WORK_SCHEDULE_FUTURE_VERSION_CONFLICT' using errcode = '23P01';
      end if;
      update public.employee_work_schedule_versions
      set effective_to = v_effective_date
      where id = v_current.id;
    end if;

    select coalesce(max(revision), 0) + 1 into v_revision
    from public.employee_work_schedule_versions
    where user_id = p_user_id;

    insert into public.employee_work_schedule_versions(
      user_id, start_time, end_time, unpaid_break_minutes,
      effective_from, effective_to, revision, created_by, change_reason
    ) values (
      p_user_id, v_start_time::time, v_end_time::time, 0,
      v_effective_date, null, v_revision, p_actor_id, 'employee_profile_save'
    );
  end if;

  return v_result;
end;
$$;

revoke all on function public.employee_update_profile_and_level_v8(bigint,jsonb,boolean,date,bigint,text)
  from public, anon, authenticated;
grant execute on function public.employee_update_profile_and_level_v8(bigint,jsonb,boolean,date,bigint,text)
  to service_role;

comment on function public.employee_update_profile_and_level_v8(bigint,jsonb,boolean,date,bigint,text) is
  'employee_update_profile_and_level_v4와 동일하나, 결과 행의 attendance_tracking_enabled가 false이면 근무시간 필수 검증과 schedule revision 생성을 건너뛴다. 근태 미사용→사용 전환 시에는 기존 v4와 동일하게 근무시간이 있어야 하고, 값이 바뀌었거나 활성 schedule이 없을 때만 새 revision을 만든다.';

-- employee_update_profile_and_level_v6(레벨 정책 포함 최상위)을 대체하는 v9: v4 대신
-- v8을 호출하는 것만 다르다. API는 이제 이 함수를 호출한다.

create or replace function public.employee_update_profile_and_level_v9(
  p_user_id bigint,
  p_updates jsonb,
  p_level_program_enabled boolean,
  p_effective_from date,
  p_base_date_mode text,
  p_base_date_override date,
  p_change_reason text,
  p_actor_id bigint,
  p_actor_username text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_before public.users%rowtype;
  v_after public.users%rowtype;
  v_target public.employee_level_program_versions%rowtype;
  v_active public.employee_level_program_versions%rowtype;
  v_revision bigint;
  v_base_date date;
  v_next_effective_from date;
  v_current_month date := date_trunc('month', now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_action text;
begin
  select * into v_before from public.users where id = p_user_id for update;
  if not found then raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0002'; end if;

  select * into v_after from jsonb_populate_record(
    null::public.users,
    public.employee_update_profile_and_level_v8(
      p_user_id, p_updates, v_before.level_program_enabled,
      v_before.level_base_date_override, p_actor_id, p_actor_username
    )
  );

  if p_effective_from is null then return to_jsonb(v_after) - 'password'; end if;
  if p_effective_from <> date_trunc('month', p_effective_from)::date
    or p_effective_from < v_current_month
    or p_effective_from > (v_current_month + interval '1 month')::date then
    raise exception 'INVALID_LEVEL_EFFECTIVE_MONTH' using errcode = '22023';
  end if;
  if p_base_date_mode not in ('hire_date', 'override') then
    raise exception 'INVALID_BASE_DATE_MODE' using errcode = '22023';
  end if;
  if nullif(btrim(p_change_reason), '') is null then
    raise exception 'CHANGE_REASON_REQUIRED' using errcode = '22023';
  end if;
  if v_after.termination_date is not null then
    raise exception 'TERMINATED_EMPLOYEE_READ_ONLY' using errcode = '22023';
  end if;
  if v_after.is_system_account and p_level_program_enabled then
    raise exception 'SYSTEM_ACCOUNT_NOT_ELIGIBLE' using errcode = '22023';
  end if;

  v_base_date := case when p_base_date_mode = 'hire_date' then v_after.hire_date else p_base_date_override end;
  if v_base_date is null then raise exception 'HIRE_DATE_REQUIRED' using errcode = '22023'; end if;
  if v_after.hire_date is not null and v_base_date < v_after.hire_date then
    raise exception 'BASE_DATE_BEFORE_HIRE_DATE' using errcode = '22023';
  end if;
  if v_after.termination_date is not null and v_base_date > v_after.termination_date then
    raise exception 'BASE_DATE_AFTER_TERMINATION_DATE' using errcode = '22023';
  end if;
  if v_base_date > (now() at time zone 'Asia/Ho_Chi_Minh')::date then
    raise exception 'BASE_DATE_IN_FUTURE' using errcode = '22023';
  end if;

  select * into v_target
  from public.employee_level_program_versions
  where user_id = p_user_id
    and effective_from <= p_effective_from
    and (effective_to is null or effective_to > p_effective_from)
  order by effective_from desc, revision desc
  limit 1 for update;

  if found
    and v_target.enabled is not distinct from p_level_program_enabled
    and v_target.base_date_mode is not distinct from p_base_date_mode
    and v_target.base_date is not distinct from v_base_date then
    return to_jsonb(v_after) - 'password';
  end if;

  v_action := case
    when v_target.enabled is distinct from p_level_program_enabled
      then case when p_level_program_enabled then 'level_program_enabled' else 'level_program_disabled' end
    when p_base_date_mode = 'hire_date' then 'level_base_date_reset_to_hire_date'
    else 'level_base_date_changed'
  end;

  if v_target.effective_from = p_effective_from then
    update public.employee_level_program_versions
    set enabled = p_level_program_enabled,
        base_date_mode = p_base_date_mode,
        base_date = v_base_date,
        change_reason = btrim(p_change_reason),
        created_by = p_actor_id,
        created_by_username = p_actor_username,
        created_at = now()
    where id = v_target.id;
  else
    select min(effective_from) into v_next_effective_from
    from public.employee_level_program_versions
    where user_id = p_user_id and effective_from > p_effective_from;

    update public.employee_level_program_versions
    set effective_to = p_effective_from
    where id = v_target.id and v_target.effective_from < p_effective_from;

    select coalesce(max(revision), 0) + 1 into v_revision
    from public.employee_level_program_versions where user_id = p_user_id;

    insert into public.employee_level_program_versions (
      user_id, enabled, effective_from, effective_to, base_date, base_date_mode, revision,
      change_reason, created_by, created_by_username
    ) values (
      p_user_id, p_level_program_enabled, p_effective_from, v_next_effective_from,
      v_base_date, p_base_date_mode, v_revision, btrim(p_change_reason), p_actor_id, p_actor_username
    );
  end if;

  select * into v_active
  from public.employee_level_program_versions
  where user_id = p_user_id
    and effective_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
    and (effective_to is null or effective_to > (now() at time zone 'Asia/Ho_Chi_Minh')::date)
  order by effective_from desc, revision desc limit 1;

  update public.users
  set level_program_enabled = v_active.enabled,
      level_base_date_override = case when v_active.base_date_mode = 'override' then v_active.base_date else null end
  where id = p_user_id returning * into v_after;

  insert into public.employee_level_audit_logs (
    user_id, action, previous_enabled, next_enabled,
    previous_base_date_override, next_base_date_override,
    previous_base_date_mode, next_base_date_mode,
    previous_effective_base_date, next_effective_base_date,
    previous_level, next_level, actor_id, actor_username, change_reason, created_at
  ) values (
    p_user_id, v_action, v_target.enabled, p_level_program_enabled,
    case when v_target.base_date_mode = 'override' then v_target.base_date else null end,
    case when p_base_date_mode = 'override' then v_base_date else null end,
    v_target.base_date_mode, p_base_date_mode,
    v_target.base_date, v_base_date, null, null, p_actor_id, p_actor_username, btrim(p_change_reason)
    , now()
  );

  return to_jsonb(v_after) - 'password';
end;
$$;

revoke all on function public.employee_update_profile_and_level_v9(bigint,jsonb,boolean,date,text,date,text,bigint,text)
  from public, anon, authenticated;
grant execute on function public.employee_update_profile_and_level_v9(bigint,jsonb,boolean,date,text,date,text,bigint,text)
  to service_role;

comment on function public.employee_update_profile_and_level_v9(bigint,jsonb,boolean,date,text,date,text,bigint,text) is
  'employee_update_profile_and_level_v6과 동일하나 내부적으로 employee_update_profile_and_level_v8을 호출해 근태 사용 토글에 따라 근무시간·schedule 요구를 조건부로 처리한다. API는 이제 이 함수를 호출한다.';

-- ---------------------------------------------------------------------------
-- 5. 동시성 보완 — 신규 출근 생성과 근태 사용 해제가 같은 users 행 잠금을 두고
--    직렬화되도록 attendance_records에 BEFORE INSERT/UPDATE trigger를 추가한다.
-- ---------------------------------------------------------------------------
-- employee_update_profile_and_level_v7은 users 행을 FOR UPDATE로 잠그고 열린 출근
-- 기록을 검사하지만, 출근 API의 attendance_records INSERT/UPDATE는 그 트랜잭션과
-- 아무 잠금도 공유하지 않는다. 따라서 두 요청이 동시에 들어오면 다음 race가 가능했다:
--   1) 근태 해제 RPC가 users 행을 잠그고 열린 기록 없음을 확인
--   2) 그 사이 출근 API가 (아직 커밋 전인) attendance_tracking_enabled=true를 읽음
--   3) 근태 해제 RPC가 false로 커밋
--   4) 출근 API가 열린 attendance_records를 생성 — 근태 미사용 직원에게 열린 기록 발생
--
-- 이 trigger는 attendance_records에 "새 출근"이 시작되는 순간에만(check_in_at이
-- null에서 값으로 처음 채워질 때만) 대상 users 행을 FOR SHARE로 잠근다. FOR SHARE는
-- v7의 FOR UPDATE와 반드시 충돌하므로, 어느 트랜잭션이 먼저 users 행을 잡든 다른
-- 트랜잭션은 그 커밋을 기다린 뒤 최종 확정된 attendance_tracking_enabled 값을 본다.
--   - 근태 해제가 먼저 잠그면: 출근 시도는 커밋을 기다렸다가 false를 보고 실패한다.
--   - 출근이 먼저 잠그면: 근태 해제 RPC가 커밋을 기다렸다가 방금 생긴 열린 기록을
--     보고 ATTENDANCE_OPEN_RECORD_EXISTS로 실패한다.
-- 두 경우 모두 근태 미사용 직원에게 새 열린 기록이 남는 조합은 존재하지 않는다.
--
-- 기존 열린 기록의 퇴근 저장, 관리자 시간 보정, 취소, 자동 미퇴근 마감, 휴무 기록
-- 생성/수정/취소, 과거 기록 수정은 전부 check_in_at이 이미 값을 갖고 있거나(퇴근·보정·
-- 취소·자동마감) 애초에 null로 유지되므로(휴무) 아래 조건에 걸리지 않아 그대로 허용된다.
create or replace function public.attendance_records_block_new_check_in_when_tracking_disabled()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_attendance_tracking_enabled boolean;
begin
  -- 휴무·빈 기록처럼 check_in_at이 없는 행은 신규 출근이 아니다.
  if new.check_in_at is null then
    return new;
  end if;

  -- UPDATE에서만 OLD를 확인한다.
  -- 기존부터 check_in_at이 있었다면 퇴근·보정·자동마감 등이며 신규 출근이 아니다.
  -- (INSERT 시점에는 OLD 행 자체가 존재하지 않으므로, tg_op = 'UPDATE' 분기 안에서만
  -- old를 참조하도록 중첩해 INSERT 경로에서는 old가 전혀 평가되지 않게 한다.)
  if tg_op = 'UPDATE' then
    if old.check_in_at is not null then
      return new;
    end if;
  end if;

  -- 여기까지 도달하는 경우만 신규 출근으로 본다.
  -- 1. INSERT 시 check_in_at이 입력된 경우
  -- 2. UPDATE 시 check_in_at이 null에서 값으로 처음 변경된 경우
  select attendance_tracking_enabled
  into v_attendance_tracking_enabled
  from public.users
  where id = new.user_id
  for share;

  if not found
    or v_attendance_tracking_enabled is distinct from true then
    raise exception 'ATTENDANCE_TRACKING_DISABLED'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

create trigger attendance_records_block_new_check_in
  before insert or update on public.attendance_records
  for each row
  execute function public.attendance_records_block_new_check_in_when_tracking_disabled();

revoke all on function public.attendance_records_block_new_check_in_when_tracking_disabled()
  from public, anon, authenticated;

comment on function public.attendance_records_block_new_check_in_when_tracking_disabled() is
  'attendance_records에 새 출근(check_in_at이 null에서 값으로 처음 채워지는 경우)이 생성/수정될 때만 대상 users 행을 FOR SHARE로 잠그고 attendance_tracking_enabled를 재확인한다. employee_update_profile_and_level_v7의 FOR UPDATE 잠금과 반드시 충돌해 근태 해제와 신규 출근 생성을 같은 users 행 잠금으로 직렬화한다. 기존 열린 기록의 퇴근·보정·취소·자동마감·휴무 처리는 검사 대상이 아니다.';

commit;
