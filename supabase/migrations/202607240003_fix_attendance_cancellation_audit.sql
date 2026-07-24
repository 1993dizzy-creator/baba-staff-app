do $$
begin
  if exists (select 1 from public.attendance_record_audit_logs limit 1) then
    raise exception
      'preflight failed: attendance_record_audit_logs must be empty before migration 003';
  end if;
end
$$;

alter table public.attendance_record_audit_logs
  drop constraint attendance_record_audit_logs_action_check,
  drop constraint attendance_record_audit_logs_attendance_record_id_fkey;

alter table public.attendance_record_audit_logs
  alter column attendance_record_id drop not null,
  add column source_attendance_record_id bigint null,
  add column target_user_id bigint not null references public.users(id),
  add column work_date date not null,
  add constraint attendance_record_audit_logs_attendance_record_id_fkey
    foreign key (attendance_record_id)
    references public.attendance_records(id)
    on delete set null,
  add constraint attendance_record_audit_logs_action_check check (
    action in (
      'manual_update',
      'normalize_late',
      'normalize_early_leave',
      'auto_close',
      'policy_recalculation',
      'cancel_check_in',
      'cancel_check_out',
      'cancel_leave'
    )
  );

comment on column public.attendance_record_audit_logs.attendance_record_id is
  'Optional link to an attendance record that still exists.';
comment on column public.attendance_record_audit_logs.source_attendance_record_id is
  'Immutable attendance record ID captured when the audited action occurred.';
comment on column public.attendance_record_audit_logs.target_user_id is
  'Employee whose attendance record was affected.';
comment on column public.attendance_record_audit_logs.work_date is
  'Business date of the affected attendance record.';

create index attendance_record_audit_logs_target_date_created_idx
  on public.attendance_record_audit_logs (
    target_user_id,
    work_date desc,
    created_at desc,
    id desc
  );

create or replace function public.attendance_admin_cancel_record_v1(
  p_action text,
  p_target_user_id bigint,
  p_work_date date,
  p_actor_user_id bigint,
  p_reason text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_record public.attendance_records%rowtype;
  v_after public.attendance_records%rowtype;
  v_before_snapshot jsonb;
begin
  if p_action not in (
    'cancel_check_in',
    'cancel_check_out',
    'cancel_leave'
  ) then
    return jsonb_build_object('status', 'invalid_action');
  end if;

  select *
    into v_record
  from public.attendance_records
  where user_id = p_target_user_id
    and work_date = p_work_date
  for update;

  if not found then
    return jsonb_build_object('status', 'record_changed');
  end if;

  v_before_snapshot := to_jsonb(v_record);

  if p_action = 'cancel_check_in' then
    if v_record.check_in_at is null
      or v_record.check_out_at is not null
      or v_record.status = 'leave'
    then
      return jsonb_build_object(
        'status',
        case
          when v_record.check_out_at is not null
            then 'check_out_must_be_cancelled_first'
          else 'check_in_cannot_be_cancelled'
        end
      );
    end if;

    insert into public.attendance_record_audit_logs (
      attendance_record_id,
      source_attendance_record_id,
      target_user_id,
      work_date,
      action,
      actor_user_id,
      before_snapshot,
      after_snapshot,
      reason
    )
    values (
      v_record.id,
      v_record.id,
      v_record.user_id,
      v_record.work_date,
      p_action,
      p_actor_user_id,
      v_before_snapshot,
      null,
      nullif(btrim(p_reason), '')
    );

    delete from public.attendance_records
    where id = v_record.id;

    return jsonb_build_object(
      'status', 'ok',
      'deletedId', v_record.id
    );
  end if;

  if p_action = 'cancel_leave' then
    if v_record.status <> 'leave'
      or v_record.check_in_at is not null
      or v_record.check_out_at is not null
      or v_record.is_staff_direct_leave is not true
    then
      return jsonb_build_object(
        'status',
        'direct_leave_cannot_be_cancelled'
      );
    end if;

    insert into public.attendance_record_audit_logs (
      attendance_record_id,
      source_attendance_record_id,
      target_user_id,
      work_date,
      action,
      actor_user_id,
      before_snapshot,
      after_snapshot,
      reason
    )
    values (
      v_record.id,
      v_record.id,
      v_record.user_id,
      v_record.work_date,
      p_action,
      p_actor_user_id,
      v_before_snapshot,
      null,
      nullif(btrim(p_reason), '')
    );

    delete from public.attendance_records
    where id = v_record.id;

    return jsonb_build_object(
      'status', 'ok',
      'deletedId', v_record.id
    );
  end if;

  if v_record.check_in_at is null
    or v_record.check_out_at is null
    or v_record.status = 'leave'
  then
    return jsonb_build_object(
      'status',
      'check_out_cannot_be_cancelled'
    );
  end if;

  update public.attendance_records
  set
    check_out_at = null,
    work_minutes = null,
    early_leave_minutes = 0,
    status = case
      when coalesce(v_record.late_minutes, 0) > 0 then 'late'
      else 'working'
    end,
    updated_at = now()
  where id = v_record.id
  returning * into v_after;

  insert into public.attendance_record_audit_logs (
    attendance_record_id,
    source_attendance_record_id,
    target_user_id,
    work_date,
    action,
    actor_user_id,
    before_snapshot,
    after_snapshot,
    reason
  )
  values (
    v_after.id,
    v_record.id,
    v_record.user_id,
    v_record.work_date,
    p_action,
    p_actor_user_id,
    v_before_snapshot,
    to_jsonb(v_after),
    nullif(btrim(p_reason), '')
  );

  return jsonb_build_object(
    'status', 'ok',
    'record', to_jsonb(v_after)
  );
end
$$;

revoke all on function public.attendance_admin_cancel_record_v1(
  text,
  bigint,
  date,
  bigint,
  text
) from public, anon, authenticated;

grant execute on function public.attendance_admin_cancel_record_v1(
  text,
  bigint,
  date,
  bigint,
  text
) to service_role;

do $$
declare
  v_is_nullable text;
  v_delete_rule text;
  v_log_count bigint;
begin
  select is_nullable
    into v_is_nullable
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'attendance_record_audit_logs'
    and column_name = 'attendance_record_id';

  if v_is_nullable <> 'YES' then
    raise exception
      'postflight failed: attendance_record_id must be nullable';
  end if;

  select rc.delete_rule
    into v_delete_rule
  from information_schema.referential_constraints rc
  where rc.constraint_schema = 'public'
    and rc.constraint_name =
      'attendance_record_audit_logs_attendance_record_id_fkey';

  if v_delete_rule <> 'SET NULL' then
    raise exception
      'postflight failed: audit attendance FK delete rule is %',
      coalesce(v_delete_rule, '<missing>');
  end if;

  select count(*)
    into v_log_count
  from public.attendance_record_audit_logs;

  if v_log_count <> 0 then
    raise exception
      'postflight failed: attendance audit log count changed to %',
      v_log_count;
  end if;
end
$$;
