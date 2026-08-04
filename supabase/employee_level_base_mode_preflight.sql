select current_database() database_name, now() checked_at;

select c.column_name,c.data_type,c.is_nullable
from information_schema.columns c
where c.table_schema='public' and c.table_name in ('users','employee_level_program_versions','employee_level_audit_logs')
  and c.column_name in ('level_program_enabled','level_base_date_override','enabled','effective_from','effective_to','base_date','base_date_mode','revision','action','previous_base_date_mode','next_base_date_mode','next_base_date_override','actor_id','actor_username','created_at','change_reason')
order by c.table_name,c.ordinal_position;

-- Before migration these counts expose legacy rows to be repaired. Run the separate
-- dry-run script to confirm their projected post-migration classification.
with observed as (
  select v.*, to_jsonb(v) ->> 'base_date_mode' as observed_mode
  from public.employee_level_program_versions v
), current_versions as (
  select distinct on (v.user_id) v.*
  from observed v
  where v.effective_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
    and (v.effective_to is null or v.effective_to > (now() at time zone 'Asia/Ho_Chi_Minh')::date)
  order by v.user_id,v.effective_from desc,v.revision desc
)
select
  count(*) filter (where v.observed_mode is null and v.base_date is not null) as null_mode_with_base_date,
  count(*) filter (where v.observed_mode is not null and v.base_date is null) as mode_without_base_date,
  count(*) filter (where v.observed_mode is not null and v.observed_mode not in ('hire_date','override')) as invalid_mode,
  (select count(*) from current_versions cv join public.users u on u.id=cv.user_id
    where not u.is_system_account and cv.observed_mode is null) as current_regular_employee_null_mode
from observed v;

select to_regprocedure('public.employee_update_profile_and_level_v5(bigint,jsonb,boolean,date,text,bigint,text)') v5_signature,
  to_regprocedure('public.employee_update_profile_and_level_v4(bigint,jsonb,boolean,date,bigint,text)') v4_signature,
  to_regprocedure('public.employee_create_with_schedule_v2(jsonb,boolean,text,bigint,text)') create_v2_signature,
  to_regprocedure('public.employee_rehire_with_level_policy_v2(bigint,date,boolean,text,bigint,text,smallint)') rehire_v2_signature;

select user_id,count(*) active_count
from public.employee_level_program_versions
where effective_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
  and (effective_to is null or effective_to > (now() at time zone 'Asia/Ho_Chi_Minh')::date)
group by user_id having count(*) > 1;

select user_id,id,effective_from,effective_to
from public.employee_level_program_versions
where effective_to is not null and effective_to <= effective_from;
