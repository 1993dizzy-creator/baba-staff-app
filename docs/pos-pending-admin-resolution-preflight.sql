-- 상태: 폐기(superseded), 2026-10-22. POS 관리자 복구 V1·V2 과거 점검 SQL이며 현재 운영 절차가 아니다.
-- 현재 기준: docs/reports/20261022-pos-admin-resolution-v1-v2-retirement.md
-- SELECT ONLY. Prepared locally; NOT executed against BABA production.
-- Run only the requested stage after approval. No function in this file writes.
-- BEFORE migration 1/2: existence, types, constraints, function definitions.
select current_setting('server_version') as server_version;
select has_schema_privilege('anon','public','CREATE') as anon_create_public,
 has_schema_privilege('authenticated','public','CREATE') as authenticated_create_public;
select (select count(*) from public.pos_sales_receipts) as receipts,
 (select count(*) from public.pos_sales_receipt_lines) as lines,
 (select count(*) from public.pos_sales_receipt_payments) as payments,
 (select count(*) from public.inventory_logs) as inventory_logs,
 (select count(*) from public.ledger_transactions) as ledger_transactions;

select n.nspname as schema_name,c.relname,a.attname,
       format_type(a.atttypid,a.atttypmod) as data_type,a.attnotnull,
       pg_get_expr(d.adbin,d.adrelid) as default_expression
from pg_attribute a join pg_class c on c.oid=a.attrelid
join pg_namespace n on n.oid=c.relnamespace
left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
where n.nspname in('public','pos_resolution_private') and a.attnum>0 and not a.attisdropped
and c.relname in('users','pos_sales_receipts','pos_sales_receipt_lines','pos_sales_receipt_payments',
 'pos_sales_receipt_modifications','pos_inventory_deductions','pos_inventory_deduction_receipts',
 'pos_inventory_deduction_batches','inventory','inventory_logs','pos_products','pos_item_mappings',
 'pos_item_mapping_recipes','pos_sales_business_day_closures','ledger_month_closures')
order by n.nspname,c.relname,a.attnum;

select schemaname,tablename,indexname,indexdef from pg_indexes
where schemaname='public' and tablename in('pos_sales_receipt_payments','pos_inventory_deductions',
 'pos_inventory_deduction_receipts','pos_sales_receipt_modifications') order by tablename,indexname;

select c.conrelid::regclass as relation,c.conname,pg_get_constraintdef(c.oid) as definition
from pg_constraint c where c.conrelid in(to_regclass('public.pos_inventory_deductions'),
 to_regclass('public.pos_inventory_deduction_receipts'),to_regclass('public.pos_sales_receipt_payments'),
 to_regclass('public.pos_sales_receipt_modifications')) order by c.conrelid::regclass::text,c.conname;

select n.nspname,p.oid::regprocedure as signature,pg_get_userbyid(p.proowner) as owner,p.prosecdef,p.proconfig,p.proacl,
 md5(pg_get_functiondef(p.oid)) as definition_md5,
 md5(replace(replace(pg_get_functiondef(p.oid),E'\r\n',E'\n'),E'\r',E'\n')) as normalized_definition_md5,
 strpos(pg_get_functiondef(p.oid),E'begin\n') as begin_lf_position,
 strpos(pg_get_functiondef(p.oid),E'begin\r\n') as begin_crlf_position,
 pg_get_functiondef(p.oid) as definition
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname in('public','pos_sales_close_private','pos_resolution_private')
and p.proname in('admin_update_paid_sales_receipt','apply_sales_inventory_deduction_batch',
 'reprocess_modified_sales_inventory_deduction_receipt','rollback_canceled_sales_inventory_deduction_receipt',
 'sales_close_business_day_v1','build_source','ledger_month_is_closed_v1','set_pos_sales_updated_at',
 'sales_resolve_pending_receipt_v1','sales_observe_resolved_receipts_v1',
 'sales_get_pending_resolution_v1','source_guard','sales_resolve_pending_receipt_v2',
 'sales_correct_admin_resolution_v2','sales_get_admin_resolution_work_v2',
 'sales_preview_admin_resolution_inventory_v2','sales_confirm_admin_resolution_inventory_v2')
order by n.nspname,p.proname;

select version,name from supabase_migrations.schema_migrations
where version in('20261021070640','20261021081604') order by version;

-- Candidate search only: suffixes are NOT approval identities. Verify full
-- source/ref_id/ref_no/business_date and actual evidence individually.
select r.id,r.source,r.ref_id,r.ref_no,r.business_date,r.ref_date,r.created_at,
 r.payment_status,r.is_canceled,r.final_amount,r.revision,
 r.inventory_deduction_processing_paused,r.is_modified,
 encode(sha256(convert_to(coalesce(r.raw_json,'{}'::jsonb)::text,'UTF8')),'hex') as raw_json_sha256,
 (select count(*) from public.pos_sales_receipt_lines l where l.receipt_id=r.id) as line_count,
 (select count(*) from public.pos_sales_receipt_payments p where p.receipt_id=r.id) as payment_count,
 (select count(*) from public.pos_inventory_deductions d where d.receipt_id=r.id or d.invoice_ref_id=r.ref_id) as deduction_history_count,
 count(*) over(partition by r.business_date,right(regexp_replace(r.ref_no,'[^0-9]','','g'),4)) as candidate_count
from public.pos_sales_receipts r
where r.source='cukcuk' and r.business_date between date '2026-10-17' and date '2026-10-21'
 and right(regexp_replace(r.ref_no,'[^0-9]','','g'),4) in('6974','6981','6982','7055','7059','7057','7063','7064','7072','7075')
order by r.business_date,r.ref_no,r.id limit 100;

select distinct on(business_date) business_date,revision,source_fingerprint
from public.pos_sales_business_day_closures where business_date in(date '2026-10-17',date '2026-10-20')
order by business_date,revision desc;
select month,status from public.ledger_month_closures where month=date '2026-10-01';

-- AFTER migration 2 only: role/DDL/trigger checks. No calls to mutating RPCs.
select n.nspname,p.oid::regprocedure as signature,p.prosecdef,p.proconfig,
 has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
 has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in('sales_resolve_pending_receipt_v2',
 'sales_correct_admin_resolution_v2','sales_get_admin_resolution_work_v2',
 'sales_preview_admin_resolution_inventory_v2','sales_confirm_admin_resolution_inventory_v2')
order by p.oid::regprocedure::text;

select n.nspname,c.relname,c.relrowsecurity,
 has_table_privilege('anon',c.oid,'SELECT') as anon_select,
 has_table_privilege('authenticated',c.oid,'SELECT') as authenticated_select,
 has_table_privilege('service_role',c.oid,'INSERT') as service_insert,
 has_table_privilege('service_role',c.oid,'UPDATE') as service_update,
 has_table_privilege('service_role',c.oid,'DELETE') as service_delete
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where (n.nspname='public' and c.relname in('pos_sales_receipt_resolution_versions',
 'pos_sales_receipt_inventory_reviews','pos_sales_receipt_inventory_approvals'))
 or (n.nspname='pos_resolution_private' and c.relname='work_capabilities')
order by n.nspname,c.relname;

select c.oid::regclass as relation,t.tgname,pg_get_triggerdef(t.oid) as definition
from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
where not t.tgisinternal and n.nspname='public' and c.relname in('pos_sales_receipts',
 'pos_sales_receipt_lines','pos_sales_receipt_payments','pos_sales_receipt_resolution_versions',
 'pos_sales_receipt_inventory_reviews','pos_sales_receipt_inventory_approvals')
order by c.oid::regclass::text,t.tgname;

-- AFTER migration 2: all three new public tables should remain empty while
-- writes are OFF; applying the schema itself creates no business audit rows.
select (select count(*) from public.pos_sales_receipt_resolution_versions) as versions,
 (select count(*) from public.pos_sales_receipt_inventory_reviews) as reviews,
 (select count(*) from public.pos_sales_receipt_inventory_approvals) as approvals;
