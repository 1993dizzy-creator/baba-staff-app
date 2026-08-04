begin;

alter table public.employee_level_program_versions
  add column base_date_mode text null;

alter table public.employee_level_program_versions
  drop constraint if exists employee_level_program_versions_base_check;

alter table public.employee_level_audit_logs
  add column previous_base_date_mode text null,
  add column next_base_date_mode text null,
  add constraint employee_level_audit_logs_previous_base_date_mode_check
    check (previous_base_date_mode is null or previous_base_date_mode in ('hire_date', 'override')),
  add constraint employee_level_audit_logs_next_base_date_mode_check
    check (next_base_date_mode is null or next_base_date_mode in ('hire_date', 'override'));

with current_policy as (
  select distinct on (v.user_id)
    v.user_id,
    coalesce(v.base_date, u.level_base_date_override) as current_base_date
  from public.employee_level_program_versions v
  join public.users u on u.id = v.user_id
  where v.effective_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
    and (v.effective_to is null or v.effective_to > (now() at time zone 'Asia/Ho_Chi_Minh')::date)
  order by v.user_id, v.effective_from desc, v.revision desc
), classified as (
  select v.id,
    case
      when u.is_system_account then null
      when cp.current_base_date is not null and cp.current_base_date is distinct from u.hire_date then 'override'
      when u.hire_date is not null then 'hire_date'
      else null
    end as base_date_mode,
    case when u.is_system_account then null
      when cp.current_base_date is not null and cp.current_base_date is distinct from u.hire_date
        then cp.current_base_date
      else coalesce(v.base_date, prior.base_date, u.hire_date)
    end as repaired_base_date
  from public.employee_level_program_versions v
  join public.users u on u.id = v.user_id
  left join current_policy cp on cp.user_id = v.user_id
  left join lateral (
    select p.base_date
    from public.employee_level_program_versions p
    where p.user_id = v.user_id and p.revision < v.revision and p.base_date is not null
    order by p.revision desc
    limit 1
  ) prior on true
)
update public.employee_level_program_versions v
set base_date_mode = c.base_date_mode,
    base_date = c.repaired_base_date
from classified c
where c.id = v.id;

do $$
begin
  if exists (
    select 1 from public.employee_level_program_versions
    where base_date_mode is null and base_date is not null
  ) then raise exception 'LEVEL_BASE_MODE_NULL_WITH_DATE'; end if;
  if exists (
    select 1 from public.employee_level_program_versions
    where base_date_mode is not null and base_date is null
  ) then raise exception 'LEVEL_BASE_MODE_WITHOUT_DATE'; end if;
  if exists (
    select 1
    from public.employee_level_program_versions v
    join public.users u on u.id=v.user_id
    where not u.is_system_account and (v.base_date_mode is null or v.base_date is null)
  ) then raise exception 'REGULAR_EMPLOYEE_BASE_PAIR_NULL'; end if;
  if exists (
    select 1
    from public.employee_level_program_versions v
    join public.users u on u.id=v.user_id
    where not u.is_system_account and v.base_date_mode is null
      and v.effective_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
      and (v.effective_to is null or v.effective_to > (now() at time zone 'Asia/Ho_Chi_Minh')::date)
  ) then raise exception 'REGULAR_EMPLOYEE_CURRENT_MODE_NULL'; end if;
  if exists (
    select 1
    from public.employee_level_program_versions v
    join public.users u on u.id=v.user_id
    where u.is_system_account and (v.base_date_mode is not null or v.base_date is not null)
  ) then raise exception 'SYSTEM_ACCOUNT_BASE_MODE_NOT_NULL'; end if;
end;
$$;

alter table public.employee_level_program_versions
  add constraint employee_level_program_versions_base_check
  check (
    (base_date_mode is null and base_date is null)
    or (base_date_mode = 'hire_date' and base_date is not null)
    or (base_date_mode = 'override' and base_date is not null)
  );

with current_version as (
  select distinct on (v.user_id) v.*
  from public.employee_level_program_versions v
  where v.effective_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
    and (v.effective_to is null or v.effective_to > (now() at time zone 'Asia/Ho_Chi_Minh')::date)
  order by v.user_id, v.effective_from desc, v.revision desc
)
update public.users u
set level_program_enabled = v.enabled,
    level_base_date_override = case when v.base_date_mode = 'override' then v.base_date else null end
from current_version v
where v.user_id = u.id;

create or replace function public.employee_update_profile_and_level_v6(
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
    public.employee_update_profile_and_level_v4(
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

create or replace function public.employee_create_with_schedule_v3(
  p_employee jsonb, p_level_program_enabled boolean, p_change_reason text,
  p_actor_id bigint, p_actor_username text
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_created public.users%rowtype;
  v_hire_date date := nullif(p_employee ->> 'hire_date', '')::date;
  v_effective_from date;
begin
  if nullif(btrim(p_change_reason), '') is null then raise exception 'CHANGE_REASON_REQUIRED' using errcode = '22023'; end if;

  select * into v_created from jsonb_populate_record(
    null::public.users,
    public.employee_create_with_schedule_v1(p_employee, p_actor_id, p_actor_username)
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

create or replace function public.employee_rehire_with_level_policy_v3(
  p_user_id bigint,p_rehire_date date,p_level_program_enabled boolean,p_change_reason text,
  p_actor_id bigint,p_actor_username text,p_previous_level smallint
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_after public.users%rowtype;
  v_effective_from date := date_trunc('month', p_rehire_date)::date;
  v_revision bigint;
  v_next_effective_from date;
  v_existing_id bigint;
begin
  select * into v_after from jsonb_populate_record(
    null::public.users,
    public.employee_rehire_with_level_reset_v1(
      p_user_id, p_rehire_date, p_actor_id, p_actor_username,
      p_change_reason, p_previous_level
    )
  );

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

-- Preserve the existing exact signatures while ensuring legacy callers also write
-- a complete mode/date pair under the stricter constraint.
create or replace function public.employee_create_with_schedule_v2(
  p_employee jsonb, p_level_program_enabled boolean, p_change_reason text,
  p_actor_id bigint, p_actor_username text
) returns jsonb language sql security definer set search_path = pg_catalog, public as $$
  select public.employee_create_with_schedule_v3(
    p_employee,p_level_program_enabled,p_change_reason,p_actor_id,p_actor_username
  );
$$;

create or replace function public.employee_rehire_with_level_policy_v2(
  p_user_id bigint,p_rehire_date date,p_level_program_enabled boolean,p_change_reason text,
  p_actor_id bigint,p_actor_username text,p_previous_level smallint
) returns jsonb language sql security definer set search_path = pg_catalog, public as $$
  select public.employee_rehire_with_level_policy_v3(
    p_user_id,p_rehire_date,p_level_program_enabled,p_change_reason,
    p_actor_id,p_actor_username,p_previous_level
  );
$$;

revoke all on function public.employee_update_profile_and_level_v6(bigint,jsonb,boolean,date,text,date,text,bigint,text)
  from public, anon, authenticated;
grant execute on function public.employee_update_profile_and_level_v6(bigint,jsonb,boolean,date,text,date,text,bigint,text)
  to service_role;
revoke all on function public.employee_create_with_schedule_v3(jsonb,boolean,text,bigint,text) from public,anon,authenticated;
revoke all on function public.employee_rehire_with_level_policy_v3(bigint,date,boolean,text,bigint,text,smallint) from public,anon,authenticated;
grant execute on function public.employee_create_with_schedule_v3(jsonb,boolean,text,bigint,text) to service_role;
grant execute on function public.employee_rehire_with_level_policy_v3(bigint,date,boolean,text,bigint,text,smallint) to service_role;

comment on column public.employee_level_program_versions.base_date_mode is
  'Explicit level calculation basis. hire_date uses the employee hire date; override uses base_date as an administrator-selected date. Null is reserved for unclassified system rows.';
comment on function public.employee_update_profile_and_level_v6(bigint,jsonb,boolean,date,text,date,text,bigint,text) is
  'Atomically updates an employee profile and effective-month level policy while preserving the level calculation basis independently from participation.';

commit;
