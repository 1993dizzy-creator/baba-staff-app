-- READ ONLY, immediately after approved apply, while app and DB activation remain OFF.
-- Save the v3 function hashes from preflight and compare separately; never call confirm.
with private_functions as(select p.* from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='table_operations_private'),
public_functions as(select p.* from pg_proc p where p.oid in(to_regprocedure('public.tables_cleaning_context_v1(text,date)'),
 to_regprocedure('public.tables_cleaning_confirm_v1(text,date,uuid,bigint,uuid,bigint,text,jsonb,jsonb)'))),
all_functions as(select * from private_functions union all select * from public_functions),
checks as(
 select 'history_registered' check_name,(select count(*)=1 from supabase_migrations.schema_migrations where version='20261115103656') pass,
  'Exact target version registered through the approved migration procedure.' detail
 union all select 'default_off_and_generation',(select count(*)=1 and bool_and(not enabled and generation>0) from table_operations_private.config where singleton),
  'Do not enable during application/postflight.'
 union all select 'catalog_27_exact',(select count(*)=27 and md5(string_agg(table_id::text||'|'||table_name||'|'||branch_id,E'\n' order by table_name collate "C"))='1ff7f5bdb9eebc38da7a403b1e65dd43'
  from table_operations_private.catalog),'All actual UUID/name/branch mappings unchanged.'
 union all select 'private_rls',(select count(*)=4 and bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='table_operations_private' and c.relkind='r'),'Config, catalog, events and invalidations RLS enabled.'
 union all select 'fixed_search_path',(select count(*)=14 and bool_and(exists(select 1 from unnest(p.proconfig) s where s in('search_path=""','search_path='))) from all_functions p),
  'All 12 private and 2 public functions use an empty fixed search_path.'
 union all select 'security_modes',(select bool_and(prosecdef=(proname in('activation_generation_v1','context_v1','confirm_v1','invalidate_order_v1','invalidate_receipt_v1','invalidate_line_v1'))) from private_functions)
  and (select count(*)=2 and bool_and(not prosecdef) from public_functions),'Only private entry/trigger functions are DEFINER; public wrappers are INVOKER.'
 union all select 'get_nonblocking',(select count(*)=2 and bool_and(provolatile='s' and prosrc not like '%pg_advisory_xact_lock%' and prosrc not like '%lock table%')
  from all_functions where proname in('context_v1','tables_cleaning_context_v1')),'STABLE MVCC GETs without advisory or SHARE locks.'
 union all select 'browser_execute_denied',not exists(select 1 from all_functions p where has_function_privilege('anon',p.oid,'EXECUTE')
  or has_function_privilege('authenticated',p.oid,'EXECUTE') or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE')),
  'No PUBLIC/anon/authenticated EXECUTE.'
 union all select 'service_entry_only',(select count(*)=14 and bool_and(has_function_privilege('service_role',oid,'EXECUTE')=
  (proname in('context_v1','confirm_v1','tables_cleaning_context_v1','tables_cleaning_confirm_v1'))) from all_functions),
  'service_role may execute the four entry/wrapper functions only.'
 union all select 'private_data_denied',not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='table_operations_private' and c.relkind='r' and (has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE')
  or has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') or has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE'))),
  'No direct API-role access to operational records.'
 union all select 'private_sequences_denied',not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='table_operations_private' and c.relkind='S' and (has_sequence_privilege('service_role',c.oid,'USAGE,SELECT,UPDATE')
  or has_sequence_privilege('anon',c.oid,'USAGE,SELECT,UPDATE') or has_sequence_privilege('authenticated',c.oid,'USAGE,SELECT,UPDATE'))),
  'Activation generation and audit sequence values cannot be reset by API roles.'
 union all select 'schema_usage_boundary',has_schema_privilege('service_role','table_operations_private','USAGE')
  and not has_schema_privilege('anon','table_operations_private','USAGE') and not has_schema_privilege('authenticated','table_operations_private','USAGE'),
  'Private schema boundary.'
 union all select 'triggers_installed',(select count(*)=4 and bool_and(t.tgenabled='O') from pg_trigger t
  where not t.tgisinternal and t.tgname in('tables_cleaning_order_invalidation','tables_cleaning_receipt_invalidation','tables_cleaning_line_invalidation','tables_cleaning_activation_generation')),
  'Three POS AFTER hooks and one private activation-generation BEFORE hook enabled.'
)
select check_name,pass,detail,
 (select coalesce(jsonb_object_agg(signature,hash),'{}'::jsonb) from (select p.oid::regprocedure::text signature,md5(p.prosrc) hash
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='pos_open_orders_private'
   or n.nspname='public' and p.proname like 'pos\_open\_orders\_%') f) v3_function_hashes
from checks order by check_name;
