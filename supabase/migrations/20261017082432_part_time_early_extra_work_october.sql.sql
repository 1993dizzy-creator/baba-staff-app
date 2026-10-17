begin;

-- Forward-only policy change; no existing decisions, payments or ledger rows are rewritten.
-- The compatibility table constraint already accepts before + after as well as after-only.
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
  v_pay_type text;
  v_include_early boolean := false;
  v_source_keys text[];
  v_source_json text;
  v_start timestamptz;
  v_end timestamptz;
  v_open timestamptz;
  v_close timestamptz;
  v_schedule_start timestamptz;
  v_schedule_end timestamptz;
  v_before integer;
  v_after integer;
  v_contract record;
  v_schedule record;
  v_user record;
  v_level record;
  v_enabled boolean;
  v_base_date date;
  v_calculation_date date;
  v_completed_months integer;
  v_raise double precision := 0;
  v_salary double precision;
  v_scheduled_minutes integer;
  v_minute_rate double precision;
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

  -- Resolve eligibility from the dated contract, never from client payType alone.
  if p_business_date is not null then
    select c.pay_type into v_pay_type
    from public.payroll_contract_versions c
    where c.id::text = p_source_snapshot->>'contractId'
      and c.revision::text = p_source_snapshot->>'contractRevision'
      and c.user_id = p_user_id
      and c.effective_from <= p_business_date
      and (c.effective_to is null or c.effective_to > p_business_date)
      and c.calculation_basis <> 'fixed_monthly';
    if not found then
      raise exception 'PAYROLL_EXTRA_WORK_INVALID_CONTRACT' using errcode = '22023';
    end if;
    v_include_early := p_business_date >= date '2026-10-01' and v_pay_type in ('hourly', 'daily');
  end if;

  if p_decision not in ('approved','rejected')
     or p_candidate_minutes <= 0
     or p_candidate_amount <= 0
     or p_hourly_rate_amount <= 0
     or p_before_schedule_minutes < 0
     or p_after_schedule_minutes < 0
     or p_excluded_before_open_minutes < 0
     or p_excluded_after_close_minutes < 0
     or p_candidate_minutes <> (p_after_schedule_minutes + case when v_include_early then p_before_schedule_minutes else 0 end)
     or p_candidate_minutes < 30
     or (v_include_early and (
       (p_source_snapshot->>'extraWorkPolicy') is distinct from 'part-time-open-early-v1'
       or (p_source_snapshot->>'payType') is distinct from v_pay_type
       or (p_source_snapshot->>'beforeScheduleMinutes') is distinct from p_before_schedule_minutes::text
       or (p_source_snapshot->>'afterScheduleMinutes') is distinct from p_after_schedule_minutes::text
       or (p_source_snapshot->>'candidateMinutes') is distinct from p_candidate_minutes::text
       or (p_source_snapshot->>'candidateAmount') is distinct from p_candidate_amount::text
     ))
     or p_source_hash !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_source_snapshot) <> 'object'
     or p_payroll_month <> date_trunc('month', p_payroll_month)::date
     or date_trunc('month', p_business_date)::date <> p_payroll_month then
    raise exception 'PAYROLL_EXTRA_WORK_INVALID_DECISION' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.attendance_records a
    where a.id = p_attendance_record_id and a.user_id = p_user_id and a.work_date = p_business_date
  ) then
    raise exception 'PAYROLL_EXTRA_WORK_INVALID_TARGET' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(82119, p_user_id::integer);
  -- Serialize with the existing cancellation RPC as well as payment writes.
  perform pg_advisory_xact_lock(82121, p_attendance_record_id::integer);

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

  -- New requests must match the calculator's complete snapshot, amount and
  -- SHA-256. Preserve pre-October decisions and their historical hash format.
  -- jsonb::text has different spacing/key order from JSON.stringify; reconstruct
  -- the calculator's explicit, primitive-only key order before hashing.
  if p_business_date >= date '2026-10-01' then
    v_source_keys := array['attendanceRecordId','checkInAt','checkOutAt','userId','businessDate',
      'contractId','contractRevision','minuteRateAmount','hourlyRateAmount',
      'scheduleId','scheduleRevision','scheduleStartTime','scheduleEndTime',
      'storeSettingId','storeSettingRevision','storeOpenTime','storeCloseTime',
      'beforeScheduleMinutes','afterScheduleMinutes','excludedBeforeOpenMinutes',
      'excludedAfterCloseMinutes','candidateMinutes','candidateAmount'];
    if v_include_early then
      v_source_keys := v_source_keys || array['extraWorkPolicy','payType'];
    end if;
    select '{' || string_agg(to_json(k)::text || ':' || (p_source_snapshot->k)::text, ',' order by ord) || '}'
    into v_source_json from unnest(v_source_keys) with ordinality as keys(k, ord);
    if (select count(*) from jsonb_object_keys(p_source_snapshot)) <> cardinality(v_source_keys)
       or not p_source_snapshot ?& v_source_keys
       or encode(sha256(convert_to(v_source_json, 'UTF8')), 'hex') is distinct from p_source_hash
       or (p_source_snapshot->>'attendanceRecordId') is distinct from p_attendance_record_id::text
       or (p_source_snapshot->>'userId') is distinct from p_user_id::text
       or (p_source_snapshot->>'businessDate') is distinct from p_business_date::text
       or (p_source_snapshot->>'hourlyRateAmount') is distinct from p_hourly_rate_amount::text
       or (p_source_snapshot->>'beforeScheduleMinutes') is distinct from p_before_schedule_minutes::text
       or (p_source_snapshot->>'afterScheduleMinutes') is distinct from p_after_schedule_minutes::text
       or (p_source_snapshot->>'excludedBeforeOpenMinutes') is distinct from p_excluded_before_open_minutes::text
       or (p_source_snapshot->>'excludedAfterCloseMinutes') is distinct from p_excluded_after_close_minutes::text
       or (p_source_snapshot->>'candidateMinutes') is distinct from p_candidate_minutes::text
       or (p_source_snapshot->>'candidateAmount') is distinct from p_candidate_amount::text
       or (p_source_snapshot->>'scheduleStartTime')::time is distinct from p_schedule_start_time
       or (p_source_snapshot->>'scheduleEndTime')::time is distinct from p_schedule_end_time
       or (p_source_snapshot->>'storeOpenTime')::time is distinct from p_store_open_time
       or (p_source_snapshot->>'storeCloseTime')::time is distinct from p_store_close_time
       or jsonb_typeof(p_source_snapshot->'minuteRateAmount') is distinct from 'number'
       or not ((p_source_snapshot->>'minuteRateAmount')::double precision > 0)
       or floor(p_candidate_minutes * (p_source_snapshot->>'minuteRateAmount')::double precision + 0.5)::bigint <> p_candidate_amount then
      raise exception 'PAYROLL_EXTRA_WORK_INVALID_SOURCE' using errcode = '22023';
    end if;
    v_start := (p_source_snapshot->>'checkInAt')::timestamptz;
    v_end := (p_source_snapshot->>'checkOutAt')::timestamptz;
    if v_start is null or v_end is null or v_end <= v_start or not exists (
      select 1 from public.attendance_records a where a.id = p_attendance_record_id
        and a.user_id = p_user_id and a.work_date = p_business_date
        and a.check_in_at = v_start and a.check_out_at = v_end
    ) then
      raise exception 'PAYROLL_EXTRA_WORK_STALE_SOURCE' using errcode = '22023';
    end if;
    -- Revalidate dated inputs after waiting for the employee lock, using the
    -- same effective-date/version ordering as loadPayrollMonthSnapshot.
    if not exists (
      select 1 from public.payroll_contract_versions c
      where c.id::text = p_source_snapshot->>'contractId'
        and c.revision::text = p_source_snapshot->>'contractRevision'
        and c.user_id = p_user_id and c.pay_type = v_pay_type
        and c.calculation_basis <> 'fixed_monthly'
        and c.effective_from <= p_business_date and (c.effective_to is null or c.effective_to > p_business_date)
    ) or not exists (
      select 1 from public.employee_work_schedule_versions s
      where s.id::text = p_source_snapshot->>'scheduleId'
        and s.revision::text = p_source_snapshot->>'scheduleRevision'
        and s.user_id = p_user_id and s.effective_from <= p_business_date
        and (s.effective_to is null or s.effective_to > p_business_date)
        and s.start_time = p_schedule_start_time and s.end_time = p_schedule_end_time
    ) or not exists (
      select 1 from (
        select id, revision from public.store_setting_versions
        where state = 'active' and effective_from_business_date <= p_business_date
        order by effective_from_business_date desc, id desc limit 1
      ) v join public.store_business_hours h on h.setting_version_id = v.id
      where v.id::text = p_source_snapshot->>'storeSettingId'
        and v.revision::text = p_source_snapshot->>'storeSettingRevision'
        and h.weekday = extract(dow from p_business_date)::integer
        and not h.is_closed and h.open_time = p_store_open_time and h.close_time = p_store_close_time
    ) then
      raise exception 'PAYROLL_EXTRA_WORK_STALE_SOURCE' using errcode = '22023';
    end if;
    -- JavaScript Date parses persisted timestamps at millisecond precision.
    -- Compare the original values above, then use the same precision for minutes.
    v_start := date_trunc('milliseconds', v_start);
    v_end := date_trunc('milliseconds', v_end);
    v_open := (p_business_date + p_store_open_time) at time zone 'Asia/Ho_Chi_Minh';
    v_close := (p_business_date + p_store_close_time) at time zone 'Asia/Ho_Chi_Minh';
    v_schedule_start := (p_business_date + p_schedule_start_time) at time zone 'Asia/Ho_Chi_Minh';
    v_schedule_end := (p_business_date + p_schedule_end_time) at time zone 'Asia/Ho_Chi_Minh';
    if v_include_early then
      if p_store_open_time < time '03:00' then v_open := v_open + interval '1 day'; end if;
      if p_store_close_time < time '03:00' then v_close := v_close + interval '1 day'; end if;
      if p_schedule_start_time < time '03:00' then v_schedule_start := v_schedule_start + interval '1 day'; end if;
      if p_schedule_end_time < time '03:00' then v_schedule_end := v_schedule_end + interval '1 day'; end if;
    end if;
    if v_close <= v_open then v_close := v_close + interval '1 day'; end if;
    if v_schedule_end <= v_schedule_start then v_schedule_end := v_schedule_end + interval '1 day'; end if;
    if v_pay_type = 'monthly' then
      v_close := (p_business_date + 1 + time '03:00') at time zone 'Asia/Ho_Chi_Minh';
    end if;
    v_before := greatest(0, floor(extract(epoch from (least(v_end, v_close, v_schedule_start) - greatest(v_start, v_open))) / 60))::integer;
    v_after := greatest(0, floor(extract(epoch from (least(v_end, v_close) - greatest(v_start, v_open, v_schedule_end))) / 60))::integer;
    if v_before <> p_before_schedule_minutes or v_after <> p_after_schedule_minutes
       or greatest(0, floor(extract(epoch from (least(v_end, v_open) - v_start)) / 60))::integer <> p_excluded_before_open_minutes
       or greatest(0, floor(extract(epoch from (v_end - greatest(v_start, v_close))) / 60))::integer <> p_excluded_after_close_minutes then
      raise exception 'PAYROLL_EXTRA_WORK_INVALID_WORK_WINDOW' using errcode = '22023';
    end if;
  end if;

  -- Authoritative rate: never trust a self-consistent snapshot/hash as proof
  -- of compensation. Mirror monthly-run.ts -> compensation.ts/work-policy.ts
  -- using the dated contract, schedule net minutes and employee level history.
  if (select count(*) from public.payroll_contract_versions c where c.user_id = p_user_id
      and c.effective_from <= p_business_date and (c.effective_to is null or c.effective_to > p_business_date)) <> 1
     or (select count(*) from public.employee_work_schedule_versions s where s.user_id = p_user_id
      and s.effective_from <= p_business_date and (s.effective_to is null or s.effective_to > p_business_date)) <> 1 then
    raise exception 'PAYROLL_EXTRA_WORK_INVALID_RATE_SOURCE' using errcode = '22023';
  end if;
  select * into v_contract from public.payroll_contract_versions where user_id = p_user_id
    and effective_from <= p_business_date and (effective_to is null or effective_to > p_business_date);
  select * into v_schedule from public.employee_work_schedule_versions where user_id = p_user_id
    and effective_from <= p_business_date and (effective_to is null or effective_to > p_business_date);
  -- Attendance facts anchor clock times before 03:00 to the following date.
  v_schedule_start := (p_business_date + make_time(extract(hour from v_schedule.start_time)::integer,
    extract(minute from v_schedule.start_time)::integer, 0)) at time zone 'Asia/Ho_Chi_Minh';
  v_schedule_end := (p_business_date + make_time(extract(hour from v_schedule.end_time)::integer,
    extract(minute from v_schedule.end_time)::integer, 0)) at time zone 'Asia/Ho_Chi_Minh';
  if v_schedule.start_time < time '03:00' then v_schedule_start := v_schedule_start + interval '1 day'; end if;
  if v_schedule.end_time < time '03:00' then v_schedule_end := v_schedule_end + interval '1 day'; end if;
  v_scheduled_minutes := greatest(0, greatest(0, floor(extract(epoch from (v_schedule_end - v_schedule_start)) / 60))::integer
    - coalesce(v_schedule.unpaid_break_minutes, 0));
  if v_pay_type = 'hourly' then
    v_minute_rate := v_contract.base_salary::double precision / 60;
  elsif v_pay_type = 'daily' then
    v_minute_rate := v_contract.base_salary::double precision / nullif(v_scheduled_minutes, 0);
  elsif v_pay_type = 'monthly' then
    select * into v_user from public.users where id = p_user_id;
    v_enabled := v_user.level_program_enabled;
    v_base_date := coalesce(v_user.level_base_date_override, v_user.hire_date);
    -- The engine seeds users from the month-start version, then overrides
    -- it with the day's highest revision. Preserve that fallback in gaps.
    select * into v_level from public.employee_level_program_versions
    where user_id = p_user_id and effective_from <= p_business_date
      and (effective_to is null or effective_to > p_business_date)
    order by revision desc limit 1;
    if not found then
      select * into v_level from public.employee_level_program_versions
      where user_id = p_user_id and effective_from <= p_payroll_month
        and (effective_to is null or effective_to > p_payroll_month)
      order by revision desc limit 1;
    end if;
    if found then
      v_enabled := coalesce(v_level.enabled, false);
      v_base_date := case when v_level.base_date_mode = 'override'
        then coalesce(v_level.base_date, v_user.hire_date) else v_user.hire_date end;
    end if;
    if not v_user.is_system_account and v_enabled is distinct from false
       and (v_user.role in ('manager', 'leader', 'staff')
         or (v_user.role in ('owner', 'master') and v_enabled is true)) then
      if v_base_date is null then
        raise exception 'PAYROLL_EXTRA_WORK_INVALID_RATE_SOURCE' using errcode = '22023';
      end if;
      v_calculation_date := least(p_business_date, coalesce(v_user.termination_date, p_business_date));
      if v_calculation_date >= v_base_date then
        v_completed_months := (extract(year from v_calculation_date)::integer - extract(year from v_base_date)::integer) * 12
          + extract(month from v_calculation_date)::integer - extract(month from v_base_date)::integer;
        -- PostgreSQL month addition clamps anniversaries just like addCalendarMonthsClamped.
        if v_calculation_date < (v_base_date + make_interval(months => v_completed_months))::date then
          v_completed_months := v_completed_months - 1;
        end if;
        v_raise := least(7, greatest(0, v_completed_months) / 3) * 500000::double precision;
      end if;
    end if;
    v_salary := (v_contract.base_salary::double precision + coalesce(v_contract.fixed_raise_amount, 0)::double precision) + v_raise;
    v_minute_rate := (v_salary / nullif(v_contract.standard_workdays, 0)::double precision) / nullif(v_scheduled_minutes, 0);
  end if;
  if v_minute_rate is null or not (v_minute_rate > 0)
     or (p_source_snapshot->>'minuteRateAmount')::double precision is distinct from v_minute_rate
     or p_hourly_rate_amount is distinct from floor(v_minute_rate * 60 + 0.5)::bigint
     or p_candidate_amount is distinct from floor(p_candidate_minutes * v_minute_rate + 0.5)::bigint then
    raise exception 'PAYROLL_EXTRA_WORK_RATE_MISMATCH' using errcode = '22023';
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

-- Both decision RPCs must acquire employee -> attendance -> decision-row locks.
-- Resolve the employee without locking a decision row, then re-read the active
-- decision under both advisory locks. Never retain a row selected before a wait.
create or replace function public.payroll_admin_cancel_part_time_extra_work_decision_v1(
  p_attendance_record_id bigint,
  p_reason text,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_actor_role text;
  v_user_id bigint;
  v_row public.payroll_part_time_extra_work_decisions%rowtype;
begin
  select lower(btrim(role)) into v_actor_role from public.users
  where id = p_actor_user_id and is_active = true and is_system_account = false;
  if v_actor_role is null or v_actor_role not in ('owner', 'master') then
    raise exception 'PAYROLL_EXTRA_WORK_FORBIDDEN' using errcode = '42501';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'PAYROLL_EXTRA_WORK_CANCEL_REASON_REQUIRED' using errcode = '22023';
  end if;

  select user_id into v_user_id from public.attendance_records
  where id = p_attendance_record_id;
  if not found then
    return jsonb_build_object('status', 'not_active');
  end if;
  perform pg_advisory_xact_lock(82119, v_user_id::integer);
  perform pg_advisory_xact_lock(82121, p_attendance_record_id::integer);

  select * into v_row from public.payroll_part_time_extra_work_decisions
  where attendance_record_id = p_attendance_record_id and cancelled_at is null
  for update;
  if not found then
    return jsonb_build_object('status', 'not_active');
  end if;
  if v_row.user_id <> v_user_id then
    raise exception 'PAYROLL_EXTRA_WORK_INVALID_TARGET' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.payroll_payment_batches b
    join public.payroll_employee_payments e on e.payroll_batch_id = b.id
    where b.payroll_month = v_row.payroll_month
      and e.user_id = v_user_id and e.payment_status = 'paid'
  ) then
    raise exception 'PAYROLL_EXTRA_WORK_LOCKED_FOR_PAID_EMPLOYEE' using errcode = '55000';
  end if;
  update public.payroll_part_time_extra_work_decisions
  set cancelled_at = now(), cancelled_by = p_actor_user_id,
      cancellation_reason = btrim(p_reason)
  where id = v_row.id returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'status', 'cancelled');
end $$;

alter function public.payroll_admin_cancel_part_time_extra_work_decision_v1(bigint,text,bigint) owner to postgres;
revoke all on function public.payroll_admin_cancel_part_time_extra_work_decision_v1(bigint,text,bigint) from public, anon, authenticated, service_role;
grant execute on function public.payroll_admin_cancel_part_time_extra_work_decision_v1(bigint,text,bigint) to postgres, service_role;

commit;
