begin;

create or replace function public.employee_update_profile_and_level_v3(
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
      'payroll_eligible_override'
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

  return to_jsonb(v_after);
end;
$$;

revoke all on function public.employee_update_profile_and_level_v3(bigint,jsonb,boolean,date,bigint,text)
  from public, anon, authenticated;
grant execute on function public.employee_update_profile_and_level_v3(bigint,jsonb,boolean,date,bigint,text)
  to service_role;

comment on function public.employee_update_profile_and_level_v3(bigint,jsonb,boolean,date,bigint,text) is
  'Atomically updates an employee profile, owner/master manual level inclusion, and level base-date override.';

commit;
