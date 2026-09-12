begin;

drop function if exists public.payroll_admin_set_part_time_extra_work_decision_v1(
  date, bigint, bigint, date, text, integer, bigint, bigint,
  integer, integer, integer, integer,
  time without time zone, time without time zone,
  time without time zone, time without time zone,
  text, jsonb, text, bigint
);

create or replace function public.payroll_admin_set_part_time_extra_work_decision_v1(
  p_attendance_record_id bigint,
  p_user_id bigint,
  p_payroll_month date,
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
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_actor_role text;
  v_existing_id bigint;
  v_new_id bigint;
  v_now timestamptz := now();
  v_reason text := nullif(btrim(p_decision_reason), '');
begin
  select lower(btrim(role)) into v_actor_role
  from public.users
  where id = p_actor_user_id
    and is_active = true
    and is_system_account = false;

  if v_actor_role is null or v_actor_role not in ('owner', 'master') then
    raise exception 'PAYROLL_EXTRA_WORK_FORBIDDEN' using errcode = '42501';
  end if;

  if p_decision not in ('approved','rejected')
     or p_candidate_minutes <= 0
     or p_candidate_amount <= 0
     or p_hourly_rate_amount <= 0
     or p_before_schedule_minutes < 0
     or p_after_schedule_minutes < 0
     or p_excluded_before_open_minutes < 0
     or p_excluded_after_close_minutes < 0
     or p_candidate_minutes <> p_after_schedule_minutes
     or p_after_schedule_minutes < 30
     or p_source_hash !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_source_snapshot) <> 'object'
     or p_payroll_month <> date_trunc('month', p_payroll_month)::date
     or date_trunc('month', p_business_date)::date <> p_payroll_month then
    raise exception 'PAYROLL_EXTRA_WORK_INVALID_DECISION' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(82119, p_user_id::integer);

  if exists (
    select 1
    from public.payroll_payment_batches b
    join public.payroll_employee_payments e on e.payroll_batch_id = b.id
    where b.payroll_month = p_payroll_month
      and e.user_id = p_user_id
      and e.payment_status = 'paid'
  ) then
    raise exception 'PAYROLL_EXTRA_WORK_LOCKED_FOR_PAID_EMPLOYEE' using errcode = '55000';
  end if;

  select id into v_existing_id
  from public.payroll_part_time_extra_work_decisions
  where attendance_record_id = p_attendance_record_id
    and cancelled_at is null
  for update;

  if v_existing_id is not null then
    if exists (
      select 1
      from public.payroll_part_time_extra_work_decisions
      where id = v_existing_id
        and user_id = p_user_id
        and payroll_month = p_payroll_month
        and business_date = p_business_date
        and decision = p_decision
        and candidate_minutes = p_candidate_minutes
        and candidate_amount = p_candidate_amount
        and hourly_rate_amount = p_hourly_rate_amount
        and before_schedule_minutes = p_before_schedule_minutes
        and after_schedule_minutes = p_after_schedule_minutes
        and excluded_before_open_minutes = p_excluded_before_open_minutes
        and excluded_after_close_minutes = p_excluded_after_close_minutes
        and schedule_start_time = p_schedule_start_time
        and schedule_end_time = p_schedule_end_time
        and store_open_time = p_store_open_time
        and store_close_time = p_store_close_time
        and source_hash = p_source_hash
    ) then
      return jsonb_build_object('id', v_existing_id, 'status', 'unchanged');
    end if;

    update public.payroll_part_time_extra_work_decisions
    set cancelled_at = v_now,
        cancelled_by = p_actor_user_id,
        cancellation_reason = case
          when source_hash <> p_source_hash
            then 'SOURCE_CHANGED_REVIEW_REPLACED'
          else 'DECISION_REPLACED'
        end
    where id = v_existing_id;
  end if;

  insert into public.payroll_part_time_extra_work_decisions(
    payroll_month, attendance_record_id, user_id, business_date, decision,
    candidate_minutes, candidate_amount, hourly_rate_amount,
    before_schedule_minutes, after_schedule_minutes, excluded_before_open_minutes, excluded_after_close_minutes,
    schedule_start_time, schedule_end_time, store_open_time, store_close_time,
    source_hash, source_snapshot, decision_reason, decided_by, decided_at
  ) values (
    p_payroll_month, p_attendance_record_id, p_user_id, p_business_date, p_decision,
    p_candidate_minutes, p_candidate_amount, p_hourly_rate_amount,
    p_before_schedule_minutes, p_after_schedule_minutes,
    p_excluded_before_open_minutes, p_excluded_after_close_minutes,
    p_schedule_start_time, p_schedule_end_time, p_store_open_time, p_store_close_time,
    p_source_hash, p_source_snapshot, v_reason, p_actor_user_id, v_now
  ) returning id into v_new_id;

  return jsonb_build_object('id', v_new_id, 'status', 'created');
end $$;

alter function public.payroll_admin_set_part_time_extra_work_decision_v1(bigint,bigint,date,date,text,integer,bigint,bigint,integer,integer,integer,integer,time without time zone,time without time zone,time without time zone,time without time zone,text,jsonb,text,bigint) owner to postgres;
revoke all on function public.payroll_admin_set_part_time_extra_work_decision_v1(bigint,bigint,date,date,text,integer,bigint,bigint,integer,integer,integer,integer,time without time zone,time without time zone,time without time zone,time without time zone,text,jsonb,text,bigint) from public, anon, authenticated, service_role;
grant execute on function public.payroll_admin_set_part_time_extra_work_decision_v1(bigint,bigint,date,date,text,integer,bigint,bigint,integer,integer,integer,integer,time without time zone,time without time zone,time without time zone,time without time zone,text,jsonb,text,bigint) to postgres, service_role;

commit;
