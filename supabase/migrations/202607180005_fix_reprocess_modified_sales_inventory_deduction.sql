-- Replace the modified-sales receipt reprocess function with an explicit,
-- repository-auditable definition. The only body change is clearing the locked
-- session-local temporary snapshot with TRUNCATE instead of an unqualified DELETE.

create or replace function public.reprocess_modified_sales_inventory_deduction_receipt(
  p_batch_receipt_id bigint,
  p_actor_username text,
  p_expected_receipt_updated_at timestamptz,
  p_expected_receipt_content_fingerprint text,
  p_expected_inventory_affecting_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_actor_name text;
  v_now timestamptz := now();
  v_batch_receipt record;
  v_batch record;
  v_receipt record;
  v_existing_success_id bigint;
  v_active_count integer := 0;
  v_candidate_count integer := 0;
  v_inventory_count integer := 0;
  v_reversed_count integer := 0;
  v_applied_count integer := 0;
  v_rollback_only boolean := false;
  v_previous_quantity numeric;
  v_new_quantity numeric;
  v_inventory_log_id bigint;
  v_revert_deduction_id bigint;
  v_has_processing_history boolean := false;
  v_active record;
  v_candidate record;
  v_inventory_totals jsonb;
  v_result jsonb;
begin
  if p_batch_receipt_id is null or p_batch_receipt_id <= 0 then
    return jsonb_build_object(
      'result', 'failed',
      'failureReason', 'invalid_batch_receipt_id'
    );
  end if;

  select coalesce(nullif(name, ''), username)
    into v_actor_name
  from public.users
  where username = nullif(btrim(p_actor_username), '')
    and is_active = true
    and role in ('owner', 'master', 'manager')
  limit 1;

  if v_actor_name is null then
    return jsonb_build_object(
      'result', 'failed',
      'failureReason', 'permission_denied'
    );
  end if;

  select batch_receipt.*
    into v_batch_receipt
  from public.pos_inventory_deduction_receipts batch_receipt
  where batch_receipt.id = p_batch_receipt_id
  for update;

  if not found then
    return jsonb_build_object(
      'result', 'failed',
      'failureReason', 'batch_receipt_not_found'
    );
  end if;

  select batch.*
    into v_batch
  from public.pos_inventory_deduction_batches batch
  where batch.id = v_batch_receipt.batch_id
  for update;

  if not found then
    return jsonb_build_object(
      'result', 'failed',
      'receiptId', v_batch_receipt.receipt_id,
      'batchId', v_batch_receipt.batch_id,
      'deductionReceiptId', v_batch_receipt.id,
      'fingerprint', v_batch_receipt.receipt_content_fingerprint,
      'failureReason', 'batch_not_found'
    );
  end if;

  if v_batch_receipt.status = 'applied' then
    return jsonb_build_object(
      'result', 'already_processed',
      'receiptId', v_batch_receipt.receipt_id,
      'batchId', v_batch.id,
      'deductionReceiptId', v_batch_receipt.id,
      'fingerprint', v_batch_receipt.receipt_content_fingerprint,
      'reversedDeductionCount', 0,
      'appliedDeductionCount', 0,
      'affectedInventoryCount', 0,
      'rollbackOnly', false,
      'failureReason', null
    );
  end if;

  if v_batch.source <> 'reprocess_modified'
    or v_batch_receipt.workflow_type <> 'reprocess_modified'
    or v_batch_receipt.status <> 'ready'
    or v_batch_receipt.selected_for_apply is not true then
    update public.pos_inventory_deduction_receipts
    set
      status = 'failed',
      error_message = 'not_reprocess_batch_receipt',
      updated_at = v_now
    where id = v_batch_receipt.id;

    update public.pos_inventory_deduction_batches
    set
      status = 'failed',
      error_message = 'not_reprocess_batch_receipt',
      updated_at = v_now
    where id = v_batch.id;

    return jsonb_build_object(
      'result', 'needs_check',
      'receiptId', v_batch_receipt.receipt_id,
      'batchId', v_batch.id,
      'deductionReceiptId', v_batch_receipt.id,
      'fingerprint', v_batch_receipt.receipt_content_fingerprint,
      'failureReason', 'not_reprocess_batch_receipt'
    );
  end if;

  select receipt.*
    into v_receipt
  from public.pos_sales_receipts receipt
  where receipt.id = v_batch_receipt.receipt_id
  for update;

  if not found then
    update public.pos_inventory_deduction_receipts
    set status = 'failed', error_message = 'receipt_not_found', updated_at = v_now
    where id = v_batch_receipt.id;
    update public.pos_inventory_deduction_batches
    set status = 'failed', error_message = 'receipt_not_found', updated_at = v_now
    where id = v_batch.id;

    return jsonb_build_object(
      'result', 'needs_check',
      'receiptId', v_batch_receipt.receipt_id,
      'batchId', v_batch.id,
      'deductionReceiptId', v_batch_receipt.id,
      'fingerprint', v_batch_receipt.receipt_content_fingerprint,
      'failureReason', 'receipt_not_found'
    );
  end if;

  if v_receipt.is_canceled is true then
    update public.pos_inventory_deduction_receipts
    set
      status = 'failed',
      error_message = 'canceled_after_applied_not_supported',
      updated_at = v_now
    where id = v_batch_receipt.id;
    update public.pos_inventory_deduction_batches
    set
      status = 'failed',
      error_message = 'canceled_after_applied_not_supported',
      updated_at = v_now
    where id = v_batch.id;

    return jsonb_build_object(
      'result', 'needs_check',
      'receiptId', v_receipt.id,
      'batchId', v_batch.id,
      'deductionReceiptId', v_batch_receipt.id,
      'fingerprint', v_batch_receipt.receipt_content_fingerprint,
      'failureReason', 'canceled_after_applied_not_supported'
    );
  end if;

  if v_receipt.payment_status is distinct from 3
    or v_receipt.updated_at is distinct from p_expected_receipt_updated_at
    or v_batch_receipt.previewed_receipt_updated_at is distinct from
      p_expected_receipt_updated_at
    or v_batch_receipt.receipt_content_fingerprint is distinct from
      p_expected_receipt_content_fingerprint
    or v_batch_receipt.inventory_affecting_hash is distinct from
      p_expected_inventory_affecting_hash then
    update public.pos_inventory_deduction_receipts
    set status = 'failed', error_message = 'stale_preview', updated_at = v_now
    where id = v_batch_receipt.id;
    update public.pos_inventory_deduction_batches
    set status = 'failed', error_message = 'stale_preview', updated_at = v_now
    where id = v_batch.id;

    return jsonb_build_object(
      'result', 'stale_preview',
      'receiptId', v_receipt.id,
      'batchId', v_batch.id,
      'deductionReceiptId', v_batch_receipt.id,
      'fingerprint', v_batch_receipt.receipt_content_fingerprint,
      'failureReason', 'stale_preview'
    );
  end if;

  select existing.id
    into v_existing_success_id
  from public.pos_inventory_deduction_receipts existing
  where existing.id <> v_batch_receipt.id
    and existing.receipt_id = v_batch_receipt.receipt_id
    and existing.workflow_type = 'reprocess_modified'
    and existing.receipt_content_fingerprint =
      v_batch_receipt.receipt_content_fingerprint
    and existing.status = 'applied'
  order by existing.applied_at desc nulls last, existing.created_at desc
  limit 1;

  if v_existing_success_id is not null then
    update public.pos_inventory_deduction_receipts
    set
      status = 'failed',
      error_message = 'already_processed',
      updated_at = v_now
    where id = v_batch_receipt.id;
    update public.pos_inventory_deduction_batches
    set
      status = 'canceled',
      error_message = 'already_processed',
      updated_at = v_now
    where id = v_batch.id;

    return jsonb_build_object(
      'result', 'already_processed',
      'receiptId', v_receipt.id,
      'batchId', v_batch.id,
      'deductionReceiptId', v_batch_receipt.id,
      'fingerprint', v_batch_receipt.receipt_content_fingerprint,
      'reversedDeductionCount', 0,
      'appliedDeductionCount', 0,
      'affectedInventoryCount', 0,
      'rollbackOnly', false,
      'failureReason', null
    );
  end if;

  drop table if exists pg_temp.sales_reprocess_active_deductions;
  create temporary table sales_reprocess_active_deductions
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
  join pg_temp.sales_reprocess_active_deductions active
    on active.id = deduction.id
  order by deduction.id
  for update of deduction;

  truncate table pg_temp.sales_reprocess_active_deductions;
  insert into pg_temp.sales_reprocess_active_deductions
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

  select count(*)
    into v_active_count
  from pg_temp.sales_reprocess_active_deductions;

  if exists (
    select 1
    from pg_temp.sales_reprocess_active_deductions active
    where active.inventory_item_id is null
      or coalesce(active.deduct_quantity_total, 0) <= 0
      or active.receipt_id is null
  ) then
    update public.pos_inventory_deduction_receipts
    set
      status = 'failed',
      error_message = 'legacy_metadata_missing',
      updated_at = v_now
    where id = v_batch_receipt.id;
    update public.pos_inventory_deduction_batches
    set
      status = 'failed',
      error_message = 'legacy_metadata_missing',
      updated_at = v_now
    where id = v_batch.id;

    return jsonb_build_object(
      'result', 'failed',
      'receiptId', v_receipt.id,
      'batchId', v_batch.id,
      'deductionReceiptId', v_batch_receipt.id,
      'fingerprint', v_batch_receipt.receipt_content_fingerprint,
      'failureReason', 'legacy_metadata_missing'
    );
  end if;

  drop table if exists pg_temp.sales_reprocess_candidates;
  create temporary table sales_reprocess_candidates
  on commit drop
  as
  select deduction.*
  from public.pos_inventory_deductions deduction
  where deduction.batch_id = v_batch.id
    and deduction.batch_receipt_id = v_batch_receipt.id
    and deduction.flow_version = 'sales_db_v1'
    and deduction.operation_type = 'preview'
    and deduction.status = 'selected';

  select count(*)
    into v_candidate_count
  from pg_temp.sales_reprocess_candidates;

  v_rollback_only := v_candidate_count = 0;

  select exists (
    select 1
    from public.pos_inventory_deduction_receipts processed
    where processed.receipt_id = v_receipt.id
      and processed.status = 'applied'
      and processed.workflow_type in ('initial_apply', 'reprocess_modified')
  ) or exists (
    select 1
    from public.pos_inventory_deductions deduction
    where deduction.receipt_id = v_receipt.id
      and (
        deduction.status in ('applied', 'success', 'reverted')
        or deduction.applied_at is not null
        or deduction.inventory_log_id is not null
      )
  ) into v_has_processing_history;

  if v_active_count = 0 and v_candidate_count = 0 then
    update public.pos_inventory_deduction_receipts
    set
      status = 'failed',
      error_message = 'no_inventory_movement',
      updated_at = v_now
    where id = v_batch_receipt.id;
    update public.pos_inventory_deduction_batches
    set
      status = 'canceled',
      error_message = 'no_inventory_movement',
      updated_at = v_now
    where id = v_batch.id;

    return jsonb_build_object(
      'result', 'needs_check',
      'receiptId', v_receipt.id,
      'batchId', v_batch.id,
      'deductionReceiptId', v_batch_receipt.id,
      'fingerprint', v_batch_receipt.receipt_content_fingerprint,
      'reversedDeductionCount', 0,
      'appliedDeductionCount', 0,
      'affectedInventoryCount', 0,
      'rollbackOnly', false,
      'failureReason', 'no_inventory_movement'
    );
  end if;

  if v_active_count = 0 and v_has_processing_history is not true then
    update public.pos_inventory_deduction_receipts
    set
      status = 'failed',
      error_message = 'initial_apply_required_or_not_reprocess',
      updated_at = v_now
    where id = v_batch_receipt.id;
    update public.pos_inventory_deduction_batches
    set
      status = 'failed',
      error_message = 'initial_apply_required_or_not_reprocess',
      updated_at = v_now
    where id = v_batch.id;

    return jsonb_build_object(
      'result', 'needs_check',
      'receiptId', v_receipt.id,
      'batchId', v_batch.id,
      'deductionReceiptId', v_batch_receipt.id,
      'fingerprint', v_batch_receipt.receipt_content_fingerprint,
      'reversedDeductionCount', 0,
      'appliedDeductionCount', 0,
      'affectedInventoryCount', 0,
      'rollbackOnly', false,
      'failureReason', 'initial_apply_required_or_not_reprocess'
    );
  end if;

  perform deduction.id
  from public.pos_inventory_deductions deduction
  join pg_temp.sales_reprocess_candidates candidate
    on candidate.id = deduction.id
  order by deduction.id
  for update of deduction;

  if exists (
    select 1
    from pg_temp.sales_reprocess_candidates candidate
    join public.pos_inventory_deductions deduction
      on deduction.id = candidate.id
    where deduction.status <> 'selected'
      or deduction.operation_type <> 'preview'
  ) then
    update public.pos_inventory_deduction_receipts
    set status = 'failed', error_message = 'candidate_changed', updated_at = v_now
    where id = v_batch_receipt.id;
    update public.pos_inventory_deduction_batches
    set status = 'failed', error_message = 'candidate_changed', updated_at = v_now
    where id = v_batch.id;

    return jsonb_build_object(
      'result', 'stale_preview',
      'receiptId', v_receipt.id,
      'batchId', v_batch.id,
      'deductionReceiptId', v_batch_receipt.id,
      'fingerprint', v_batch_receipt.receipt_content_fingerprint,
      'failureReason', 'candidate_changed'
    );
  end if;

  if exists (
    select 1
    from pg_temp.sales_reprocess_candidates candidate
    where candidate.inventory_item_id is null
      or coalesce(candidate.deduct_quantity_total, 0) <= 0
      or candidate.receipt_id is null
      or candidate.receipt_line_id is null
      or candidate.mapping_id is null
  ) then
    update public.pos_inventory_deduction_receipts
    set
      status = 'failed',
      error_message = 'candidate_metadata_missing',
      updated_at = v_now
    where id = v_batch_receipt.id;
    update public.pos_inventory_deduction_batches
    set
      status = 'failed',
      error_message = 'candidate_metadata_missing',
      updated_at = v_now
    where id = v_batch.id;

    return jsonb_build_object(
      'result', 'needs_check',
      'receiptId', v_receipt.id,
      'batchId', v_batch.id,
      'deductionReceiptId', v_batch_receipt.id,
      'fingerprint', v_batch_receipt.receipt_content_fingerprint,
      'failureReason', 'candidate_metadata_missing'
    );
  end if;

  if exists (
    select 1
    from pg_temp.sales_reprocess_candidates candidate
    left join public.pos_item_mappings mapping
      on mapping.id = candidate.mapping_id
    where mapping.id is null
      or mapping.is_active is not true
      or mapping.mapping_type is distinct from candidate.mapping_type
      or mapping.mapping_version is distinct from
        coalesce(
          nullif(candidate.mapping_snapshot ->> 'mappingVersion', '')::integer,
          0
        )
  ) then
    update public.pos_inventory_deduction_receipts
    set status = 'failed', error_message = 'mapping_changed', updated_at = v_now
    where id = v_batch_receipt.id;
    update public.pos_inventory_deduction_batches
    set status = 'failed', error_message = 'mapping_changed', updated_at = v_now
    where id = v_batch.id;

    return jsonb_build_object(
      'result', 'stale_preview',
      'receiptId', v_receipt.id,
      'batchId', v_batch.id,
      'deductionReceiptId', v_batch_receipt.id,
      'fingerprint', v_batch_receipt.receipt_content_fingerprint,
      'failureReason', 'mapping_changed'
    );
  end if;

  if exists (
    select 1
    from pg_temp.sales_reprocess_candidates candidate
    left join public.pos_item_mapping_recipes recipe
      on recipe.id = candidate.recipe_id
    where candidate.recipe_id is not null
      and (
        recipe.id is null
        or recipe.is_active is not true
        or recipe.version is distinct from
          coalesce(
            nullif(candidate.mapping_snapshot ->> 'recipeVersion', '')::integer,
            0
          )
        or recipe.quantity_per_pos_unit is distinct from
          candidate.deduct_quantity_per_unit
      )
  ) then
    update public.pos_inventory_deduction_receipts
    set status = 'failed', error_message = 'recipe_changed', updated_at = v_now
    where id = v_batch_receipt.id;
    update public.pos_inventory_deduction_batches
    set status = 'failed', error_message = 'recipe_changed', updated_at = v_now
    where id = v_batch.id;

    return jsonb_build_object(
      'result', 'stale_preview',
      'receiptId', v_receipt.id,
      'batchId', v_batch.id,
      'deductionReceiptId', v_batch_receipt.id,
      'fingerprint', v_batch_receipt.receipt_content_fingerprint,
      'failureReason', 'recipe_changed'
    );
  end if;

  drop table if exists pg_temp.sales_reprocess_inventory_totals;
  create temporary table sales_reprocess_inventory_totals
  on commit drop
  as
  select
    inventory_item_id,
    sum(restore_quantity)::numeric as restore_quantity,
    sum(deduct_quantity)::numeric as deduct_quantity,
    0::numeric as previous_quantity,
    0::numeric as new_quantity,
    null::text as item_name,
    null::text as item_name_vi
  from (
    select
      active.inventory_item_id,
      active.deduct_quantity_total::numeric as restore_quantity,
      0::numeric as deduct_quantity
    from pg_temp.sales_reprocess_active_deductions active
    union all
    select
      candidate.inventory_item_id,
      0::numeric as restore_quantity,
      candidate.deduct_quantity_total::numeric as deduct_quantity
    from pg_temp.sales_reprocess_candidates candidate
  ) movement
  group by inventory_item_id;

  perform inventory.id
  from public.inventory inventory
  join pg_temp.sales_reprocess_inventory_totals total
    on total.inventory_item_id = inventory.id
  order by inventory.id
  for update of inventory;

  select count(*)
    into v_inventory_count
  from pg_temp.sales_reprocess_inventory_totals;

  if exists (
    select 1
    from pg_temp.sales_reprocess_inventory_totals total
    left join public.inventory inventory
      on inventory.id = total.inventory_item_id
    where inventory.id is null
  ) then
    update public.pos_inventory_deduction_receipts
    set
      status = 'failed',
      error_message = 'inventory_item_missing',
      updated_at = v_now
    where id = v_batch_receipt.id;
    update public.pos_inventory_deduction_batches
    set
      status = 'failed',
      error_message = 'inventory_item_missing',
      updated_at = v_now
    where id = v_batch.id;

    return jsonb_build_object(
      'result', 'failed',
      'receiptId', v_receipt.id,
      'batchId', v_batch.id,
      'deductionReceiptId', v_batch_receipt.id,
      'fingerprint', v_batch_receipt.receipt_content_fingerprint,
      'failureReason', 'inventory_item_missing'
    );
  end if;

  update pg_temp.sales_reprocess_inventory_totals total
  set
    previous_quantity = inventory.quantity,
    new_quantity =
      inventory.quantity + total.restore_quantity - total.deduct_quantity,
    item_name = inventory.item_name,
    item_name_vi = inventory.item_name_vi
  from public.inventory inventory
  where inventory.id = total.inventory_item_id;

  if exists (
    select 1
    from pg_temp.sales_reprocess_inventory_totals
    where new_quantity < 0
  ) then
    update public.pos_inventory_deduction_receipts
    set
      status = 'failed',
      error_message = 'insufficient_stock_after_reversal',
      updated_at = v_now
    where id = v_batch_receipt.id;
    update public.pos_inventory_deduction_batches
    set
      status = 'failed',
      error_message = 'insufficient_stock_after_reversal',
      updated_at = v_now
    where id = v_batch.id;

    return jsonb_build_object(
      'result', 'failed',
      'receiptId', v_receipt.id,
      'batchId', v_batch.id,
      'deductionReceiptId', v_batch_receipt.id,
      'fingerprint', v_batch_receipt.receipt_content_fingerprint,
      'reversedDeductionCount', 0,
      'appliedDeductionCount', 0,
      'affectedInventoryCount', v_inventory_count,
      'rollbackOnly', v_rollback_only,
      'failureReason', 'insufficient_stock_after_reversal'
    );
  end if;

  for v_active in
    select active.*
    from pg_temp.sales_reprocess_active_deductions active
    order by active.inventory_item_id, active.receipt_line_id, active.id
  loop
    select inventory.quantity
      into v_previous_quantity
    from public.inventory inventory
    where inventory.id = v_active.inventory_item_id;

    v_new_quantity := v_previous_quantity + v_active.deduct_quantity_total;

    update public.inventory
    set quantity = v_new_quantity, updated_at = v_now
    where id = v_active.inventory_item_id;

    insert into public.pos_inventory_deductions (
      processed_line_id,
      invoice_ref_id,
      ref_detail_id,
      pos_item_code,
      pos_item_name,
      pos_quantity,
      mapping_type,
      inventory_item_id,
      deduct_quantity,
      status,
      error_message,
      applied_at,
      inventory_log_id,
      flow_version,
      batch_id,
      batch_receipt_id,
      receipt_id,
      receipt_line_id,
      receipt_ref_no,
      business_date,
      mapping_id,
      recipe_id,
      operation_type,
      mapping_snapshot,
      inventory_affecting_hash,
      amount_hash,
      idempotency_key,
      quantity_sold,
      deduct_quantity_per_unit,
      deduct_quantity_total,
      current_quantity_snapshot,
      after_quantity_snapshot,
      blocked_reason,
      reversal_of_deduction_id,
      updated_at
    )
    values (
      v_active.processed_line_id,
      v_active.invoice_ref_id,
      v_active.ref_detail_id,
      v_active.pos_item_code,
      v_active.pos_item_name,
      v_active.pos_quantity,
      v_active.mapping_type,
      v_active.inventory_item_id,
      v_active.deduct_quantity,
      'applied',
      null,
      v_now,
      null,
      'sales_db_v1',
      v_batch.id,
      v_batch_receipt.id,
      v_active.receipt_id,
      v_active.receipt_line_id,
      v_batch_receipt.receipt_ref_no,
      v_batch_receipt.business_date,
      v_active.mapping_id,
      v_active.recipe_id,
      'revert',
      coalesce(v_active.mapping_snapshot, '{}'::jsonb) ||
        jsonb_build_object(
          'workflowType', 'reprocess_modified',
          'receiptContentFingerprint',
          v_batch_receipt.receipt_content_fingerprint,
          'reversalOfDeductionId',
          v_active.id
        ),
      v_batch_receipt.inventory_affecting_hash,
      v_batch_receipt.amount_hash,
      format(
        'reprocess:%s:%s:revert:%s',
        v_receipt.id,
        v_batch_receipt.receipt_content_fingerprint,
        v_active.id
      ),
      v_active.quantity_sold,
      v_active.deduct_quantity_per_unit,
      v_active.deduct_quantity_total,
      v_previous_quantity,
      v_new_quantity,
      null,
      v_active.id,
      v_now
    )
    returning id into v_revert_deduction_id;

    insert into public.inventory_logs (
      item_id,
      item_name,
      item_name_vi,
      action,
      part,
      category,
      category_vi,
      prev_quantity,
      new_quantity,
      change_quantity,
      prev_note,
      new_note,
      prev_supplier,
      new_supplier,
      prev_code,
      new_code,
      prev_unit,
      new_unit,
      prev_category,
      new_category,
      prev_category_vi,
      new_category_vi,
      prev_part,
      new_part,
      unit,
      code,
      prev_purchase_price,
      new_purchase_price,
      actor_name,
      actor_username,
      reason,
      source,
      business_date,
      related_receipt_id,
      related_receipt_line_id,
      related_deduction_id,
      related_batch_id
    )
    select
      inventory.id,
      inventory.item_name,
      inventory.item_name_vi,
      'update',
      inventory.part,
      inventory.category,
      inventory.category_vi,
      v_previous_quantity,
      v_new_quantity,
      v_active.deduct_quantity_total,
      inventory.note,
      inventory.note,
      inventory.supplier,
      inventory.supplier,
      inventory.code,
      inventory.code,
      inventory.unit,
      inventory.unit,
      inventory.category,
      inventory.category,
      inventory.category_vi,
      inventory.category_vi,
      inventory.part,
      inventory.part,
      inventory.unit,
      inventory.code,
      inventory.purchase_price,
      inventory.purchase_price,
      v_actor_name,
      p_actor_username,
      'sale_deduction',
      'pos_sales',
      v_batch_receipt.business_date,
      v_active.receipt_id,
      v_active.receipt_line_id,
      v_revert_deduction_id,
      v_batch.id
    from public.inventory inventory
    where inventory.id = v_active.inventory_item_id
    returning id into v_inventory_log_id;

    update public.pos_inventory_deductions
    set inventory_log_id = v_inventory_log_id, updated_at = v_now
    where id = v_revert_deduction_id;

    v_reversed_count := v_reversed_count + 1;
  end loop;

  for v_candidate in
    select candidate.*
    from pg_temp.sales_reprocess_candidates candidate
    order by candidate.inventory_item_id, candidate.receipt_line_id, candidate.id
  loop
    select inventory.quantity
      into v_previous_quantity
    from public.inventory inventory
    where inventory.id = v_candidate.inventory_item_id;

    v_new_quantity := v_previous_quantity - v_candidate.deduct_quantity_total;

    update public.inventory
    set quantity = v_new_quantity, updated_at = v_now
    where id = v_candidate.inventory_item_id;

    insert into public.inventory_logs (
      item_id,
      item_name,
      item_name_vi,
      action,
      part,
      category,
      category_vi,
      prev_quantity,
      new_quantity,
      change_quantity,
      prev_note,
      new_note,
      prev_supplier,
      new_supplier,
      prev_code,
      new_code,
      prev_unit,
      new_unit,
      prev_category,
      new_category,
      prev_category_vi,
      new_category_vi,
      prev_part,
      new_part,
      unit,
      code,
      prev_purchase_price,
      new_purchase_price,
      actor_name,
      actor_username,
      reason,
      source,
      business_date,
      related_receipt_id,
      related_receipt_line_id,
      related_deduction_id,
      related_batch_id
    )
    select
      inventory.id,
      inventory.item_name,
      inventory.item_name_vi,
      'update',
      inventory.part,
      inventory.category,
      inventory.category_vi,
      v_previous_quantity,
      v_new_quantity,
      -v_candidate.deduct_quantity_total,
      inventory.note,
      inventory.note,
      inventory.supplier,
      inventory.supplier,
      inventory.code,
      inventory.code,
      inventory.unit,
      inventory.unit,
      inventory.category,
      inventory.category,
      inventory.category_vi,
      inventory.category_vi,
      inventory.part,
      inventory.part,
      inventory.unit,
      inventory.code,
      inventory.purchase_price,
      inventory.purchase_price,
      v_actor_name,
      p_actor_username,
      'sale_deduction',
      'pos_sales',
      v_candidate.business_date,
      v_candidate.receipt_id,
      v_candidate.receipt_line_id,
      v_candidate.id,
      v_batch.id
    from public.inventory inventory
    where inventory.id = v_candidate.inventory_item_id
    returning id into v_inventory_log_id;

    update public.pos_inventory_deductions
    set
      status = 'applied',
      operation_type = 'deduction',
      inventory_log_id = v_inventory_log_id,
      applied_at = v_now,
      current_quantity_snapshot = v_previous_quantity,
      after_quantity_snapshot = v_new_quantity,
      blocked_reason = null,
      error_message = null,
      updated_at = v_now
    where id = v_candidate.id;

    v_applied_count := v_applied_count + 1;
  end loop;

  update public.pos_inventory_deduction_receipts
  set
    status = 'applied',
    applied_at = v_now,
    applied_by = p_actor_username,
    error_message = null,
    updated_at = v_now
  where id = v_batch_receipt.id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'inventoryItemId', total.inventory_item_id,
        'itemName', coalesce(total.item_name_vi, total.item_name),
        'restoreQuantity', total.restore_quantity,
        'deductQuantity', total.deduct_quantity,
        'previousQuantity', total.previous_quantity,
        'newQuantity', total.new_quantity
      )
      order by total.inventory_item_id
    ),
    '[]'::jsonb
  )
    into v_inventory_totals
  from pg_temp.sales_reprocess_inventory_totals total;

  update public.pos_inventory_deduction_batches
  set
    status = 'applied',
    applied_receipt_count = 1,
    confirmed_by = p_actor_username,
    confirmed_at = v_now,
    metadata = coalesce(metadata, '{}'::jsonb) ||
      jsonb_build_object(
        'workflowType', 'reprocess_modified',
        'receiptId', v_receipt.id,
        'receiptContentFingerprint',
        v_batch_receipt.receipt_content_fingerprint,
        'reversedDeductionCount', v_reversed_count,
        'appliedDeductionCount', v_applied_count,
        'affectedInventoryCount', v_inventory_count,
        'rollbackOnly', v_rollback_only,
        'inventoryTotals', v_inventory_totals
      ),
    error_message = null,
    updated_at = v_now
  where id = v_batch.id;

  v_result := jsonb_build_object(
    'result', 'applied',
    'receiptId', v_receipt.id,
    'batchId', v_batch.id,
    'deductionReceiptId', v_batch_receipt.id,
    'fingerprint', v_batch_receipt.receipt_content_fingerprint,
    'reversedDeductionCount', v_reversed_count,
    'appliedDeductionCount', v_applied_count,
    'affectedInventoryCount', v_inventory_count,
    'rollbackOnly', v_rollback_only,
    'failureReason', null
  );

  return v_result;
end;
$function$;

revoke all on function public.reprocess_modified_sales_inventory_deduction_receipt(
  bigint, text, timestamptz, text, text
) from public, anon, authenticated;

grant execute on function public.reprocess_modified_sales_inventory_deduction_receipt(
  bigint, text, timestamptz, text, text
) to service_role;
