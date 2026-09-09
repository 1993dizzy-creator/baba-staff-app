begin;

create function public.payroll_admin_set_part_time_extra_work_decision_v1(
  p_payroll_month date,
  p_attendance_record_id bigint,
  p_user_id bigint,
  p_business_date date,
  p_decision text,
  p_candidate_minutes integer,
  p_candidate_amount bigint,
  p_hourly_rate_amount bigint,
  p_before_schedule_minutes integer,
  p_after_schedule_minutes integer,
  p_excluded_before_open_minutes integer,
  p_excluded_after_close_minutes integer,
  p_schedule_start_time time without time zone,
  p_schedule_end_time time without time zone,
  p_store_open_time time without time zone,
  p_store_close_time time without time zone,
  p_source_hash text,
  p_source_snapshot jsonb,
  p_decision_reason text,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog, public
as $$
declare
  v_actor_role text;
  v_attendance public.attendance_records%rowtype;
  v_row public.payroll_part_time_extra_work_decisions%rowtype;
begin
  select role into v_actor_role from public.users where id = p_actor_user_id and is_active = true;
  if v_actor_role not in ('owner', 'master') then raise exception 'PAYROLL_FORBIDDEN' using errcode='42501'; end if;
  if p_decision not in ('approved', 'rejected') then raise exception 'INVALID_EXTRA_WORK_DECISION' using errcode='22023'; end if;
  if p_source_hash !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_source_snapshot) <> 'object' then raise exception 'INVALID_EXTRA_WORK_SOURCE' using errcode='22023'; end if;

  select * into v_attendance from public.attendance_records where id = p_attendance_record_id;
  if not found then raise exception 'ATTENDANCE_RECORD_NOT_FOUND' using errcode='P0002'; end if;
  if p_user_id <> v_attendance.user_id or p_business_date <> v_attendance.work_date
    or p_payroll_month <> date_trunc('month', v_attendance.work_date)::date then
    raise exception 'INVALID_EXTRA_WORK_TARGET' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(82121, p_attendance_record_id::integer);
  if exists(
    select 1 from public.payroll_payment_batches b
    join public.payroll_employee_payments e on e.payroll_batch_id=b.id
    where b.payroll_month=p_payroll_month and e.user_id=p_user_id and e.payment_status='paid'
  ) then raise exception 'PAYROLL_EMPLOYEE_ALREADY_PAID' using errcode='55000'; end if;

  update public.payroll_part_time_extra_work_decisions
  set cancelled_at=now(), cancelled_by=p_actor_user_id, cancellation_reason='superseded'
  where attendance_record_id=p_attendance_record_id and cancelled_at is null;

  insert into public.payroll_part_time_extra_work_decisions(
    payroll_month, attendance_record_id, user_id, business_date, decision,
    candidate_minutes, candidate_amount, hourly_rate_amount,
    before_schedule_minutes, after_schedule_minutes, excluded_before_open_minutes, excluded_after_close_minutes,
    schedule_start_time, schedule_end_time, store_open_time, store_close_time,
    source_hash, source_snapshot, decision_reason, decided_by
  ) values (
    p_payroll_month, p_attendance_record_id, p_user_id, p_business_date, p_decision,
    p_candidate_minutes, p_candidate_amount, p_hourly_rate_amount,
    p_before_schedule_minutes, p_after_schedule_minutes,
    p_excluded_before_open_minutes, p_excluded_after_close_minutes,
    p_schedule_start_time, p_schedule_end_time, p_store_open_time, p_store_close_time,
    p_source_hash, p_source_snapshot, nullif(btrim(p_decision_reason), ''), p_actor_user_id
  ) returning * into v_row;
  return to_jsonb(v_row);
end $$;

create function public.payroll_admin_cancel_part_time_extra_work_decision_v1(
  p_attendance_record_id bigint,
  p_reason text,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog, public
as $$
declare
  v_actor_role text;
  v_row public.payroll_part_time_extra_work_decisions%rowtype;
begin
  select role into v_actor_role from public.users where id = p_actor_user_id and is_active = true;
  if v_actor_role not in ('owner', 'master') then raise exception 'PAYROLL_FORBIDDEN' using errcode='42501'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'CANCELLATION_REASON_REQUIRED' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(82121, p_attendance_record_id::integer);
  select * into v_row from public.payroll_part_time_extra_work_decisions where attendance_record_id=p_attendance_record_id and cancelled_at is null for update;
  if not found then raise exception 'EXTRA_WORK_DECISION_NOT_FOUND' using errcode='P0002'; end if;
  if exists(
    select 1 from public.payroll_payment_batches b
    join public.payroll_employee_payments e on e.payroll_batch_id=b.id
    where b.payroll_month=v_row.payroll_month and e.user_id=v_row.user_id and e.payment_status='paid'
  ) then raise exception 'PAYROLL_EMPLOYEE_ALREADY_PAID' using errcode='55000'; end if;
  update public.payroll_part_time_extra_work_decisions
  set cancelled_at=now(), cancelled_by=p_actor_user_id, cancellation_reason=btrim(p_reason)
  where id=v_row.id returning * into v_row;
  return to_jsonb(v_row);
end $$;

revoke all on function public.payroll_admin_set_part_time_extra_work_decision_v1(date,bigint,bigint,date,text,integer,bigint,bigint,integer,integer,integer,integer,time without time zone,time without time zone,time without time zone,time without time zone,text,jsonb,text,bigint) from public, anon, authenticated;
revoke all on function public.payroll_admin_cancel_part_time_extra_work_decision_v1(bigint,text,bigint) from public, anon, authenticated;
grant execute on function public.payroll_admin_set_part_time_extra_work_decision_v1(date,bigint,bigint,date,text,integer,bigint,bigint,integer,integer,integer,integer,time without time zone,time without time zone,time without time zone,time without time zone,text,jsonb,text,bigint) to service_role;
grant execute on function public.payroll_admin_cancel_part_time_extra_work_decision_v1(bigint,text,bigint) to service_role;
alter function public.payroll_admin_set_part_time_extra_work_decision_v1(date,bigint,bigint,date,text,integer,bigint,bigint,integer,integer,integer,integer,time without time zone,time without time zone,time without time zone,time without time zone,text,jsonb,text,bigint) owner to postgres;
alter function public.payroll_admin_cancel_part_time_extra_work_decision_v1(bigint,text,bigint) owner to postgres;

commit;
