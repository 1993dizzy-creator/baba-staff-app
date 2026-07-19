-- MANUAL DISASTER-RECOVERY DRAFT. DO NOT RUN AS A NORMAL DOWN MIGRATION.
-- First recreate the retired tables, sequence, constraints, indexes, trigger,
-- and legacy RPC from their original migrations in an isolated review branch.
-- Restore rows only after confirming both archive counts and an empty target.
-- This draft deliberately performs no inventory UPDATE and no inventory-log INSERT.

do $guards$
begin
  if to_regclass('public.pos_processed_invoice_lines') is null then
    raise exception 'recreate the retired staging schema before restoring rows';
  end if;
  if exists (select 1 from public.pos_processed_invoice_lines) then
    raise exception 'restore target is not empty';
  end if;
  if exists (select 1 from public.pos_inventory_deductions where processed_line_id is not null) then
    raise exception 'legacy deductions already exist';
  end if;
  if exists (
    select 1 from public.pos_inventory_deductions current_deduction
    join public.legacy_pos_inventory_deduction_archive archived
      on archived.legacy_deduction_id = current_deduction.id
  ) then
    raise exception 'an archived deduction ID has been reused';
  end if;
  if (select count(*) from public.legacy_pos_processed_line_archive) <> 319
    or (select count(*) from public.legacy_pos_inventory_deduction_archive) <> 42 then
    raise exception 'archive counts do not match the cleanup snapshot';
  end if;
end
$guards$;

insert into public.pos_processed_invoice_lines (
  id, invoice_ref_id, invoice_ref_no, invoice_date, ref_detail_id,
  order_detail_id, parent_id, ref_detail_type, item_code, item_name,
  quantity, unit_name, amount, mapping_id, mapping_type, status,
  processed_at, created_at, updated_at
)
select
  legacy_processed_line_id, invoice_ref_id, invoice_ref_no, invoice_date,
  ref_detail_id, order_detail_id, parent_id, ref_detail_type, pos_item_code,
  pos_item_name, quantity, unit_name, amount, mapping_id, mapping_type,
  processed_status, processed_at, legacy_created_at, legacy_updated_at
from public.legacy_pos_processed_line_archive;

insert into public.pos_inventory_deductions (
  id, processed_line_id, invoice_ref_id, ref_detail_id, pos_item_code,
  pos_item_name, pos_quantity, mapping_id, mapping_type, inventory_item_id,
  deduct_quantity, inventory_log_id, status, error_message, applied_at,
  created_at, updated_at
)
select
  deduction.legacy_deduction_id,
  deduction.legacy_processed_line_id,
  processed.invoice_ref_id,
  processed.ref_detail_id,
  processed.pos_item_code,
  processed.pos_item_name,
  processed.quantity,
  processed.mapping_id,
  processed.mapping_type,
  deduction.inventory_item_id,
  deduction.deduct_quantity,
  deduction.inventory_log_id,
  deduction.deduction_status,
  deduction.error_message,
  deduction.applied_at,
  deduction.legacy_created_at,
  deduction.legacy_updated_at
from public.legacy_pos_inventory_deduction_archive deduction
join public.legacy_pos_processed_line_archive processed
  on processed.legacy_processed_line_id = deduction.legacy_processed_line_id;

select setval(
  'public.pos_processed_invoice_lines_id_seq',
  (select max(id) from public.pos_processed_invoice_lines),
  true
);
select setval(
  'public.pos_inventory_deductions_id_seq',
  (select max(id) from public.pos_inventory_deductions),
  true
);

-- Do not call the legacy direct-apply RPC and do not reapply or reverse inventory.
