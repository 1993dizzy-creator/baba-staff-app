-- Archive and remove the retired processed-line POS inventory workflow.
-- This migration intentionally does not alter inventory quantities or inventory logs.

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtext('archive_cleanup_legacy_pos_processed_lines_v1')
);

do $preconditions$
declare
  v_count bigint;
  v_definition text;
begin
  if to_regclass('public.pos_processed_invoice_lines') is null then
    raise exception 'precondition failed: pos_processed_invoice_lines is missing';
  end if;

  if to_regclass('public.legacy_pos_processed_line_archive') is not null
    or to_regclass('public.legacy_pos_inventory_deduction_archive') is not null then
    raise exception 'precondition failed: legacy POS archive already exists';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'pos_inventory_deductions'
      and column_name = 'processed_line_id'
  ) then
    raise exception 'precondition failed: processed_line_id is missing';
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_row
    join pg_class table_relation on table_relation.oid = constraint_row.conrelid
    join pg_namespace namespace on namespace.oid = table_relation.relnamespace
    join pg_class backing_index on backing_index.oid = constraint_row.conindid
    where namespace.nspname = 'public'
      and table_relation.relname = 'pos_inventory_deductions'
      and constraint_row.conname = 'pos_inventory_deductions_unique_item'
      and constraint_row.contype = 'u'
      and backing_index.relname = 'pos_inventory_deductions_unique_item'
      and pg_get_constraintdef(constraint_row.oid) =
        'UNIQUE (processed_line_id, inventory_item_id)'
  ) then
    raise exception 'precondition failed: legacy unique constraint definition changed';
  end if;

  if not exists (
    select 1
    from pg_class index_relation
    join pg_index index_row on index_row.indexrelid = index_relation.oid
    join pg_class table_relation on table_relation.oid = index_row.indrelid
    join pg_namespace namespace on namespace.oid = table_relation.relnamespace
    left join pg_constraint constraint_row
      on constraint_row.conindid = index_relation.oid
    where namespace.nspname = 'public'
      and table_relation.relname = 'pos_inventory_deductions'
      and index_relation.relname = 'idx_pos_inventory_deductions_processed_line_id'
      and constraint_row.oid is null
      and pg_get_indexdef(index_relation.oid) =
        'CREATE INDEX idx_pos_inventory_deductions_processed_line_id ON public.pos_inventory_deductions USING btree (processed_line_id)'
  ) then
    raise exception 'precondition failed: processed-line index is missing, changed, or constraint-owned';
  end if;

  if to_regclass('public.pos_inventory_deductions_idempotency_uidx') is null
    or to_regclass('public.pos_inventory_deductions_success_reversal_uidx') is null
    or to_regclass('public.pos_inventory_deductions_receipt_id_idx') is null then
    raise exception 'precondition failed: current receipt idempotency indexes are missing';
  end if;

  if to_regprocedure(
    'public.apply_pos_direct_inventory_deductions(date,integer,text,text)'
  ) is null then
    raise exception 'precondition failed: legacy direct-apply RPC is missing';
  end if;

  select count(*) into v_count
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'apply_pos_direct_inventory_deductions';
  if v_count <> 1 then
    raise exception 'precondition failed: unexpected legacy direct-apply overload count %', v_count;
  end if;

  if to_regprocedure(
    'public.reprocess_modified_sales_inventory_deduction_receipt(bigint,text,timestamp with time zone,text,text)'
  ) is null or to_regprocedure(
    'public.rollback_canceled_sales_inventory_deduction_receipt(bigint,text,timestamp with time zone,text)'
  ) is null then
    raise exception 'precondition failed: current receipt lifecycle RPC is missing';
  end if;

  select count(*) into v_count from public.pos_processed_invoice_lines;
  if v_count <> 319 then
    raise exception 'precondition failed: expected 319 processed lines, found %', v_count;
  end if;

  select count(*) into v_count
  from public.pos_inventory_deductions where processed_line_id is not null;
  if v_count <> 42 then
    raise exception 'precondition failed: expected 42 legacy deductions, found %', v_count;
  end if;

  select count(*) into v_count
  from public.pos_inventory_deductions
  where processed_line_id is not null and status = 'applied';
  if v_count <> 1 then
    raise exception 'precondition failed: expected 1 applied legacy deduction, found %', v_count;
  end if;

  select count(*) into v_count
  from public.pos_inventory_deductions
  where processed_line_id is not null and status = 'failed';
  if v_count <> 41 then
    raise exception 'precondition failed: expected 41 failed legacy deductions, found %', v_count;
  end if;

  select count(*) into v_count
  from public.pos_inventory_deductions
  where processed_line_id is not null and status not in ('applied', 'failed');
  if v_count <> 0 then
    raise exception 'precondition failed: unexpected legacy deduction statuses: % rows', v_count;
  end if;

  select count(*) into v_count
  from public.pos_inventory_deductions
  where processed_line_id is not null and receipt_id is not null;
  if v_count <> 0 then
    raise exception 'precondition failed: legacy and receipt deduction identities overlap';
  end if;

  select count(*) into v_count
  from public.pos_inventory_deductions
  where processed_line_id is null and receipt_id is null;
  if v_count <> 0 then
    raise exception 'precondition failed: non-legacy deduction without receipt_id exists';
  end if;

  select count(*) into v_count
  from public.pos_inventory_deductions deduction
  left join public.pos_processed_invoice_lines processed
    on processed.id = deduction.processed_line_id
  where deduction.processed_line_id is not null and processed.id is null;
  if v_count <> 0 then
    raise exception 'precondition failed: orphan legacy processed-line reference exists';
  end if;

  select count(*) into v_count
  from public.pos_inventory_deductions deduction
  left join public.inventory inventory
    on inventory.id = deduction.inventory_item_id
  where deduction.processed_line_id is not null and inventory.id is null;
  if v_count <> 0 then
    raise exception 'precondition failed: orphan legacy inventory item exists';
  end if;

  select count(*) into v_count
  from public.pos_inventory_deductions deduction
  left join public.pos_item_mappings mapping
    on mapping.id = deduction.mapping_id
  where deduction.processed_line_id is not null
    and deduction.mapping_id is not null
    and mapping.id is null;
  if v_count <> 0 then
    raise exception 'precondition failed: orphan legacy mapping exists';
  end if;

  select count(*) into v_count
  from public.pos_inventory_deductions deduction
  join public.inventory_logs inventory_log
    on inventory_log.id = deduction.inventory_log_id
  where deduction.processed_line_id is not null
    and deduction.status = 'applied'
    and deduction.applied_at is not null
    and inventory_log.item_id = deduction.inventory_item_id
    and inventory_log.change_quantity = -deduction.deduct_quantity
    and abs(extract(epoch from inventory_log.created_at - deduction.applied_at)) <= 5;
  if v_count <> 1 then
    raise exception 'precondition failed: applied legacy inventory-log link is not exact';
  end if;

  select pg_get_functiondef(oid) into v_definition
  from pg_proc
  where oid = to_regprocedure(
    'public.reprocess_modified_sales_inventory_deduction_receipt(bigint,text,timestamp with time zone,text,text)'
  );
  if md5(v_definition) <> '2372eae27e4dc73c3bc801fe6057a38a' then
    raise exception 'precondition failed: reprocess function definition changed';
  end if;

  select pg_get_functiondef(oid) into v_definition
  from pg_proc
  where oid = to_regprocedure(
    'public.rollback_canceled_sales_inventory_deduction_receipt(bigint,text,timestamp with time zone,text)'
  );
  if md5(v_definition) <> 'a8e9137c0f705ed9df511a3f90219755' then
    raise exception 'precondition failed: rollback function definition changed';
  end if;
end
$preconditions$;

create temporary table legacy_cleanup_receipt_snapshot on commit drop as
select id, status, applied_at, inventory_log_id, receipt_id, receipt_line_id,
       idempotency_key, operation_type, updated_at
from public.pos_inventory_deductions
where processed_line_id is null;

create temporary table legacy_cleanup_protection_snapshot on commit drop as
select
  (select count(*) from public.inventory) as inventory_count,
  (select coalesce(sum(quantity), 0) from public.inventory) as inventory_quantity_sum,
  (select coalesce(sum(id::numeric * coalesce(quantity, 0)), 0)
     from public.inventory) as inventory_quantity_checksum,
  (select count(*) from public.inventory_logs) as inventory_log_count,
  (select max(id) from public.inventory_logs) as inventory_log_max_id,
  (select count(*) from public.pos_inventory_deduction_batches) as batch_count,
  (select count(*) from public.pos_inventory_deduction_receipts) as batch_receipt_count;

create table public.legacy_pos_processed_line_archive (
  legacy_processed_line_id bigint primary key,
  invoice_ref_id text not null,
  invoice_ref_no text,
  invoice_date timestamptz,
  ref_detail_id text not null,
  order_detail_id text,
  parent_id text,
  ref_detail_type integer,
  pos_item_code text,
  pos_item_name text,
  quantity numeric,
  unit_name text,
  amount numeric,
  mapping_id bigint,
  mapping_type text,
  processed_status text not null,
  processed_at timestamptz,
  legacy_created_at timestamptz not null,
  legacy_updated_at timestamptz not null,
  archived_at timestamptz not null default now(),
  archive_version text not null,
  archive_reason text not null
);

comment on table public.legacy_pos_processed_line_archive is
  'Immutable audit archive for the retired CUKCUK processed-line staging workflow; not a processing queue.';

create table public.legacy_pos_inventory_deduction_archive (
  legacy_deduction_id bigint primary key,
  legacy_processed_line_id bigint not null
    references public.legacy_pos_processed_line_archive(legacy_processed_line_id)
    on delete restrict,
  inventory_item_id bigint not null,
  deduct_quantity numeric not null,
  deduction_status text not null,
  error_message text,
  applied_at timestamptz,
  inventory_log_id bigint references public.inventory_logs(id) on delete restrict,
  legacy_created_at timestamptz not null,
  legacy_updated_at timestamptz not null,
  archived_at timestamptz not null default now(),
  archive_version text not null,
  archive_reason text not null
);

comment on table public.legacy_pos_inventory_deduction_archive is
  'Immutable audit archive for retired processed-line deductions, including the original inventory log link.';

alter table public.legacy_pos_processed_line_archive enable row level security;
alter table public.legacy_pos_inventory_deduction_archive enable row level security;

revoke all on table public.legacy_pos_processed_line_archive
  from public, anon, authenticated, service_role;
revoke all on table public.legacy_pos_inventory_deduction_archive
  from public, anon, authenticated, service_role;
grant select on table public.legacy_pos_processed_line_archive to service_role;
grant select on table public.legacy_pos_inventory_deduction_archive to service_role;

insert into public.legacy_pos_processed_line_archive (
  legacy_processed_line_id, invoice_ref_id, invoice_ref_no, invoice_date,
  ref_detail_id, order_detail_id, parent_id, ref_detail_type, pos_item_code,
  pos_item_name, quantity, unit_name, amount, mapping_id, mapping_type,
  processed_status, processed_at, legacy_created_at, legacy_updated_at,
  archive_version, archive_reason
)
select
  id, invoice_ref_id, invoice_ref_no, invoice_date, ref_detail_id,
  order_detail_id, parent_id, ref_detail_type, item_code, item_name, quantity,
  unit_name, amount, mapping_id, mapping_type, status, processed_at, created_at,
  updated_at, '202607190002', 'retired_legacy_pos_processed_line_workflow'
from public.pos_processed_invoice_lines;

insert into public.legacy_pos_inventory_deduction_archive (
  legacy_deduction_id, legacy_processed_line_id, inventory_item_id,
  deduct_quantity, deduction_status, error_message, applied_at,
  inventory_log_id, legacy_created_at, legacy_updated_at,
  archive_version, archive_reason
)
select
  id, processed_line_id, inventory_item_id, deduct_quantity, status,
  error_message, applied_at, inventory_log_id, created_at, updated_at,
  '202607190002', 'retired_legacy_pos_processed_line_workflow'
from public.pos_inventory_deductions
where processed_line_id is not null;

do $archive_verification$
declare
  v_count bigint;
begin
  select count(*) into v_count from public.legacy_pos_processed_line_archive;
  if v_count <> 319 then
    raise exception 'archive verification failed: expected 319 processed lines, found %', v_count;
  end if;

  select count(*) into v_count from public.legacy_pos_inventory_deduction_archive;
  if v_count <> 42 then
    raise exception 'archive verification failed: expected 42 deductions, found %', v_count;
  end if;

  if (select count(*) from public.legacy_pos_inventory_deduction_archive where deduction_status = 'applied') <> 1
    or (select count(*) from public.legacy_pos_inventory_deduction_archive where deduction_status = 'failed') <> 41
    or (select count(*) from public.legacy_pos_inventory_deduction_archive where deduction_status not in ('applied', 'failed')) <> 0 then
    raise exception 'archive verification failed: deduction status counts differ';
  end if;

  if (
    select count(*)
    from public.legacy_pos_inventory_deduction_archive deduction
    join public.inventory_logs inventory_log on inventory_log.id = deduction.inventory_log_id
    where deduction.deduction_status = 'applied'
      and inventory_log.item_id = deduction.inventory_item_id
      and inventory_log.change_quantity = -deduction.deduct_quantity
  ) <> 1 then
    raise exception 'archive verification failed: applied inventory-log link differs';
  end if;

  if exists (
    select id from public.pos_processed_invoice_lines
    except select legacy_processed_line_id from public.legacy_pos_processed_line_archive
  ) or exists (
    select legacy_processed_line_id from public.legacy_pos_processed_line_archive
    except select id from public.pos_processed_invoice_lines
  ) then
    raise exception 'archive verification failed: processed line ID set differs';
  end if;

  if exists (
    select id, processed_line_id, inventory_item_id, deduct_quantity, status,
           applied_at, inventory_log_id
    from public.pos_inventory_deductions where processed_line_id is not null
    except
    select legacy_deduction_id, legacy_processed_line_id, inventory_item_id,
           deduct_quantity, deduction_status, applied_at, inventory_log_id
    from public.legacy_pos_inventory_deduction_archive
  ) then
    raise exception 'archive verification failed: deduction audit values differ';
  end if;
end
$archive_verification$;

revoke all on function public.apply_pos_direct_inventory_deductions(
  date, integer, text, text
) from public, anon, authenticated, service_role;

drop function public.apply_pos_direct_inventory_deductions(
  date, integer, text, text
);

-- Preserve the exact deployed function bodies and remove only the two legacy
-- insert-list references. Definition hashes above make this transformation fail
-- closed if either operational function changes before this migration is applied.
do $replace_current_functions$
declare
  v_signature regprocedure;
  v_definition text;
begin
  v_signature := to_regprocedure(
    'public.reprocess_modified_sales_inventory_deduction_receipt(bigint,text,timestamp with time zone,text,text)'
  );
  select pg_get_functiondef(v_signature::oid) into v_definition;
  if (select count(*) from regexp_matches(v_definition, 'processed_line_id', 'g')) <> 2 then
    raise exception 'reprocess replacement failed: expected exactly two legacy references';
  end if;
  v_definition := regexp_replace(
    v_definition,
    'processed_line_id,[[:space:]]*invoice_ref_id',
    'invoice_ref_id',
    'g'
  );
  v_definition := regexp_replace(
    v_definition,
    'v_active[.]processed_line_id,[[:space:]]*v_active[.]invoice_ref_id',
    'v_active.invoice_ref_id',
    'g'
  );
  if v_definition like '%processed_line_id%' then
    raise exception 'reprocess replacement failed: legacy reference remains';
  end if;
  execute v_definition;

  v_signature := to_regprocedure(
    'public.rollback_canceled_sales_inventory_deduction_receipt(bigint,text,timestamp with time zone,text)'
  );
  select pg_get_functiondef(v_signature::oid) into v_definition;
  if (select count(*) from regexp_matches(v_definition, 'processed_line_id', 'g')) <> 2 then
    raise exception 'rollback replacement failed: expected exactly two legacy references';
  end if;
  v_definition := regexp_replace(
    v_definition,
    'processed_line_id,[[:space:]]*invoice_ref_id',
    'invoice_ref_id',
    'g'
  );
  v_definition := regexp_replace(
    v_definition,
    'v_active[.]processed_line_id,[[:space:]]*v_active[.]invoice_ref_id',
    'v_active.invoice_ref_id',
    'g'
  );
  if v_definition like '%processed_line_id%' then
    raise exception 'rollback replacement failed: legacy reference remains';
  end if;
  execute v_definition;
end
$replace_current_functions$;

revoke all on function public.reprocess_modified_sales_inventory_deduction_receipt(
  bigint, text, timestamptz, text, text
) from public, anon, authenticated;
grant execute on function public.reprocess_modified_sales_inventory_deduction_receipt(
  bigint, text, timestamptz, text, text
) to service_role;

revoke all on function public.rollback_canceled_sales_inventory_deduction_receipt(
  bigint, text, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.rollback_canceled_sales_inventory_deduction_receipt(
  bigint, text, timestamptz, text
) to service_role;

delete from public.pos_inventory_deductions where processed_line_id is not null;

do $delete_verification$
begin
  if (select count(*) from public.pos_inventory_deductions where processed_line_id is not null) <> 0 then
    raise exception 'cleanup failed: legacy deductions remain';
  end if;
  if (select count(*) from public.pos_inventory_deductions) <>
     (select count(*) from legacy_cleanup_receipt_snapshot) then
    raise exception 'cleanup failed: receipt deduction count changed';
  end if;
  if exists (
    select id, status, applied_at, inventory_log_id, receipt_id, receipt_line_id,
           idempotency_key, operation_type, updated_at
    from public.pos_inventory_deductions
    except
    select * from legacy_cleanup_receipt_snapshot
  ) or exists (
    select * from legacy_cleanup_receipt_snapshot
    except
    select id, status, applied_at, inventory_log_id, receipt_id, receipt_line_id,
           idempotency_key, operation_type, updated_at
    from public.pos_inventory_deductions
  ) then
    raise exception 'cleanup failed: receipt deduction ID or state changed';
  end if;
end
$delete_verification$;

alter table public.pos_inventory_deductions
  drop constraint pos_inventory_deductions_processed_line_id_fkey;
alter table public.pos_inventory_deductions
  drop constraint pos_inventory_deductions_unique_item;
drop index public.idx_pos_inventory_deductions_processed_line_id;
alter table public.pos_inventory_deductions drop column processed_line_id;

drop trigger trg_pos_processed_invoice_lines_updated_at
  on public.pos_processed_invoice_lines;
alter table public.pos_processed_invoice_lines
  drop constraint pos_processed_invoice_lines_mapping_id_fkey;
alter sequence public.pos_processed_invoice_lines_id_seq owned by none;
drop table public.pos_processed_invoice_lines;
drop sequence public.pos_processed_invoice_lines_id_seq;

do $final_verification$
declare
  v_before record;
begin
  if to_regclass('public.pos_processed_invoice_lines') is not null
    or exists (
      select 1 from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'public'
        and procedure.proname = 'apply_pos_direct_inventory_deductions'
    ) then
    raise exception 'cleanup failed: legacy table or RPC remains';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'pos_inventory_deductions'
      and column_name = 'processed_line_id'
  ) then
    raise exception 'cleanup failed: processed_line_id remains';
  end if;
  if to_regclass('public.pos_inventory_deductions_idempotency_uidx') is null
    or to_regclass('public.pos_inventory_deductions_success_reversal_uidx') is null
    or to_regclass('public.pos_inventory_deductions_receipt_id_idx') is null then
    raise exception 'cleanup failed: current receipt idempotency indexes changed';
  end if;
  if exists (
    select 1 from pg_proc
    where oid in (
      to_regprocedure('public.reprocess_modified_sales_inventory_deduction_receipt(bigint,text,timestamp with time zone,text,text)'),
      to_regprocedure('public.rollback_canceled_sales_inventory_deduction_receipt(bigint,text,timestamp with time zone,text)')
    ) and pg_get_functiondef(oid) like '%processed_line_id%'
  ) then
    raise exception 'cleanup failed: operational function still references legacy column';
  end if;

  select * into v_before from legacy_cleanup_protection_snapshot;
  if (select count(*) from public.inventory) <> v_before.inventory_count
    or (select coalesce(sum(quantity), 0) from public.inventory) <> v_before.inventory_quantity_sum
    or (select coalesce(sum(id::numeric * coalesce(quantity, 0)), 0) from public.inventory) <> v_before.inventory_quantity_checksum
    or (select count(*) from public.inventory_logs) <> v_before.inventory_log_count
    or (select max(id) from public.inventory_logs) is distinct from v_before.inventory_log_max_id
    or (select count(*) from public.pos_inventory_deduction_batches) <> v_before.batch_count
    or (select count(*) from public.pos_inventory_deduction_receipts) <> v_before.batch_receipt_count then
    raise exception 'cleanup failed: protected operational data changed';
  end if;
end
$final_verification$;
