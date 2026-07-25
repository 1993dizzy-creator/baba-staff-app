-- Adds per-policy early-leave and missing-checkout grace settings so the Shadow
-- attendance engine can judge departure per employee (users.work_end_time vs the
-- actual store close for that business day) instead of a single store-wide fixed
-- checkout time.
--
-- default_normal_checkout_time is intentionally NOT dropped: existing revisions,
-- the store_setting_snapshot_v1 payload shape, and any historical audit-log
-- snapshots still reference it. It is kept as a deprecated, unused-by-Shadow
-- column for rollback safety and historical readability.

alter table public.store_attendance_policies
  add column early_leave_grace_minutes integer not null default 0,
  add column missing_checkout_grace_minutes integer not null default 60,
  add constraint store_attendance_policies_early_leave_grace_check
    check (early_leave_grace_minutes between 0 and 180),
  add constraint store_attendance_policies_missing_checkout_grace_check
    check (missing_checkout_grace_minutes between 0 and 360);

comment on column public.store_attendance_policies.default_normal_checkout_time is
  'Deprecated: fixed store-wide checkout time. Kept for historical revision/API compatibility only; the Shadow attendance engine no longer reads it. See early_leave_grace_minutes / missing_checkout_grace_minutes, applied against the employee''s own effective scheduled end time.';
comment on column public.store_attendance_policies.early_leave_grace_minutes is
  'Minutes of tolerance before an early checkout (relative to the employee''s effective scheduled end time, i.e. the earlier of work_end_time and the actual store close) counts as early leave.';
comment on column public.store_attendance_policies.missing_checkout_grace_minutes is
  'Minutes after the employee''s effective scheduled end time before an open (checked-in, not checked-out) shift is flagged as a missing checkout.';

-- Snapshot payload now also exposes the two new fields; defaultNormalCheckoutTime
-- stays in the payload for backward compatibility with older UI/API consumers.
create or replace function public.store_setting_snapshot_v1(p_version_id bigint)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'id', v.id,
    'timezone', v.timezone,
    'businessDayCutoffTime', to_char(v.business_day_cutoff_time, 'HH24:MI'),
    'effectiveFromBusinessDate', to_char(v.effective_from_business_date, 'YYYY-MM-DD'),
    'revision', v.revision,
    'state', v.state,
    'createdBy', v.created_by,
    'createdAt', v.created_at,
    'cancelledBy', v.cancelled_by,
    'cancelledAt', v.cancelled_at,
    'attendancePolicy', jsonb_build_object(
      'lateGraceMinutes', coalesce(p.late_grace_minutes, 0),
      'earlyLeaveGraceMinutes', coalesce(p.early_leave_grace_minutes, 0),
      'missingCheckoutGraceMinutes', coalesce(p.missing_checkout_grace_minutes, 60),
      'defaultNormalCheckoutTime',
        coalesce(to_char(p.default_normal_checkout_time, 'HH24:MI'), '00:00')
    ),
    'hours', coalesce((
      select jsonb_agg(jsonb_build_object(
        'weekday', h.weekday,
        'isClosed', h.is_closed,
        'openTime', case when h.open_time is null then null else to_char(h.open_time, 'HH24:MI') end,
        'closeTime', case when h.close_time is null then null else to_char(h.close_time, 'HH24:MI') end
      ) order by h.weekday)
      from public.store_business_hours h
      where h.setting_version_id = v.id
    ), '[]'::jsonb)
  )
  from public.store_setting_versions v
  left join public.store_attendance_policies p
    on p.setting_version_id = v.id
  where v.id = p_version_id
$$;

-- Parameter list grows (2 new trailing params with defaults for compatibility with
-- any in-flight caller using the previous 8-arg signature); Postgres treats a
-- changed argument list as a distinct function identity, so the old signature is
-- dropped explicitly rather than relying on CREATE OR REPLACE.
drop function if exists public.store_schedule_settings_v1(
  date,
  bigint,
  text,
  time without time zone,
  jsonb,
  bigint,
  integer,
  time without time zone
);

create function public.store_schedule_settings_v1(
  p_effective_from_business_date date,
  p_expected_revision bigint,
  p_timezone text,
  p_business_day_cutoff_time time without time zone,
  p_hours jsonb,
  p_actor_user_id bigint,
  p_late_grace_minutes integer,
  p_default_normal_checkout_time time without time zone,
  p_early_leave_grace_minutes integer default 0,
  p_missing_checkout_grace_minutes integer default 60
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_current_business_date date := public.store_business_date_for_timestamp_v1(now());
  v_latest_revision bigint;
  v_version_id bigint;
  v_item jsonb;
  v_weekday integer;
  v_is_closed boolean;
  v_open time;
  v_close time;
begin
  perform pg_advisory_xact_lock(hashtext('store_settings_schedule_v1'));

  select role::text into v_role
  from public.users
  where id = p_actor_user_id and is_active = true;

  if lower(coalesce(v_role, '')) not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;

  select coalesce(max(revision), 0) into v_latest_revision
  from public.store_setting_versions;

  if p_expected_revision is distinct from v_latest_revision then
    return jsonb_build_object(
      'status', 'version_conflict',
      'latestRevision', v_latest_revision
    );
  end if;
  if p_effective_from_business_date <= v_current_business_date then
    return jsonb_build_object('status', 'invalid_effective_date');
  end if;
  if p_timezone <> 'Asia/Ho_Chi_Minh' then
    return jsonb_build_object('status', 'invalid_timezone');
  end if;
  if p_late_grace_minutes not between 0 and 180
    or p_default_normal_checkout_time is null
    or p_early_leave_grace_minutes not between 0 and 180
    or p_missing_checkout_grace_minutes not between 0 and 360
  then
    return jsonb_build_object('status', 'invalid_attendance_policy');
  end if;
  if p_hours is null
    or jsonb_typeof(p_hours) <> 'array'
    or jsonb_array_length(p_hours) <> 7
  then
    return jsonb_build_object('status', 'invalid_hours');
  end if;
  if exists (
    select 1
    from public.store_setting_versions
    where state = 'active'
      and effective_from_business_date > v_current_business_date
  ) then
    return jsonb_build_object('status', 'scheduled_exists');
  end if;

  insert into public.store_setting_versions (
    timezone,
    business_day_cutoff_time,
    effective_from_business_date,
    revision,
    created_by
  )
  values (
    p_timezone,
    p_business_day_cutoff_time,
    p_effective_from_business_date,
    v_latest_revision + 1,
    p_actor_user_id
  )
  returning id into v_version_id;

  insert into public.store_attendance_policies (
    setting_version_id,
    late_grace_minutes,
    default_normal_checkout_time,
    early_leave_grace_minutes,
    missing_checkout_grace_minutes
  )
  values (
    v_version_id,
    p_late_grace_minutes,
    p_default_normal_checkout_time,
    p_early_leave_grace_minutes,
    p_missing_checkout_grace_minutes
  );

  for v_item in select value from jsonb_array_elements(p_hours) loop
    if jsonb_typeof(v_item) <> 'object'
      or not (v_item ?& array['weekday','isClosed','openTime','closeTime'])
      or (select count(*) from jsonb_object_keys(v_item)) <> 4
      or jsonb_typeof(v_item->'weekday') <> 'number'
      or jsonb_typeof(v_item->'isClosed') <> 'boolean'
    then
      raise check_violation using message = 'invalid hours object';
    end if;

    v_weekday := (v_item->>'weekday')::integer;
    v_is_closed := (v_item->>'isClosed')::boolean;
    v_open := nullif(v_item->>'openTime', '')::time;
    v_close := nullif(v_item->>'closeTime', '')::time;

    insert into public.store_business_hours (
      setting_version_id,
      weekday,
      is_closed,
      open_time,
      close_time
    )
    values (v_version_id, v_weekday, v_is_closed, v_open, v_close);
  end loop;

  if (
    select count(*)
    from public.store_business_hours
    where setting_version_id = v_version_id
  ) <> 7 then
    raise check_violation using message = 'seven weekdays required';
  end if;

  insert into public.store_setting_audit_logs (
    setting_version_id,
    action,
    actor_user_id,
    after_snapshot
  )
  values (
    v_version_id,
    'created',
    p_actor_user_id,
    public.store_setting_snapshot_v1(v_version_id)
  );

  return jsonb_build_object(
    'status', 'ok',
    'setting', public.store_setting_snapshot_v1(v_version_id),
    'latestRevision', v_latest_revision + 1
  );
exception
  when check_violation
    or unique_violation
    or not_null_violation
    or invalid_text_representation
    or invalid_datetime_format
    or datetime_field_overflow
  then
    return jsonb_build_object('status', 'invalid_hours');
end
$$;

-- Newly CREATEd functions default to EXECUTE granted to PUBLIC, so this new
-- 10-arg overload is locked down explicitly and separately per grantee
-- (rather than one combined "from public, anon, authenticated" statement) so
-- each revoke is independently verifiable in postflight checks.
revoke all on function public.store_schedule_settings_v1(
  date,
  bigint,
  text,
  time without time zone,
  jsonb,
  bigint,
  integer,
  time without time zone,
  integer,
  integer
) from public;

revoke all on function public.store_schedule_settings_v1(
  date,
  bigint,
  text,
  time without time zone,
  jsonb,
  bigint,
  integer,
  time without time zone,
  integer,
  integer
) from anon;

revoke all on function public.store_schedule_settings_v1(
  date,
  bigint,
  text,
  time without time zone,
  jsonb,
  bigint,
  integer,
  time without time zone,
  integer,
  integer
) from authenticated;

grant execute on function public.store_schedule_settings_v1(
  date,
  bigint,
  text,
  time without time zone,
  jsonb,
  bigint,
  integer,
  time without time zone,
  integer,
  integer
) to service_role;
