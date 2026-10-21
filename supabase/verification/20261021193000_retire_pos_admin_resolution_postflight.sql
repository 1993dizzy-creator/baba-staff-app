-- READ-ONLY postflight for 20261021193000_retire_pos_admin_resolution_v1_v2.sql.
-- SELECT only. Run in SQL Editor AFTER applying; compare with the preflight output.

-- 1) Every V1/V2 object is gone (all present=false).
select 'pos_resolution_private schema' as object, to_regnamespace('pos_resolution_private') is not null as present
union all select 'pos_sales_receipt_admin_resolutions', to_regclass('public.pos_sales_receipt_admin_resolutions') is not null
union all select 'pos_sales_receipt_resolution_history', to_regclass('public.pos_sales_receipt_resolution_history') is not null
union all select 'pos_sales_receipt_pos_observations', to_regclass('public.pos_sales_receipt_pos_observations') is not null
union all select 'pos_sales_receipt_resolution_versions', to_regclass('public.pos_sales_receipt_resolution_versions') is not null
union all select 'pos_sales_receipt_inventory_reviews', to_regclass('public.pos_sales_receipt_inventory_reviews') is not null
union all select 'pos_sales_receipt_inventory_approvals', to_regclass('public.pos_sales_receipt_inventory_approvals') is not null
union all select 'pos_pending_resolution_candidates_idx', to_regclass('public.pos_pending_resolution_candidates_idx') is not null
union all select 'V1/V2 public functions', exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('sales_get_pending_resolution_v1', 'sales_resolve_pending_receipt_v1',
    'sales_observe_resolved_receipts_v1', 'sales_claim_pending_rechecks_v1', 'sales_finish_pending_recheck_v1',
    'sales_resolve_pending_receipt_v2', 'sales_correct_admin_resolution_v2', 'sales_get_admin_resolution_work_v2',
    'sales_preview_admin_resolution_inventory_v2', 'sales_confirm_admin_resolution_inventory_v2'))
union all select 'V1/V2 triggers', exists(select 1 from pg_trigger where not tgisinternal
  and (tgname like 'pos_resolution%' or tgname = 'pos_admin_resolution_deduction_write_guard'))
union all select 'admin_resolution_* columns', exists(select 1 from information_schema.columns
  where table_schema = 'public' and column_name like 'admin_resolution%')
union all select 'function bodies referencing V1/V2', exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname not in ('pg_catalog', 'information_schema')
    and (p.prosrc like '%pos_resolution_private%' or p.prosrc like '%admin_resolution%' or p.prosrc like '%POS_RESOLUTION_%'));

-- 2) Restored operating functions: same OID/owner/ACL/options as the preflight (section 4).
--    reprocess/rollback LF SHA-256 must equal the user-confirmed pre-V2 operating values.
select p.oid, p.oid::regprocedure as signature, pg_get_userbyid(p.proowner) as owner, p.proacl, p.prosecdef, p.proconfig,
  encode(sha256(convert_to(replace(replace(pg_get_functiondef(p.oid), E'\r\n', E'\n'), E'\r', E'\n'), 'UTF8')), 'hex') as lf_sha256,
  case p.oid
    when 'public.reprocess_modified_sales_inventory_deduction_receipt(bigint,text,timestamptz,text,text)'::regprocedure
      then 'b10b5f8b4d51563570f05f3e30d96262738ef7490cdc71c9c49b0d882b4f19ba'
    when 'public.rollback_canceled_sales_inventory_deduction_receipt(bigint,text,timestamptz,text)'::regprocedure
      then '63c86abd5d7e99a602db115bbf48e88b590e82cab2f538d9f448842feddd2648'
    else '(no recorded pre-V2 hash; compare OID/owner/ACL only)' end as expected_lf_sha256
from pg_proc p
where p.oid in (
  'public.apply_sales_inventory_deduction_batch(bigint,text,jsonb)'::regprocedure,
  'public.reprocess_modified_sales_inventory_deduction_receipt(bigint,text,timestamptz,text,text)'::regprocedure,
  'public.rollback_canceled_sales_inventory_deduction_receipt(bigint,text,timestamptz,text)'::regprocedure,
  'pos_sales_close_private.build_source(date)'::regprocedure)
order by 2;

-- 3) Kept POS payment snapshot fix (20261016180852) is untouched.
select p.oid::regprocedure as signature, pg_get_userbyid(p.proowner) as owner, p.proacl
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'reconcile_sales_receipt_payments_v1';

-- 4) Row counts: must equal preflight section 5.
select 'pos_sales_receipts' as t, count(*) from public.pos_sales_receipts
union all select 'pos_sales_receipt_lines', count(*) from public.pos_sales_receipt_lines
union all select 'pos_sales_receipt_payments', count(*) from public.pos_sales_receipt_payments
union all select 'pos_sales_receipt_modifications', count(*) from public.pos_sales_receipt_modifications
union all select 'pos_inventory_deduction_receipts', count(*) from public.pos_inventory_deduction_receipts
union all select 'pos_inventory_deductions', count(*) from public.pos_inventory_deductions
union all select 'inventory_logs', count(*) from public.inventory_logs
union all select 'pos_sales_business_day_closures', count(*) from public.pos_sales_business_day_closures
union all select 'ledger_transactions', count(*) from public.ledger_transactions;

-- 5) Closed days still verify against the live source (expect every row source_matches=true
--    unless a day was legitimately changed after closing; that is pre-existing drift).
select c.business_date, c.revision,
  c.source_fingerprint = (pos_sales_close_private.build_source(c.business_date)->>'sourceFingerprint') as source_matches
from public.pos_sales_business_day_closures c
where c.business_date >= current_date - 14
  and c.revision = (select max(x.revision) from public.pos_sales_business_day_closures x where x.business_date = c.business_date)
order by 1 desc;

-- 6) History: 20261021193000 is not auto-registered by SQL Editor (register only per AGENTS.md step 4).
select version, name from supabase_migrations.schema_migrations
where version like '2026102%' order by version;
