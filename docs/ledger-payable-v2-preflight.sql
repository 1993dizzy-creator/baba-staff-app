-- Read-only preflight. Run in the approved target environment; no payment RPC is invoked.
-- Run the conditional sections only after verifying the named relation exists.

select version from supabase_migrations.schema_migrations where version='20261018105936';

select n.nspname as schema_name,p.proname,
 pg_get_function_identity_arguments(p.oid) as arguments,
 pg_get_userbyid(p.proowner) as owner,p.prosecdef as security_definer,p.proconfig,
 has_function_privilege('service_role',p.oid,'EXECUTE') as service_role_execute,
 has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where p.proname in ('ledger_pay_payables_v1','ledger_pay_payables_v2')
 or (p.prokind='f' and p.prosrc like '%ledger_pay_payables_v1%');

-- Installed V2 must retain EXECUTE as its definer after caller-facing V1 grants are revoked.
select pg_get_userbyid(v1.proowner) as v1_owner,pg_get_userbyid(v2.proowner) as v2_owner,
 v1.proowner=v2.proowner as same_owner,
 v2.prosecdef as v2_security_definer,
 has_function_privilege(v2.proowner,v1.oid,'EXECUTE') as definer_can_execute_v1
from pg_proc v1 join pg_namespace n1 on n1.oid=v1.pronamespace
cross join pg_proc v2 join pg_namespace n2 on n2.oid=v2.pronamespace
where n1.nspname='public' and n2.nspname='public'
 and v1.proname='ledger_pay_payables_v1' and v2.proname='ledger_pay_payables_v2';

-- No command text: cron commands may contain credentials.
select to_regclass('cron.job') is not null as cron_jobs_available;
-- Run only if cron_jobs_available=true, with a role permitted to inspect jobs:
select jobid,active,schedule,
 position('ledger_pay_payables_v1' in command)>0 as calls_v1,
 position('/api/admin/ledger/payables/pay' in command)>0 as calls_payment_api
from cron.job
where position('ledger_pay_payables' in command)>0
 or position('/api/admin/ledger/payables/pay' in command)>0;

select to_regclass('public.ledger_payable_payment_requests') is not null as requests_available;
-- Run only if requests_available=true, as an approved audit role:
select count(*) as incomplete_request_count from public.ledger_payable_payment_requests
where result is null or completed_at is null
 or jsonb_typeof(result) is distinct from 'object'
 or nullif(result->>'status','') is null;