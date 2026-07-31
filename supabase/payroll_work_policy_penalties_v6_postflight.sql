-- Read-only verification for monthly-payroll-v6. Run after applying the migration.
with expected_columns(table_name,column_name,expected_default) as (
  values
    ('payroll_settings','late_major_threshold_minutes','20'),
    ('payroll_settings','late_minor_penalty_minutes','60'),
    ('payroll_settings','late_major_penalty_rate_bp','5000'),
    ('payroll_settings','unauthorized_absence_penalty_days','3'),
    ('payroll_runs','penalty_settings_snapshot',null)
)
select e.table_name,e.column_name,c.data_type,c.is_nullable,c.column_default,e.expected_default,
       c.column_name is not null as exists
from expected_columns e
left join information_schema.columns c on c.table_schema='public' and c.table_name=e.table_name and c.column_name=e.column_name
order by e.table_name,e.column_name;

select conrelid::regclass as table_name,conname,pg_get_constraintdef(oid) as definition
from pg_constraint
where connamespace='public'::regnamespace
  and conname in (
    'payroll_settings_late_major_threshold_check','payroll_settings_late_minor_penalty_check',
    'payroll_settings_late_major_rate_check','payroll_settings_unauthorized_absence_days_check',
    'payroll_run_items_category_check','payroll_run_item_category_direction_check'
  )
order by conname;

select schemaname,tablename,indexname,indexdef
from pg_indexes
where schemaname='public' and indexname in('payroll_run_item_automatic_late_unique','payroll_run_item_unauthorized_absence_unique')
order by indexname;

with expected(signature) as (values
 ('public.payroll_refresh_totals_v4(bigint)'),
 ('public.payroll_insert_payload_v4(bigint,jsonb,bigint,bigint)'),
 ('public.payroll_create_run_v4(date,timestamp with time zone,text,jsonb,jsonb,bigint)'),
 ('public.payroll_recalculate_run_v4(bigint,timestamp with time zone,text,jsonb,jsonb,bigint)'),
 ('public.payroll_mutate_item_v4(bigint,bigint,bigint,text,text,text,bigint,text,text,bigint)'),
 ('public.payroll_resolve_review_v4(bigint,bigint,bigint,text,integer,text,bigint)'),
 ('public.payroll_transition_run_v4(bigint,text,text,date,text,text,bigint)'),
 ('public.payroll_create_run_v3(date,timestamp with time zone,text,jsonb,jsonb,bigint)'),
 ('public.payroll_create_run_v2(date,timestamp with time zone,text,jsonb,jsonb,bigint)')
)
select signature,to_regprocedure(signature) is not null as exists from expected order by signature;

select p.oid::regprocedure as function_signature,r.rolname as owner,
       not exists (
         select 1
         from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
         where acl.grantee=0
           and acl.privilege_type='EXECUTE'
       ) as public_execute_revoked,
       has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
       has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
       has_function_privilege('service_role',p.oid,'EXECUTE') as service_role_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner
where n.nspname='public' and p.proname like 'payroll_%_v4'
order by p.oid::regprocedure::text;

select
  (select count(*) from public.payroll_settings) as payroll_settings_rows,
  (select count(*) from public.payroll_contract_versions) as contract_version_rows,
  (select count(*) from public.employee_work_schedule_versions) as schedule_version_rows,
  (select count(*) from public.payroll_runs) as payroll_run_rows,
  (select count(*) from public.payroll_run_employees) as payroll_run_employee_rows,
  (select count(*) from public.payroll_run_items) as payroll_run_item_rows,
  (select count(*) from public.payroll_run_reviews) as payroll_run_review_rows,
  (select count(*) from public.payroll_insurance_setting_versions) as insurance_version_rows;

select id,payment_day,employee_insurance_rate_bp,employer_insurance_rate_bp,director_insurance_enabled,
       director_insurance_base_amount,director_insurance_rate_bp,late_major_threshold_minutes,
       late_minor_penalty_minutes,late_major_penalty_rate_bp,unauthorized_absence_penalty_days
from public.payroll_settings where id=1;

select
  count(*) filter(where u.username in('quyen','linh_h','uyen','nhon') and v.effective_month=date '2026-07-01' and v.revision=1 and v.is_enrolled and v.insurance_base_amount=5000000) as expected_initial_insurance_rows,
  count(*) filter(where u.username='mjk') as mjk_insurance_version_rows
from public.payroll_insurance_setting_versions v join public.users u on u.id=v.user_id;

select payroll_run_employee_id,business_date,category,count(*) as duplicate_count
from public.payroll_run_items
where (item_type='automatic' and category='late_deduction') or category='unauthorized_absence_deduction'
group by payroll_run_employee_id,business_date,category having count(*)>1;
