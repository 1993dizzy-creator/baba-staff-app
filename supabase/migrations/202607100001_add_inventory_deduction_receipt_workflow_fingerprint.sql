alter table public.pos_inventory_deduction_receipts
  add column if not exists workflow_type text null,
  add column if not exists receipt_content_fingerprint text null,
  add column if not exists supersedes_deduction_receipt_id bigint null;

alter table public.pos_inventory_deduction_receipts
  drop constraint if exists pos_inventory_deduction_receipts_workflow_type_check;

alter table public.pos_inventory_deduction_receipts
  add constraint pos_inventory_deduction_receipts_workflow_type_check
  check (
    workflow_type is null
    or workflow_type in ('initial_apply', 'reprocess_modified')
  )
  not valid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pos_inventory_deduction_receipts_supersedes_fkey'
  ) then
    alter table public.pos_inventory_deduction_receipts
      add constraint pos_inventory_deduction_receipts_supersedes_fkey
      foreign key (supersedes_deduction_receipt_id)
      references public.pos_inventory_deduction_receipts(id)
      on delete set null;
  end if;
end
$$;

create index if not exists pos_inventory_deduction_receipts_fingerprint_idx
  on public.pos_inventory_deduction_receipts (
    receipt_id,
    receipt_content_fingerprint
  )
  where receipt_content_fingerprint is not null;

create unique index if not exists pos_inventory_deduction_receipts_success_fingerprint_uidx
  on public.pos_inventory_deduction_receipts (
    receipt_id,
    workflow_type,
    receipt_content_fingerprint
  )
  where status = 'applied'
    and workflow_type is not null
    and receipt_content_fingerprint is not null;
