-- Additive save guard. Existing v10 and historical policy/payment rows are unchanged.
-- New policy changes start next month, automatically pay level raises when ON,
-- and must not overwrite any scheduled policy. Basic profile saves preserve policy.
BEGIN;
create or replace function public.employee_update_profile_and_level_v11(
  p_user_id bigint,p_updates jsonb,p_level_program_enabled boolean,p_effective_from date,
  p_base_date_mode text,p_base_date_override date,p_salary_raise_enabled boolean,
  p_change_reason text,p_actor_id bigint,p_actor_username text,
  p_expected_version_id bigint,p_expected_revision bigint
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_user public.users%rowtype;
  v_current public.employee_level_program_versions%rowtype;
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_next_month date := (date_trunc('month',now() at time zone 'Asia/Ho_Chi_Minh')+interval '1 month')::date;
  v_mode text;v_base date;v_hire date;v_enabled boolean;v_raise boolean;v_changed boolean;
  v_effective date;v_pass_mode text;v_pass_override date;
begin
  perform 1 from public.users where id=p_actor_id and username=p_actor_username
    and is_active and role in('owner','master') for share;
  if not found then raise exception 'FORBIDDEN' using errcode='42501';end if;
  -- v10 also locks this user: old and new callers serialize on the same row.
  select * into v_user from public.users where id=p_user_id for update;
  if not found then raise exception 'EMPLOYEE_NOT_FOUND' using errcode='P0002';end if;
  select * into v_current from public.employee_level_program_versions
    where user_id=p_user_id and effective_from<=v_today and (effective_to is null or effective_to>v_today)
    order by revision desc limit 1 for share;
  if v_current.id is distinct from p_expected_version_id or v_current.revision is distinct from p_expected_revision then
    raise exception 'LEVEL_POLICY_STALE' using errcode='40001';
  end if;
  v_mode := coalesce(v_current.base_date_mode,v_user.level_base_mode,
    case when v_user.level_base_date_override is not null then 'override' else 'hire_date' end);
  v_base := coalesce(v_current.base_date,v_user.level_base_date_override,v_user.hire_date);
  v_enabled := coalesce(v_current.enabled,case when v_user.level_program_enabled is false then false
    else v_user.role in('manager','leader','staff') or v_user.level_program_enabled is true end);
  v_raise := coalesce(v_current.salary_raise_enabled,true);
  if p_effective_from is null then
    -- Never copy a client draft or a future reservation into today's policy mirrors.
    v_pass_mode := v_mode;
    v_pass_override := case when v_mode in('override','override_month') then v_base else null end;
  else
    if p_effective_from<>v_next_month then raise exception 'INVALID_LEVEL_EFFECTIVE_MONTH' using errcode='22023';end if;
    if p_base_date_mode not in('hire_month','override_month') or p_base_date_mode is null then
      raise exception 'LEVEL_MONTH_BASE_REQUIRED' using errcode='22023';end if;
    v_hire := case when p_updates ? 'hire_date' then nullif(p_updates->>'hire_date','')::date else v_user.hire_date end;
    v_pass_mode := p_base_date_mode;
    v_pass_override := case when p_base_date_mode='override_month' then p_base_date_override else null end;
    v_changed := v_enabled is distinct from p_level_program_enabled or v_mode is distinct from p_base_date_mode
      or v_base is distinct from (case when p_base_date_mode='hire_month' then public.employee_level_hire_month_base(v_hire) else p_base_date_override end)
      or (p_level_program_enabled and not v_raise);
    if v_changed then
      if exists(select 1 from public.employee_level_program_versions where user_id=p_user_id and effective_from>v_today) then
        raise exception 'LEVEL_POLICY_SCHEDULED_CHANGE_EXISTS' using errcode='55000';end if;
      v_effective := v_next_month;
      v_enabled := p_level_program_enabled;
      if v_enabled then v_raise := true;end if;
    end if;
  end if;
  return public.employee_update_profile_and_level_v10(p_user_id,p_updates,v_enabled,v_effective,
    v_pass_mode,v_pass_override,v_raise,case when v_effective is not null then p_change_reason else null end,p_actor_id,p_actor_username);
end $$;
revoke all on function public.employee_update_profile_and_level_v11(bigint,jsonb,boolean,date,text,date,boolean,text,bigint,text,bigint,bigint) from public,anon,authenticated;
grant execute on function public.employee_update_profile_and_level_v11(bigint,jsonb,boolean,date,text,date,boolean,text,bigint,text,bigint,bigint) to service_role;
COMMIT;
