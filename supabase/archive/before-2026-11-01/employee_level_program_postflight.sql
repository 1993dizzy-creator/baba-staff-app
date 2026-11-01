-- Read-only checks to run after 202608030001_add_employee_level_program_versions.sql.
select version
from supabase_migrations.schema_migrations
where version = '202608030001';

select (select count(*) from public.users) as user_count,
  (select count(*) from public.employee_level_program_versions where revision = 1) as backfill_count;

select user_id, revision, enabled, effective_from, effective_to, base_date
from public.employee_level_program_versions
where extract(day from effective_from) <> 1
   or (effective_to is not null and extract(day from effective_to) <> 1)
   or (effective_to is not null and effective_to < effective_from)
   or (not enabled and base_date is not null)
order by user_id, revision;

select a.user_id, a.revision as revision_a, b.revision as revision_b
from public.employee_level_program_versions a
join public.employee_level_program_versions b
  on b.user_id = a.user_id and b.id > a.id
where daterange(a.effective_from, coalesce(a.effective_to, 'infinity'::date), '[)')
   && daterange(b.effective_from, coalesce(b.effective_to, 'infinity'::date), '[)');

select u.id, u.username, u.role, u.is_system_account,
  v.enabled, v.effective_from, v.base_date
from public.users u
join public.employee_level_program_versions v
  on v.user_id = u.id and v.revision = 1
where v.enabled is distinct from case
    when u.is_system_account then false
    when u.role in ('manager', 'leader', 'staff') then true
    when u.role in ('owner', 'master') then u.level_program_enabled is true
    else false
  end;

select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name in (
    'employee_update_profile_and_level_v5',
    'employee_create_with_schedule_v2',
    'employee_rehire_with_level_policy_v2'
  )
order by routine_name, grantee;

select proname, pg_get_function_identity_arguments(oid) as arguments, proacl
from pg_proc
where proname in (
  'employee_update_profile_and_level_v4',
  'employee_create_with_schedule_v1',
  'employee_rehire_with_level_reset_v1',
  'employee_update_profile_and_level_v5',
  'employee_create_with_schedule_v2',
  'employee_rehire_with_level_policy_v2'
)
order by proname;
