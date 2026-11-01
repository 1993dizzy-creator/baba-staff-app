-- Read-only checks to run before 202608030001_add_employee_level_program_versions.sql.
select extname from pg_extension where extname = 'btree_gist';

select role, is_system_account, level_program_enabled, count(*) as employee_count
from public.users
group by role, is_system_account, level_program_enabled
order by role, is_system_account, level_program_enabled;

select id, username, role, hire_date, termination_date,
  level_program_enabled, level_base_date_override
from public.users
where (role in ('manager', 'leader', 'staff') and hire_date is null)
   or (level_base_date_override is not null and hire_date is not null
       and level_base_date_override < hire_date)
   or (termination_date is not null and hire_date is not null
       and termination_date < hire_date)
   or role is null
   or role not in ('owner', 'master', 'manager', 'leader', 'staff', 'admin')
order by id;

select username, count(*) as duplicate_count, array_agg(id order by id) as user_ids
from public.users
group by username
having count(*) > 1;

select id, username, role, hire_date, level_program_enabled
from public.users
where role in ('manager', 'leader', 'staff')
  and level_program_enabled is false
order by id;

select id, username, role, is_system_account, level_program_enabled,
  level_base_date_override
from public.users
where is_system_account
   or level_base_date_override is not null
order by id;

-- Per-employee preview of the exact revision-1 backfill result.
select u.id, u.username, u.role, u.hire_date,
  case
    when u.is_system_account then false
    when u.role in ('manager', 'leader', 'staff') then true
    when u.role in ('owner', 'master') then u.level_program_enabled is true
    else false
  end as expected_enabled,
  greatest(date '2026-07-01',
    coalesce(date_trunc('month', u.hire_date)::date, date '2026-07-01')) as expected_effective_from,
  case
    when u.is_system_account then null
    when u.role in ('manager', 'leader', 'staff')
      then coalesce(u.level_base_date_override, u.hire_date)
    when u.role in ('owner', 'master') and u.level_program_enabled is true
      then coalesce(u.level_base_date_override, u.hire_date)
    else null
  end as expected_base_date
from public.users u
order by u.id;
