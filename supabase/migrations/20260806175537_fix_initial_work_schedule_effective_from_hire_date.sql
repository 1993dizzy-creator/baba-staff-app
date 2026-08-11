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
  v_hire_date date := nullif(p_employee ->> 'hire_date', '')::date;
  v_schedule_effective_from date;
begin
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

  return to_jsonb(v_created) - 'password';
end;
$$;

comment on function public.employee_create_with_schedule_v4(jsonb, bigint, text) is
  '직원 생성과 최초 근무시간 version 생성을 한 transaction으로 처리한다. 근태 사용 직원의 최초 근무시간 적용일은 입사일을 사용하고, 입사일이 없을 때만 베트남 현지 생성일을 fallback으로 사용한다.';
