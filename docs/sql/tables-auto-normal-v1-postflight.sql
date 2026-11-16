-- READ ONLY. Initial OFF installation gate, not an activation command.
begin transaction isolation level repeatable read read only;
select 'installed_off' check_name,exists(select 1 from table_operations_private.auto_config where singleton and not enabled and generation>0) pass;
select 'manual_still_on' check_name,exists(select 1 from table_operations_private.config where singleton and enabled) pass;
select 'registered' check_name,exists(select 1 from supabase_migrations.schema_migrations where version='20261116095122') pass;
select 'rls' check_name,count(*)=3 and bool_and(c.relrowsecurity) pass
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='table_operations_private'
 and c.relname in('auto_config','payment_observations','auto_invalidations');
select 'new_hooks_only' check_name,count(*)=3 and bool_and(tgenabled='O') pass from pg_trigger
 where tgname in('tables_auto_order_invalidation','tables_auto_receipt_invalidation','tables_auto_line_invalidation');
select 'manual_hooks_preserved' check_name,count(*)=3 and bool_and(tgenabled='O') pass from pg_trigger
 where tgname in('tables_cleaning_order_invalidation','tables_cleaning_receipt_invalidation','tables_cleaning_line_invalidation');
select 'mvcc_get' check_name,bool_and(provolatile='s' and not prosecdef) pass from pg_proc
 where oid='public.tables_auto_context_v1(text,date,uuid)'::regprocedure;
select 'no_direct_data_access' check_name,not exists(
 select 1 from (values('anon'),('authenticated'),('service_role')) r(role)
 cross join (values('auto_config'),('payment_observations'),('auto_invalidations')) t(name)
 where has_table_privilege(r.role,'table_operations_private.'||t.name,'SELECT,INSERT,UPDATE,DELETE')) pass;
select 'rpc_acl' check_name,bool_and(
 not has_function_privilege('anon',p,'EXECUTE') and not has_function_privilege('authenticated',p,'EXECUTE')
 and has_function_privilege('service_role',p,'EXECUTE')) pass
 from unnest(array['public.tables_auto_context_v1(text,date,uuid)'::regprocedure,
 'public.tables_observe_payments_v1(text,date,uuid,jsonb,jsonb,jsonb)'::regprocedure]) p;
-- Compare matching keys to Preflight. New auto_* functions are expected additions.
select jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))) existing_function_hashes
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in('table_operations_private','pos_open_orders_private')
 or n.nspname='public' and (p.proname like 'pos_open_orders_%' or p.proname like 'tables_cleaning_%');
rollback;
