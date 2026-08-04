begin;

do $$
begin
  if exists (select 1 from public.payroll_runs)
     or exists (select 1 from public.payroll_run_employees) then
    raise exception 'PAYROLL_LEDGER_ALREADY_EXISTS';
  end if;
end;
$$;

with corrections(username,next_basis,reason) as (
  values
    ('vuong','fixed_monthly','2026-08-04 사용자 승인: Vuong 2026년 8월 계약 계산 기준 day → fixed_monthly 정정'),
    ('quyen','minute','2026-08-04 사용자 승인: legacy day 계산 기준 제거 (일반 직원 minute, owner fixed_monthly)'),
    ('diep','minute','2026-08-04 사용자 승인: legacy day 계산 기준 제거 (일반 직원 minute, owner fixed_monthly)')
), targets as (
  select c.id,correction.next_basis
  from corrections correction
  join public.users u on lower(u.username)=correction.username
  join public.payroll_contract_versions c on c.user_id=u.id
  where c.calculation_basis='day'
), updated as (
  update public.payroll_contract_versions c
  set calculation_basis=t.next_basis
  from targets t
  where c.id=t.id
  returning c.*
)
insert into public.payroll_contract_audit_logs(
  contract_version_id,user_id,action,actor_user_id,snapshot,reason
)
select u.id,u.user_id,'corrected',actor.id,to_jsonb(u),correction.reason
from updated u
join public.users employee on employee.id=u.user_id
join corrections correction on correction.username=lower(employee.username)
join public.users actor on actor.username='admin';

do $$
begin
  if exists (select 1 from public.payroll_contract_versions where calculation_basis='day') then
    raise exception 'LEGACY_DAY_CALCULATION_BASIS_REMAINS';
  end if;
end;
$$;

alter table public.payroll_contract_versions
  drop constraint if exists payroll_contract_versions_calculation_basis_check;

alter table public.payroll_contract_versions
  add constraint payroll_contract_versions_calculation_basis_check
  check (calculation_basis in ('minute','hour','fixed_monthly'));

commit;
