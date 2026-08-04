select column_name,data_type,is_nullable
from information_schema.columns
where table_schema='public' and table_name='employee_level_program_versions' and column_name='base_date_mode';

select to_regprocedure('public.employee_update_profile_and_level_v6(bigint,jsonb,boolean,date,text,date,text,bigint,text)') exact_signature;

select base_date_mode,count(*)
from public.employee_level_program_versions group by base_date_mode order by base_date_mode nulls last;

select
  count(*) filter (where base_date_mode is null and base_date is not null) as null_mode_with_base_date,
  count(*) filter (where base_date_mode is not null and base_date is null) as mode_without_base_date,
  count(*) filter (where base_date_mode is not null and base_date_mode not in ('hire_date','override')) as invalid_mode
from public.employee_level_program_versions;

select count(*) as current_regular_employee_null_mode
from public.employee_level_program_versions v
join public.users u on u.id=v.user_id
where not u.is_system_account
  and v.base_date_mode is null
  and v.effective_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
  and (v.effective_to is null or v.effective_to > (now() at time zone 'Asia/Ho_Chi_Minh')::date);

select column_name,data_type,is_nullable
from information_schema.columns
where table_schema='public' and table_name='employee_level_audit_logs'
  and column_name in ('previous_base_date_mode','next_base_date_mode','actor_id','actor_username','created_at','change_reason')
order by ordinal_position;

select user_id,count(*) active_count
from public.employee_level_program_versions
where effective_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
  and (effective_to is null or effective_to > (now() at time zone 'Asia/Ho_Chi_Minh')::date)
group by user_id having count(*) > 1;

select user_id,id,effective_from,effective_to
from public.employee_level_program_versions
where effective_to is not null and effective_to <= effective_from;

select u.id,coalesce(u.name,u.full_name,u.username) employee_name,v.enabled,v.base_date_mode,v.base_date,
  u.level_program_enabled,u.level_base_date_override
from public.users u
join lateral (
  select * from public.employee_level_program_versions v
  where v.user_id=u.id and v.effective_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
    and (v.effective_to is null or v.effective_to > (now() at time zone 'Asia/Ho_Chi_Minh')::date)
  order by v.effective_from desc,v.revision desc limit 1
) v on true
where u.level_program_enabled is distinct from v.enabled
   or u.level_base_date_override is distinct from case when v.base_date_mode='override' then v.base_date else null end;

select grantee,privilege_type
from information_schema.routine_privileges
where specific_schema='public' and routine_name='employee_update_profile_and_level_v6'
order by grantee,privilege_type;
