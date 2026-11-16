-- READ ONLY. Run immediately before the separately approved migration.
begin transaction isolation level repeatable read read only;
select 'manual_cleaning_p0' check_name,
 to_regprocedure('table_operations_private.evidence_v1(text,date,uuid)') is not null
 and to_regclass('table_operations_private.activation_generation_seq') is not null pass;
select 'prior_migration_registered' check_name,
 exists(select 1 from supabase_migrations.schema_migrations where version='20261115103656') pass;
select 'successor_not_applied' check_name,
 not exists(select 1 from supabase_migrations.schema_migrations where version='20261116095122') pass;
select 'successor_objects_absent' check_name,
 to_regclass('table_operations_private.auto_config') is null
 and to_regclass('table_operations_private.payment_observations') is null
 and to_regclass('table_operations_private.auto_invalidations') is null
 and to_regprocedure('public.tables_auto_context_v1(text,date,uuid)') is null pass;
select 'manual_feature_on' check_name, enabled pass,generation from table_operations_private.config where singleton;
select 'receipt_line_index' check_name,exists(select 1 from pg_index i join pg_attribute a
 on a.attrelid=i.indrelid and a.attnum=i.indkey[0] where i.indrelid='public.pos_sales_receipt_lines'::regclass
 and i.indisvalid and i.indisready and i.indpred is null and a.attname='receipt_id') pass;
-- Preserve and compare this full object after install; any existing function change is NO-GO.
select jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))) existing_function_hashes
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in('table_operations_private','pos_open_orders_private')
 or n.nspname='public' and (p.proname like 'pos_open_orders_%' or p.proname like 'tables_cleaning_%');
rollback;
