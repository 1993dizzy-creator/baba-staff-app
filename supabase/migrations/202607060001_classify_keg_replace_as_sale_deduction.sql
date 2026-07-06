create or replace function public.replace_inventory_keg(
  p_item_id bigint,
  p_actor_username text,
  p_business_date date,
  p_expected_quantity numeric default null,
  p_replacement_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor record;
  v_item record;
  v_active_session record;
  v_current_quantity numeric;
  v_new_quantity numeric;
  v_capacity numeric;
  v_sold_ml numeric := 0;
  v_loss_ml numeric := null;
  v_loss_rate numeric := null;
  v_usage_rate numeric := null;
  v_summary_note text;
  v_visible_note text := '케그 교체';
  v_log_id bigint;
  v_new_session_id bigint;
  v_replacement_at timestamptz := coalesce(p_replacement_at, now());
begin
  if v_replacement_at > now() then
    raise exception 'Keg replacement time cannot be in the future' using errcode = 'P0001';
  end if;

  select id, username, name, role, is_active
    into v_actor
  from public.users
  where username = p_actor_username
    and is_active = true
  limit 1;

  if v_actor.id is null then
    raise exception 'Invalid user' using errcode = 'P0001';
  end if;

  select
    id,
    item_name,
    item_name_vi,
    part,
    category,
    category_vi,
    quantity,
    purchase_price,
    note,
    unit,
    code,
    supplier,
    low_stock_threshold,
    package_content_quantity,
    package_content_unit
    into v_item
  from public.inventory
  where id = p_item_id
  for update;

  if v_item.id is null then
    raise exception 'Inventory item not found' using errcode = 'P0001';
  end if;

  if lower(coalesce(v_item.unit, '')) <> 'keg' then
    raise exception 'Inventory item unit must be Keg' using errcode = 'P0001';
  end if;

  v_capacity := coalesce(v_item.package_content_quantity, 0);
  if v_capacity <= 0 or lower(coalesce(v_item.package_content_unit, '')) <> 'ml' then
    raise exception 'Keg capacity must be configured in ml' using errcode = 'P0001';
  end if;

  if not exists (
    select 1
    from public.inventory_keg_tracking_mappings mapping
    where mapping.inventory_item_id = p_item_id
      and mapping.is_active = true
      and mapping.target_type = 'product'
  ) then
    raise exception 'Active keg tracking mapping not found' using errcode = 'P0001';
  end if;

  v_current_quantity := round(coalesce(v_item.quantity, 0)::numeric, 6);
  if p_expected_quantity is not null and v_current_quantity <> round(p_expected_quantity, 6) then
    return jsonb_build_object(
      'ok', false,
      'code', 'QUANTITY_CONFLICT',
      'currentQuantity', v_current_quantity
    );
  end if;

  if v_current_quantity < 1 then
    raise exception 'Keg quantity cannot be lower than 1 before replacement' using errcode = 'P0001';
  end if;

  select *
    into v_active_session
  from public.inventory_keg_sessions
  where inventory_item_id = p_item_id
    and status = 'active'
  order by started_at desc
  limit 1
  for update;

  if v_active_session.id is not null and v_replacement_at < v_active_session.started_at then
    raise exception 'Keg replacement time cannot be earlier than the active session start time' using errcode = 'P0001';
  end if;

  if v_active_session.id is not null then
    select coalesce(sum(coalesce(line.quantity, 0)::numeric * mapping.quantity_per_pos_unit), 0)
      into v_sold_ml
    from public.inventory_keg_tracking_mappings mapping
    join public.pos_products product
      on product.id = mapping.pos_product_id
    join public.pos_sales_receipt_lines line
      on (
        line.item_id = product.pos_item_id
        or line.item_id = product.item_id
        or line.item_code = product.item_code
      )
    join public.pos_sales_receipts receipt
      on receipt.id = line.receipt_id
    where mapping.inventory_item_id = p_item_id
      and mapping.is_active = true
      and mapping.target_type = 'product'
      and coalesce(line.is_option, false) = false
      and coalesce(line.is_excluded, false) = false
      and coalesce(line.is_canceled, false) = false
      and coalesce(receipt.is_canceled, false) = false
      and line.payment_status = 3
      and receipt.payment_status = 3
      and coalesce(
        line.ref_date::timestamptz,
        receipt.ref_date::timestamptz,
        line.synced_at::timestamptz,
        receipt.synced_at::timestamptz,
        line.updated_at::timestamptz,
        receipt.updated_at::timestamptz
      ) >= v_active_session.started_at
      and coalesce(
        line.ref_date::timestamptz,
        receipt.ref_date::timestamptz,
        line.synced_at::timestamptz,
        receipt.synced_at::timestamptz,
        line.updated_at::timestamptz,
        receipt.updated_at::timestamptz
      ) < v_replacement_at;

    v_sold_ml := round(coalesce(v_sold_ml, 0), 3);
    v_loss_ml := greatest(v_capacity - v_sold_ml, 0);
    v_loss_rate := case when v_capacity > 0 then round(v_loss_ml / v_capacity, 6) else null end;
    v_usage_rate := case when v_capacity > 0 then round(v_sold_ml / v_capacity, 6) else null end;

    v_summary_note := format(
      '케그 교체. 이전 케그 판매기준 사용량 %sL / %sL (%s%%), 예상 미판매/로스 %sL (%s%%).',
      trim(to_char(v_sold_ml / 1000, 'FM999999990.999')),
      trim(to_char(v_capacity / 1000, 'FM999999990.999')),
      trim(to_char(coalesce(v_usage_rate, 0) * 100, 'FM999999990.9')),
      trim(to_char(v_loss_ml / 1000, 'FM999999990.999')),
      trim(to_char(coalesce(v_loss_rate, 0) * 100, 'FM999999990.9'))
    );
  else
    v_summary_note := '케그 교체.';
  end if;

  v_new_quantity := round(v_current_quantity - 1, 6);

  update public.inventory
  set
    quantity = v_new_quantity,
    note = v_visible_note,
    updated_at = now(),
    updated_by_name = coalesce(v_actor.name, v_actor.username),
    updated_by_username = v_actor.username
  where id = p_item_id;

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
    prev_purchase_price,
    new_purchase_price,
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
    prev_low_stock_threshold,
    new_low_stock_threshold,
    reason,
    source,
    business_date
  )
  values (
    v_item.id,
    v_item.item_name,
    v_item.item_name_vi,
    'update',
    v_item.part,
    v_item.category,
    v_item.category_vi,
    v_current_quantity,
    v_new_quantity,
    -1,
    v_item.purchase_price,
    v_item.purchase_price,
    v_item.note,
    v_visible_note,
    v_item.supplier,
    v_item.supplier,
    v_item.code,
    v_item.code,
    v_item.unit,
    v_item.unit,
    v_item.category,
    v_item.category,
    v_item.category_vi,
    v_item.category_vi,
    v_item.part,
    v_item.part,
    v_item.unit,
    v_item.code,
    coalesce(v_actor.name, ''),
    coalesce(v_actor.username, ''),
    coalesce(v_item.low_stock_threshold, 1),
    coalesce(v_item.low_stock_threshold, 1),
    'sale_deduction',
    'keg_replace',
    p_business_date
  )
  returning id into v_log_id;

  if v_active_session.id is not null then
    update public.inventory_keg_sessions
    set
      status = 'closed',
      ended_at = v_replacement_at,
      ended_business_date = p_business_date,
      ended_log_id = v_log_id,
      sold_quantity = v_sold_ml,
      sold_unit = 'ml',
      loss_quantity = v_loss_ml,
      loss_rate = v_loss_rate,
      summary_note = v_summary_note,
      closed_by = v_actor.username,
      updated_at = now()
    where id = v_active_session.id;
  end if;

  insert into public.inventory_keg_sessions (
    inventory_item_id,
    status,
    started_at,
    started_business_date,
    started_log_id,
    capacity_quantity,
    capacity_unit,
    created_by,
    created_at,
    updated_at
  )
  values (
    p_item_id,
    'active',
    v_replacement_at,
    p_business_date,
    v_log_id,
    v_capacity,
    'ml',
    v_actor.username,
    now(),
    now()
  )
  returning id into v_new_session_id;

  return jsonb_build_object(
    'ok', true,
    'itemId', p_item_id,
    'quantity', v_new_quantity,
    'logId', v_log_id,
    'closedSession', case
      when v_active_session.id is null then null
      else jsonb_build_object(
        'id', v_active_session.id,
        'soldQuantity', v_sold_ml,
        'soldUnit', 'ml',
        'lossQuantity', v_loss_ml,
        'lossRate', v_loss_rate,
        'summaryNote', v_summary_note
      )
    end,
    'newSession', jsonb_build_object(
      'id', v_new_session_id,
      'capacityQuantity', v_capacity,
      'capacityUnit', 'ml',
      'startedAt', v_replacement_at,
      'startedBusinessDate', p_business_date
    )
  );
end;
$$;

-- Backfill check before manual update:
-- select
--   id,
--   item_id,
--   item_name,
--   reason,
--   source,
--   change_quantity,
--   new_note,
--   business_date,
--   created_at
-- from public.inventory_logs
-- where source = 'keg_replace'
-- order by created_at desc;

-- Manual backfill query. Review the SELECT result first, then run this UPDATE manually if expected:
-- update public.inventory_logs
-- set reason = 'sale_deduction'
-- where source = 'keg_replace'
--   and reason = 'other'
--   and change_quantity = -1
--   and new_note = '케그 교체';
