-- 상태: 폐기(superseded), 2026-10-22. POS 관리자 복구 V1·V2 과거 점검 SQL이며 현재 운영 절차가 아니다.
-- 현재 기준: docs/reports/20261022-pos-admin-resolution-v1-v2-retirement.md
-- SELECT ONLY. Not executed on production. No calls to mutating RPCs.
-- Check actual FK parents/trigger ordering before manually approving migration3.
select current_setting('server_version') as version;
select count(*) as deductions,
 count(*) filter(where batch_id is null) as null_batch,
 count(*) filter(where batch_receipt_id is null) as null_batch_receipt,
 count(*) filter(where receipt_id is null) as null_receipt,
 count(*) filter(where receipt_id is not null and not exists(
  select 1 from public.pos_sales_receipts r where r.id=d.receipt_id)) as orphan_receipt
from public.pos_inventory_deductions d;
select a.attname,format_type(a.atttypid,a.atttypmod) as type,a.attnotnull
from pg_attribute a where a.attrelid='public.pos_inventory_deductions'::regclass
 and a.attname in('id','receipt_id','invoice_ref_id','batch_id','batch_receipt_id',
 'receipt_line_id','reversal_of_deduction_id','receipt_ref_no','business_date','inventory_item_id');
select conname,pg_get_constraintdef(oid) as definition from pg_constraint
where conrelid='public.pos_inventory_deductions'::regclass order by conname;
select t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) as trigger_definition,
 pg_get_functiondef(t.tgfoid) as function_definition
from pg_trigger t where t.tgrelid='public.pos_inventory_deductions'::regclass and not t.tgisinternal
order by t.tgname;
select p.oid::regprocedure as signature,p.prosecdef,p.proconfig,
 encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') as sha256,
 has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
 has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute
from pg_proc p where p.pronamespace=to_regnamespace('pos_resolution_private')
 and p.proname in('deduction_links','deduction_receipt_ids','deduction_write_guard');

-- Approval/history are immutable; sample their existing row counts after
-- schema-only application, with all application write/recheck flags still OFF.
select (select count(*) from public.pos_sales_receipt_admin_resolutions) as resolutions,
 (select count(*) from public.pos_sales_receipt_inventory_approvals) as approvals,
 (select count(*) from public.inventory_logs) as inventory_logs;
