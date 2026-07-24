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
    work_minutes = 0,
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
