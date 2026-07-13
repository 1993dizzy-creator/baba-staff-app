alter table public.pos_sales_receipts
  add column if not exists inventory_deduction_auto_eligible_at timestamptz null,
  add column if not exists inventory_deduction_processing_paused boolean
    not null default false,
  add column if not exists inventory_deduction_processing_paused_at timestamptz null,
  add column if not exists inventory_deduction_processing_error text null,
  add column if not exists inventory_deduction_reprocess_required boolean
    not null default false,
  add column if not exists inventory_deduction_last_checked_at timestamptz null,
  add column if not exists inventory_deduction_pending_fingerprint text null,
  add column if not exists inventory_deduction_pending_status text null;

comment on column public.pos_sales_receipts.inventory_deduction_auto_eligible_at is
  'New or explicitly changed receipts become eligible for automatic inventory deduction. NULL protects historical rows from automatic backfill.';

comment on column public.pos_sales_receipts.inventory_deduction_processing_paused is
  'Prevents preview/apply while an administrator is replacing receipt lines and payments.';

comment on column public.pos_sales_receipts.inventory_deduction_reprocess_required is
  'Marks a post-deployment inventory-line change that must be compared with the active deduction, including legacy rows without a fingerprint.';

create index if not exists pos_sales_receipts_auto_deduction_eligible_idx
  on public.pos_sales_receipts (
    inventory_deduction_auto_eligible_at,
    inventory_deduction_last_checked_at,
    id
  )
  where inventory_deduction_auto_eligible_at is not null;

alter table public.pos_inventory_deduction_receipts
  drop constraint if exists pos_inventory_deduction_receipts_workflow_type_check;

alter table public.pos_inventory_deduction_receipts
  add constraint pos_inventory_deduction_receipts_workflow_type_check
  check (
    workflow_type is null
    or workflow_type in (
      'initial_apply',
      'reprocess_modified',
      'rollback_canceled'
    )
  )
  not valid;

create or replace function public.rollback_canceled_sales_inventory_deduction_receipt(
  p_receipt_id bigint,
  p_actor_username text,
  p_expected_receipt_updated_at timestamptz,
  p_expected_receipt_content_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_actor_name text;
  v_now timestamptz := now();
  v_receipt record;
  v_active record;
  v_previous_quantity numeric;
  v_new_quantity numeric;
  v_batch_id bigint;
  v_batch_receipt_id bigint;
  v_superseded_id bigint;
  v_revert_deduction_id bigint;
  v_inventory_log_id bigint;
  v_active_count integer := 0;
  v_inventory_count integer := 0;
  v_reversed_count integer := 0;
begin
  if p_receipt_id is null or p_receipt_id <= 0 then
    return jsonb_build_object('result', 'failed', 'failureReason', 'invalid_receipt_id');
  end if;

  select coalesce(nullif(name, ''), username)
    into v_actor_name
  from public.users
  where username = nullif(btrim(p_actor_username), '')
    and is_active = true
    and role in ('owner', 'master', 'manager')
  limit 1;

  if v_actor_name is null then
    return jsonb_build_object('result', 'failed', 'failureReason', 'permission_denied');
  end if;

  select receipt.*
    into v_receipt
  from public.pos_sales_receipts receipt
  where receipt.id = p_receipt_id
  for update;

  if not found then
    return jsonb_build_object(
      'result', 'needs_check',
      'receiptId', p_receipt_id,
      'failureReason', 'receipt_not_found'
    );
  end if;

  if v_receipt.is_canceled is not true then
    return jsonb_build_object(
      'result', 'stale_preview',
      'receiptId', v_receipt.id,
      'failureReason', 'receipt_not_canceled'
    );
  end if;

  if v_receipt.inventory_deduction_processing_paused is true then
    return jsonb_build_object(
      'result', 'stale_preview',
      'receiptId', v_receipt.id,
      'failureReason', 'receipt_processing_paused'
    );
  end if;

  if v_receipt.updated_at is distinct from p_expected_receipt_updated_at then
    return jsonb_build_object(
      'result', 'stale_preview',
      'receiptId', v_receipt.id,
      'failureReason', 'receipt_updated'
    );
  end if;

  select applied.id
    into v_batch_receipt_id
  from public.pos_inventory_deduction_receipts applied
  where applied.receipt_id = v_receipt.id
    and applied.workflow_type = 'rollback_canceled'
    and applied.receipt_content_fingerprint =
      p_expected_receipt_content_fingerprint
    and applied.status = 'applied'
  order by applied.applied_at desc nulls last, applied.created_at desc
  limit 1;

  if v_batch_receipt_id is not null then
    return jsonb_build_object(
      'result', 'already_processed',
      'receiptId', v_receipt.id,
      'deductionReceiptId', v_batch_receipt_id,
      'fingerprint', p_expected_receipt_content_fingerprint,
      'reversedDeductionCount', 0,
      'appliedDeductionCount', 0,
      'rollbackOnly', true,
      'failureReason', null
    );
  end if;

  drop table if exists pg_temp.sales_cancel_active_deductions;
  create temporary table sales_cancel_active_deductions
  on commit drop
  as
  select deduction.*
  from public.pos_inventory_deductions deduction
  where deduction.receipt_id = v_receipt.id
    and coalesce(deduction.operation_type, 'deduction') <> 'revert'
    and (
      deduction.status in ('applied', 'success')
      or deduction.applied_at is not null
      or deduction.inventory_log_id is not null
    )
    and not exists (
      select 1
      from public.pos_inventory_deductions reverted
      where reverted.reversal_of_deduction_id = deduction.id
        and reverted.operation_type = 'revert'
        and (
          reverted.status in ('applied', 'success', 'reverted')
          or reverted.applied_at is not null
          or reverted.inventory_log_id is not null
        )
    );

  perform deduction.id
  from public.pos_inventory_deductions deduction
  join pg_temp.sales_cancel_active_deductions active on active.id = deduction.id
  order by deduction.id
  for update of deduction;

  select count(*) into v_active_count
  from pg_temp.sales_cancel_active_deductions;

  if v_active_count = 0 then
    return jsonb_build_object(
      'result', 'needs_check',
      'receiptId', v_receipt.id,
      'fingerprint', p_expected_receipt_content_fingerprint,
      'failureReason', 'no_active_deductions'
    );
  end if;

  if exists (
    select 1
    from pg_temp.sales_cancel_active_deductions active
    where active.inventory_item_id is null
      or coalesce(active.deduct_quantity_total, 0) <= 0
      or active.receipt_id is null
  ) then
    return jsonb_build_object(
      'result', 'needs_check',
      'receiptId', v_receipt.id,
      'fingerprint', p_expected_receipt_content_fingerprint,
      'failureReason', 'legacy_metadata_missing'
    );
  end if;

  perform inventory.id
  from public.inventory inventory
  join (
    select distinct active.inventory_item_id
    from pg_temp.sales_cancel_active_deductions active
  ) affected on affected.inventory_item_id = inventory.id
  order by inventory.id
  for update of inventory;

  select count(distinct active.inventory_item_id)
    into v_inventory_count
  from pg_temp.sales_cancel_active_deductions active;

  if exists (
    select 1
    from pg_temp.sales_cancel_active_deductions active
    left join public.inventory inventory on inventory.id = active.inventory_item_id
    where inventory.id is null
  ) then
    return jsonb_build_object(
      'result', 'needs_check',
      'receiptId', v_receipt.id,
      'fingerprint', p_expected_receipt_content_fingerprint,
      'failureReason', 'inventory_item_missing'
    );
  end if;

  select processed.id
    into v_superseded_id
  from public.pos_inventory_deduction_receipts processed
  where processed.receipt_id = v_receipt.id
    and processed.status = 'applied'
  order by processed.applied_at desc nulls last, processed.created_at desc
  limit 1;

  insert into public.pos_inventory_deduction_batches (
    flow_version, business_date_from, business_date_to, source, status,
    receipt_count, ready_receipt_count, blocked_receipt_count,
    skipped_receipt_count, already_applied_receipt_count, created_by,
    created_at, previewed_at, note, metadata, updated_at
  ) values (
    'sales_db_v1', v_receipt.business_date, v_receipt.business_date,
    'rollback_canceled', 'previewed', 1, 1, 0, 0, 0,
    p_actor_username, v_now, v_now, 'rollback_canceled_receipt',
    jsonb_build_object(
      'workflowType', 'rollback_canceled',
      'receiptId', v_receipt.id,
      'receiptContentFingerprint', p_expected_receipt_content_fingerprint
    ),
    v_now
  ) returning id into v_batch_id;

  insert into public.pos_inventory_deduction_receipts (
    batch_id, receipt_id, receipt_ref_no, business_date, status,
    inventory_affecting_hash, amount_hash, previewed_receipt_updated_at,
    blocked_reasons, line_summary, selected_for_apply, workflow_type,
    receipt_content_fingerprint, supersedes_deduction_receipt_id,
    created_at, updated_at
  ) values (
    v_batch_id, v_receipt.id, v_receipt.ref_no, v_receipt.business_date,
    'ready', p_expected_receipt_content_fingerprint,
    p_expected_receipt_content_fingerprint, v_receipt.updated_at, '[]'::jsonb,
    jsonb_build_object(
      'workflowType', 'rollback_canceled',
      'activeDeductionCount', v_active_count
    ),
    true, 'rollback_canceled', p_expected_receipt_content_fingerprint,
    v_superseded_id, v_now, v_now
  ) returning id into v_batch_receipt_id;

  for v_active in
    select active.*
    from pg_temp.sales_cancel_active_deductions active
    order by active.inventory_item_id, active.receipt_line_id, active.id
  loop
    select inventory.quantity into v_previous_quantity
    from public.inventory inventory
    where inventory.id = v_active.inventory_item_id;

    v_new_quantity := v_previous_quantity + v_active.deduct_quantity_total;

    update public.inventory
    set quantity = v_new_quantity, updated_at = v_now
    where id = v_active.inventory_item_id;

    insert into public.pos_inventory_deductions (
      processed_line_id, invoice_ref_id, ref_detail_id, pos_item_code,
      pos_item_name, pos_quantity, mapping_type, inventory_item_id,
      deduct_quantity, status, error_message, applied_at, inventory_log_id,
      flow_version, batch_id, batch_receipt_id, receipt_id, receipt_line_id,
      receipt_ref_no, business_date, mapping_id, recipe_id, operation_type,
      mapping_snapshot, inventory_affecting_hash, amount_hash,
      idempotency_key, quantity_sold, deduct_quantity_per_unit,
      deduct_quantity_total, current_quantity_snapshot,
      after_quantity_snapshot, blocked_reason, reversal_of_deduction_id,
      updated_at
    ) values (
      v_active.processed_line_id, v_active.invoice_ref_id,
      v_active.ref_detail_id, v_active.pos_item_code, v_active.pos_item_name,
      v_active.pos_quantity, v_active.mapping_type, v_active.inventory_item_id,
      v_active.deduct_quantity, 'applied', null, v_now, null,
      'sales_db_v1', v_batch_id, v_batch_receipt_id, v_active.receipt_id,
      v_active.receipt_line_id, v_receipt.ref_no, v_receipt.business_date,
      v_active.mapping_id, v_active.recipe_id, 'revert',
      coalesce(v_active.mapping_snapshot, '{}'::jsonb) || jsonb_build_object(
        'workflowType', 'rollback_canceled',
        'receiptContentFingerprint', p_expected_receipt_content_fingerprint,
        'reversalOfDeductionId', v_active.id
      ),
      v_active.inventory_affecting_hash, v_active.amount_hash,
      format(
        'rollback_canceled:%s:%s:revert:%s',
        v_receipt.id, p_expected_receipt_content_fingerprint, v_active.id
      ),
      v_active.quantity_sold, v_active.deduct_quantity_per_unit,
      v_active.deduct_quantity_total, v_previous_quantity, v_new_quantity,
      null, v_active.id, v_now
    ) returning id into v_revert_deduction_id;

    insert into public.inventory_logs (
      item_id, item_name, item_name_vi, action, part, category, category_vi,
      prev_quantity, new_quantity, change_quantity, prev_note, new_note,
      prev_supplier, new_supplier, prev_code, new_code, prev_unit, new_unit,
      prev_category, new_category, prev_category_vi, new_category_vi,
      prev_part, new_part, unit, code, prev_purchase_price,
      new_purchase_price, actor_name, actor_username, reason, source,
      business_date, related_receipt_id, related_receipt_line_id,
      related_deduction_id, related_batch_id
    )
    select
      inventory.id, inventory.item_name, inventory.item_name_vi, 'update',
      inventory.part, inventory.category, inventory.category_vi,
      v_previous_quantity, v_new_quantity, v_active.deduct_quantity_total,
      inventory.note, inventory.note, inventory.supplier, inventory.supplier,
      inventory.code, inventory.code, inventory.unit, inventory.unit,
      inventory.category, inventory.category, inventory.category_vi,
      inventory.category_vi, inventory.part, inventory.part, inventory.unit,
      inventory.code, inventory.purchase_price, inventory.purchase_price,
      v_actor_name, p_actor_username, 'sale_deduction', 'pos_sales',
      v_receipt.business_date, v_receipt.id, v_active.receipt_line_id,
      v_revert_deduction_id, v_batch_id
    from public.inventory inventory
    where inventory.id = v_active.inventory_item_id
    returning id into v_inventory_log_id;

    update public.pos_inventory_deductions
    set inventory_log_id = v_inventory_log_id, updated_at = v_now
    where id = v_revert_deduction_id;

    v_reversed_count := v_reversed_count + 1;
  end loop;

  update public.pos_inventory_deduction_receipts
  set status = 'applied', applied_at = v_now, applied_by = p_actor_username,
      error_message = null, updated_at = v_now
  where id = v_batch_receipt_id;

  update public.pos_inventory_deduction_batches
  set status = 'applied', applied_receipt_count = 1,
      confirmed_by = p_actor_username, confirmed_at = v_now,
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'reversedDeductionCount', v_reversed_count,
        'affectedInventoryCount', v_inventory_count,
        'rollbackOnly', true
      ),
      error_message = null, updated_at = v_now
  where id = v_batch_id;

  return jsonb_build_object(
    'result', 'applied',
    'receiptId', v_receipt.id,
    'batchId', v_batch_id,
    'deductionReceiptId', v_batch_receipt_id,
    'fingerprint', p_expected_receipt_content_fingerprint,
    'reversedDeductionCount', v_reversed_count,
    'appliedDeductionCount', 0,
    'affectedInventoryCount', v_inventory_count,
    'rollbackOnly', true,
    'failureReason', null
  );
end;
$function$;

revoke all on function public.rollback_canceled_sales_inventory_deduction_receipt(
  bigint,
  text,
  timestamptz,
  text
) from public;

grant execute on function public.rollback_canceled_sales_inventory_deduction_receipt(
  bigint,
  text,
  timestamptz,
  text
) to service_role;

revoke all on function public.reprocess_modified_sales_inventory_deduction_receipt(
  bigint,
  text,
  timestamptz,
  text,
  text
) from public;

grant execute on function public.reprocess_modified_sales_inventory_deduction_receipt(
  bigint,
  text,
  timestamptz,
  text,
  text
) to service_role;
