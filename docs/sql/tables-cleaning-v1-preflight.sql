-- READ ONLY. Run against the intended production target immediately before approved
-- application. Any false = NO-GO. No apply/repair/config/RPC execution in this file.
with required_objects(signature) as(values
 ('pos_open_orders_private.read_v1(text,date)'),
 ('pos_open_orders_private.commit_v1(uuid,uuid,jsonb,jsonb)'),
 ('public.store_business_date_for_timestamp_v1(timestamp with time zone)')),
required_columns(schema_name,table_name,column_name) as(values
 ('public','users','id'),('public','users','role'),('public','users','is_active'),('public','users','app_login_enabled'),
 ('public','pos_sales_receipts','id'),('public','pos_sales_receipts','source'),('public','pos_sales_receipts','branch_id'),
 ('public','pos_sales_receipts','business_date'),('public','pos_sales_receipts','payment_status'),('public','pos_sales_receipts','is_canceled'),
 ('public','pos_sales_receipts','final_amount'),('public','pos_sales_receipts','ref_no'),('public','pos_sales_receipts','ref_date'),
 ('public','pos_sales_receipts','status_changed_at'),('public','pos_sales_receipts','raw_json'),
 ('public','pos_sales_receipt_lines','id'),('public','pos_sales_receipt_lines','receipt_id'),('public','pos_sales_receipt_lines','source'),
 ('pos_open_orders_private','orders','closure_receipt_id'),('pos_open_orders_private','orders','closure_merged_into_order_id'),
 ('pos_open_orders_private','orders','closure_evidence_hash'),('pos_open_orders_private','sync_state','last_success_at')),
checks as(
 select 'migration_history_absent' check_name,not exists(select 1 from supabase_migrations.schema_migrations where version='20261115103656' or name like '%tables_cleaning%') pass,
  'Existing history requires a new successor migration; never edit or repair it.' detail
 union all select 'cleaning_objects_absent',to_regnamespace('table_operations_private') is null
  and to_regprocedure('public.tables_cleaning_context_v1(text,date)') is null
  and to_regprocedure('public.tables_cleaning_confirm_v1(text,date,uuid,bigint,uuid,bigint,text,jsonb,jsonb)') is null
  and not exists(select 1 from pg_trigger where not tgisinternal and tgname like 'tables_cleaning_%'),'No partial/conflicting cleaning installation.'
 union all select 'roles_exist',(select count(*)=3 from pg_roles where rolname in('anon','authenticated','service_role')),'Expected API roles.'
 union all select 'functions_exist',not exists(select 1 from required_objects where to_regprocedure(signature) is null),'Existing v3 read/commit and configured business date function.'
 union all select 'columns_exist',not exists(select 1 from required_columns r where not exists(select 1 from information_schema.columns c
  where c.table_schema=r.schema_name and c.table_name=r.table_name and c.column_name=r.column_name)),'All statically referenced columns.'
 union all select 'read_v3_contract',coalesce((select prosrc like '%closureMergedIntoOrderId%' from pg_proc where oid=to_regprocedure('pos_open_orders_private.read_v1(text,date)')),false),'Preserve v3 closure read evidence.'
 union all select 'collector_scope_fence',coalesce((select prosrc like '%pos_open_orders:%' and prosrc like '%pg_advisory_xact_lock%' from pg_proc
  where oid=to_regprocedure('pos_open_orders_private.commit_v1(uuid,uuid,jsonb,jsonb)')),false),'Writer lock order: scope advisory, receipt SHARE.'
 union all select 'receipt_line_lookup_index',exists(select 1 from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=i.indkey[0]
  where i.indrelid=to_regclass('public.pos_sales_receipt_lines') and i.indisvalid and i.indisready and a.attname='receipt_id' and i.indpred is null),
  'A valid unfiltered index beginning with receipt_id is required for repeated line projection.'
)
select check_name,pass,detail,statement_timestamp() checked_at,current_setting('transaction_read_only') read_only,
 (select coalesce(jsonb_object_agg(signature,hash),'{}'::jsonb) from (select p.oid::regprocedure::text signature,md5(p.prosrc) hash
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='pos_open_orders_private'
   or n.nspname='public' and p.proname like 'pos\_open\_orders\_%') f) v3_function_hashes
from checks order by check_name;
