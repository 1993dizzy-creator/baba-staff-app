begin;

alter table public.users
  add column if not exists is_system_account boolean not null default false,
  add column if not exists termination_date date null;

alter table public.users drop constraint if exists users_employment_dates_check;
alter table public.users add constraint users_employment_dates_check
  check (termination_date is null or hire_date is null or termination_date >= hire_date);

create index if not exists users_non_system_account_idx
  on public.users(id) where is_system_account = false;

do $$
declare v_count integer;
begin
  select count(*) into v_count from public.users where username = 'pos';
  if v_count <> 1 then
    raise exception 'Expected exactly one POS account, found %', v_count;
  end if;
  update public.users set is_system_account = true where username = 'pos';
  if not exists (
    select 1 from public.users
    where username = 'pos' and name = 'POS' and role = 'master' and is_system_account = true
  ) then
    raise exception 'POS account identity verification failed';
  end if;
end $$;

create table public.payroll_settings (
  id smallint primary key default 1 check (id = 1),
  payment_day smallint not null default 10 check (payment_day between 1 and 28),
  payment_month_offset smallint not null default 1 check (payment_month_offset = 1),
  updated_at timestamptz not null default now(),
  updated_by bigint null references public.users(id)
);

insert into public.payroll_settings(id, payment_day, payment_month_offset)
values (1, 10, 1)
on conflict (id) do nothing;

alter table public.payroll_settings enable row level security;
revoke all on table public.payroll_settings from public, anon, authenticated, service_role;
grant select, insert, update on table public.payroll_settings to service_role;

alter table public.payroll_runs
  add column if not exists payment_due_date date null,
  add column if not exists payment_schedule_snapshot jsonb not null default '{}'::jsonb;

alter table public.payroll_runs drop constraint if exists payroll_runs_payroll_month_check;
alter table public.payroll_runs add constraint payroll_runs_payroll_month_check
  check (payroll_month >= date '2026-07-01' and payroll_month = date_trunc('month', payroll_month)::date);

create or replace function public.payroll_create_run_v2(
  p_month date,p_calculated_at timestamptz,p_engine_version text,p_source_snapshot jsonb,
  p_employees jsonb,p_actor_user_id bigint
) returns bigint language plpgsql security definer set search_path=public as $$
declare
  v_run_id bigint; v_revision bigint; v_payment_day integer; v_payment_offset integer;
  v_payment_due_date date; v_schedule_snapshot jsonb;
begin
  perform public.payroll_assert_actor_v2(p_actor_user_id);
  if p_month<date '2026-07-01' or p_month<>date_trunc('month',p_month)::date then
    raise exception 'PAYROLL_MONTH_NOT_SUPPORTED' using errcode='22023';
  end if;
  select payment_day,payment_month_offset
    into v_payment_day,v_payment_offset from public.payroll_settings where id=1;
  if not found then raise exception 'PAYROLL_SETTINGS_NOT_FOUND' using errcode='55000'; end if;
  v_payment_due_date := (date_trunc('month',p_month)+(v_payment_offset||' month')::interval
    +(v_payment_day-1||' day')::interval)::date;
  v_schedule_snapshot := jsonb_build_object('paymentDay',v_payment_day,'paymentMonthOffset',v_payment_offset);
  perform pg_advisory_xact_lock(82117,(extract(year from p_month)::integer*100+extract(month from p_month)::integer));
  if exists(select 1 from public.payroll_runs where payroll_month=p_month and status in('draft','finalized','paid')) then
    raise exception 'PAYROLL_ACTIVE_RUN_EXISTS' using errcode='23505';
  end if;
  select coalesce(max(revision),0)+1 into v_revision from public.payroll_runs where payroll_month=p_month;
  insert into public.payroll_runs(
    payroll_month,revision,status,calculated_at,engine_version,source_snapshot,created_by,
    payment_due_date,payment_schedule_snapshot
  ) values (
    p_month,v_revision,'draft',p_calculated_at,p_engine_version,
    p_source_snapshot||jsonb_build_object('paymentSchedule',v_schedule_snapshot),p_actor_user_id,
    v_payment_due_date,v_schedule_snapshot
  ) returning id into v_run_id;
  perform public.payroll_insert_payload_v2(v_run_id,p_employees,p_actor_user_id,null);
  insert into public.payroll_run_audit_logs(payroll_run_id,action,actor_user_id,after_snapshot)
    select id,'run_created',p_actor_user_id,to_jsonb(r) from public.payroll_runs r where id=v_run_id;
  return v_run_id;
end $$;

revoke all on function public.payroll_create_run_v2(date,timestamptz,text,jsonb,jsonb,bigint)
  from public,anon,authenticated;
grant execute on function public.payroll_create_run_v2(date,timestamptz,text,jsonb,jsonb,bigint)
  to service_role;

create or replace function public.payroll_recalculate_run_v2(
  p_run_id bigint,p_calculated_at timestamptz,p_engine_version text,p_source_snapshot jsonb,
  p_employees jsonb,p_actor_user_id bigint
) returns bigint language plpgsql security definer set search_path=public as $$
declare v_old public.payroll_runs%rowtype;v_new_id bigint;v_revision bigint;
begin
  perform public.payroll_assert_actor_v2(p_actor_user_id);
  select * into v_old from public.payroll_runs where id=p_run_id for update;
  if not found then raise exception 'PAYROLL_RUN_NOT_FOUND';end if;
  perform pg_advisory_xact_lock(82117,(extract(year from v_old.payroll_month)::integer*100+extract(month from v_old.payroll_month)::integer));
  if v_old.status<>'draft' then raise exception 'PAYROLL_RUN_LOCKED' using errcode='55000';end if;
  select coalesce(max(revision),0)+1 into v_revision from public.payroll_runs where payroll_month=v_old.payroll_month;
  insert into public.payroll_runs(
    payroll_month,revision,status,calculated_at,engine_version,source_snapshot,created_by,
    payment_due_date,payment_schedule_snapshot
  ) values(
    v_old.payroll_month,v_revision,'cancelled',p_calculated_at,p_engine_version,
    p_source_snapshot||jsonb_build_object('paymentSchedule',v_old.payment_schedule_snapshot),p_actor_user_id,
    v_old.payment_due_date,v_old.payment_schedule_snapshot
  ) returning id into v_new_id;
  perform public.payroll_insert_payload_v2(v_new_id,p_employees,p_actor_user_id,v_old.id);
  insert into public.payroll_run_audit_logs(payroll_run_id,action,actor_user_id,before_snapshot,after_snapshot)
    values(v_old.id,'run_recalculated',p_actor_user_id,to_jsonb(v_old),jsonb_build_object('replacementRunId',v_new_id,'replacementRevision',v_revision));
  update public.payroll_runs set status='cancelled',cancelled_by=p_actor_user_id,cancelled_at=now(),cancel_reason='Recalculated',updated_at=now() where id=v_old.id;
  update public.payroll_runs set status='draft',updated_at=now() where id=v_new_id;
  insert into public.payroll_run_audit_logs(payroll_run_id,action,actor_user_id,after_snapshot)
    select id,'run_created',p_actor_user_id,to_jsonb(r) from public.payroll_runs r where id=v_new_id;
  return v_new_id;
end $$;

revoke all on function public.payroll_recalculate_run_v2(bigint,timestamptz,text,jsonb,jsonb,bigint)
  from public,anon,authenticated;
grant execute on function public.payroll_recalculate_run_v2(bigint,timestamptz,text,jsonb,jsonb,bigint)
  to service_role;

create or replace function public.employee_create_work_schedule_version_v1(
  p_user_id bigint,p_start_time time without time zone,p_end_time time without time zone,
  p_unpaid_break_minutes integer,p_effective_from date,p_actor_user_id bigint,p_change_reason text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_previous public.employee_work_schedule_versions%rowtype;v_first public.employee_work_schedule_versions%rowtype;v_created public.employee_work_schedule_versions%rowtype;v_revision bigint;v_effective_to date;
begin
  if p_effective_from<date '2026-07-01' then return jsonb_build_object('status','invalid_effective_from');end if;
  perform 1 from public.users where id=p_actor_user_id and is_active=true and role in('owner','master');
  if not found then return jsonb_build_object('status','forbidden');end if;
  perform 1 from public.users where id=p_user_id and is_system_account=false;
  if not found then return jsonb_build_object('status','user_not_found');end if;
  perform pg_advisory_xact_lock(-p_user_id);
  select * into v_previous from public.employee_work_schedule_versions where user_id=p_user_id and effective_to is null order by effective_from desc limit 1 for update;
  if found and p_effective_from<=v_previous.effective_from then
    select * into v_first from public.employee_work_schedule_versions where user_id=p_user_id order by effective_from limit 1 for update;
    if p_effective_from>=v_first.effective_from then return jsonb_build_object('status','period_conflict');end if;
    v_effective_to:=v_first.effective_from;
  end if;
  select coalesce(max(revision),0)+1 into v_revision from public.employee_work_schedule_versions where user_id=p_user_id;
  if v_effective_to is null and v_previous.id is not null then update public.employee_work_schedule_versions set effective_to=p_effective_from where id=v_previous.id;end if;
  insert into public.employee_work_schedule_versions(user_id,start_time,end_time,unpaid_break_minutes,effective_from,effective_to,revision,created_by,change_reason)
    values(p_user_id,p_start_time,p_end_time,p_unpaid_break_minutes,p_effective_from,v_effective_to,v_revision,p_actor_user_id,nullif(btrim(p_change_reason),'')) returning * into v_created;
  return jsonb_build_object('status','created','schedule',to_jsonb(v_created));
exception when exclusion_violation or unique_violation then return jsonb_build_object('status','period_conflict');
end $$;

create or replace function public.payroll_create_contract_version_v1(
  p_user_id bigint,p_pay_type text,p_calculation_basis text,p_base_salary numeric,p_standard_workdays numeric,
  p_standard_minutes_per_day integer,p_time_block_minutes integer,p_rounding_mode text,p_late_adjustment_mode text,
  p_early_leave_adjustment_mode text,p_overtime_mode text,p_paid_leave_mode text,p_effective_from date,
  p_actor_user_id bigint,p_note text default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_previous public.payroll_contract_versions%rowtype;v_first public.payroll_contract_versions%rowtype;v_created public.payroll_contract_versions%rowtype;v_revision bigint;v_effective_to date;
begin
  if p_effective_from<date '2026-07-01' then return jsonb_build_object('status','invalid_effective_from');end if;
  if p_pay_type='hourly' and p_calculation_basis='day' then return jsonb_build_object('status','invalid_pay_basis');end if;
  if p_base_salary<>trunc(p_base_salary) then return jsonb_build_object('status','invalid_base_salary');end if;
  perform 1 from public.users where id=p_actor_user_id and is_active=true and role in('owner','master');
  if not found then return jsonb_build_object('status','forbidden');end if;
  perform 1 from public.users where id=p_user_id and is_system_account=false;
  if not found then return jsonb_build_object('status','user_not_found');end if;
  perform pg_advisory_xact_lock(p_user_id);
  select * into v_previous from public.payroll_contract_versions where user_id=p_user_id and effective_to is null order by effective_from desc limit 1 for update;
  if found and p_effective_from<=v_previous.effective_from then
    select * into v_first from public.payroll_contract_versions where user_id=p_user_id order by effective_from limit 1 for update;
    if p_effective_from>=v_first.effective_from then return jsonb_build_object('status','period_conflict');end if;
    v_effective_to:=v_first.effective_from;
  end if;
  select coalesce(max(revision),0)+1 into v_revision from public.payroll_contract_versions where user_id=p_user_id;
  if v_effective_to is null and v_previous.id is not null then update public.payroll_contract_versions set effective_to=p_effective_from where id=v_previous.id;end if;
  insert into public.payroll_contract_versions(user_id,pay_type,calculation_basis,base_salary,standard_workdays,standard_minutes_per_day,time_block_minutes,rounding_mode,late_adjustment_mode,early_leave_adjustment_mode,overtime_mode,paid_leave_mode,effective_from,effective_to,revision,created_by,note)
    values(p_user_id,p_pay_type,p_calculation_basis,p_base_salary,p_standard_workdays,p_standard_minutes_per_day,p_time_block_minutes,p_rounding_mode,p_late_adjustment_mode,p_early_leave_adjustment_mode,p_overtime_mode,p_paid_leave_mode,p_effective_from,v_effective_to,v_revision,p_actor_user_id,nullif(btrim(p_note),'')) returning * into v_created;
  insert into public.payroll_contract_audit_logs(contract_version_id,user_id,action,actor_user_id,snapshot,reason) values(v_created.id,p_user_id,'created',p_actor_user_id,to_jsonb(v_created),nullif(btrim(p_note),''));
  return jsonb_build_object('status','created','contract',to_jsonb(v_created));
exception when exclusion_violation or unique_violation then return jsonb_build_object('status','period_conflict');
end $$;

revoke all on function public.employee_create_work_schedule_version_v1(bigint,time without time zone,time without time zone,integer,date,bigint,text), public.payroll_create_contract_version_v1(bigint,text,text,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text) from public,anon,authenticated;
grant execute on function public.employee_create_work_schedule_version_v1(bigint,time without time zone,time without time zone,integer,date,bigint,text), public.payroll_create_contract_version_v1(bigint,text,text,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text) to service_role;

-- Apply-time checks. Duy's dates are intentionally not inferred or updated here.
do $$
begin
  if (select count(*) from public.users where username='pos' and is_system_account=true) <> 1 then
    raise exception 'POS system-account backfill verification failed';
  end if;
  if not exists(select 1 from public.payroll_settings where id=1 and payment_day=10 and payment_month_offset=1) then
    raise exception 'Default payroll schedule verification failed';
  end if;
end $$;

commit;
