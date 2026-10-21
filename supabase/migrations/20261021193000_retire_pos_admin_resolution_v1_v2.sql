-- Retire the 2026-10-21 POS admin-resolution V1/V2 system.
-- Reverses 20261021070640, 20261021081604 and 20261021133856 with a NEW migration;
-- those files and their history rows are left untouched.
--
-- * No receipt/line/payment/stock/deduction/inventory_log/ledger/close DML.
-- * Aborts (whole transaction) if any V1/V2 table holds a row, any V1/V2 column
--   holds a non-default value, or any receipt is still held by V2 inventory review.
-- * Restores the four existing operating functions by removing ONLY the exact text
--   V2 inserted into their live definitions. CREATE OR REPLACE keeps OID, owner,
--   ACL, SECURITY DEFINER and SET options; this is verified before COMMIT.
-- * Does not re-run 20261021174643 and never re-creates the automatic recheck
--   queue. Works whether that queue removal was already applied or not.
-- * No DROP ... CASCADE. Every DROP is RESTRICT and fails on an unknown dependant.
--
-- Apply the whole file once, in one transaction (SQL Editor). Avoid the 03:00-03:10
-- final sync/close window: the POS tables are locked for the duration (seconds).
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Fixed lock order. POS sync / stock engines wait (or this migration times out)
-- instead of writing between the emptiness checks and the DDL below.
lock table public.pos_sales_receipts, public.pos_sales_receipt_lines,
  public.pos_sales_receipt_payments, public.pos_inventory_deduction_receipts,
  public.pos_inventory_deductions in access exclusive mode;

do $preflight$
declare
  v_name text;
  v_count bigint;
begin
  -- Exact V1/V2 footprint (20261021174643 objects are optional on purpose).
  foreach v_name in array array[
    'public.pos_sales_receipt_admin_resolutions', 'public.pos_sales_receipt_resolution_history',
    'public.pos_sales_receipt_pos_observations', 'public.pos_sales_receipt_resolution_versions',
    'public.pos_sales_receipt_inventory_reviews', 'public.pos_sales_receipt_inventory_approvals',
    'pos_resolution_private.capabilities', 'pos_resolution_private.work_capabilities'] loop
    if to_regclass(v_name) is null then
      raise exception 'RETIRE_POS_RESOLUTION_STATE_MISMATCH: missing %', v_name;
    end if;
  end loop;
  foreach v_name in array array[
    'public.sales_get_pending_resolution_v1(bigint,bigint)',
    'public.sales_resolve_pending_receipt_v1(bigint,bigint,jsonb)',
    'public.sales_observe_resolved_receipts_v1(jsonb)',
    'public.sales_resolve_pending_receipt_v2(bigint,bigint,jsonb)',
    'public.sales_correct_admin_resolution_v2(bigint,bigint,jsonb)',
    'public.sales_get_admin_resolution_work_v2(bigint,bigint)',
    'public.sales_preview_admin_resolution_inventory_v2(bigint,bigint,text,jsonb,jsonb)',
    'public.sales_confirm_admin_resolution_inventory_v2(bigint,bigint,jsonb)',
    'pos_resolution_private.source_guard()', 'pos_resolution_private.deduction_write_guard()',
    'public.apply_sales_inventory_deduction_batch(bigint,text,jsonb)',
    'public.reprocess_modified_sales_inventory_deduction_receipt(bigint,text,timestamptz,text,text)',
    'public.rollback_canceled_sales_inventory_deduction_receipt(bigint,text,timestamptz,text)',
    'pos_sales_close_private.build_source(date)'] loop
    if to_regprocedure(v_name) is null then
      raise exception 'RETIRE_POS_RESOLUTION_STATE_MISMATCH: missing %', v_name;
    end if;
  end loop;
  if (select count(*) from pg_trigger where not tgisinternal and tgname in (
      'pos_resolution_receipt_guard', 'pos_resolution_line_guard', 'pos_resolution_payment_guard',
      'pos_admin_resolution_deduction_write_guard')) <> 4 then
    raise exception 'RETIRE_POS_RESOLUTION_STATE_MISMATCH: guard triggers';
  end if;
  if (select count(*) from information_schema.columns where table_schema = 'public' and (table_name, column_name) in (
      ('pos_sales_receipts', 'admin_resolution_version'),
      ('pos_sales_receipts', 'admin_resolution_financial_review_required'),
      ('pos_sales_receipt_payments', 'admin_resolution_retired'),
      ('pos_inventory_deduction_receipts', 'admin_resolution_content_fingerprint'))) <> 4 then
    raise exception 'RETIRE_POS_RESOLUTION_STATE_MISMATCH: columns';
  end if;
  -- Only the expected kinds of objects may live in the private schema.
  if exists (select 1 from pg_class c where c.relnamespace = 'pos_resolution_private'::regnamespace
      and not (c.relkind = 'r' and c.relname in ('capabilities', 'work_capabilities', 'recheck_jobs'))
      and not (c.relkind = 'i' and c.relname in ('capabilities_pkey', 'work_capabilities_pkey',
        'recheck_jobs_pkey', 'pos_pending_recheck_budget_idx'))
      and c.relkind not in ('S'))
    or exists (select 1 from pg_type t where t.typnamespace = 'pos_resolution_private'::regnamespace
      and t.typrelid = 0 and t.typelem = 0) then
    raise exception 'RETIRE_POS_RESOLUTION_UNEXPECTED_PRIVATE_OBJECT';
  end if;

  -- Never discard recorded work: every V1/V2 table must be empty.
  foreach v_name in array array[
    'public.pos_sales_receipt_inventory_approvals', 'public.pos_sales_receipt_inventory_reviews',
    'public.pos_sales_receipt_resolution_versions', 'public.pos_sales_receipt_resolution_history',
    'public.pos_sales_receipt_pos_observations', 'public.pos_sales_receipt_admin_resolutions',
    'pos_resolution_private.recheck_jobs', 'pos_resolution_private.work_capabilities',
    'pos_resolution_private.capabilities'] loop
    if to_regclass(v_name) is not null then
      execute format('lock table %s in access exclusive mode', v_name);
      execute format('select count(*) from %s', v_name) into v_count;
      if v_count <> 0 then
        raise exception 'RETIRE_POS_RESOLUTION_NONEMPTY: % (% rows)', v_name, v_count;
      end if;
    end if;
  end loop;
  -- Dropped columns must carry only their defaults; no receipt may be V2-held.
  if exists (select 1 from public.pos_sales_receipts
      where admin_resolution_version <> 0 or admin_resolution_financial_review_required is not false
        or inventory_deduction_processing_error = 'admin_resolution_inventory_review_required')
    or exists (select 1 from public.pos_sales_receipt_payments where admin_resolution_retired is not false)
    or exists (select 1 from public.pos_inventory_deduction_receipts
      where admin_resolution_content_fingerprint is not null) then
    raise exception 'RETIRE_POS_RESOLUTION_NONDEFAULT_STATE';
  end if;
end $preflight$;

-- Identity/ownership/ACL/options of the four restored functions, checked before COMMIT.
create temporary table retire_pos_resolution_function_meta on commit drop as
select p.oid, p.oid::regprocedure::text as signature, p.proowner, p.proacl::text as acl,
  p.prosecdef, p.proconfig::text as config, p.provolatile, p.prorettype
from pg_proc p
where p.oid in (
  'public.apply_sales_inventory_deduction_batch(bigint,text,jsonb)'::regprocedure,
  'public.reprocess_modified_sales_inventory_deduction_receipt(bigint,text,timestamptz,text,text)'::regprocedure,
  'public.rollback_canceled_sales_inventory_deduction_receipt(bigint,text,timestamptz,text)'::regprocedure,
  'pos_sales_close_private.build_source(date)'::regprocedure);

-- Remove ONLY the V2 inserts. Each must occur exactly once in the live
-- definition (CRLF/CR normalised exactly as V2 did before inserting).
do $restore_functions$
declare
  v_signature text;
  v_guard text;
  v_inserted text;
  v_definition text;
  v_old_join constant text := 'from public.pos_sales_receipt_payments p join public.pos_sales_receipts r on r.id = p.receipt_id';
  v_old_sum constant text := 'where p.receipt_id = r.id';
  v_retired constant text := ' and p.admin_resolution_retired is not true';
begin
  for v_signature, v_guard in values
    ('public.apply_sales_inventory_deduction_batch(bigint,text,jsonb)',
     'exists(select 1 from public.pos_inventory_deduction_receipts b join public.pos_sales_receipt_admin_resolutions a on a.receipt_id=b.receipt_id where b.batch_id=p_batch_id and not exists(select 1 from pos_resolution_private.work_capabilities c where c.transaction_id=txid_current() and c.receipt_id=b.receipt_id and purpose=''inventory''))'),
    ('public.reprocess_modified_sales_inventory_deduction_receipt(bigint,text,timestamptz,text,text)',
     'exists(select 1 from public.pos_inventory_deduction_receipts b join public.pos_sales_receipt_admin_resolutions a on a.receipt_id=b.receipt_id where b.id=p_batch_receipt_id and not exists(select 1 from pos_resolution_private.work_capabilities c where c.transaction_id=txid_current() and c.receipt_id=b.receipt_id and purpose=''inventory''))'),
    ('public.rollback_canceled_sales_inventory_deduction_receipt(bigint,text,timestamptz,text)',
     'exists(select 1 from public.pos_sales_receipt_admin_resolutions a where a.receipt_id=p_receipt_id and not exists(select 1 from pos_resolution_private.work_capabilities c where c.transaction_id=txid_current() and c.receipt_id=a.receipt_id and purpose=''inventory''))')
  loop
    v_inserted := E'\nbegin\n if ' || v_guard || E' then raise exception ''POS_RESOLUTION_INVENTORY_APPROVAL_REQUIRED'';end if;\n';
    v_definition := replace(replace(pg_get_functiondef(v_signature::regprocedure), E'\r\n', E'\n'), E'\r', E'\n');
    if (length(v_definition) - length(replace(v_definition, v_inserted, ''))) <> length(v_inserted) then
      raise exception 'RETIRE_POS_RESOLUTION_ENGINE_CONTRACT_MISMATCH: %', v_signature;
    end if;
    v_definition := replace(v_definition, v_inserted, E'\nbegin\n');
    if position('pos_resolution_private' in v_definition) > 0 or position('admin_resolution' in v_definition) > 0
      or position('POS_RESOLUTION' in v_definition) > 0 then
      raise exception 'RETIRE_POS_RESOLUTION_ENGINE_RESIDUE: %', v_signature;
    end if;
    execute v_definition;
  end loop;

  v_definition := replace(replace(pg_get_functiondef('pos_sales_close_private.build_source(date)'::regprocedure),
    E'\r\n', E'\n'), E'\r', E'\n');
  v_inserted := E'\nbegin\n if exists(select 1 from public.pos_sales_receipts where business_date=p_date and payment_status=3 and is_canceled is not true and admin_resolution_financial_review_required=true) then raise exception ''POS_RESOLUTION_FINANCIAL_CORRECTION_REQUIRED'';end if;\n';
  if (length(v_definition) - length(replace(v_definition, v_inserted, ''))) <> length(v_inserted)
    or position(v_old_join || v_retired in v_definition) = 0
    or position(v_old_sum || v_retired in v_definition) = 0 then
    raise exception 'RETIRE_POS_RESOLUTION_SOURCE_CONTRACT_MISMATCH';
  end if;
  v_definition := replace(v_definition, v_inserted, E'\nbegin\n');
  v_definition := replace(v_definition, v_old_join || v_retired, v_old_join);
  v_definition := replace(v_definition, v_old_sum || v_retired, v_old_sum);
  if position('admin_resolution' in v_definition) > 0 or position('POS_RESOLUTION' in v_definition) > 0
    or position('pos_resolution_private' in v_definition) > 0 then
    raise exception 'RETIRE_POS_RESOLUTION_SOURCE_RESIDUE';
  end if;
  execute v_definition;
end $restore_functions$;

-- Guards first, then entry points, then tables (children before parents), then helpers.
drop trigger pos_admin_resolution_deduction_write_guard on public.pos_inventory_deductions;
drop trigger pos_resolution_receipt_guard on public.pos_sales_receipts;
drop trigger pos_resolution_line_guard on public.pos_sales_receipt_lines;
drop trigger pos_resolution_payment_guard on public.pos_sales_receipt_payments;

drop function public.sales_confirm_admin_resolution_inventory_v2(bigint,bigint,jsonb) restrict;
drop function public.sales_preview_admin_resolution_inventory_v2(bigint,bigint,text,jsonb,jsonb) restrict;
drop function public.sales_get_admin_resolution_work_v2(bigint,bigint) restrict;
drop function public.sales_correct_admin_resolution_v2(bigint,bigint,jsonb) restrict;
drop function public.sales_resolve_pending_receipt_v2(bigint,bigint,jsonb) restrict;
drop function public.sales_observe_resolved_receipts_v1(jsonb) restrict;
drop function public.sales_resolve_pending_receipt_v1(bigint,bigint,jsonb) restrict;
drop function public.sales_get_pending_resolution_v1(bigint,bigint) restrict;
-- Removed in production by 20261021174643 (not in history); kept tolerant here.
drop function if exists public.sales_claim_pending_rechecks_v1() restrict;
drop function if exists public.sales_finish_pending_recheck_v1(bigint,uuid,text) restrict;

drop table public.pos_sales_receipt_inventory_approvals restrict;
drop table public.pos_sales_receipt_inventory_reviews restrict;
drop table public.pos_sales_receipt_resolution_versions restrict;
drop table public.pos_sales_receipt_resolution_history restrict;
drop table public.pos_sales_receipt_pos_observations restrict;
drop table public.pos_sales_receipt_admin_resolutions restrict;
drop table if exists pos_resolution_private.recheck_jobs restrict;
drop table pos_resolution_private.work_capabilities restrict;
drop table pos_resolution_private.capabilities restrict;

do $drop_private_functions$
declare v_function regprocedure;
begin
  for v_function in select p.oid::regprocedure from pg_proc p
    where p.pronamespace = 'pos_resolution_private'::regnamespace order by p.oid loop
    execute format('drop function %s restrict', v_function);
  end loop;
end $drop_private_functions$;
drop schema pos_resolution_private restrict;

drop index if exists public.pos_pending_resolution_candidates_idx restrict;
alter table public.pos_sales_receipts
  drop column admin_resolution_version restrict,
  drop column admin_resolution_financial_review_required restrict;
alter table public.pos_sales_receipt_payments drop column admin_resolution_retired restrict;
alter table public.pos_inventory_deduction_receipts drop column admin_resolution_content_fingerprint restrict;

do $postflight$
declare v_residue text;
begin
  if to_regnamespace('pos_resolution_private') is not null
    or exists (select 1 from pg_class where relname in ('pos_sales_receipt_admin_resolutions',
      'pos_sales_receipt_resolution_history', 'pos_sales_receipt_pos_observations',
      'pos_sales_receipt_resolution_versions', 'pos_sales_receipt_inventory_reviews',
      'pos_sales_receipt_inventory_approvals', 'pos_pending_resolution_candidates_idx'))
    or exists (select 1 from information_schema.columns where table_schema = 'public'
      and column_name like 'admin_resolution%')
    or exists (select 1 from pg_trigger where not tgisinternal and (tgname like 'pos_resolution%'
      or tgname = 'pos_admin_resolution_deduction_write_guard')) then
    raise exception 'RETIRE_POS_RESOLUTION_POSTFLIGHT_OBJECT_REMAINS';
  end if;
  -- PL/pgSQL bodies are not tracked by pg_depend: scan every application function.
  select p.oid::regprocedure::text into v_residue
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'
    and (p.prosrc like '%pos_resolution_private%' or p.prosrc like '%admin_resolution%'
      or p.prosrc like '%pos_sales_receipt_pos_observations%' or p.prosrc like '%sales_observe_resolved_receipts%'
      or p.prosrc like '%POS_RESOLUTION_%')
  limit 1;
  if v_residue is not null then
    raise exception 'RETIRE_POS_RESOLUTION_REFERENCE_REMAINS: %', v_residue;
  end if;
  if exists (select 1 from retire_pos_resolution_function_meta m left join pg_proc p on p.oid = m.oid
      where p.oid is null or p.oid::regprocedure::text <> m.signature or p.proowner <> m.proowner
        or p.proacl::text is distinct from m.acl or p.prosecdef <> m.prosecdef
        or p.proconfig::text is distinct from m.config or p.provolatile <> m.provolatile
        or p.prorettype <> m.prorettype)
    or (select count(*) from retire_pos_resolution_function_meta) <> 4 then
    raise exception 'RETIRE_POS_RESOLUTION_FUNCTION_IDENTITY_CHANGED';
  end if;
end $postflight$;
commit;
