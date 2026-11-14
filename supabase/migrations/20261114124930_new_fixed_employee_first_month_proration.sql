-- Prospective enrollment only. No backfill and no changes to financial history.
begin;

create table public.payroll_first_month_policies (
  user_id bigint primary key references public.users(id),
  policy_version text not null default 'fixed-calendar-v1' check (policy_version = 'fixed-calendar-v1'),
  hire_date date not null check (hire_date >= date '2026-08-01'),
  first_contract_id bigint unique references public.payroll_contract_versions(id),
  status text not null default 'pending' check (status in ('pending','active')),
  created_at timestamptz not null default now(),
  created_by bigint not null references public.users(id),
  change_history jsonb not null default '[]'::jsonb,
  check ((status = 'pending' and first_contract_id is null) or (status = 'active' and first_contract_id is not null))
);
alter table public.payroll_first_month_policies enable row level security;
revoke all on public.payroll_first_month_policies from public, anon, authenticated, service_role;

-- Includes cancelled payments: a cancellation is not permission to rewrite evidence.
create function public.payroll_first_month_used_v1(p_user_id bigint) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select exists(select 1 from public.payroll_employee_payments where user_id=p_user_id and payment_status='paid')
    or exists(select 1 from public.payroll_payment_audit_logs a
      join public.payroll_employee_payments p on p.id=a.employee_payment_id
      where p.user_id=p_user_id and a.action in ('employee_paid','employee_payment_cancelled'))
$$;

create function public.employee_create_with_proration_v1(
  p_employee jsonb, p_level_program_enabled boolean, p_base_date_mode text, p_base_date_override date,
  p_salary_raise_enabled boolean, p_change_reason text, p_actor_id bigint, p_actor_username text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_user jsonb; v_date date := (p_employee->>'hire_date')::date;
begin
  if coalesce(p_employee->>'role','') not in ('staff','leader','manager')
     or coalesce((p_employee->>'is_active')::boolean,true) is not true
     or (p_employee->>'attendance_tracking_enabled')::boolean is distinct from false then
    raise exception 'INVALID_FIRST_MONTH_EMPLOYEE' using errcode='22023';
  end if;
  if v_date is null or v_date < date '2026-08-01'
     or public.ledger_month_is_closed_v1(date_trunc('month',v_date)::date) then
    raise exception 'FIRST_MONTH_POLICY_REVIEW_REQUIRED' using errcode='22023';
  end if;
  -- Existing RPC retains role, schedule, level and actor checks in the same transaction.
  v_user := public.employee_create_with_schedule_v6(p_employee,p_level_program_enabled,p_base_date_mode,
    p_base_date_override,p_salary_raise_enabled,p_change_reason,p_actor_id,p_actor_username);
  insert into public.payroll_first_month_policies(user_id,hire_date,created_by)
    values ((v_user->>'id')::bigint,v_date,p_actor_id);
  return v_user;
end $$;

create function public.payroll_first_month_policies_v1(p_user_ids bigint[]) returns jsonb
language sql stable security definer set search_path = pg_catalog, public as $$
  select coalesce(jsonb_agg(jsonb_build_object('userId',p.user_id,'policyVersion',p.policy_version,
    'hireDate',p.hire_date,'hireDateMatches',u.hire_date=p.hire_date,'firstContractId',p.first_contract_id,'status',p.status,
    'rehired',exists(select 1 from public.employee_level_audit_logs a where a.user_id=p.user_id
      and a.action='level_reset_on_rehire' and a.created_at>=p.created_at))), '[]'::jsonb)
  from public.payroll_first_month_policies p join public.users u on u.id=p.user_id where p.user_id=any(p_user_ids)
$$;

create function public.payroll_link_first_month_contract_v1(
  p_user_id bigint,p_base_salary numeric,p_fixed_raise_amount numeric,p_standard_workdays numeric,
  p_effective_from date,p_actor_user_id bigint)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare p public.payroll_first_month_policies%rowtype; u public.users%rowtype;
  c public.payroll_contract_versions%rowtype; v_count integer; r jsonb;
begin
  perform public.payroll_assert_actor_v2(p_actor_user_id);
  if p_base_salary is null or p_base_salary<0 or p_base_salary<>trunc(p_base_salary)
    or p_fixed_raise_amount is null or p_fixed_raise_amount<0 or p_fixed_raise_amount<>trunc(p_fixed_raise_amount)
    or p_standard_workdays is null or p_standard_workdays<=0 then
    return jsonb_build_object('status','invalid_contract');
  end if;
  perform pg_advisory_xact_lock(p_user_id);
  select * into u from public.users where id=p_user_id for update;
  select * into p from public.payroll_first_month_policies where user_id=p_user_id for update;
  if not found then return jsonb_build_object('status','policy_not_registered'); end if;
  if u.hire_date is distinct from p.hire_date or u.is_system_account or not u.is_active
    or u.role not in ('staff','leader','manager') or u.attendance_tracking_enabled is distinct from false
    or p_effective_from is distinct from date_trunc('month',p.hire_date)::date
    or exists(select 1 from public.employee_level_audit_logs a where a.user_id=p_user_id
      and a.action='level_reset_on_rehire' and a.created_at>=p.created_at) then
    return jsonb_build_object('status','policy_review_required');
  end if;
  select count(*) into v_count from public.payroll_contract_versions where user_id=p_user_id;
  if v_count>1 then return jsonb_build_object('status','policy_contract_conflict'); end if;
  if v_count=1 then
    select * into c from public.payroll_contract_versions where user_id=p_user_id for update;
    if c.pay_type<>'monthly' or c.calculation_basis<>'fixed_monthly' or c.effective_from<>p_effective_from
      or c.base_salary is distinct from p_base_salary or c.fixed_raise_amount is distinct from p_fixed_raise_amount
      or c.standard_workdays is distinct from p_standard_workdays or c.effective_to is not null then
      return jsonb_build_object('status','policy_contract_conflict');
    end if;
  end if;
  if p.status='active' then
    if c.id is distinct from p.first_contract_id then return jsonb_build_object('status','policy_contract_conflict'); end if;
    return jsonb_build_object('status','created','contract',to_jsonb(c),'firstMonthPolicy','active');
  end if;
  if public.payroll_first_month_used_v1(p_user_id)
    or public.ledger_month_is_closed_v1(date_trunc('month',p.hire_date)::date) then
    return jsonb_build_object('status','policy_review_required');
  end if;
  if v_count=0 then
    r := public.payroll_create_contract_version_v6(p_user_id,'monthly',p_base_salary,p_fixed_raise_amount,
      p_standard_workdays,p_effective_from,p_actor_user_id,null);
    if r->>'status'<>'created' or r->'contract' is null then return r; end if;
    select * into strict c from public.payroll_contract_versions where id=(r#>>'{contract,id}')::bigint;
  end if;
  update public.payroll_first_month_policies set status='active',first_contract_id=c.id,
    change_history=change_history||jsonb_build_array(jsonb_build_object('action','activated','contractId',c.id,
      'actorId',p_actor_user_id,'at',now())) where user_id=p_user_id;
  return jsonb_build_object('status','created','contract',to_jsonb(c),'firstMonthPolicy','active');
end $$;

-- Explicit, audited correction only. Does not edit the employee or contract.
-- A different month must be reviewed separately because fixed contracts start on the 1st.
create function public.payroll_correct_first_month_hire_date_v1(p_user_id bigint,p_expected_hire_date date,
  p_hire_date date,p_reason text,p_actor_user_id bigint) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare p public.payroll_first_month_policies%rowtype; u public.users%rowtype;
begin
  perform public.payroll_assert_actor_v2(p_actor_user_id);
  perform pg_advisory_xact_lock(p_user_id);
  select * into u from public.users where id=p_user_id for update;
  select * into p from public.payroll_first_month_policies where user_id=p_user_id for update;
  if not found then return jsonb_build_object('status','policy_not_registered'); end if;
  if p.hire_date is distinct from p_expected_hire_date then return jsonb_build_object('status','revision_conflict'); end if;
  if nullif(btrim(p_reason),'') is null or p_hire_date is null or p_hire_date is distinct from u.hire_date
    or (u.termination_date is not null and u.termination_date<p_hire_date)
    or date_trunc('month',p_hire_date)<>date_trunc('month',p.hire_date)
    or exists(select 1 from public.employee_level_audit_logs a where a.user_id=p_user_id
      and a.action='level_reset_on_rehire' and a.created_at>=p.created_at) then
    return jsonb_build_object('status','policy_review_required');
  end if;
  if public.payroll_first_month_used_v1(p_user_id)
    or public.ledger_month_is_closed_v1(date_trunc('month',p.hire_date)::date) then
    return jsonb_build_object('status','policy_locked');
  end if;
  update public.payroll_first_month_policies set hire_date=p_hire_date,
    change_history=change_history||jsonb_build_array(jsonb_build_object('action','hire_date_corrected',
      'before',p.hire_date,'after',p_hire_date,'reason',p_reason,'actorId',p_actor_user_id,'at',now()))
    where user_id=p_user_id;
  return jsonb_build_object('status','corrected');
end $$;

-- Runs inside the existing payment transaction. It does not change batch/preflight,
-- cancellation or ledger close-first rules. Locks serialize against profile/contract edits.
create function public.payroll_first_month_payment_guard_v1() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare p public.payroll_first_month_policies%rowtype; u public.users%rowtype;
  c public.payroll_contract_versions%rowtype; m date; e jsonb; b jsonb; n integer; d integer;
begin
  if new.payment_status<>'paid' then return new; end if;
  if tg_op='UPDATE' and old.payment_status='paid' then return new; end if;
  select * into u from public.users where id=new.user_id for share;
  select * into p from public.payroll_first_month_policies where user_id=new.user_id for share;
  if not found then return new; end if;
  select payroll_month into m from public.payroll_payment_batches where id=new.payroll_batch_id;
  if m<>date_trunc('month',p.hire_date)::date and m is distinct from date_trunc('month',u.hire_date)::date then return new; end if;
  if p.status<>'active' or u.hire_date is distinct from p.hire_date
    or exists(select 1 from public.employee_level_audit_logs a where a.user_id=p.user_id
      and a.action='level_reset_on_rehire' and a.created_at>=p.created_at) then
    raise exception 'FIRST_MONTH_POLICY_REVIEW_REQUIRED';
  end if;
  select * into c from public.payroll_contract_versions where id=p.first_contract_id for share;
  if not found or c.user_id<>p.user_id or c.pay_type<>'monthly' or c.calculation_basis<>'fixed_monthly'
    or c.effective_from<>m or (c.effective_to is not null and c.effective_to<m+interval '1 month')
    or (select count(*) from public.payroll_contract_versions where user_id=p.user_id
      and effective_from<m+interval '1 month' and (effective_to is null or effective_to>m))<>1 then
    raise exception 'FIRST_MONTH_POLICY_REVIEW_REQUIRED';
  end if;
  select count(*) into n from jsonb_array_elements(new.calculation_snapshot->'automaticItemsSnapshot') i
    where i->>'category'='base_work';
  select i into b from jsonb_array_elements(new.calculation_snapshot->'automaticItemsSnapshot') i where i->>'category'='base_work' limit 1;
  e := b#>'{sourceSnapshot,firstMonthProration}';
  d := extract(day from (m+interval '1 month'-interval '1 day'))::integer;
  n := case when n=1 then greatest(0,least(coalesce(u.termination_date,m+d-1),m+d-1)-u.hire_date+1) else -1 end;
  if n<=0 or e is null or e->>'policyVersion' is distinct from p.policy_version
    or (e->>'hireDate')::date is distinct from p.hire_date
    or (e->>'terminationDate')::date is distinct from u.termination_date
    or (e->>'firstContractId')::bigint is distinct from c.id
    or (e->>'contractRevision')::bigint is distinct from c.revision
    or (e->>'contractSalary')::numeric is distinct from c.base_salary
    or (e->>'fixedRaiseAmount')::numeric is distinct from c.fixed_raise_amount
    or (e->>'employedDays')::integer is distinct from n or (e->>'totalDays')::integer is distinct from d
    or (e->>'monthlyAmount')::numeric is distinct from round(c.base_salary+c.fixed_raise_amount+coalesce((b#>>'{sourceSnapshot,appliedLevelRaiseAmount}')::numeric,0))
    or (e->>'amount')::numeric is distinct from round((e->>'monthlyAmount')::numeric*n/d)
    or (b->>'amount')::numeric is distinct from (e->>'amount')::numeric then
    raise exception 'FIRST_MONTH_POLICY_REVIEW_REQUIRED';
  end if;
  return new;
end $$;
create trigger payroll_first_month_payment_guard before insert or update on public.payroll_employee_payments
  for each row execute function public.payroll_first_month_payment_guard_v1();

-- Only server-side RPC calls; no new anon/authenticated or direct service-role writes.
revoke all on function public.payroll_first_month_used_v1(bigint),
  public.employee_create_with_proration_v1(jsonb,boolean,text,date,boolean,text,bigint,text),
  public.payroll_first_month_policies_v1(bigint[]),
  public.payroll_link_first_month_contract_v1(bigint,numeric,numeric,numeric,date,bigint),
  public.payroll_correct_first_month_hire_date_v1(bigint,date,date,text,bigint),
  public.payroll_first_month_payment_guard_v1() from public,anon,authenticated,service_role;
grant execute on function public.employee_create_with_proration_v1(jsonb,boolean,text,date,boolean,text,bigint,text),
  public.payroll_first_month_policies_v1(bigint[]),
  public.payroll_link_first_month_contract_v1(bigint,numeric,numeric,numeric,date,bigint),
  public.payroll_correct_first_month_hire_date_v1(bigint,date,date,text,bigint) to service_role;
commit;
