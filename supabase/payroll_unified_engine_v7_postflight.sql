with expected(name,signature,result_type) as (values
 ('payroll_create_contract_version_v4','public.payroll_create_contract_version_v4(bigint,text,numeric,numeric,numeric,date,bigint,text)','jsonb'),
 ('payroll_correct_latest_unused_contract_v2','public.payroll_correct_latest_unused_contract_v2(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text)','jsonb')
), named_functions as (
 select e.name,e.signature,e.result_type as expected_result_type,p.oid,p.oid::regprocedure::text actual_signature,
 pg_get_function_result(p.oid) actual_result_type,p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) owner_name,
 has_function_privilege('public',p.oid,'execute') public_execute,
 has_function_privilege('anon',p.oid,'execute') anon_execute,
 has_function_privilege('authenticated',p.oid,'execute') authenticated_execute,
 has_function_privilege('service_role',p.oid,'execute') service_role_execute
 from expected e left join pg_proc p on p.proname=e.name
 left join pg_namespace n on n.oid=p.pronamespace
 where p.oid is null or n.nspname='public'
), existing_expected(signature) as (values
 ('public.payroll_create_contract_version_v3(bigint,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text)'),
 ('public.payroll_correct_latest_unused_contract_v1(bigint,bigint,bigint,bigint,date,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text,text)'),
 ('public.payroll_create_run_v4(date,timestamp with time zone,text,jsonb,jsonb,bigint)'),
 ('public.payroll_recalculate_run_v4(bigint,timestamp with time zone,text,jsonb,jsonb,bigint)'),
 ('public.payroll_resolve_review_v4(bigint,bigint,bigint,text,integer,text,bigint)'),
 ('public.payroll_transition_run_v4(bigint,text,text,date,text,text,bigint)')
), target as (
 select c.*,(select max(a.id) from public.payroll_contract_audit_logs a where a.contract_version_id=c.id) audit_version
 from public.payroll_contract_versions c where c.id=4 and c.user_id=23
), schedule as (
 select s.*,(((extract(hour from end_time)::int*60+extract(minute from end_time)::int)
 -(extract(hour from start_time)::int*60+extract(minute from start_time)::int)+1440)%1440)-unpaid_break_minutes calculated_minutes
 from public.employee_work_schedule_versions s
 where user_id=23 and effective_from<=date '2026-08-01' and (effective_to is null or effective_to>date '2026-08-01')
), usage as (
 select count(distinct e.id) snapshot_rows,
 count(distinct r.id) filter(where r.status in('finalized','paid')) locked_rows,
 count(distinct i.payroll_run_employee_id) item_rows,count(distinct rv.payroll_run_employee_id) review_rows
 from target c left join public.payroll_run_employees e on e.user_id=c.user_id and (
 jsonb_path_exists(e.contract_snapshot,'$[*] ? (@.id == $contractId || @.revision == $revision)',jsonb_build_object('contractId',c.id,'revision',c.revision))
 or jsonb_path_exists(e.attendance_snapshot,'$.** ? (@.contractRevision == $revision)',jsonb_build_object('revision',c.revision)))
 left join public.payroll_runs r on r.id=e.payroll_run_id
 left join public.payroll_run_items i on i.payroll_run_employee_id=e.id and jsonb_path_exists(i.source_snapshot,'$.** ? (@.contractId == $contractId || @.contractRevision == $revision)',jsonb_build_object('contractId',c.id,'revision',c.revision))
 left join public.payroll_run_reviews rv on rv.payroll_run_employee_id=e.id and jsonb_path_exists(rv.source_snapshot,'$.** ? (@.contractId == $contractId || @.contractRevision == $revision)',jsonb_build_object('contractId',c.id,'revision',c.revision))
)
select jsonb_build_object(
 'newFunctions',(select jsonb_agg(jsonb_build_object(
   'name',e.name,'expectedSignature',e.signature,
   'overloadCount',(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=e.name),
   'overloads',(select jsonb_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=e.name),
   'exactExists',to_regprocedure(e.signature) is not null,
   'resultType',f.actual_result_type,'securityDefiner',f.prosecdef,'searchPath',f.proconfig,'owner',f.owner_name,
   'publicExecute',f.public_execute,'anonExecute',f.anon_execute,'authenticatedExecute',f.authenticated_execute,'serviceRoleExecute',f.service_role_execute
 ) order by e.name) from expected e left join named_functions f on f.name=e.name and f.oid=to_regprocedure(e.signature)),
 'existingFunctions',(select jsonb_agg(jsonb_build_object('signature',signature,'preserved',to_regprocedure(signature) is not null) order by signature) from existing_expected),
 'rowCounts',jsonb_build_object(
   'contracts',(select count(*) from public.payroll_contract_versions),'contractsExpected4',(select count(*)=4 from public.payroll_contract_versions),
   'auditLogs',(select count(*) from public.payroll_contract_audit_logs),'auditLogsExpected4',(select count(*)=4 from public.payroll_contract_audit_logs),
   'runs',(select count(*) from public.payroll_runs),'runsExpected0',(select count(*)=0 from public.payroll_runs),
   'runEmployees',(select count(*) from public.payroll_run_employees),'runEmployeesExpected0',(select count(*)=0 from public.payroll_run_employees)),
 'targetContract',(select jsonb_build_object('id',id,'revision',revision,'auditVersion',audit_version,'effectiveFrom',effective_from,
   'standardMinutesPerDay',standard_minutes_per_day,'still540',standard_minutes_per_day=540,
   'isLatest',id=(select id from public.payroll_contract_versions where user_id=23 order by revision desc,effective_from desc,id desc limit 1)) from target),
 'schedule',(select jsonb_build_object('rows',count(*),'startTime',min(start_time),'endTime',min(end_time),
   'unpaidBreakMinutes',min(unpaid_break_minutes),'calculatedMinutes',min(calculated_minutes),
   'expected',count(*)=1 and min(start_time)=time '18:00' and min(end_time)=time '23:00' and min(unpaid_break_minutes)=0 and min(calculated_minutes)=300) from schedule),
 'usage',(select jsonb_build_object('snapshotRows',snapshot_rows,'lockedRows',locked_rows,'itemRows',item_rows,'reviewRows',review_rows,
   'stillUnused',snapshot_rows=0 and locked_rows=0 and item_rows=0 and review_rows=0) from usage)
);
