begin;

create or replace function public.attendance_admin_unauthorized_absence_v1(
  p_action text,
  p_target_user_id bigint,
  p_work_date date,
  p_actor_user_id bigint,
  p_reason text
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_actor_role text;
  v_user public.users%rowtype;
  v_record public.attendance_records%rowtype;
  v_created public.attendance_records%rowtype;
  v_current_business_date date;
  v_setting_version_id bigint;
  v_weekday integer;
  v_weekly_closed boolean;
  v_holiday_group text;
  v_holiday_group_size integer := 0;
  v_holiday_multiplier numeric;
  v_premium_holiday boolean := false;
  v_reason text := nullif(btrim(p_reason), '');
begin
  if p_action not in ('set_unauthorized_absence', 'cancel_unauthorized_absence') then
    return jsonb_build_object('status', 'invalid_action');
  end if;
  if p_work_date is null then return jsonb_build_object('status', 'invalid_work_date'); end if;

  select lower(coalesce(role, '')) into v_actor_role
  from public.users where id = p_actor_user_id and is_active = true;
  if v_actor_role is null or v_actor_role not in ('owner', 'master') then return jsonb_build_object('status', 'forbidden'); end if;

  -- Match payroll_pay_employee_v1's lock order so a payment and attendance
  -- mutation for the same employee/month cannot commit past each other.
  perform pg_advisory_xact_lock(82118, (extract(year from p_work_date)::integer * 100 + extract(month from p_work_date)::integer));
  perform pg_advisory_xact_lock(82119, p_target_user_id::integer);

  select * into v_user from public.users where id = p_target_user_id for share;
  if not found or v_user.is_system_account = true then return jsonb_build_object('status', 'user_not_found'); end if;
  if v_user.attendance_tracking_enabled is not true then return jsonb_build_object('status', 'attendance_tracking_disabled'); end if;
  if v_user.hire_date is not null and p_work_date < v_user.hire_date then return jsonb_build_object('status', 'before_hire_date'); end if;
  if v_user.termination_date is not null and p_work_date > v_user.termination_date then return jsonb_build_object('status', 'after_termination_date'); end if;

  v_current_business_date := public.store_business_date_for_timestamp_v1(now());
  if p_work_date > v_current_business_date then return jsonb_build_object('status', 'future_date'); end if;
  if p_work_date = v_current_business_date then return jsonb_build_object('status', 'business_day_not_completed'); end if;

  if (select count(*) from public.employee_work_schedule_versions
      where user_id = p_target_user_id and effective_from <= p_work_date
        and (effective_to is null or effective_to > p_work_date)) <> 1 then
    return jsonb_build_object('status', 'work_schedule_not_found');
  end if;

  select id into v_setting_version_id
  from public.store_setting_versions
  where state = 'active' and effective_from_business_date <= p_work_date
  order by effective_from_business_date desc, id desc limit 1;
  if v_setting_version_id is null then return jsonb_build_object('status', 'store_settings_not_found'); end if;

  v_weekday := extract(dow from p_work_date)::integer;
  select is_closed into v_weekly_closed from public.store_business_hours
  where setting_version_id = v_setting_version_id and weekday = v_weekday;
  if v_weekly_closed is null then return jsonb_build_object('status', 'store_settings_not_found'); end if;

  select h.holiday_group, p.internal_pay_multiplier
    into v_holiday_group, v_holiday_multiplier
  from public.store_holidays h
  left join public.store_holiday_operation_policies p on p.holiday_id = h.id
  where h.holiday_date = p_work_date
  limit 1;
  if v_holiday_group is not null then
    select count(*) into v_holiday_group_size
    from public.store_holidays where calendar_year = extract(year from p_work_date)::integer
      and holiday_group = v_holiday_group;
    v_premium_holiday := v_holiday_group_size = 1 or v_holiday_multiplier = 2;
  end if;
  if v_weekly_closed and not v_premium_holiday then return jsonb_build_object('status', 'store_closed'); end if;

  if exists (
    select 1 from public.payroll_employee_payments ep
    join public.payroll_payment_batches b on b.id = ep.payroll_batch_id
    where ep.user_id = p_target_user_id
      and b.payroll_month = date_trunc('month', p_work_date)::date
      and ep.payment_status = 'paid'
  ) then return jsonb_build_object('status', 'payroll_paid_locked'); end if;

  select * into v_record from public.attendance_records
  where user_id = p_target_user_id and work_date = p_work_date for update;

  if p_action = 'set_unauthorized_absence' then
    if found then
      if v_record.status = 'unauthorized_absence' then return jsonb_build_object('status', 'already_unauthorized_absence'); end if;
      if v_record.status = 'leave' then return jsonb_build_object('status', 'leave_conflict'); end if;
      return jsonb_build_object('status', 'attendance_conflict');
    end if;

    insert into public.attendance_records (
      user_id, work_date, status, check_in_at, check_out_at, late_minutes,
      early_leave_minutes, work_minutes, note, approval_status, approved_by,
      approved_at, is_staff_direct_leave, updated_at
    ) values (
      p_target_user_id, p_work_date, 'unauthorized_absence', null, null, 0,
      0, 0, v_reason, 'approved', p_actor_user_id::text,
      now(), false, now()
    ) returning * into v_created;

    insert into public.attendance_record_audit_logs (
      attendance_record_id, source_attendance_record_id, target_user_id, work_date,
      action, actor_user_id, before_snapshot, after_snapshot, reason
    ) values (
      v_created.id, v_created.id, p_target_user_id, p_work_date,
      p_action, p_actor_user_id, null, to_jsonb(v_created), v_reason
    );
    return jsonb_build_object('status', 'ok', 'record', to_jsonb(v_created));
  end if;

  if not found then return jsonb_build_object('status', 'record_changed'); end if;
  if v_record.status <> 'unauthorized_absence' or v_record.check_in_at is not null or v_record.check_out_at is not null then
    return jsonb_build_object('status', 'unauthorized_absence_cannot_be_cancelled');
  end if;

  insert into public.attendance_record_audit_logs (
    attendance_record_id, source_attendance_record_id, target_user_id, work_date,
    action, actor_user_id, before_snapshot, after_snapshot, reason
  ) values (
    v_record.id, v_record.id, p_target_user_id, p_work_date,
    p_action, p_actor_user_id, to_jsonb(v_record), null, v_reason
  );
  delete from public.attendance_records where id = v_record.id;
  return jsonb_build_object('status', 'ok', 'deletedId', v_record.id);
end
$$;

revoke all on function public.attendance_admin_unauthorized_absence_v1(
  text, bigint, date, bigint, text
) from public, anon, authenticated;
grant execute on function public.attendance_admin_unauthorized_absence_v1(
  text, bigint, date, bigint, text
) to service_role;

comment on function public.attendance_admin_unauthorized_absence_v1(text,bigint,date,bigint,text)
  is 'Atomically sets/cancels a confirmed unauthorized absence with optional reason, policy, paid-payroll lock, and audit validation. Service-role API only.';

commit;
