alter table public.pos_inventory_deduction_batches
  add column if not exists applied_receipt_count integer not null default 0;

alter table public.pos_inventory_deduction_receipts
  drop constraint if exists pos_inventory_deduction_receipts_selection_check;

alter table public.pos_inventory_deduction_receipts
  add constraint pos_inventory_deduction_receipts_selection_check
  check (
    selected_for_apply = false
    or status in ('ready', 'applied')
  );

create or replace function public.apply_sales_inventory_deduction_batch(
  p_batch_id bigint,
  p_actor_username text,
  p_validation_receipts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_actor_name text;
  v_batch_status text;
  v_selected_count integer;
  v_candidate_count integer;
  v_applied_receipt_count integer;
  v_batch_result_status text;
  v_now timestamptz := now();
  v_candidate record;
  v_previous_quantity numeric;
  v_new_quantity numeric;
  v_inventory_log_id bigint;
  v_inventory_totals jsonb;
  v_receipts jsonb;
begin
  if p_batch_id is null or p_batch_id <= 0 then
    raise exception using
      errcode = '22023',
      message = 'Invalid batch id.';
  end if;

  select coalesce(nullif(name, ''), username)
    into v_actor_name
  from public.users
  where username = nullif(btrim(p_actor_username), '')
    and is_active = true
    and role in ('owner', 'master')
  limit 1;

  if v_actor_name is null then
    raise exception using
      errcode = '42501',
      message = 'Only owner or master can apply an inventory deduction batch.';
  end if;

  select status
    into v_batch_status
  from public.pos_inventory_deduction_batches
  where id = p_batch_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Batch was not found.';
  end if;

  if v_batch_status <> 'previewed' then
    raise exception using
      errcode = 'P0001',
      message = format(
        'Batch cannot be applied from status %s.',
        v_batch_status
      );
  end if;

  drop table if exists pg_temp.sales_apply_selected_receipts;
  create temporary table sales_apply_selected_receipts
  on commit drop
  as
  select
    batch_receipt.id as batch_receipt_id,
    batch_receipt.receipt_id,
    batch_receipt.receipt_ref_no,
    batch_receipt.business_date
  from public.pos_inventory_deduction_receipts batch_receipt
  where batch_receipt.batch_id = p_batch_id
    and batch_receipt.selected_for_apply = true
    and batch_receipt.status = 'ready';

  select count(*)
    into v_selected_count
  from pg_temp.sales_apply_selected_receipts;

  if v_selected_count = 0 then
    raise exception using
      errcode = 'P0001',
      message = 'No ready receipts are selected for apply.';
  end if;

  if exists (
    select 1
    from public.pos_inventory_deduction_receipts batch_receipt
    where batch_receipt.batch_id = p_batch_id
      and batch_receipt.selected_for_apply = true
      and batch_receipt.status <> 'ready'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'A selected receipt is no longer ready.';
  end if;

  perform batch_receipt.id
  from public.pos_inventory_deduction_receipts batch_receipt
  join pg_temp.sales_apply_selected_receipts selected
    on selected.batch_receipt_id = batch_receipt.id
  order by batch_receipt.id
  for update of batch_receipt;

  if exists (
    select 1
    from pg_temp.sales_apply_selected_receipts selected
    join public.pos_inventory_deduction_receipts batch_receipt
      on batch_receipt.id = selected.batch_receipt_id
    where batch_receipt.selected_for_apply is not true
      or batch_receipt.status <> 'ready'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'Receipt selection changed while apply was starting.';
  end if;

  perform receipt.id
  from public.pos_sales_receipts receipt
  join pg_temp.sales_apply_selected_receipts selected
    on selected.receipt_id = receipt.id
  order by receipt.id
  for update of receipt;

  drop table if exists pg_temp.sales_apply_validation_receipts;
  create temporary table sales_apply_validation_receipts (
    receipt_id bigint primary key,
    current_inventory_hash text null,
    current_receipt_updated_at timestamptz null,
    apply_allowed boolean not null
  ) on commit drop;

  insert into pg_temp.sales_apply_validation_receipts (
    receipt_id,
    current_inventory_hash,
    current_receipt_updated_at,
    apply_allowed
  )
  select
    (entry.value ->> 'receiptId')::bigint,
    entry.value ->> 'currentInventoryHash',
    nullif(entry.value ->> 'currentReceiptUpdatedAt', '')::timestamptz,
    coalesce((entry.value ->> 'applyAllowed')::boolean, false)
  from jsonb_array_elements(
    coalesce(p_validation_receipts, '[]'::jsonb)
  ) entry(value);

  if (
    select count(*)
    from pg_temp.sales_apply_validation_receipts
    where apply_allowed = true
  ) <> v_selected_count then
    raise exception using
      errcode = 'P0001',
      message = 'Validation token does not match selected receipts.';
  end if;

  if exists (
    select 1
    from pg_temp.sales_apply_selected_receipts selected
    left join pg_temp.sales_apply_validation_receipts validation
      on validation.receipt_id = selected.receipt_id
    left join public.pos_sales_receipts receipt
      on receipt.id = selected.receipt_id
    where validation.receipt_id is null
      or validation.apply_allowed is not true
      or receipt.id is null
      or receipt.payment_status is distinct from 3
      or receipt.is_canceled is true
      or receipt.updated_at is distinct from validation.current_receipt_updated_at
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'A receipt changed after server validation. Validate again.';
  end if;

  drop table if exists pg_temp.sales_apply_candidates;
  create temporary table sales_apply_candidates
  on commit drop
  as
  select deduction.*
  from public.pos_inventory_deductions deduction
  join pg_temp.sales_apply_selected_receipts selected
    on selected.batch_receipt_id = deduction.batch_receipt_id
  where deduction.batch_id = p_batch_id
    and deduction.flow_version = 'sales_db_v1'
    and deduction.operation_type = 'preview'
    and deduction.status = 'selected';

  select count(*)
    into v_candidate_count
  from pg_temp.sales_apply_candidates;

  if v_candidate_count = 0 then
    raise exception using
      errcode = 'P0001',
      message = 'No deduction candidates are available for apply.';
  end if;

  if exists (
    select 1
    from pg_temp.sales_apply_selected_receipts selected
    where not exists (
      select 1
      from pg_temp.sales_apply_candidates candidate
      where candidate.batch_receipt_id = selected.batch_receipt_id
    )
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'A selected receipt has no deduction candidates.';
  end if;

  perform deduction.id
  from public.pos_inventory_deductions deduction
  join pg_temp.sales_apply_candidates candidate
    on candidate.id = deduction.id
  order by deduction.id
  for update of deduction;

  if exists (
    select 1
    from pg_temp.sales_apply_candidates candidate
    join public.pos_inventory_deductions deduction
      on deduction.id = candidate.id
    where deduction.status <> 'selected'
      or deduction.operation_type <> 'preview'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'A deduction candidate changed while apply was starting.';
  end if;

  if exists (
    select 1
    from pg_temp.sales_apply_candidates candidate
    where candidate.inventory_item_id is null
      or coalesce(candidate.deduct_quantity_total, 0) <= 0
      or candidate.receipt_id is null
      or candidate.receipt_line_id is null
      or candidate.mapping_id is null
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'A deduction candidate is incomplete.';
  end if;

  if exists (
    select 1
    from pg_temp.sales_apply_candidates candidate
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
    raise exception using
      errcode = 'P0001',
      message = 'A mapping changed after preview.';
  end if;

  if exists (
    select 1
    from pg_temp.sales_apply_candidates candidate
    left join public.pos_item_mapping_recipes recipe
      on recipe.id = candidate.recipe_id
    where candidate.recipe_id is not null
      and (
        recipe.id is null
        or recipe.is_active is not true
        or recipe.version is distinct from
          coalesce(
            nullif(
              candidate.mapping_snapshot ->> 'recipeVersion',
              ''
            )::integer,
            0
          )
        or recipe.quantity_per_pos_unit is distinct from
          candidate.deduct_quantity_per_unit
      )
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'A recipe changed after preview.';
  end if;

  if exists (
    select 1
    from pg_temp.sales_apply_candidates candidate
    join public.pos_inventory_deductions applied
      on applied.id <> candidate.id
      and (
        applied.status in ('applied', 'success')
        or applied.applied_at is not null
        or applied.inventory_log_id is not null
      )
      and (
        (
          candidate.idempotency_key is not null
          and applied.idempotency_key = candidate.idempotency_key
        )
        or applied.batch_receipt_id = candidate.batch_receipt_id
        or applied.receipt_id = candidate.receipt_id
        or (
          applied.receipt_id is null
          and applied.invoice_ref_id = candidate.invoice_ref_id
        )
        or (
          applied.receipt_line_id = candidate.receipt_line_id
          and applied.inventory_item_id = candidate.inventory_item_id
          and applied.mapping_id is not distinct from candidate.mapping_id
          and applied.recipe_id is not distinct from candidate.recipe_id
        )
      )
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'An applied deduction already exists for a selected receipt.';
  end if;

  drop table if exists pg_temp.sales_apply_inventory_totals;
  create temporary table sales_apply_inventory_totals
  on commit drop
  as
  select
    candidate.inventory_item_id,
    sum(candidate.deduct_quantity_total)::numeric as deduct_quantity,
    0::numeric as previous_quantity,
    0::numeric as new_quantity,
    min(inventory.item_name) as item_name,
    min(inventory.item_name_vi) as item_name_vi
  from pg_temp.sales_apply_candidates candidate
  left join public.inventory inventory
    on inventory.id = candidate.inventory_item_id
  group by candidate.inventory_item_id;

  perform inventory.id
  from public.inventory inventory
  join pg_temp.sales_apply_inventory_totals total
    on total.inventory_item_id = inventory.id
  order by inventory.id
  for update of inventory;

  if exists (
    select 1
    from pg_temp.sales_apply_inventory_totals total
    left join public.inventory inventory
      on inventory.id = total.inventory_item_id
    where inventory.id is null
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'An inventory item no longer exists.';
  end if;

  update pg_temp.sales_apply_inventory_totals total
  set
    previous_quantity = inventory.quantity,
    new_quantity = inventory.quantity - total.deduct_quantity,
    item_name = inventory.item_name,
    item_name_vi = inventory.item_name_vi
  from public.inventory inventory
  where inventory.id = total.inventory_item_id;

  if exists (
    select 1
    from pg_temp.sales_apply_inventory_totals
    where new_quantity < 0
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'Current inventory is insufficient for the selected receipts.';
  end if;

  for v_candidate in
    select candidate.*
    from pg_temp.sales_apply_candidates candidate
    order by
      candidate.inventory_item_id,
      candidate.receipt_id,
      candidate.receipt_line_id,
      candidate.id
  loop
    select inventory.quantity
      into v_previous_quantity
    from public.inventory inventory
    where inventory.id = v_candidate.inventory_item_id;

    v_new_quantity :=
      v_previous_quantity - v_candidate.deduct_quantity_total;

    update public.inventory
    set
      quantity = v_new_quantity,
      updated_at = v_now
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
      v_actor_name,
      p_actor_username,
      'sale_deduction',
      'pos_sales',
      v_candidate.business_date,
      v_candidate.receipt_id,
      v_candidate.receipt_line_id,
      v_candidate.id,
      p_batch_id
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
  end loop;

  update public.pos_inventory_deduction_receipts batch_receipt
  set
    status = 'applied',
    applied_at = v_now,
    applied_by = p_actor_username,
    error_message = null,
    updated_at = v_now
  from pg_temp.sales_apply_selected_receipts selected
  where batch_receipt.id = selected.batch_receipt_id;

  select count(*)
    into v_applied_receipt_count
  from public.pos_inventory_deduction_receipts
  where batch_id = p_batch_id
    and status = 'applied';

  if exists (
    select 1
    from public.pos_inventory_deduction_receipts
    where batch_id = p_batch_id
      and status <> 'applied'
  ) then
    v_batch_result_status := 'partially_applied';
  else
    v_batch_result_status := 'applied';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'inventoryItemId', total.inventory_item_id,
        'itemName', coalesce(total.item_name_vi, total.item_name),
        'previousQuantity', total.previous_quantity,
        'deductQuantity', total.deduct_quantity,
        'newQuantity', total.new_quantity
      )
      order by total.inventory_item_id
    ),
    '[]'::jsonb
  )
    into v_inventory_totals
  from pg_temp.sales_apply_inventory_totals total;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'receiptId', selected.receipt_id,
        'receiptRefNo', selected.receipt_ref_no,
        'status', 'applied'
      )
      order by selected.receipt_id
    ),
    '[]'::jsonb
  )
    into v_receipts
  from pg_temp.sales_apply_selected_receipts selected;

  update public.pos_inventory_deduction_batches
  set
    status = v_batch_result_status,
    applied_receipt_count = v_applied_receipt_count,
    confirmed_by = p_actor_username,
    confirmed_at = v_now,
    error_message = null,
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'lastApplySummary',
      jsonb_build_object(
        'appliedAt', v_now,
        'appliedBy', p_actor_username,
        'appliedReceiptCount', v_selected_count,
        'appliedDeductionCount', v_candidate_count,
        'inventoryLogCount', v_candidate_count
      )
    ),
    updated_at = v_now
  where id = p_batch_id;

  return jsonb_build_object(
    'ok', true,
    'batchId', p_batch_id,
    'status', v_batch_result_status,
    'summary', jsonb_build_object(
      'appliedReceiptCount', v_selected_count,
      'appliedDeductionCount', v_candidate_count,
      'inventoryLogCount', v_candidate_count
    ),
    'inventoryTotals', v_inventory_totals,
    'receipts', v_receipts
  );
end;
$function$;

revoke all on function public.apply_sales_inventory_deduction_batch(
  bigint,
  text,
  jsonb
) from public;

grant execute on function public.apply_sales_inventory_deduction_batch(
  bigint,
  text,
  jsonb
) to service_role;
