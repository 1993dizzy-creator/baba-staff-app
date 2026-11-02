-- P1-1. Additive only: no historical receipt/deduction/log backfill.
-- Explicit engine definition retains the installed P0 boundary handler.
begin;

create temporary table pos_reprocess_engine_identity on commit drop as
select oid, proowner, proacl::text acl, prosecdef, proconfig::text config
from pg_proc where oid = 'public.reprocess_modified_sales_inventory_deduction_receipt(bigint,text,timestamptz,text,text)'::regprocedure;

do $preflight$
begin
  if (select md5(replace(replace(prosrc, E'\r\n', E'\n'), E'\r', E'\n'))
      from pg_proc where oid = 'public.reprocess_modified_sales_inventory_deduction_receipt(bigint,text,timestamptz,text,text)'::regprocedure)
      <> '2c1c389e352d91c7b3632fcc713c81bd' then
    raise exception 'POS_REPROCESS_P1_ENGINE_DEFINITION_MISMATCH';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid='public.inventory_logs'::regclass
      and tgname='inventory_logs_pos_stock_check_boundary' and not tgisinternal and tgenabled='O') then
    raise exception 'POS_REPROCESS_P1_REQUIRES_P0_GUARD';
  end if;
end $preflight$;

alter table public.pos_inventory_deduction_receipts
  add column reprocess_request_key text,
  add column reprocess_dependency_snapshot jsonb,
  add column reprocess_result jsonb;
create unique index pos_inventory_reprocess_request_uidx
  on public.pos_inventory_deduction_receipts(receipt_id, reprocess_request_key)
  where reprocess_request_key is not null;

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

  -- Failed attempts are immutable. Changed dependencies get a NEW attempt in
  -- prepare_and_apply_sales_inventory_reprocess; never reselect a failed row.
  if v_batch_receipt.status = 'failed' then
    return coalesce(v_batch_receipt.reprocess_result, jsonb_build_object(
      'result', case
        when v_batch_receipt.error_message = 'already_processed' then 'already_processed'
        when v_batch_receipt.error_message in ('stale_preview','candidate_changed','mapping_changed','recipe_changed') then 'stale_preview'
        when v_batch_receipt.error_message in ('legacy_metadata_missing','inventory_item_missing','insufficient_stock_after_reversal') then 'failed'
        else 'needs_check' end,
      'receiptId', v_batch_receipt.receipt_id, 'batchId', v_batch.id,
      'deductionReceiptId', v_batch_receipt.id,
      'fingerprint', v_batch_receipt.receipt_content_fingerprint,
      'failureReason', case when v_batch_receipt.error_message = 'already_processed' then null else v_batch_receipt.error_message end,
      'reversedDeductionCount', 0, 'appliedDeductionCount', 0));
  end if;

  if v_batch.source <> 'reprocess_modified'
    or v_batch_receipt.workflow_type <> 'reprocess_modified'
    or v_batch_receipt.status <> 'ready'
    or v_batch_receipt.selected_for_apply is not true then
    update public.pos_inventory_deduction_receipts
    set
      status = 'failed', selected_for_apply = false,
      error_message = 'not_reprocess_batch_receipt',
      updated_at = v_now
    where id = v_batch_receipt.id;

    update public.pos_inventory_deduction_batches
    set
      status = 'failed',
      error_message = 'not_reprocess_batch_receipt',
      updated_at = v_now
    where id = v_batch.id;

    v_result := jsonb_build_object(
      'result', 'needs_check',
      'receiptId', v_batch_receipt.receipt_id,
      'batchId', v_batch.id,
      'deductionReceiptId', v_batch_receipt.id,
      'fingerprint', v_batch_receipt.receipt_content_fingerprint,
      'failureReason', 'not_reprocess_batch_receipt'
    );
    update public.pos_inventory_deduction_receipts
    set reprocess_result = v_result where id = v_batch_receipt.id;
    return v_result;
  end if;

  select receipt.*
    into v_receipt
  from public.pos_sales_receipts receipt
  where receipt.id = v_batch_receipt.receipt_id
  for update;

  if not found then
    update public.pos_inventory_deduction_receipts
    set status = 'failed', selected_for_apply = false, error_message = 'receipt_not_found', updated_at = v_now
    where id = v_batch_receipt.id;
    update public.pos_inventory_deduction_batches
    set status = 'failed', error_message = 'receipt_not_found', updated_at = v_now
    where id = v_batch.id;

    v_result := jsonb_build_object(
      'result', 'needs_check',
      'receiptId', v_batch_receipt.receipt_id,
      'batchId', v_batch.id,
      'deductionReceiptId', v_batch_receipt.id,
      'fingerprint', v_batch_receipt.receipt_content_fingerprint,
      'failureReason', 'receipt_not_found'
    );
    update public.pos_inventory_deduction_receipts
    set reprocess_result = v_result where id = v_batch_receipt.id;
    return v_result;
  end if;

  if v_receipt.is_canceled is true then
    update public.pos_inventory_deduction_receipts
    set
      status = 'failed', selected_for_apply = false,
      error_message = 'canceled_after_applied_not_supported',
      updated_at = v_now
    where id = v_batch_receipt.id;
    update public.pos_inventory_deduction_batches
    set
      status = 'failed',
      error_message = 'canceled_after_applied_not_supported',
      updated_at = v_now
    where id = v_batch.id;

    v_result := jsonb_build_object(
      'result', 'needs_check',
      'receiptId', v_receipt.id,
      'batchId', v_batch.id,
      'deductionReceiptId', v_batch_receipt.id,
      'fingerprint', v_batch_receipt.receipt_content_fingerprint,
      'failureReason', 'canceled_after_applied_not_supported'
    );
    update public.pos_inventory_deduction_receipts
    set reprocess_result = v_result where id = v_batch_receipt.id;
    return v_result;
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
    set status = 'failed', selected_for_apply = false, error_message = 'stale_preview', updated_at = v_now
    where id = v_batch_receipt.id;
    update public.pos_inventory_deduction_batches
    set status = 'failed', error_message = 'stale_preview', updated_at = v_now
    where id = v_batch.id;

    v_result := jsonb_build_object(
      'result', 'stale_preview',
      'receiptId', v_receipt.id,
      'batchId', v_batch.id,
      'deductionReceiptId', v_batch_receipt.id,
      'fingerprint', v_batch_receipt.receipt_content_fingerprint,
      'failureReason', 'stale_preview'
    );
    update public.pos_inventory_deduction_receipts
    set reprocess_result = v_result where id = v_batch_receipt.id;
    return v_result;
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
      status = 'failed', selected_for_apply = false,
      error_message = 'already_processed',
      updated_at = v_now
    where id = v_batch_receipt.id;
    update public.pos_inventory_deduction_batches
    set
      status = 'canceled',
      error_message = 'already_processed',
      updated_at = v_now
    where id = v_batch.id;

    v_result := jsonb_build_object(
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
    update public.pos_inventory_deduction_receipts
    set reprocess_result = v_result where id = v_batch_receipt.id;
    return v_result;
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
      status = 'failed', selected_for_apply = false,
      error_message = 'legacy_metadata_missing',
      updated_at = v_now
    where id = v_batch_receipt.id;
    update public.pos_inventory_deduction_batches
    set
      status = 'failed',
      error_message = 'legacy_metadata_missing',
      updated_at = v_now
    where id = v_batch.id;

    v_result := jsonb_build_object(
      'result', 'failed',
      'receiptId', v_receipt.id,
      'batchId', v_batch.id,
      'deductionReceiptId', v_batch_receipt.id,
      'fingerprint', v_batch_receipt.receipt_content_fingerprint,
      'failureReason', 'legacy_metadata_missing'
    );
    update public.pos_inventory_deduction_receipts
    set reprocess_result = v_result where id = v_batch_receipt.id;
    return v_result;
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
      status = 'failed', selected_for_apply = false,
      error_message = 'no_inventory_movement',
      updated_at = v_now
    where id = v_batch_receipt.id;
    update public.pos_inventory_deduction_batches
    set
      status = 'canceled',
      error_message = 'no_inventory_movement',
      updated_at = v_now
    where id = v_batch.id;

    v_result := jsonb_build_object(
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
    update public.pos_inventory_deduction_receipts
    set reprocess_result = v_result where id = v_batch_receipt.id;
    return v_result;
  end if;

  if v_active_count = 0 and v_has_processing_history is not true then
    update public.pos_inventory_deduction_receipts
    set
      status = 'failed', selected_for_apply = false,
      error_message = 'initial_apply_required_or_not_reprocess',
      updated_at = v_now
    where id = v_batch_receipt.id;
    update public.pos_inventory_deduction_batches
    set
      status = 'failed',
      error_message = 'initial_apply_required_or_not_reprocess',
      updated_at = v_now
    where id = v_batch.id;

    v_result := jsonb_build_object(
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
    update public.pos_inventory_deduction_receipts
    set reprocess_result = v_result where id = v_batch_receipt.id;
    return v_result;
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
    set status = 'failed', selected_for_apply = false, error_message = 'candidate_changed', updated_at = v_now
    where id = v_batch_receipt.id;
    update public.pos_inventory_deduction_batches
    set status = 'failed', error_message = 'candidate_changed', updated_at = v_now
    where id = v_batch.id;

    v_result := jsonb_build_object(
      'result', 'stale_preview',
      'receiptId', v_receipt.id,
      'batchId', v_batch.id,
      'deductionReceiptId', v_batch_receipt.id,
      'fingerprint', v_batch_receipt.receipt_content_fingerprint,
      'failureReason', 'candidate_changed'
    );
    update public.pos_inventory_deduction_receipts
    set reprocess_result = v_result where id = v_batch_receipt.id;
    return v_result;
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
      status = 'failed', selected_for_apply = false,
      error_message = 'candidate_metadata_missing',
      updated_at = v_now
    where id = v_batch_receipt.id;
    update public.pos_inventory_deduction_batches
    set
      status = 'failed',
      error_message = 'candidate_metadata_missing',
      updated_at = v_now
    where id = v_batch.id;

    v_result := jsonb_build_object(
      'result', 'needs_check',
      'receiptId', v_receipt.id,
      'batchId', v_batch.id,
      'deductionReceiptId', v_batch_receipt.id,
      'fingerprint', v_batch_receipt.receipt_content_fingerprint,
      'failureReason', 'candidate_metadata_missing'
    );
    update public.pos_inventory_deduction_receipts
    set reprocess_result = v_result where id = v_batch_receipt.id;
    return v_result;
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
    set status = 'failed', selected_for_apply = false, error_message = 'mapping_changed', updated_at = v_now
    where id = v_batch_receipt.id;
    update public.pos_inventory_deduction_batches
    set status = 'failed', error_message = 'mapping_changed', updated_at = v_now
    where id = v_batch.id;

    v_result := jsonb_build_object(
      'result', 'stale_preview',
      'receiptId', v_receipt.id,
      'batchId', v_batch.id,
      'deductionReceiptId', v_batch_receipt.id,
      'fingerprint', v_batch_receipt.receipt_content_fingerprint,
      'failureReason', 'mapping_changed'
    );
    update public.pos_inventory_deduction_receipts
    set reprocess_result = v_result where id = v_batch_receipt.id;
    return v_result;
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
    set status = 'failed', selected_for_apply = false, error_message = 'recipe_changed', updated_at = v_now
    where id = v_batch_receipt.id;
    update public.pos_inventory_deduction_batches
    set status = 'failed', error_message = 'recipe_changed', updated_at = v_now
    where id = v_batch.id;

    v_result := jsonb_build_object(
      'result', 'stale_preview',
      'receiptId', v_receipt.id,
      'batchId', v_batch.id,
      'deductionReceiptId', v_batch_receipt.id,
      'fingerprint', v_batch_receipt.receipt_content_fingerprint,
      'failureReason', 'recipe_changed'
    );
    update public.pos_inventory_deduction_receipts
    set reprocess_result = v_result where id = v_batch_receipt.id;
    return v_result;
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
      status = 'failed', selected_for_apply = false,
      error_message = 'inventory_item_missing',
      updated_at = v_now
    where id = v_batch_receipt.id;
    update public.pos_inventory_deduction_batches
    set
      status = 'failed',
      error_message = 'inventory_item_missing',
      updated_at = v_now
    where id = v_batch.id;

    v_result := jsonb_build_object(
      'result', 'failed',
      'receiptId', v_receipt.id,
      'batchId', v_batch.id,
      'deductionReceiptId', v_batch_receipt.id,
      'fingerprint', v_batch_receipt.receipt_content_fingerprint,
      'failureReason', 'inventory_item_missing'
    );
    update public.pos_inventory_deduction_receipts
    set reprocess_result = v_result where id = v_batch_receipt.id;
    return v_result;
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
      status = 'failed', selected_for_apply = false,
      error_message = 'insufficient_stock_after_reversal',
      updated_at = v_now
    where id = v_batch_receipt.id;
    update public.pos_inventory_deduction_batches
    set
      status = 'failed',
      error_message = 'insufficient_stock_after_reversal',
      updated_at = v_now
    where id = v_batch.id;

    v_result := jsonb_build_object(
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
    update public.pos_inventory_deduction_receipts
    set reprocess_result = v_result where id = v_batch_receipt.id;
    return v_result;
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

  update public.pos_inventory_deduction_receipts
  set reprocess_result = v_result where id = v_batch_receipt.id;
  return v_result;

exception when sqlstate 'P0S01' then -- POS_STOCK_CHECK_P0_GUARD
  update public.pos_sales_receipts set
    inventory_deduction_processing_error = 'stock_check_boundary_requires_review',
    inventory_deduction_pending_status = 'needs_check',
    inventory_deduction_auto_eligible_at = null,
    inventory_deduction_last_checked_at = clock_timestamp()
  where id = v_receipt.id;
  update public.pos_inventory_deduction_receipts set status = 'failed', selected_for_apply = false,
    error_message = 'stock_check_boundary_requires_review',
    review_reason = 'stock_check_boundary_requires_review',
    review_required_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = p_batch_receipt_id;
  update public.pos_inventory_deduction_batches set status = 'failed',
    error_message = 'stock_check_boundary_requires_review', updated_at = clock_timestamp()
  where id = v_batch.id;
  v_result := jsonb_build_object('result', 'needs_check', 'receiptId', v_receipt.id,
    'batchId', v_batch.id, 'deductionReceiptId', p_batch_receipt_id,
    'appliedDeductionCount', 0, 'reversedDeductionCount', 0,
    'requiresReview', true, 'failureReason', 'stock_check_boundary_requires_review');
  update public.pos_inventory_deduction_receipts
  set reprocess_result = v_result where id = p_batch_receipt_id;
  return v_result;

end;
$function$;


-- CREATE OR REPLACE must retain the operating identity and permissions.
do $identity$
begin
 if exists (select 1 from pos_reprocess_engine_identity old
   join pg_proc p on p.oid=old.oid
   where p.proowner<>old.proowner or p.proacl::text is distinct from old.acl
     or p.prosecdef<>old.prosecdef or p.proconfig::text is distinct from old.config)
 or not exists (select 1 from pos_reprocess_engine_identity old join pg_proc p on p.oid=old.oid) then
   raise exception 'POS_REPROCESS_P1_ENGINE_IDENTITY_CHANGED';
 end if;
end $identity$;

-- One atomic candidate-save + apply operation. Receipt locking serializes both
-- automatic and manual callers. Existing failed attempts are NEVER reselected.
-- Changed stock/mapping/count/active history permits a new, auditable attempt.
create or replace function public.prepare_and_apply_sales_inventory_reprocess(
  p_receipt_id bigint,
  p_actor_username text,
  p_expected_receipt_updated_at timestamptz,
  p_expected_receipt_content_fingerprint text,
  p_expected_inventory_affecting_hash text,
  p_preview jsonb,
  p_candidates jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set timezone = 'UTC'
as $prepare$
declare
  v_receipt public.pos_sales_receipts%rowtype;
  v_existing public.pos_inventory_deduction_receipts%rowtype;
  v_dependency jsonb;
  v_plan jsonb;
  v_key text;
  v_batch_id bigint;
  v_batch_receipt_id bigint;
  v_supersedes bigint;
  v_result jsonb;
begin
  if not exists (select 1 from public.users where username=nullif(btrim(p_actor_username),'')
      and is_active and role in ('owner','master','manager')) then
    return jsonb_build_object('result','failed','failureReason','permission_denied');
  end if;
  if p_receipt_id is null or p_receipt_id<=0
    or nullif(p_expected_receipt_content_fingerprint,'') is null
    or nullif(p_expected_inventory_affecting_hash,'') is null
    or p_expected_receipt_updated_at is null
    or jsonb_typeof(p_preview) is distinct from 'object'
    or jsonb_typeof(p_candidates) is distinct from 'array' then
    return jsonb_build_object('result','failed','failureReason','invalid_reprocess_plan');
  end if;

  -- No existing batch/candidate is subsequently locked on the cached path.
  -- On the new path only this transaction can see the newly inserted rows.
  select * into v_receipt from public.pos_sales_receipts where id=p_receipt_id for update;
  if not found then
    return jsonb_build_object('result','needs_check','failureReason','receipt_not_found');
  end if;
  if v_receipt.updated_at is distinct from p_expected_receipt_updated_at
      or v_receipt.payment_status is distinct from 3 or v_receipt.is_canceled then
    return jsonb_build_object('result','stale_preview','receiptId',p_receipt_id,
      'failureReason','stale_preview','appliedDeductionCount',0,'reversedDeductionCount',0);
  end if;
  if v_receipt.inventory_deduction_processing_error = 'stock_check_boundary_requires_review' then
    return jsonb_build_object('result','needs_check','receiptId',p_receipt_id,
      'requiresReview',true,'failureReason','stock_check_boundary_requires_review',
      'appliedDeductionCount',0,'reversedDeductionCount',0);
  end if;

  -- A successful version is terminal even if stock has changed since applying.
  select * into v_existing from public.pos_inventory_deduction_receipts
  where receipt_id=p_receipt_id and workflow_type='reprocess_modified'
    and receipt_content_fingerprint=p_expected_receipt_content_fingerprint and status='applied'
  order by id desc limit 1;
  if found then
    return jsonb_build_object('result','already_processed','receiptId',p_receipt_id,
      'batchId',v_existing.batch_id,'deductionReceiptId',v_existing.id,
      'fingerprint',p_expected_receipt_content_fingerprint,'failureReason',null,
      'appliedDeductionCount',0,'reversedDeductionCount',0);
  end if;

  -- Ignore display-only quantities when identifying the immutable candidate plan.
  select coalesce(jsonb_agg(c - 'current_quantity_snapshot' - 'after_quantity_snapshot'
    order by (c - 'current_quantity_snapshot' - 'after_quantity_snapshot')::text), '[]'::jsonb) into v_plan
  from jsonb_array_elements(p_candidates) with ordinality t(c,ordinal);

  with active as (
    select d.* from public.pos_inventory_deductions d
    where d.receipt_id=p_receipt_id and coalesce(d.operation_type,'deduction')<>'revert'
      and (d.status in ('applied','success') or d.applied_at is not null or d.inventory_log_id is not null)
      and not exists (select 1 from public.pos_inventory_deductions r
        where r.reversal_of_deduction_id=d.id and r.operation_type='revert'
          and (r.status in ('applied','success','reverted') or r.applied_at is not null or r.inventory_log_id is not null))
  ), item_ids as (
    select (c->>'inventory_item_id')::bigint id from jsonb_array_elements(p_candidates) c
    union select inventory_item_id from active
  )
  select jsonb_build_object(
    'items',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'quantity',i.quantity,
      'updatedAt',i.updated_at,'latestLogId',(select max(l.id) from public.inventory_logs l where l.item_id=x.id)) order by x.id)
      from item_ids x left join public.inventory i on i.id=x.id),'[]'::jsonb),
    'active',coalesce((select jsonb_agg(jsonb_build_object('id',id,'itemId',inventory_item_id,
      'quantity',deduct_quantity_total) order by id) from active),'[]'::jsonb),
    'mappings',coalesce((select jsonb_agg(to_jsonb(m) order by m.id) from public.pos_item_mappings m
      where m.id in (select (c->>'mapping_id')::bigint from jsonb_array_elements(p_candidates) c)),'[]'::jsonb),
    'recipes',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from public.pos_item_mapping_recipes r
      where r.id in (select (c->>'recipe_id')::bigint from jsonb_array_elements(p_candidates) c)),'[]'::jsonb)
  ) into v_dependency;

  v_key := encode(sha256(convert_to(jsonb_build_object('protocol','p1-1',
    'updatedAt',p_expected_receipt_updated_at,'fingerprint',p_expected_receipt_content_fingerprint,
    'inventoryHash',p_expected_inventory_affecting_hash,'plan',v_plan,'dependency',v_dependency)::text,'UTF8')),'hex');
  select * into v_existing from public.pos_inventory_deduction_receipts
  where receipt_id=p_receipt_id and reprocess_request_key=v_key;
  if found then
    if v_existing.reprocess_result is null then
      raise exception 'POS_REPROCESS_P1_INCOMPLETE_ATTEMPT';
    end if;
    return v_existing.reprocess_result;
  end if;

  select id into v_supersedes from public.pos_inventory_deduction_receipts
  where receipt_id=p_receipt_id and status='applied'
  order by applied_at desc nulls last,created_at desc,id desc limit 1;
  insert into public.pos_inventory_deduction_batches(
    flow_version,business_date_from,business_date_to,source,status,receipt_count,
    ready_receipt_count,created_by,note,metadata)
  values('sales_db_v1',v_receipt.business_date,v_receipt.business_date,'reprocess_modified',
    'previewed',1,1,p_actor_username,'reprocess_modified_receipt',
    jsonb_build_object('workflowType','reprocess_modified','receiptId',p_receipt_id,
      'currentFingerprint',p_expected_receipt_content_fingerprint,'requestKey',v_key))
  returning id into v_batch_id;
  insert into public.pos_inventory_deduction_receipts(
    batch_id,receipt_id,receipt_ref_no,business_date,status,inventory_affecting_hash,
    amount_hash,previewed_receipt_updated_at,line_summary,selected_for_apply,
    workflow_type,receipt_content_fingerprint,supersedes_deduction_receipt_id,
    reprocess_request_key,reprocess_dependency_snapshot)
  values(v_batch_id,p_receipt_id,v_receipt.ref_no,v_receipt.business_date,'ready',
    p_expected_inventory_affecting_hash,p_preview->>'amount_hash',p_expected_receipt_updated_at,
    p_preview->'line_summary',true,'reprocess_modified',p_expected_receipt_content_fingerprint,
    v_supersedes,v_key,v_dependency) returning id into v_batch_receipt_id;

  insert into public.pos_inventory_deductions(
    invoice_ref_id,ref_detail_id,pos_item_code,pos_item_name,pos_quantity,mapping_type,
    inventory_item_id,deduct_quantity,status,flow_version,batch_id,batch_receipt_id,
    receipt_id,receipt_line_id,receipt_ref_no,business_date,mapping_id,recipe_id,
    operation_type,mapping_snapshot,inventory_affecting_hash,amount_hash,idempotency_key,
    quantity_sold,deduct_quantity_per_unit,deduct_quantity_total,
    current_quantity_snapshot,after_quantity_snapshot)
  select c.invoice_ref_id,c.ref_detail_id,c.pos_item_code,c.pos_item_name,c.pos_quantity,
    c.mapping_type,c.inventory_item_id,c.deduct_quantity,'selected','sales_db_v1',
    v_batch_id,v_batch_receipt_id,p_receipt_id,c.receipt_line_id,v_receipt.ref_no,
    v_receipt.business_date,c.mapping_id,c.recipe_id,'preview',c.mapping_snapshot,
    p_expected_inventory_affecting_hash,p_preview->>'amount_hash',
    'p1-1:'||p_receipt_id||':'||v_key||':'||t.ordinal,
    c.quantity_sold,c.deduct_quantity_per_unit,c.deduct_quantity_total,
    c.current_quantity_snapshot,c.after_quantity_snapshot
  from jsonb_array_elements(p_candidates) with ordinality t(payload,ordinal)
  cross join lateral jsonb_populate_record(null::public.pos_inventory_deductions,t.payload) c;

  v_result := public.reprocess_modified_sales_inventory_deduction_receipt(
    v_batch_receipt_id,p_actor_username,p_expected_receipt_updated_at,
    p_expected_receipt_content_fingerprint,p_expected_inventory_affecting_hash);
  -- P0's subtransaction rolls back movements, not the wrapper's candidate-save.
  -- Its failed candidate and review metadata are therefore retained normally.
  update public.pos_inventory_deduction_receipts set reprocess_result=v_result
  where id=v_batch_receipt_id;
  return v_result;
end;
$prepare$;

revoke all on function public.prepare_and_apply_sales_inventory_reprocess(
  bigint,text,timestamptz,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.prepare_and_apply_sales_inventory_reprocess(
  bigint,text,timestamptz,text,text,jsonb,jsonb) to service_role;

commit;
