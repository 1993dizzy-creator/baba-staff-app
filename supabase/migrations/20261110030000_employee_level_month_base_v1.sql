-- DRAFT — NOT APPLIED. Month-based employee level base ("기준월") v1.
-- Requires separate Owner approval before any production use. Do not run as-is.
--
-- Scope
-- * Adds month-based base modes next to the legacy date modes:
--     hire_month     : base month derived from the hire date (day 1–15 -> hire month,
--                      day 16+ -> next month); stored base_date = that month's 1st.
--     override_month : admin-chosen base month, stored as "YYYY-MM-01"; never before the
--                      actual hire month.
--   Lv.0 starts on the base month's 1st; promotions on the 1st of base +3/+6/+9 ... months.
-- * Legacy 'hire_date' / 'override' rows and their audit logs are NOT rewritten. No
--   existing date is snapped to a 1st. Nothing here touches payroll payments, their
--   calculation_snapshot / calculation_hash, amounts or statuses.
-- * Adds salary_raise_enabled (default true = current behaviour) so the level program
--   and the payment of its raise are separate decisions (e.g. a part-timer on the level
--   program without a raise). Hourly pay never receives the level raise (app rule).
-- * Same-month in-place updates now keep the full before/after version row in the audit.
-- * New RPCs: employee_update_profile_and_level_v10, employee_create_with_schedule_v6,
--   employee_rehire_with_level_policy_v4. v9 / v5 / v3 stay in place (not dropped).
--
-- Order of operations for production (each step needs approval):
--   1. this migration  2. deploy the app that calls v10/v6/v4 and selects the new columns
--   3. later, optionally revoke v9/v5/v3.

-- 1. Columns (defaults keep every existing row's behaviour) ------------------------------
-- Execute this entire file on one connection; on error ROLLBACK before retrying.
-- DDL, SECURITY DEFINER creation and final ACLs become visible together at COMMIT.
BEGIN;

alter table public.employee_level_program_versions
  add column salary_raise_enabled boolean not null default true;

alter table public.users
  add column level_base_mode text;

alter table public.employee_level_audit_logs
  add column previous_salary_raise_enabled boolean,
  add column next_salary_raise_enabled boolean,
  add column previous_version_snapshot jsonb,
  add column next_version_snapshot jsonb;

-- 2. Constraints widened for the month modes (all existing rows satisfy them) -----------
alter table public.employee_level_program_versions
  drop constraint employee_level_program_versions_base_check;
alter table public.employee_level_program_versions
  add constraint employee_level_program_versions_base_check check (
    (base_date_mode is null and base_date is null)
    or (base_date_mode in ('hire_date', 'override') and base_date is not null)
    or (base_date_mode in ('hire_month', 'override_month') and base_date is not null
        and extract(day from base_date) = 1)
  );

alter table public.employee_level_audit_logs
  drop constraint employee_level_audit_logs_previous_base_date_mode_check,
  drop constraint employee_level_audit_logs_next_base_date_mode_check,
  drop constraint employee_level_audit_logs_action_check;
alter table public.employee_level_audit_logs
  add constraint employee_level_audit_logs_previous_base_date_mode_check check (
    previous_base_date_mode is null
    or previous_base_date_mode in ('hire_date', 'override', 'hire_month', 'override_month')),
  add constraint employee_level_audit_logs_next_base_date_mode_check check (
    next_base_date_mode is null
    or next_base_date_mode in ('hire_date', 'override', 'hire_month', 'override_month')),
  add constraint employee_level_audit_logs_action_check check (action in (
    'level_program_enabled', 'level_program_disabled', 'level_base_date_changed',
    'level_base_date_reset_to_hire_date', 'level_reset_on_rehire', 'level_salary_raise_changed'));

alter table public.users
  add constraint users_level_base_mode_check check (
    level_base_mode is null or level_base_mode in ('hire_month', 'override_month')),
  -- hire_month derives its month from hire_date: no stored override.
  add constraint users_level_hire_month_no_override_check check (
    level_base_mode is distinct from 'hire_month' or level_base_date_override is null),
  -- override_month stores the base month's 1st.
  add constraint users_level_override_month_start_check check (
    level_base_mode is distinct from 'override_month'
    or (level_base_date_override is not null and extract(day from level_base_date_override) = 1));

-- A base month may equal the hire month even when the hire day is after the 1st.
alter table public.users drop constraint users_level_base_date_not_before_hire_check;
alter table public.users
  add constraint users_level_base_date_not_before_hire_check check (
    level_base_date_override is null or hire_date is null
    or level_base_date_override >= hire_date
    or (level_base_mode = 'override_month'
        and level_base_date_override >= date_trunc('month', hire_date)::date));

alter table public.users drop constraint users_system_account_level_settings_check;
alter table public.users
  add constraint users_system_account_level_settings_check check (
    is_system_account = false
    or (level_program_enabled is distinct from true and level_base_date_override is null
        and level_base_mode is null));

-- 3. Hire-month rule (single source in SQL) --------------------------------------------
create function public.employee_level_hire_month_base(p_hire_date date)
returns date language sql immutable set search_path = pg_catalog as $$
  select case
    when p_hire_date is null then null
    when extract(day from p_hire_date) <= 15 then date_trunc('month', p_hire_date)::date
    else (date_trunc('month', p_hire_date) + interval '1 month')::date
  end
$$;

-- 4. Profile + level save v10 (v9 + month modes + raise flag + full audit snapshots) ----
create function public.employee_update_profile_and_level_v10(
  p_user_id bigint, p_updates jsonb, p_level_program_enabled boolean, p_effective_from date,
  p_base_date_mode text, p_base_date_override date, p_salary_raise_enabled boolean,
  p_change_reason text, p_actor_id bigint, p_actor_username text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $function$
declare
  v_actor public.users%rowtype;
  v_before public.users%rowtype;
  v_after public.users%rowtype;
  v_hire_date date;
  v_termination_date date;
  v_role text;
  v_pass_level_program_enabled boolean;
  v_pass_base_date_override date;
  v_pass_base_mode text;
  v_next_attendance_tracking_enabled boolean;
  v_instant_level_action text;
  v_work_start_time text;
  v_work_end_time text;
  v_schedule_effective_date date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_schedule_current public.employee_work_schedule_versions%rowtype;
  v_schedule_revision bigint;
  v_level_target public.employee_level_program_versions%rowtype;
  v_level_written public.employee_level_program_versions%rowtype;
  v_level_active public.employee_level_program_versions%rowtype;
  v_level_revision bigint;
  v_level_base_date date;
  v_salary_raise_enabled boolean;
  v_level_next_effective_from date;
  v_current_month date := date_trunc('month', now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_level_version_action text;
  v_previous_snapshot jsonb;
begin
  -- === profile / attendance / login / role fields (unchanged from v9) ===
  if p_updates is null or jsonb_typeof(p_updates) <> 'object' then
    raise exception 'INVALID_EMPLOYEE_UPDATES' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_updates) as keys(key_name)
    where key_name not in (
      'name', 'full_name', 'role', 'part', 'position', 'gender',
      'birth_date', 'hire_date', 'termination_date',
      'work_start_time', 'work_end_time', 'is_active',
      'payroll_eligible_override', 'attendance_tracking_enabled', 'app_login_enabled')
  ) then
    raise exception 'INVALID_EMPLOYEE_UPDATE_KEY' using errcode = '22023';
  end if;

  select * into v_actor from public.users
  where id = p_actor_id and username = p_actor_username and is_active = true for share;
  if not found or v_actor.role not in ('owner', 'master') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_before from public.users where id = p_user_id for update;
  if not found then raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0002'; end if;

  v_role := case when p_updates ? 'role' then nullif(btrim(p_updates ->> 'role'), '') else v_before.role end;
  v_pass_level_program_enabled := case
    when v_role in ('owner', 'master') and v_before.level_program_enabled is true then true
    when v_role in ('owner', 'master') then null
    else v_before.level_program_enabled
  end;
  v_pass_base_date_override := case
    when v_role in ('owner', 'master') and v_pass_level_program_enabled is distinct from true then null
    else v_before.level_base_date_override
  end;
  v_pass_base_mode := case
    when v_role in ('owner', 'master') and v_pass_level_program_enabled is distinct from true then null
    else v_before.level_base_mode
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
    and (v_before.level_program_enabled is distinct from v_pass_level_program_enabled
      or v_before.level_base_date_override is distinct from v_pass_base_date_override
      or v_before.level_base_mode is distinct from v_pass_base_mode) then
    raise exception 'TERMINATED_EMPLOYEE_READ_ONLY' using errcode = '22023';
  end if;

  v_hire_date := case when p_updates ? 'hire_date' then nullif(p_updates ->> 'hire_date', '')::date else v_before.hire_date end;
  v_termination_date := case when p_updates ? 'termination_date' then nullif(p_updates ->> 'termination_date', '')::date else v_before.termination_date end;

  if not v_before.is_system_account
    and (v_role in ('manager', 'leader', 'staff') or v_pass_level_program_enabled is true)
    and v_hire_date is null then
    raise exception 'HIRE_DATE_REQUIRED' using errcode = '22023';
  end if;
  if v_termination_date is not null and v_termination_date < v_hire_date then
    raise exception 'TERMINATION_DATE_BEFORE_HIRE_DATE' using errcode = '22023';
  end if;
  -- Mirror checks: date rules for legacy overrides, month rules for override_month.
  if v_pass_base_date_override is not null then
    if v_pass_base_mode = 'override_month' then
      if v_pass_base_date_override < date_trunc('month', v_hire_date)::date then
        raise exception 'BASE_MONTH_BEFORE_HIRE_MONTH' using errcode = '22023';
      end if;
    else
      if v_pass_base_date_override < v_hire_date then
        raise exception 'BASE_DATE_BEFORE_HIRE_DATE' using errcode = '22023';
      end if;
      if v_pass_base_date_override > v_today then
        raise exception 'BASE_DATE_IN_FUTURE' using errcode = '22023';
      end if;
    end if;
    if v_termination_date is not null and v_pass_base_date_override > v_termination_date then
      raise exception 'BASE_DATE_AFTER_TERMINATION_DATE' using errcode = '22023';
    end if;
  end if;

  v_next_attendance_tracking_enabled := case
    when p_updates ? 'attendance_tracking_enabled'
      then coalesce((p_updates ->> 'attendance_tracking_enabled')::boolean, true)
    else v_before.attendance_tracking_enabled
  end;
  if v_before.attendance_tracking_enabled = true and v_next_attendance_tracking_enabled = false
    and exists (select 1 from public.attendance_records
      where user_id = p_user_id and check_in_at is not null and check_out_at is null) then
    raise exception 'ATTENDANCE_OPEN_RECORD_EXISTS' using errcode = '55000';
  end if;

  update public.users set
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
      when p_updates ? 'app_login_enabled' then coalesce((p_updates ->> 'app_login_enabled')::boolean, true)
      else v_before.app_login_enabled
    end,
    level_program_enabled = v_pass_level_program_enabled,
    level_base_date_override = v_pass_base_date_override,
    level_base_mode = v_pass_base_mode
  where id = p_user_id
  returning * into v_after;

  if not v_before.is_system_account
    and (v_before.level_program_enabled is distinct from v_after.level_program_enabled
      or v_before.level_base_date_override is distinct from v_after.level_base_date_override
      or v_before.level_base_mode is distinct from v_after.level_base_mode) then
    v_instant_level_action := case
      when v_before.level_program_enabled is distinct from true and v_after.level_program_enabled is true then 'level_program_enabled'
      when v_before.level_program_enabled is true and v_after.level_program_enabled is distinct from true then 'level_program_disabled'
      when v_before.level_base_date_override is not null and v_after.level_base_date_override is null then 'level_base_date_reset_to_hire_date'
      else 'level_base_date_changed'
    end;
    insert into public.employee_level_audit_logs(
      user_id, action, previous_enabled, next_enabled,
      previous_base_date_override, next_base_date_override,
      previous_base_date_mode, next_base_date_mode,
      previous_effective_base_date, next_effective_base_date,
      previous_level, next_level, actor_id, actor_username, change_reason
    ) values (
      p_user_id, v_instant_level_action, v_before.level_program_enabled, v_after.level_program_enabled,
      v_before.level_base_date_override, v_after.level_base_date_override,
      v_before.level_base_mode, v_after.level_base_mode,
      coalesce(v_before.level_base_date_override, v_before.hire_date),
      coalesce(v_after.level_base_date_override, v_after.hire_date),
      null, null, p_actor_id, p_actor_username, 'employee_profile_save'
    );
  end if;

  -- A hire-date edit must not silently move a stored automatic base month: the change
  -- has to be saved as a new level version (p_effective_from) so history stays fixed.
  if v_before.hire_date is distinct from v_after.hire_date and p_effective_from is null
    and exists (select 1 from public.employee_level_program_versions
      where user_id = p_user_id and base_date_mode = 'hire_month'
        and effective_to is null
        and base_date is distinct from public.employee_level_hire_month_base(v_after.hire_date)) then
    raise exception 'LEVEL_BASE_MONTH_REVIEW_REQUIRED' using errcode = '22023';
  end if;

  -- === work schedule (unchanged from v9) ===
  if coalesce(v_after.attendance_tracking_enabled, true) then
    v_work_start_time := nullif(v_after.work_start_time::text, '');
    v_work_end_time := nullif(v_after.work_end_time::text, '');
    if v_work_start_time is null or v_work_end_time is null then
      raise exception 'WORK_SCHEDULE_TIMES_REQUIRED' using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock(-p_user_id);
    select * into v_schedule_current from public.employee_work_schedule_versions
    where user_id = p_user_id and effective_to is null
    order by effective_from desc, revision desc limit 1 for update;
    if v_schedule_current.id is null
      or v_schedule_current.start_time is distinct from v_work_start_time::time
      or v_schedule_current.end_time is distinct from v_work_end_time::time then
      if v_schedule_current.id is not null then
        if v_schedule_current.effective_from > v_schedule_effective_date then
          raise exception 'WORK_SCHEDULE_FUTURE_VERSION_CONFLICT' using errcode = '23P01';
        end if;
        update public.employee_work_schedule_versions set effective_to = v_schedule_effective_date
        where id = v_schedule_current.id;
      end if;
      select coalesce(max(revision), 0) + 1 into v_schedule_revision
      from public.employee_work_schedule_versions where user_id = p_user_id;
      insert into public.employee_work_schedule_versions(
        user_id, start_time, end_time, unpaid_break_minutes,
        effective_from, effective_to, revision, created_by, change_reason
      ) values (
        p_user_id, v_work_start_time::time, v_work_end_time::time, 0,
        v_schedule_effective_date, null, v_schedule_revision, p_actor_id, 'employee_profile_save'
      );
    end if;
  end if;

  -- === effective-month level policy version ===
  if p_effective_from is null then return to_jsonb(v_after) - 'password'; end if;
  if p_effective_from <> date_trunc('month', p_effective_from)::date
    or p_effective_from < v_current_month
    or p_effective_from > (v_current_month + interval '1 month')::date then
    raise exception 'INVALID_LEVEL_EFFECTIVE_MONTH' using errcode = '22023';
  end if;
  if p_base_date_mode is null or p_base_date_mode not in ('hire_date', 'override', 'hire_month', 'override_month') then
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

  v_level_base_date := case p_base_date_mode
    when 'hire_date' then v_after.hire_date
    when 'override' then p_base_date_override
    when 'hire_month' then public.employee_level_hire_month_base(v_after.hire_date)
    else p_base_date_override
  end;
  if v_level_base_date is null then
    if p_base_date_mode = 'override_month' then
      raise exception 'INVALID_BASE_MONTH' using errcode = '22023';
    end if;
    raise exception 'HIRE_DATE_REQUIRED' using errcode = '22023';
  end if;
  if p_base_date_mode in ('hire_date', 'override') then
    -- Legacy date rules, exactly as v9.
    if v_after.hire_date is not null and v_level_base_date < v_after.hire_date then
      raise exception 'BASE_DATE_BEFORE_HIRE_DATE' using errcode = '22023';
    end if;
    if v_level_base_date > v_today then
      raise exception 'BASE_DATE_IN_FUTURE' using errcode = '22023';
    end if;
  else
    if extract(day from v_level_base_date) <> 1 then
      raise exception 'INVALID_BASE_MONTH' using errcode = '22023';
    end if;
    if v_after.hire_date is null then
      raise exception 'HIRE_DATE_REQUIRED' using errcode = '22023';
    end if;
    if v_level_base_date < date_trunc('month', v_after.hire_date)::date then
      raise exception 'BASE_MONTH_BEFORE_HIRE_MONTH' using errcode = '22023';
    end if;
  end if;
  if v_after.termination_date is not null and v_level_base_date > v_after.termination_date then
    raise exception 'BASE_DATE_AFTER_TERMINATION_DATE' using errcode = '22023';
  end if;

  select * into v_level_target from public.employee_level_program_versions
  where user_id = p_user_id
    and effective_from <= p_effective_from
    and (effective_to is null or effective_to > p_effective_from)
  order by effective_from desc, revision desc
  limit 1 for update;

  -- Turning the level ON (no version, or the version in force is OFF) needs an explicit
  -- raise decision; otherwise NULL keeps the decision of the version in force.
  if p_level_program_enabled and v_level_target.enabled is distinct from true and p_salary_raise_enabled is null then
    raise exception 'SALARY_RAISE_DECISION_REQUIRED' using errcode = '22023';
  end if;
  v_salary_raise_enabled := coalesce(p_salary_raise_enabled, v_level_target.salary_raise_enabled, true);

  if found
    and v_level_target.enabled is not distinct from p_level_program_enabled
    and v_level_target.base_date_mode is not distinct from p_base_date_mode
    and v_level_target.base_date is not distinct from v_level_base_date
    and v_level_target.salary_raise_enabled is not distinct from v_salary_raise_enabled then
    return to_jsonb(v_after) - 'password';
  end if;

  v_level_version_action := case
    when v_level_target.enabled is distinct from p_level_program_enabled
      then case when p_level_program_enabled then 'level_program_enabled' else 'level_program_disabled' end
    when v_level_target.base_date_mode is not distinct from p_base_date_mode
      and v_level_target.base_date is not distinct from v_level_base_date
      then 'level_salary_raise_changed'
    when p_base_date_mode in ('hire_date', 'hire_month') then 'level_base_date_reset_to_hire_date'
    else 'level_base_date_changed'
  end;
  -- Full row before any change: an in-place same-month update no longer loses the
  -- previous reason / author / time.
  v_previous_snapshot := case when v_level_target.id is null then null else to_jsonb(v_level_target) end;

  if v_level_target.effective_from = p_effective_from then
    update public.employee_level_program_versions
    set enabled = p_level_program_enabled,
        base_date_mode = p_base_date_mode,
        base_date = v_level_base_date,
        salary_raise_enabled = v_salary_raise_enabled,
        change_reason = btrim(p_change_reason),
        created_by = p_actor_id,
        created_by_username = p_actor_username,
        created_at = now()
    where id = v_level_target.id
    returning * into v_level_written;
  else
    select min(effective_from) into v_level_next_effective_from
    from public.employee_level_program_versions
    where user_id = p_user_id and effective_from > p_effective_from;

    update public.employee_level_program_versions set effective_to = p_effective_from
    where id = v_level_target.id and v_level_target.effective_from < p_effective_from;

    select coalesce(max(revision), 0) + 1 into v_level_revision
    from public.employee_level_program_versions where user_id = p_user_id;

    insert into public.employee_level_program_versions (
      user_id, enabled, effective_from, effective_to, base_date, base_date_mode, salary_raise_enabled,
      revision, change_reason, created_by, created_by_username
    ) values (
      p_user_id, p_level_program_enabled, p_effective_from, v_level_next_effective_from,
      v_level_base_date, p_base_date_mode, v_salary_raise_enabled,
      v_level_revision, btrim(p_change_reason), p_actor_id, p_actor_username
    ) returning * into v_level_written;
  end if;

  select * into v_level_active from public.employee_level_program_versions
  where user_id = p_user_id
    and effective_from <= v_today
    and (effective_to is null or effective_to > v_today)
  order by effective_from desc, revision desc limit 1;

  update public.users
  set level_program_enabled = v_level_active.enabled,
      level_base_date_override = case when v_level_active.base_date_mode in ('override', 'override_month') then v_level_active.base_date else null end,
      level_base_mode = case when v_level_active.base_date_mode in ('hire_month', 'override_month') then v_level_active.base_date_mode else null end
  where id = p_user_id returning * into v_after;

  insert into public.employee_level_audit_logs (
    user_id, action, previous_enabled, next_enabled,
    previous_base_date_override, next_base_date_override,
    previous_base_date_mode, next_base_date_mode,
    previous_effective_base_date, next_effective_base_date,
    previous_salary_raise_enabled, next_salary_raise_enabled,
    previous_version_snapshot, next_version_snapshot,
    previous_level, next_level, actor_id, actor_username, change_reason, created_at
  ) values (
    p_user_id, v_level_version_action, v_level_target.enabled, p_level_program_enabled,
    case when v_level_target.base_date_mode in ('override', 'override_month') then v_level_target.base_date else null end,
    case when p_base_date_mode in ('override', 'override_month') then v_level_base_date else null end,
    v_level_target.base_date_mode, p_base_date_mode,
    v_level_target.base_date, v_level_base_date,
    v_level_target.salary_raise_enabled, v_salary_raise_enabled,
    v_previous_snapshot, to_jsonb(v_level_written),
    null, null, p_actor_id, p_actor_username, btrim(p_change_reason), now()
  );

  return to_jsonb(v_after) - 'password';
end;
$function$;

-- 5. Create v6 (v5 + base mode, default hire_month, + raise flag) ----------------------
create function public.employee_create_with_schedule_v6(
  p_employee jsonb, p_level_program_enabled boolean, p_base_date_mode text, p_base_date_override date,
  p_salary_raise_enabled boolean, p_change_reason text, p_actor_id bigint, p_actor_username text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $function$
declare
  v_actor public.users%rowtype;
  v_created public.users%rowtype;
  v_attendance_tracking_enabled boolean := coalesce((p_employee ->> 'attendance_tracking_enabled')::boolean, true);
  v_app_login_enabled boolean := coalesce((p_employee ->> 'app_login_enabled')::boolean, true);
  v_start_time text := nullif(p_employee ->> 'work_start_time', '');
  v_end_time text := nullif(p_employee ->> 'work_end_time', '');
  v_hire_date date := nullif(p_employee ->> 'hire_date', '')::date;
  v_mode text := coalesce(p_base_date_mode, 'hire_month');
  v_base_date date;
  v_schedule_effective_from date;
  v_effective_from date;
begin
  if nullif(btrim(p_change_reason), '') is null then
    raise exception 'CHANGE_REASON_REQUIRED' using errcode = '22023';
  end if;
  -- New employees use the month rules; legacy date modes are not offered here.
  if v_mode not in ('hire_month', 'override_month') then
    raise exception 'INVALID_BASE_DATE_MODE' using errcode = '22023';
  end if;

  select * into v_actor from public.users
  where id = p_actor_id and username = p_actor_username and is_active = true for share;
  if not found or v_actor.role not in ('owner', 'master') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_attendance_tracking_enabled and (v_start_time is null or v_end_time is null) then
    raise exception 'WORK_SCHEDULE_TIMES_REQUIRED' using errcode = '22023';
  end if;
  if not v_attendance_tracking_enabled then v_start_time := null; v_end_time := null; end if;
  if v_hire_date is null then raise exception 'HIRE_DATE_REQUIRED' using errcode = '22023'; end if;
  if p_level_program_enabled and p_salary_raise_enabled is null then
    raise exception 'SALARY_RAISE_DECISION_REQUIRED' using errcode = '22023';
  end if;

  v_base_date := case when v_mode = 'hire_month' then public.employee_level_hire_month_base(v_hire_date) else p_base_date_override end;
  if v_base_date is null or extract(day from v_base_date) <> 1 then
    raise exception 'INVALID_BASE_MONTH' using errcode = '22023';
  end if;
  if v_base_date < date_trunc('month', v_hire_date)::date then
    raise exception 'BASE_MONTH_BEFORE_HIRE_MONTH' using errcode = '22023';
  end if;

  insert into public.users(
    username, password, name, full_name, role, part, position, gender,
    birth_date, hire_date, termination_date, work_start_time, work_end_time,
    is_active, is_system_account, attendance_tracking_enabled, app_login_enabled
  ) values (
    p_employee ->> 'username', p_employee ->> 'password', p_employee ->> 'name',
    nullif(p_employee ->> 'full_name', ''), p_employee ->> 'role', nullif(p_employee ->> 'part', ''),
    p_employee ->> 'position', nullif(p_employee ->> 'gender', ''),
    nullif(p_employee ->> 'birth_date', '')::date, v_hire_date, null, v_start_time, v_end_time,
    coalesce((p_employee ->> 'is_active')::boolean, true), false,
    v_attendance_tracking_enabled, v_app_login_enabled
  ) returning * into v_created;

  if v_attendance_tracking_enabled then
    v_schedule_effective_from := coalesce(v_hire_date, (now() at time zone 'Asia/Ho_Chi_Minh')::date);
    insert into public.employee_work_schedule_versions(
      user_id, start_time, end_time, unpaid_break_minutes,
      effective_from, effective_to, revision, created_by, change_reason
    ) values (
      v_created.id, v_start_time::time, v_end_time::time, 0,
      v_schedule_effective_from, null, 1, p_actor_id, 'employee_profile_create'
    );
  end if;

  v_effective_from := date_trunc('month', v_hire_date)::date;
  update public.users
  set level_program_enabled = p_level_program_enabled,
      level_base_date_override = case when v_mode = 'override_month' then v_base_date else null end,
      level_base_mode = v_mode
  where id = v_created.id returning * into v_created;

  insert into public.employee_level_program_versions (
    user_id, enabled, effective_from, effective_to, base_date, base_date_mode, salary_raise_enabled,
    revision, change_reason, created_by, created_by_username
  ) values (
    v_created.id, p_level_program_enabled, v_effective_from, null, v_base_date, v_mode,
    coalesce(p_salary_raise_enabled, true), 1, btrim(p_change_reason), p_actor_id, p_actor_username
  );

  return to_jsonb(v_created) - 'password';
end;
$function$;

-- 6. Rehire v4 (v3 + hire_month base for the new hire date + explicit raise decision +
--    audit snapshot) -----------------------------------------------------------------
create function public.employee_rehire_with_level_policy_v4(
  p_user_id bigint, p_rehire_date date, p_level_program_enabled boolean, p_change_reason text,
  p_actor_id bigint, p_actor_username text, p_previous_level smallint, p_salary_raise_enabled boolean)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $function$
declare
  v_actor public.users%rowtype;
  v_before public.users%rowtype;
  v_after public.users%rowtype;
  v_effective_from date := date_trunc('month', p_rehire_date)::date;
  v_base_date date := public.employee_level_hire_month_base(p_rehire_date);
  v_revision bigint;
  v_next_effective_from date;
  v_existing public.employee_level_program_versions%rowtype;
  v_previous public.employee_level_program_versions%rowtype;
  v_saved public.employee_level_program_versions%rowtype;
begin
  if p_rehire_date is null then raise exception 'INVALID_REHIRE_DATE' using errcode = '22023'; end if;
  if nullif(btrim(p_change_reason), '') is null then raise exception 'CHANGE_REASON_REQUIRED' using errcode = '22023'; end if;
  -- Rehire with the level ON needs an explicit raise decision (no silent raise).
  if p_level_program_enabled and p_salary_raise_enabled is null then
    raise exception 'SALARY_RAISE_DECISION_REQUIRED' using errcode = '22023';
  end if;
  select * into v_actor from public.users
  where id = p_actor_id and username = p_actor_username and is_active = true for share;
  if not found or v_actor.role not in ('owner', 'master') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_before from public.users where id = p_user_id for update;
  if not found then raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_before.is_system_account or v_before.is_active is distinct from false or v_before.termination_date is null then
    raise exception 'REHIRE_NOT_ALLOWED' using errcode = '22023';
  end if;

  update public.users set
    hire_date = p_rehire_date, termination_date = null, is_active = true,
    level_program_enabled = null, level_base_date_override = null, level_base_mode = null
  where id = p_user_id returning * into v_after;

  select min(effective_from) into v_next_effective_from
  from public.employee_level_program_versions
  where user_id = p_user_id and effective_from > v_effective_from;

  -- Capture the policy in force before closing any interval. A same-month row
  -- is separately retained as the exact preimage when it is overwritten.
  select * into v_previous from public.employee_level_program_versions
  where user_id = p_user_id and effective_from <= v_effective_from
    and (effective_to is null or effective_to > v_effective_from)
  order by effective_from desc, revision desc limit 1 for update;

  update public.employee_level_program_versions set effective_to = v_effective_from
  where user_id = p_user_id and effective_from < v_effective_from
    and (effective_to is null or effective_to > v_effective_from);

  select * into v_existing from public.employee_level_program_versions
  where user_id = p_user_id and effective_from = v_effective_from
  order by revision desc limit 1 for update;

  if v_existing.id is not null then
    update public.employee_level_program_versions
    set enabled = p_level_program_enabled, effective_to = v_next_effective_from,
        base_date = v_base_date, base_date_mode = 'hire_month', salary_raise_enabled = coalesce(p_salary_raise_enabled, true),
        change_reason = btrim(p_change_reason), created_by = p_actor_id,
        created_by_username = p_actor_username, created_at = now()
    where id = v_existing.id returning * into v_saved;
  else
    select coalesce(max(revision), 0) + 1 into v_revision
    from public.employee_level_program_versions where user_id = p_user_id;
    insert into public.employee_level_program_versions (
      user_id, enabled, effective_from, effective_to, base_date, base_date_mode, salary_raise_enabled,
      revision, change_reason, created_by, created_by_username
    ) values (
      p_user_id, p_level_program_enabled, v_effective_from, v_next_effective_from, v_base_date, 'hire_month', coalesce(p_salary_raise_enabled, true),
      v_revision, btrim(p_change_reason), p_actor_id, p_actor_username
    ) returning * into v_saved;
  end if;

  insert into public.employee_level_audit_logs(
    user_id, action, previous_enabled, next_enabled,
    previous_base_date_override, next_base_date_override,
    previous_base_date_mode, next_base_date_mode,
    previous_effective_base_date, next_effective_base_date,
    previous_salary_raise_enabled, next_salary_raise_enabled,
    previous_version_snapshot, next_version_snapshot,
    previous_level, next_level, actor_id, actor_username, change_reason
  ) values (
    p_user_id, 'level_reset_on_rehire', v_previous.enabled, v_saved.enabled,
    v_before.level_base_date_override, null, v_previous.base_date_mode, v_saved.base_date_mode,
    v_previous.base_date, v_saved.base_date,
    v_previous.salary_raise_enabled, v_saved.salary_raise_enabled,
    case when v_existing.id is not null then to_jsonb(v_existing)
         when v_previous.id is not null then to_jsonb(v_previous) else null end,
    to_jsonb(v_saved),
    p_previous_level, null, p_actor_id, p_actor_username, btrim(p_change_reason)
  );

  update public.users
  set level_program_enabled = p_level_program_enabled, level_base_date_override = null, level_base_mode = 'hire_month'
  where id = p_user_id returning * into v_after;

  return to_jsonb(v_after) - 'password';
end;
$function$;

-- 7. Privileges: same as v9/v5/v3 (service_role only) ---------------------------------
revoke all on function public.employee_level_hire_month_base(date),
  public.employee_update_profile_and_level_v10(bigint, jsonb, boolean, date, text, date, boolean, text, bigint, text),
  public.employee_create_with_schedule_v6(jsonb, boolean, text, date, boolean, text, bigint, text),
  public.employee_rehire_with_level_policy_v4(bigint, date, boolean, text, bigint, text, smallint, boolean)
  from public, anon, authenticated;
grant execute on function public.employee_level_hire_month_base(date),
  public.employee_update_profile_and_level_v10(bigint, jsonb, boolean, date, text, date, boolean, text, bigint, text),
  public.employee_create_with_schedule_v6(jsonb, boolean, text, date, boolean, text, bigint, text),
  public.employee_rehire_with_level_policy_v4(bigint, date, boolean, text, bigint, text, smallint, boolean)
  to service_role;

COMMIT;