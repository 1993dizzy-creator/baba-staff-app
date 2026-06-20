alter table public.pos_inventory_deductions
  drop constraint if exists pos_inventory_deductions_status_check;

alter table public.pos_inventory_deductions
  drop constraint if exists pos_inventory_deductions_sales_status_check;

alter table public.pos_inventory_deductions
  add constraint pos_inventory_deductions_status_check
  check (
    status in (
      'pending',
      'previewed',
      'selected',
      'skipped',
      'blocked',
      'applied',
      'success',
      'reverted',
      'failed',
      'canceled',
      'cancelled'
    )
  )
  not valid;

alter table public.pos_inventory_deductions
  add constraint pos_inventory_deductions_sales_status_check
  check (
    flow_version <> 'sales_db_v1'
    or status in (
      'pending',
      'previewed',
      'selected',
      'skipped',
      'blocked',
      'applied',
      'success',
      'reverted',
      'failed',
      'canceled',
      'cancelled'
    )
  )
  not valid;

alter table public.pos_inventory_deduction_receipts
  drop constraint if exists pos_inventory_deduction_receipts_status_check;

alter table public.pos_inventory_deduction_receipts
  add constraint pos_inventory_deduction_receipts_status_check
  check (
    status in (
      'ready',
      'skipped',
      'missing_mapping',
      'manual_review',
      'invalid_mapping',
      'incomplete_recipe',
      'insufficient_stock',
      'already_applied',
      'applied_after_modified',
      'review_required',
      'applied',
      'reverted',
      'failed'
    )
  )
  not valid;
