-- READ-ONLY preflight for 20261021193000_retire_pos_admin_resolution_v1_v2.sql.
-- SELECT only. Run in SQL Editor BEFORE applying; every "expected" column must match.

-- 1) V1/V2 records: all must be 0 (the migration refuses to discard recorded work).
select 'pos_sales_receipt_admin_resolutions' as object, count(*) as rows, 0 as expected from public.pos_sales_receipt_admin_resolutions
union all select 'pos_sales_receipt_resolution_history', count(*), 0 from public.pos_sales_receipt_resolution_history
union all select 'pos_sales_receipt_pos_observations', count(*), 0 from public.pos_sales_receipt_pos_observations
union all select 'pos_sales_receipt_resolution_versions', count(*), 0 from public.pos_sales_receipt_resolution_versions
union all select 'pos_sales_receipt_inventory_reviews', count(*), 0 from public.pos_sales_receipt_inventory_reviews
union all select 'pos_sales_receipt_inventory_approvals', count(*), 0 from public.pos_sales_receipt_inventory_approvals
union all select 'receipts admin_resolution_version<>0', count(*), 0 from public.pos_sales_receipts where admin_resolution_version <> 0
union all select 'receipts financial_review_required', count(*), 0 from public.pos_sales_receipts where admin_resolution_financial_review_required is not false
union all select 'receipts held for V2 inventory review', count(*), 0 from public.pos_sales_receipts where inventory_deduction_processing_error = 'admin_resolution_inventory_review_required'
union all select 'payments admin_resolution_retired', count(*), 0 from public.pos_sales_receipt_payments where admin_resolution_retired is not false
union all select 'deduction receipts admin fingerprint', count(*), 0 from public.pos_inventory_deduction_receipts where admin_resolution_content_fingerprint is not null;
-- pos_resolution_private.capabilities / work_capabilities are not readable through the API
-- roles; the migration itself counts them under lock and aborts if they are not empty.

-- 2) Exact V2 inserts are present once in each operating function (all must be 1).
with defs as (
  select p.oid::regprocedure::text as signature,
    replace(replace(pg_get_functiondef(p.oid), E'\r\n', E'\n'), E'\r', E'\n') as d
  from pg_proc p
  where p.oid in (
    'public.apply_sales_inventory_deduction_batch(bigint,text,jsonb)'::regprocedure,
    'public.reprocess_modified_sales_inventory_deduction_receipt(bigint,text,timestamptz,text,text)'::regprocedure,
    'public.rollback_canceled_sales_inventory_deduction_receipt(bigint,text,timestamptz,text)'::regprocedure,
    'pos_sales_close_private.build_source(date)'::regprocedure)
)
select signature,
  (length(d) - length(replace(d, 'POS_RESOLUTION_INVENTORY_APPROVAL_REQUIRED', ''))) / length('POS_RESOLUTION_INVENTORY_APPROVAL_REQUIRED') as engine_guard,
  (length(d) - length(replace(d, 'POS_RESOLUTION_FINANCIAL_CORRECTION_REQUIRED', ''))) / length('POS_RESOLUTION_FINANCIAL_CORRECTION_REQUIRED') as source_guard,
  (length(d) - length(replace(d, ' and p.admin_resolution_retired is not true', ''))) / length(' and p.admin_resolution_retired is not true') as retired_filters,
  'engines: engine_guard=1; build_source: source_guard=1 and retired_filters>=2' as expected
from defs order by 1;

-- 3) Object footprint and the already-removed recheck queue (174643 effect).
select 'pos_resolution_private schema' as object, to_regnamespace('pos_resolution_private') is not null as present, true as expected
union all select 'recheck_jobs (removed by 174643)', to_regclass('pos_resolution_private.recheck_jobs') is not null, false
union all select 'sales_claim_pending_rechecks_v1 (removed by 174643)', to_regprocedure('public.sales_claim_pending_rechecks_v1()') is not null, false
union all select 'sales_correct_admin_resolution_v2', to_regprocedure('public.sales_correct_admin_resolution_v2(bigint,bigint,jsonb)') is not null, true
union all select 'sales_confirm_admin_resolution_inventory_v2', to_regprocedure('public.sales_confirm_admin_resolution_inventory_v2(bigint,bigint,jsonb)') is not null, true
union all select 'trigger pos_admin_resolution_deduction_write_guard', exists(select 1 from pg_trigger where tgname = 'pos_admin_resolution_deduction_write_guard'), true
union all select 'trigger pos_resolution_receipt_guard', exists(select 1 from pg_trigger where tgname = 'pos_resolution_receipt_guard'), true
union all select 'trigger pos_resolution_line_guard', exists(select 1 from pg_trigger where tgname = 'pos_resolution_line_guard'), true
union all select 'trigger pos_resolution_payment_guard', exists(select 1 from pg_trigger where tgname = 'pos_resolution_payment_guard'), true;

-- 4) Identity to compare after applying (OID/owner/ACL/options must be unchanged).
select p.oid, p.oid::regprocedure as signature, pg_get_userbyid(p.proowner) as owner, p.proacl, p.prosecdef, p.proconfig
from pg_proc p
where p.oid in (
  'public.apply_sales_inventory_deduction_batch(bigint,text,jsonb)'::regprocedure,
  'public.reprocess_modified_sales_inventory_deduction_receipt(bigint,text,timestamptz,text,text)'::regprocedure,
  'public.rollback_canceled_sales_inventory_deduction_receipt(bigint,text,timestamptz,text)'::regprocedure,
  'pos_sales_close_private.build_source(date)'::regprocedure)
order by 2;

-- 5) Row counts to compare after applying (must be identical).
select 'pos_sales_receipts' as t, count(*) from public.pos_sales_receipts
union all select 'pos_sales_receipt_lines', count(*) from public.pos_sales_receipt_lines
union all select 'pos_sales_receipt_payments', count(*) from public.pos_sales_receipt_payments
union all select 'pos_sales_receipt_modifications', count(*) from public.pos_sales_receipt_modifications
union all select 'pos_inventory_deduction_receipts', count(*) from public.pos_inventory_deduction_receipts
union all select 'pos_inventory_deductions', count(*) from public.pos_inventory_deductions
union all select 'inventory_logs', count(*) from public.inventory_logs
union all select 'pos_sales_business_day_closures', count(*) from public.pos_sales_business_day_closures
union all select 'ledger_transactions', count(*) from public.ledger_transactions;

-- 6) Migration history around this change (no automatic repair).
select version, name from supabase_migrations.schema_migrations
where version like '2026102%' order by version;
