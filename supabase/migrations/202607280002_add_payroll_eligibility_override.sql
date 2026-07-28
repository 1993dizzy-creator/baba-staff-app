begin;

alter table public.users
  add column if not exists payroll_eligible_override boolean null;

comment on column public.users.payroll_eligible_override is
  'NULL uses role default; true forces payroll inclusion; false forces payroll exclusion. System accounts remain excluded by application policy.';

commit;
