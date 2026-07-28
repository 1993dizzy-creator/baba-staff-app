begin;

create or replace function public.employee_update_level_policy_v1(
  p_user_id bigint,
  p_enabled boolean,
  p_base_date_override date,
  p_actor_id bigint,
  p_actor_username text,
  p_change_reason text,
  p_previous_level smallint,
  p_next_level smallint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor public.users%rowtype;
  v_before public.users%rowtype;
  v_after public.users%rowtype;
  v_action text;
begin
  if p_enabled is null then raise exception 'INVALID_LEVEL_PROGRAM_ENABLED' using errcode = '22023'; end if;
  select * into v_actor from public.users
  where id = p_actor_id and username = p_actor_username and is_active = true
  for share;
  if not found or v_actor.role not in ('owner', 'master') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_before from public.users where id = p_user_id for update;
  if not found then raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_before.is_system_account then raise exception 'SYSTEM_ACCOUNT_NOT_ELIGIBLE' using errcode = '22023'; end if;
  if v_before.termination_date is not null then raise exception 'TERMINATED_EMPLOYEE_READ_ONLY' using errcode = '22023'; end if;
  if v_before.hire_date is null then raise exception 'HIRE_DATE_REQUIRED' using errcode = '22023'; end if;
  if nullif(btrim(p_change_reason), '') is null then raise exception 'CHANGE_REASON_REQUIRED' using errcode = '22023'; end if;
  if p_base_date_override is not null and p_base_date_override < v_before.hire_date then
    raise exception 'BASE_DATE_BEFORE_HIRE_DATE' using errcode = '22023';
  end if;
  if p_base_date_override is not null and p_base_date_override > (now() at time zone 'Asia/Ho_Chi_Minh')::date then
    raise exception 'BASE_DATE_IN_FUTURE' using errcode = '22023';
  end if;
  if v_before.level_program_enabled is not distinct from p_enabled
    and v_before.level_base_date_override is not distinct from p_base_date_override then
    raise exception 'NO_CHANGES' using errcode = '22023';
  end if;

  v_action := case
    when p_enabled and v_before.level_program_enabled is distinct from true then 'level_program_enabled'
    when not p_enabled and v_before.level_program_enabled is distinct from false then 'level_program_disabled'
    when v_before.level_base_date_override is not null and p_base_date_override is null then 'level_base_date_reset_to_hire_date'
    else 'level_base_date_changed'
  end;

  update public.users
  set level_program_enabled = p_enabled,
      level_base_date_override = p_base_date_override
  where id = p_user_id
  returning * into v_after;

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
    p_previous_level, p_next_level, p_actor_id, p_actor_username, btrim(p_change_reason)
  );
  return to_jsonb(v_after);
end;
$$;

create or replace function public.employee_rehire_with_level_reset_v1(
  p_user_id bigint,
  p_rehire_date date,
  p_actor_id bigint,
  p_actor_username text,
  p_change_reason text,
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
begin
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
  return to_jsonb(v_after);
end;
$$;

revoke all on function public.employee_update_level_policy_v1(bigint,boolean,date,bigint,text,text,smallint,smallint)
  from public, anon, authenticated;
revoke all on function public.employee_rehire_with_level_reset_v1(bigint,date,bigint,text,text,smallint)
  from public, anon, authenticated;
grant execute on function public.employee_update_level_policy_v1(bigint,boolean,date,bigint,text,text,smallint,smallint)
  to service_role;
grant execute on function public.employee_rehire_with_level_reset_v1(bigint,date,bigint,text,text,smallint)
  to service_role;

commit;
