-- BABA 레거시 구조 Cleanup Phase 1-C: 직원관리 최신 entry RPC 3개를 구버전 RPC
-- delegation 없이 독립시킨다.
--
-- 배경: 현재 application이 직접 호출하는 최신 entry
--   employee_update_profile_and_level_v9
--   employee_create_with_schedule_v5
--   employee_rehire_with_level_policy_v3
-- 은 각각 내부적으로
--   v9 → v8 → v7
--   v5 → v4
--   v3 → employee_rehire_with_level_reset_v1
-- 를 호출하는 구조였다. 최근 급여 계약(payroll_correct_latest_unused_contract 계열)에서
-- 신규 RPC가 구버전 RPC를 다시 호출하다 과거 정책이 재실행되어 실제 오류가 발생한
-- 사례가 있었고, 이 위임 구조가 동일한 위험을 안고 있다고 판단해 정리한다.
--
-- 이번 Migration은 v9/v5/v3의 body를 CREATE OR REPLACE로 교체해, 위임하던 구버전
-- 함수(v8/v7, v4, reset_v1)의 로직을 각 entry 안에 그대로 흡수한다. 세 함수 모두
-- 기존 signature를 그대로 유지하므로(DROP 불필요) 기존 grant가 함수 OID에 그대로
-- 보존된다.
--
-- 로직은 새로 설계하지 않고, 흡수 대상 함수의 SQL을 그대로 옮기면서 같은 함수
-- scope 안에서 변수명이 겹치는 부분만 이름을 바꿨다(예: v9의 v_action →
-- v_instant_level_action / v_level_version_action, v8의 v_revision →
-- v_schedule_revision). 실행 순서·조건·예외 코드는 흡수 전과 완전히 동일하다.
--
-- 유지되는 정책(전부 확인 후 그대로 이식):
--   - role/position 통합(position은 API가 role에서 파생해 넘긴 값을 그대로 저장)
--   - attendance_tracking_enabled / app_login_enabled
--   - 열린 출근 기록이 있을 때 근태 사용 해제 차단(ATTENDANCE_OPEN_RECORD_EXISTS)
--   - master/시스템 계정 레벨 정책 제한(SYSTEM_ACCOUNT_NOT_ELIGIBLE)
--   - payroll_eligible_override
--   - 직원 레벨 정책(즉시 반영 + 효력일 기반 버전 스케줄링) 양쪽 모두
--   - hire/termination 검증 전체
--   - 신규 직원 최초 schedule effective_from = hire_date 기준(v5)
--   - 재입사 시 기존 이력(payroll/level audit log) 보존, 신규 삭제 없음(rehire)
--
-- 이번 Migration에서는 구버전 RPC(v8, v7, v4, v1~v3(create), v2(rehire),
-- employee_rehire_with_level_reset_v1)를 DROP하지 않는다. Production에서 최신
-- entry가 이 흡수된 형태로 정상 동작하는 것을 확인한 뒤 별도 cleanup migration으로
-- DROP한다.

begin;

-- ---------------------------------------------------------------------------
-- 1. employee_update_profile_and_level_v9 — v8 → v7 흡수.
-- ---------------------------------------------------------------------------

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
  v_actor public.users%rowtype;
  v_before public.users%rowtype;
  v_after public.users%rowtype;
  v_hire_date date;
  v_termination_date date;
  v_role text;
  v_pass_level_program_enabled boolean;
  v_pass_base_date_override date;
  v_next_attendance_tracking_enabled boolean;
  v_instant_level_action text;
  v_work_start_time text;
  v_work_end_time text;
  v_schedule_effective_date date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_schedule_current public.employee_work_schedule_versions%rowtype;
  v_schedule_revision bigint;
  v_level_target public.employee_level_program_versions%rowtype;
  v_level_active public.employee_level_program_versions%rowtype;
  v_level_revision bigint;
  v_level_base_date date;
  v_level_next_effective_from date;
  v_current_month date := date_trunc('month', now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_level_version_action text;
begin
  -- === (구 v7) 프로필/근태/로그인/역할/레벨 즉시 필드 갱신 ===
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
  -- v9가 v8/v7에 항상 "현재 값 그대로"를 넘기던 부분(레벨 정책 자체의 효력 변경은
  -- 아래 v9 전용 블록에서 별도로 처리한다).
  v_pass_level_program_enabled := case
    when v_role in ('owner', 'master') and v_before.level_program_enabled is true then true
    when v_role in ('owner', 'master') then null
    else v_before.level_program_enabled
  end;
  v_pass_base_date_override := case
    when v_role in ('owner', 'master')
      and v_pass_level_program_enabled is distinct from true then null
    else v_before.level_base_date_override
  end;

  if v_before.is_system_account and v_pass_level_program_enabled is true then
    raise exception 'SYSTEM_ACCOUNT_NOT_ELIGIBLE' using errcode = '22023';
  end if;
  if v_before.is_system_account
    and v_before.level_base_date_override is distinct from v_pass_base_date_override
    and v_pass_base_date_override is not null then
    raise exception 'SYSTEM_ACCOUNT_NOT_ELIGIBLE' using errcode = '22023';
  end if;
  if v_before.termination_date is not null
    and (
      v_before.level_program_enabled is distinct from v_pass_level_program_enabled
      or v_before.level_base_date_override is distinct from v_pass_base_date_override
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
    and (v_role in ('manager', 'leader', 'staff') or v_pass_level_program_enabled is true)
    and v_hire_date is null then
    raise exception 'HIRE_DATE_REQUIRED' using errcode = '22023';
  end if;
  if v_termination_date is not null and v_termination_date < v_hire_date then
    raise exception 'TERMINATION_DATE_BEFORE_HIRE_DATE' using errcode = '22023';
  end if;
  if v_pass_base_date_override is not null and v_pass_base_date_override < v_hire_date then
    raise exception 'BASE_DATE_BEFORE_HIRE_DATE' using errcode = '22023';
  end if;
  if v_pass_base_date_override is not null
    and v_pass_base_date_override > (now() at time zone 'Asia/Ho_Chi_Minh')::date then
    raise exception 'BASE_DATE_IN_FUTURE' using errcode = '22023';
  end if;
  if v_pass_base_date_override is not null
    and v_termination_date is not null
    and v_pass_base_date_override > v_termination_date then
    raise exception 'BASE_DATE_AFTER_TERMINATION_DATE' using errcode = '22023';
  end if;

  -- 근태 사용을 true→false로 끄려는 요청인데 아직 퇴근되지 않은 열린 출근 기록이
  -- 있으면 차단한다. v_before는 이미 FOR UPDATE로 잠긴 상태이므로 이 판정과 update는
  -- 하나의 트랜잭션으로 원자적으로 처리된다.
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
    level_program_enabled = v_pass_level_program_enabled,
    level_base_date_override = v_pass_base_date_override
  where id = p_user_id
  returning * into v_after;

  if not v_before.is_system_account
    and (
      v_before.level_program_enabled is distinct from v_after.level_program_enabled
      or v_before.level_base_date_override is distinct from v_after.level_base_date_override
    ) then
    v_instant_level_action := case
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
      p_user_id, v_instant_level_action, v_before.level_program_enabled, v_after.level_program_enabled,
      v_before.level_base_date_override, v_after.level_base_date_override,
      coalesce(v_before.level_base_date_override, v_before.hire_date),
      coalesce(v_after.level_base_date_override, v_after.hire_date),
      null, null, p_actor_id, p_actor_username, 'employee_profile_save'
    );
  end if;

  -- === (구 v8) 근태 사용 여부에 따른 근무시간 schedule 조건부 갱신 ===
  if coalesce(v_after.attendance_tracking_enabled, true) then
    v_work_start_time := nullif(v_after.work_start_time::text, '');
    v_work_end_time := nullif(v_after.work_end_time::text, '');

    if v_work_start_time is null or v_work_end_time is null then
      raise exception 'WORK_SCHEDULE_TIMES_REQUIRED' using errcode = '22023';
    end if;

    perform pg_advisory_xact_lock(-p_user_id);
    select * into v_schedule_current
    from public.employee_work_schedule_versions
    where user_id = p_user_id and effective_to is null
    order by effective_from desc, revision desc
    limit 1
    for update;

    if v_schedule_current.id is null
      or v_schedule_current.start_time::text is distinct from v_work_start_time
      or v_schedule_current.end_time::text is distinct from v_work_end_time then
      if v_schedule_current.id is not null then
        if v_schedule_current.effective_from > v_schedule_effective_date then
          raise exception 'WORK_SCHEDULE_FUTURE_VERSION_CONFLICT' using errcode = '23P01';
        end if;
        update public.employee_work_schedule_versions
        set effective_to = v_schedule_effective_date
        where id = v_schedule_current.id;
      end if;

      select coalesce(max(revision), 0) + 1 into v_schedule_revision
      from public.employee_work_schedule_versions
      where user_id = p_user_id;

      insert into public.employee_work_schedule_versions(
        user_id, start_time, end_time, unpaid_break_minutes,
        effective_from, effective_to, revision, created_by, change_reason
      ) values (
        p_user_id, v_work_start_time::time, v_work_end_time::time, 0,
        v_schedule_effective_date, null, v_schedule_revision, p_actor_id, 'employee_profile_save'
      );
    end if;
  end if;
  -- 근태 미사용 상태에서는 근무시간을 요구하지 않고 기존 schedule 이력도 건드리지 않는다.

  -- === (v9 고유) 효력일 기반 레벨 정책 버전 스케줄링 ===
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

  v_level_base_date := case when p_base_date_mode = 'hire_date' then v_after.hire_date else p_base_date_override end;
  if v_level_base_date is null then raise exception 'HIRE_DATE_REQUIRED' using errcode = '22023'; end if;
  if v_after.hire_date is not null and v_level_base_date < v_after.hire_date then
    raise exception 'BASE_DATE_BEFORE_HIRE_DATE' using errcode = '22023';
  end if;
  if v_after.termination_date is not null and v_level_base_date > v_after.termination_date then
    raise exception 'BASE_DATE_AFTER_TERMINATION_DATE' using errcode = '22023';
  end if;
  if v_level_base_date > (now() at time zone 'Asia/Ho_Chi_Minh')::date then
    raise exception 'BASE_DATE_IN_FUTURE' using errcode = '22023';
  end if;

  select * into v_level_target
  from public.employee_level_program_versions
  where user_id = p_user_id
    and effective_from <= p_effective_from
    and (effective_to is null or effective_to > p_effective_from)
  order by effective_from desc, revision desc
  limit 1 for update;

  if found
    and v_level_target.enabled is not distinct from p_level_program_enabled
    and v_level_target.base_date_mode is not distinct from p_base_date_mode
    and v_level_target.base_date is not distinct from v_level_base_date then
    return to_jsonb(v_after) - 'password';
  end if;

  v_level_version_action := case
    when v_level_target.enabled is distinct from p_level_program_enabled
      then case when p_level_program_enabled then 'level_program_enabled' else 'level_program_disabled' end
    when p_base_date_mode = 'hire_date' then 'level_base_date_reset_to_hire_date'
    else 'level_base_date_changed'
  end;

  if v_level_target.effective_from = p_effective_from then
    update public.employee_level_program_versions
    set enabled = p_level_program_enabled,
        base_date_mode = p_base_date_mode,
        base_date = v_level_base_date,
        change_reason = btrim(p_change_reason),
        created_by = p_actor_id,
        created_by_username = p_actor_username,
        created_at = now()
    where id = v_level_target.id;
  else
    select min(effective_from) into v_level_next_effective_from
    from public.employee_level_program_versions
    where user_id = p_user_id and effective_from > p_effective_from;

    update public.employee_level_program_versions
    set effective_to = p_effective_from
    where id = v_level_target.id and v_level_target.effective_from < p_effective_from;

    select coalesce(max(revision), 0) + 1 into v_level_revision
    from public.employee_level_program_versions where user_id = p_user_id;

    insert into public.employee_level_program_versions (
      user_id, enabled, effective_from, effective_to, base_date, base_date_mode, revision,
      change_reason, created_by, created_by_username
    ) values (
      p_user_id, p_level_program_enabled, p_effective_from, v_level_next_effective_from,
      v_level_base_date, p_base_date_mode, v_level_revision, btrim(p_change_reason), p_actor_id, p_actor_username
    );
  end if;

  select * into v_level_active
  from public.employee_level_program_versions
  where user_id = p_user_id
    and effective_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
    and (effective_to is null or effective_to > (now() at time zone 'Asia/Ho_Chi_Minh')::date)
  order by effective_from desc, revision desc limit 1;

  update public.users
  set level_program_enabled = v_level_active.enabled,
      level_base_date_override = case when v_level_active.base_date_mode = 'override' then v_level_active.base_date else null end
  where id = p_user_id returning * into v_after;

  insert into public.employee_level_audit_logs (
    user_id, action, previous_enabled, next_enabled,
    previous_base_date_override, next_base_date_override,
    previous_base_date_mode, next_base_date_mode,
    previous_effective_base_date, next_effective_base_date,
    previous_level, next_level, actor_id, actor_username, change_reason, created_at
  ) values (
    p_user_id, v_level_version_action, v_level_target.enabled, p_level_program_enabled,
    case when v_level_target.base_date_mode = 'override' then v_level_target.base_date else null end,
    case when p_base_date_mode = 'override' then v_level_base_date else null end,
    v_level_target.base_date_mode, p_base_date_mode,
    v_level_target.base_date, v_level_base_date, null, null, p_actor_id, p_actor_username, btrim(p_change_reason)
    , now()
  );

  return to_jsonb(v_after) - 'password';
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. employee_create_with_schedule_v5 — v4 흡수.
-- ---------------------------------------------------------------------------

create or replace function public.employee_create_with_schedule_v5(
  p_employee jsonb,
  p_level_program_enabled boolean,
  p_change_reason text,
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
  v_hire_date date := nullif(p_employee ->> 'hire_date', '')::date;
  v_schedule_effective_from date;
  v_effective_from date;
begin
  if nullif(btrim(p_change_reason), '') is null then
    raise exception 'CHANGE_REASON_REQUIRED' using errcode = '22023';
  end if;

  -- === (구 v4) 실제 users 행 생성 + 근태 사용 여부에 따른 최초 schedule 생성 ===
  select * into v_actor
  from public.users
  where id = p_actor_id
    and username = p_actor_username
    and is_active = true
  for share;

  if not found or v_actor.role not in ('owner', 'master') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if v_attendance_tracking_enabled and (v_start_time is null or v_end_time is null) then
    raise exception 'WORK_SCHEDULE_TIMES_REQUIRED' using errcode = '22023';
  end if;

  if not v_attendance_tracking_enabled then
    v_start_time := null;
    v_end_time := null;
  end if;

  insert into public.users(
    username, password, name, full_name, role, part, position, gender,
    birth_date, hire_date, termination_date, work_start_time, work_end_time,
    is_active, is_system_account, attendance_tracking_enabled, app_login_enabled
  ) values (
    p_employee ->> 'username',
    p_employee ->> 'password',
    p_employee ->> 'name',
    nullif(p_employee ->> 'full_name', ''),
    p_employee ->> 'role',
    nullif(p_employee ->> 'part', ''),
    p_employee ->> 'position',
    nullif(p_employee ->> 'gender', ''),
    nullif(p_employee ->> 'birth_date', '')::date,
    v_hire_date,
    null,
    v_start_time,
    v_end_time,
    coalesce((p_employee ->> 'is_active')::boolean, true),
    false,
    v_attendance_tracking_enabled,
    v_app_login_enabled
  ) returning * into v_created;

  if v_attendance_tracking_enabled then
    v_schedule_effective_from := coalesce(
      v_hire_date,
      (now() at time zone 'Asia/Ho_Chi_Minh')::date
    );

    insert into public.employee_work_schedule_versions(
      user_id, start_time, end_time, unpaid_break_minutes,
      effective_from, effective_to, revision, created_by, change_reason
    ) values (
      v_created.id,
      v_start_time::time,
      v_end_time::time,
      0,
      v_schedule_effective_from,
      null,
      1,
      p_actor_id,
      'employee_profile_create'
    );
  end if;

  -- === (v5 고유) 직원 레벨 정책 최초 버전 등록 ===
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

-- ---------------------------------------------------------------------------
-- 3. employee_rehire_with_level_policy_v3 — employee_rehire_with_level_reset_v1 흡수.
-- ---------------------------------------------------------------------------

create or replace function public.employee_rehire_with_level_policy_v3(
  p_user_id bigint,
  p_rehire_date date,
  p_level_program_enabled boolean,
  p_change_reason text,
  p_actor_id bigint,
  p_actor_username text,
  p_previous_level smallint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.users%rowtype;
  v_before public.users%rowtype;
  v_after public.users%rowtype;
  v_effective_from date := date_trunc('month', p_rehire_date)::date;
  v_revision bigint;
  v_next_effective_from date;
  v_existing_id bigint;
begin
  -- === (구 employee_rehire_with_level_reset_v1) 재입사 대상 검증 + 즉시 초기화 ===
  if p_rehire_date is null then raise exception 'INVALID_REHIRE_DATE' using errcode = '22023'; end if;
  if nullif(btrim(p_change_reason), '') is null then raise exception 'CHANGE_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into v_actor from public.users
  where id = p_actor_id and username = p_actor_username and is_active = true
  for share;
  if not found or v_actor.role not in ('owner', 'master') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_before from public.users where id = p_user_id for update;
  if not found then raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_before.is_system_account or v_before.is_active is distinct from false or v_before.termination_date is null then
    raise exception 'REHIRE_NOT_ALLOWED' using errcode = '22023';
  end if;

  update public.users set
    hire_date = p_rehire_date,
    termination_date = null,
    is_active = true,
    level_program_enabled = null,
    level_base_date_override = null
  where id = p_user_id returning * into v_after;

  insert into public.employee_level_audit_logs(
    user_id, action, previous_enabled, next_enabled,
    previous_base_date_override, next_base_date_override,
    previous_effective_base_date, next_effective_base_date,
    previous_level, next_level, actor_id, actor_username, change_reason
  ) values (
    p_user_id, 'level_reset_on_rehire', v_before.level_program_enabled, null,
    v_before.level_base_date_override, null,
    coalesce(v_before.level_base_date_override, v_before.hire_date), p_rehire_date,
    p_previous_level, null, p_actor_id, p_actor_username, btrim(p_change_reason)
  );

  -- === (v3 고유) 복귀 시점 기준 직원 레벨 정책 버전 등록 ===
  select min(effective_from) into v_next_effective_from
  from public.employee_level_program_versions
  where user_id = p_user_id and effective_from > v_effective_from;

  update public.employee_level_program_versions
  set effective_to = v_effective_from
  where user_id = p_user_id
    and effective_from < v_effective_from
    and (effective_to is null or effective_to > v_effective_from);

  select id into v_existing_id
  from public.employee_level_program_versions
  where user_id = p_user_id and effective_from = v_effective_from
  order by revision desc limit 1 for update;

  if v_existing_id is not null then
    update public.employee_level_program_versions
    set enabled = p_level_program_enabled,
        effective_to = v_next_effective_from,
        base_date = p_rehire_date,
        base_date_mode = 'hire_date',
        change_reason = btrim(p_change_reason),
        created_by = p_actor_id,
        created_by_username = p_actor_username,
        created_at = now()
    where id = v_existing_id;
  else
    select coalesce(max(revision), 0) + 1 into v_revision
    from public.employee_level_program_versions where user_id = p_user_id;

    insert into public.employee_level_program_versions (
      user_id, enabled, effective_from, effective_to, base_date, base_date_mode, revision,
      change_reason, created_by, created_by_username
    ) values (
      p_user_id, p_level_program_enabled, v_effective_from, v_next_effective_from, p_rehire_date, 'hire_date',
      v_revision, btrim(p_change_reason), p_actor_id, p_actor_username
    );
  end if;

  update public.users
  set level_program_enabled = p_level_program_enabled,
      level_base_date_override = null
  where id = p_user_id returning * into v_after;

  return to_jsonb(v_after) - 'password';
end;
$$;

commit;
