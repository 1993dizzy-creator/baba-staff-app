-- Read-only postflight for 202607310001_add_payroll_insurance_v5.sql.
-- Save the three payroll row counts before applying the migration and compare
-- them with the informational rows returned at the bottom of this query.
with required_columns(table_name,column_name) as (
  values
    ('payroll_settings','employee_insurance_rate_bp'),
    ('payroll_settings','employer_insurance_rate_bp'),
    ('payroll_settings','director_insurance_enabled'),
    ('payroll_settings','director_insurance_base_amount'),
    ('payroll_settings','director_insurance_rate_bp'),
    ('payroll_run_employees','insurance_snapshot'),
    ('payroll_run_employees','pre_insurance_payout_amount'),
    ('payroll_run_employees','employee_insurance_deduction_amount'),
    ('payroll_run_employees','employer_insurance_amount'),
    ('payroll_runs','insurance_settings_snapshot'),
    ('payroll_runs','total_pre_insurance_payout_amount'),
    ('payroll_runs','total_employee_insurance_deduction_amount'),
    ('payroll_runs','total_employer_insurance_amount'),
    ('payroll_runs','director_insurance_amount'),
    ('payroll_runs','total_insurance_remittance_amount'),
    ('payroll_runs','total_company_cost_amount')
), required_constraints(name) as (
  values
    ('payroll_insurance_setting_month_check'),
    ('payroll_insurance_setting_revision_check'),
    ('payroll_insurance_setting_base_check'),
    ('payroll_insurance_setting_version_unique'),
    ('payroll_run_item_employee_insurance_shape_check')
), required_functions(signature) as (
  values
    ('public.payroll_create_insurance_setting_version_v1(bigint,boolean,bigint,date,bigint,text)'),
    ('public.payroll_refresh_totals_v3(bigint)'),
    ('public.payroll_insert_payload_v3(bigint,jsonb,bigint,bigint)'),
    ('public.payroll_create_run_v3(date,timestamp with time zone,text,jsonb,jsonb,bigint)'),
    ('public.payroll_recalculate_run_v3(bigint,timestamp with time zone,text,jsonb,jsonb,bigint)'),
    ('public.payroll_mutate_item_v3(bigint,bigint,bigint,text,text,text,bigint,text,text,bigint)'),
    ('public.payroll_resolve_review_v3(bigint,bigint,bigint,text,integer,text,bigint)'),
    ('public.payroll_transition_run_v3(bigint,text,text,date,text,text,bigint)')
), service_functions(signature) as (
  values
    ('public.payroll_create_insurance_setting_version_v1(bigint,boolean,bigint,date,bigint,text)'),
    ('public.payroll_create_run_v3(date,timestamp with time zone,text,jsonb,jsonb,bigint)'),
    ('public.payroll_recalculate_run_v3(bigint,timestamp with time zone,text,jsonb,jsonb,bigint)'),
    ('public.payroll_mutate_item_v3(bigint,bigint,bigint,text,text,text,bigint,text,text,bigint)'),
    ('public.payroll_resolve_review_v3(bigint,bigint,bigint,text,integer,text,bigint)'),
    ('public.payroll_transition_run_v3(bigint,text,text,date,text,text,bigint)')
), checks as (
  select 'table exists'::text check_name,
    to_regclass('public.payroll_insurance_setting_versions') is not null passed,
    coalesce(to_regclass('public.payroll_insurance_setting_versions')::text,'missing') detail
  union all
  select 'all required columns',count(*)=16,count(*)||'/16'
  from required_columns r join information_schema.columns c
    on c.table_schema='public' and c.table_name=r.table_name and c.column_name=r.column_name
  union all
  select 'all required constraints',count(*)=5,count(*)||'/5'
  from required_constraints r join pg_constraint c on c.conname=r.name
  union all
  select 'lookup and partial unique indexes',count(*)=2,count(*)||'/2'
  from pg_indexes where schemaname='public' and indexname in
    ('payroll_insurance_setting_lookup_idx','payroll_run_item_employee_insurance_unique')
  union all
  select 'RLS enabled',coalesce(c.relrowsecurity,false),coalesce(c.relrowsecurity::text,'missing')
  from (values(1)) seed left join pg_class c on c.oid=to_regclass('public.payroll_insurance_setting_versions')
  union all
  select 'all required function signatures',count(*)=8,count(*)||'/8'
  from required_functions where to_regprocedure(signature) is not null
  union all
  select 'function owners are privileged roles',bool_and(r.rolname not in ('public','anon','authenticated','service_role')),
    string_agg(distinct r.rolname,', ' order by r.rolname)
  from required_functions f join pg_proc p on p.oid=to_regprocedure(f.signature) join pg_roles r on r.oid=p.proowner
  union all
  select 'PUBLIC/anon/authenticated cannot execute',count(*)=0,count(*)||' grants'
  from required_functions f join pg_proc p on p.oid=to_regprocedure(f.signature)
  cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  where a.privilege_type='EXECUTE' and (a.grantee=0 or a.grantee in
    ((select oid from pg_roles where rolname='anon'),(select oid from pg_roles where rolname='authenticated')))
  union all
  select 'service_role can execute external RPCs',bool_and(has_function_privilege('service_role',to_regprocedure(signature),'execute')),
    count(*)||'/6 checked' from service_functions
  union all
  select 'service_role table SELECT+INSERT only',
    has_table_privilege('service_role','public.payroll_insurance_setting_versions','select') and
    has_table_privilege('service_role','public.payroll_insurance_setting_versions','insert') and
    not has_table_privilege('service_role','public.payroll_insurance_setting_versions','update') and
    not has_table_privilege('service_role','public.payroll_insurance_setting_versions','delete'),
    'select='||has_table_privilege('service_role','public.payroll_insurance_setting_versions','select')||
    ', insert='||has_table_privilege('service_role','public.payroll_insurance_setting_versions','insert')||
    ', update='||has_table_privilege('service_role','public.payroll_insurance_setting_versions','update')||
    ', delete='||has_table_privilege('service_role','public.payroll_insurance_setting_versions','delete')
  union all
  select 'public/anon/authenticated have no table privileges',count(*)=0,count(*)||' grants'
  from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
  where c.oid=to_regclass('public.payroll_insurance_setting_versions')
    and a.privilege_type in ('SELECT','INSERT','UPDATE','DELETE') and (a.grantee=0 or a.grantee in
      ((select oid from pg_roles where rolname='anon'),(select oid from pg_roles where rolname='authenticated')))
  union all
  select 'service_role sequence minimum privileges',
    has_sequence_privilege('service_role','public.payroll_insurance_setting_versions_id_seq','usage') and
    has_sequence_privilege('service_role','public.payroll_insurance_setting_versions_id_seq','select') and
    not has_sequence_privilege('service_role','public.payroll_insurance_setting_versions_id_seq','update'),
    'usage/select granted; update denied'
  union all
  select 'initial four exact settings',count(*)=4,count(*)||'/4'
  from public.payroll_insurance_setting_versions v join public.users u on u.id=v.user_id
  where u.username in ('quyen','linh_h','uyen','nhon') and v.is_enrolled
    and v.insurance_base_amount=5000000 and v.effective_month=date '2026-07-01' and v.revision=1
  union all
  select 'mjk has no employee insurance version',count(*)=0,count(*)::text
  from public.payroll_insurance_setting_versions v join public.users u on u.id=v.user_id where u.username='mjk'
  union all
  select 'global insurance defaults',count(*)=1,count(*)||'/1'
  from public.payroll_settings where id=1 and employee_insurance_rate_bp=1050
    and employer_insurance_rate_bp=2150 and director_insurance_enabled
    and director_insurance_base_amount=9000000 and director_insurance_rate_bp=3200
  union all
  select 'director monthly amount',round(director_insurance_base_amount*director_insurance_rate_bp/10000)=2880000,
    round(director_insurance_base_amount*director_insurance_rate_bp/10000)::text
  from public.payroll_settings where id=1
  union all
  select 'INFO payroll_runs row count',true,count(*)::text from public.payroll_runs
  union all
  select 'INFO payroll_run_employees row count',true,count(*)::text from public.payroll_run_employees
  union all
  select 'INFO payroll_run_items row count',true,count(*)::text from public.payroll_run_items
)
select check_name,passed,detail from checks order by check_name;
