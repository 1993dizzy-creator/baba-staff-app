-- READ ONLY; prepared locally, not executed on production.
-- Run after separately approved application, with Keg changes paused.
-- Compare existing RPC/trigger/ACL/data output with a saved pre-apply baseline.
-- Never call apply/replace RPCs as a postflight test.
begin transaction isolation level repeatable read read only;
select current_setting('transaction_read_only') as read_only, current_timestamp as captured_at;

-- Exactly one row is expected. Missing history is a STOP condition.
select version,name,cardinality(statements) as statement_count
from supabase_migrations.schema_migrations where version='20261020120000';

-- Exact argument names/defaults, JSONB returns, SECURITY DEFINER, owner/config/ACL.
with expected(signature) as (values
 ('public.inventory_preview_keg_change(text,bigint,bigint,timestamptz,date,text,numeric)'),
 ('public.inventory_apply_keg_change(text,bigint,bigint,timestamptz,date,text,numeric,text,uuid,text,boolean)'))
select e.signature,p.oid is not null as exists,pg_get_function_arguments(p.oid) as arguments,
 pg_get_function_result(p.oid) as result,r.rolname as owner,p.prosecdef,p.provolatile,p.proconfig,
 p.proacl::text as acl,md5(pg_get_functiondef(p.oid)) as definition_md5,pg_get_functiondef(p.oid) as definition
from expected e left join pg_proc p on p.oid=to_regprocedure(e.signature)
left join pg_roles r on r.oid=p.proowner;

-- Exactly one overload per new function; anon/authenticated false, service_role true.
select p.proname,p.oid::regprocedure as signature,r.role_name,
 has_function_privilege(r.role_name,p.oid,'EXECUTE') as execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
cross join unnest(array['anon','authenticated','service_role']) r(role_name)
where n.nspname='public' and p.proname in ('inventory_preview_keg_change','inventory_apply_keg_change')
order by 1,2,3;
-- No PUBLIC execute or unexpected grantees; owner privileges remain implicit.
select p.oid::regprocedure as signature,
 case when a.grantee=0 then 'PUBLIC' else grantee.rolname end as grantee,a.privilege_type,a.is_grantable
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
left join pg_roles grantee on grantee.oid=a.grantee
where n.nspname='public' and p.proname in ('inventory_preview_keg_change','inventory_apply_keg_change')
order by 1,2,3;

-- Audit RLS true; no browser access/policies; service_role direct SELECT only.
select c.relname,r.rolname as owner,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text as acl
from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_roles r on r.oid=c.relowner
where n.nspname='public' and c.relname='inventory_keg_safety_audit';
select r.role_name,p.privilege,
 has_table_privilege(r.role_name,'public.inventory_keg_safety_audit',p.privilege) as allowed
from unnest(array['anon','authenticated','service_role']) r(role_name)
cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(privilege)
order by 1,2;
select * from pg_policies where schemaname='public' and tablename='inventory_keg_safety_audit';
select conname,pg_get_constraintdef(oid) as definition from pg_constraint
where conrelid='public.inventory_keg_safety_audit'::regclass order by conname;
select indexname,indexdef from pg_indexes where schemaname='public' and tablename='inventory_keg_safety_audit';
select count(*) as audit_count_before_saving_is_enabled from public.inventory_keg_safety_audit;

-- Existing RPC definition/owner/config/ACL must equal the saved baseline.
select p.oid::regprocedure as signature,r.rolname as owner,p.proacl::text as acl,p.proconfig,p.prosecdef,
 md5(pg_get_functiondef(p.oid)) as definition_md5,pg_get_functiondef(p.oid) as definition
from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner
where n.nspname='public' and p.proname in ('replace_inventory_keg','calculate_inventory_keg_sales') order by 1;
select c.relname,c.relacl::text as acl,c.relrowsecurity,t.tgname,pg_get_triggerdef(t.oid) as trigger_definition
from pg_class c join pg_namespace n on n.oid=c.relnamespace
left join pg_trigger t on t.tgrelid=c.oid and not t.tgisinternal
where n.nspname='public' and c.relname in ('inventory','inventory_logs','inventory_keg_sessions','inventory_keg_tracking_mappings')
order by c.relname,t.tgname;

-- Bounded Keg state: equality requires no legitimate writes between snapshots.
select count(*) as keg_item_count,
 md5(coalesce(string_agg(md5(to_jsonb(i)::text),'' order by id),'')) as fingerprint
from public.inventory i where lower(coalesce(unit,''))='keg';
select count(*) as session_count,count(*) filter(where status='active') as active_count,
 count(*) filter(where status='closed') as closed_count,
 md5(coalesce(string_agg(md5(to_jsonb(s)::text),'' order by id),'')) as fingerprint
from public.inventory_keg_sessions s;
select count(*) as mapping_count,
 md5(coalesce(string_agg(md5(to_jsonb(m)::text),'' order by id),'')) as fingerprint
from public.inventory_keg_tracking_mappings m;
select count(*) as replacement_log_count,max(id) as latest_replacement_log_id,
 md5(coalesce(string_agg(md5(to_jsonb(l)::text),'' order by id),'')) as fingerprint
from public.inventory_logs l where source='keg_replace';
select inventory_item_id,count(*) as active_count from public.inventory_keg_sessions
where status='active' group by inventory_item_id having count(*)>1;
rollback;