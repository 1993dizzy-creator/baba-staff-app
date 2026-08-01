begin;

alter table public.employee_work_schedule_versions
  drop constraint employee_schedule_valid_range;
alter table public.employee_work_schedule_versions
  add constraint employee_schedule_valid_range
  check (effective_to is null or effective_to >= effective_from);

create or replace function public.employee_update_profile_and_level_v4(
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
  v_start_time text;
  v_end_time text;
  v_effective_date date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_current public.employee_work_schedule_versions%rowtype;
  v_revision bigint;
begin
  -- v3 owns employee/actor validation and the profile update. A failure below
  -- rolls that update back because both calls execute in this transaction.
  v_result := public.employee_update_profile_and_level_v3(
    p_user_id, p_updates, p_level_program_enabled, p_base_date_override,
    p_actor_id, p_actor_username
  );

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
      -- A second edit on the same date creates an empty historical range.
      -- It preserves the revision while leaving exactly one active row.
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

revoke all on function public.employee_update_profile_and_level_v4(bigint,jsonb,boolean,date,bigint,text)
  from public, anon, authenticated;
grant execute on function public.employee_update_profile_and_level_v4(bigint,jsonb,boolean,date,bigint,text)
  to service_role;

comment on function public.employee_update_profile_and_level_v4(bigint,jsonb,boolean,date,bigint,text) is
  'Atomically updates an employee profile and appends a Vietnam-date payroll work schedule revision when work times change.';

create or replace function public.employee_create_with_schedule_v1(
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
  v_start_time text := nullif(p_employee ->> 'work_start_time', '');
  v_end_time text := nullif(p_employee ->> 'work_end_time', '');
begin
  select * into v_actor from public.users
  where id = p_actor_id and username = p_actor_username and is_active = true
  for share;
  if not found or v_actor.role not in ('owner', 'master') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_start_time is null or v_end_time is null then
    raise exception 'WORK_SCHEDULE_TIMES_REQUIRED' using errcode = '22023';
  end if;

  insert into public.users(
    username, password, name, full_name, role, part, position, gender,
    birth_date, hire_date, termination_date, work_start_time, work_end_time,
    is_active, is_system_account
  ) values (
    p_employee ->> 'username', p_employee ->> 'password', p_employee ->> 'name',
    nullif(p_employee ->> 'full_name', ''), p_employee ->> 'role',
    nullif(p_employee ->> 'part', ''), p_employee ->> 'position',
    nullif(p_employee ->> 'gender', ''), nullif(p_employee ->> 'birth_date', '')::date,
    nullif(p_employee ->> 'hire_date', '')::date, null,
    v_start_time, v_end_time, coalesce((p_employee ->> 'is_active')::boolean, true), false
  ) returning * into v_created;

  insert into public.employee_work_schedule_versions(
    user_id, start_time, end_time, unpaid_break_minutes,
    effective_from, effective_to, revision, created_by, change_reason
  ) values (
    v_created.id, v_start_time::time, v_end_time::time, 0,
    (now() at time zone 'Asia/Ho_Chi_Minh')::date, null, 1,
    p_actor_id, 'employee_profile_create'
  );

  return to_jsonb(v_created) - 'password';
end;
$$;

revoke all on function public.employee_create_with_schedule_v1(jsonb,bigint,text)
  from public, anon, authenticated;
grant execute on function public.employee_create_with_schedule_v1(jsonb,bigint,text)
  to service_role;

comment on function public.employee_create_with_schedule_v1(jsonb,bigint,text) is
  'Atomically creates an employee and the initial Vietnam-date payroll work schedule revision.';

commit;
