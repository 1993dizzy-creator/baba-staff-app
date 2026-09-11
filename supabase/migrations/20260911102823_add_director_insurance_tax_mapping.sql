alter table public.payroll_settings
  add column if not exists director_insurance_user_id bigint,
  add column if not exists director_employee_insurance_rate_bp smallint not null default 0;

update public.payroll_settings
set director_insurance_user_id = 2,
    director_employee_insurance_rate_bp = 950
where id = 1;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'payroll_settings_director_insurance_user_fkey'
  ) then
    alter table public.payroll_settings
      add constraint payroll_settings_director_insurance_user_fkey
      foreign key (director_insurance_user_id)
      references public.users(id)
      on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'payroll_settings_director_employee_rate_check'
  ) then
    alter table public.payroll_settings
      add constraint payroll_settings_director_employee_rate_check
      check (
        director_employee_insurance_rate_bp >= 0
        and director_employee_insurance_rate_bp <= 10000
        and director_employee_insurance_rate_bp <= director_insurance_rate_bp
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'payroll_settings_director_user_required_check'
  ) then
    alter table public.payroll_settings
      add constraint payroll_settings_director_user_required_check
      check (
        not director_insurance_enabled
        or director_insurance_user_id is not null
      );
  end if;
end $$;
