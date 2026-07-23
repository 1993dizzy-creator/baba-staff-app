create or replace function public.calculate_inventory_keg_sales(
  p_item_id bigint,
  p_started_at timestamp with time zone,
  p_ended_at timestamp with time zone
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $function$
  with matched_lines as (
    select
      line.id as line_id,
      coalesce(line.quantity, 0)::numeric as units,
      mapping.quantity_per_pos_unit::numeric as ml_per_unit,
      case
        when nullif(btrim(coalesce(product.unit_name, '')), '') is not null then
          case
            when lower(product.unit_name) like any (
              array['%tháp%', '%thap%', '%tower%', '%타워%']
            ) then 'tower'
            else 'regular'
          end
        when nullif(btrim(coalesce(product.item_name, '')), '') is not null then
          case
            when lower(product.item_name) like any (
              array['%tháp%', '%thap%', '%tower%', '%타워%']
            ) then 'tower'
            else 'regular'
          end
        else 'other'
      end as category,
      row_number() over (
        partition by line.id
        order by mapping.id, product.id
      ) as match_rank
    from public.inventory_keg_tracking_mappings mapping
    join public.pos_products product
      on product.id = mapping.pos_product_id
    join public.pos_sales_receipt_lines line
      on (
        (product.pos_item_id is not null and line.item_id = product.pos_item_id)
        or (product.item_id is not null and line.item_id = product.item_id)
        or (product.item_code is not null and line.item_code = product.item_code)
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
        line.ref_date::timestamp with time zone,
        receipt.ref_date::timestamp with time zone,
        line.synced_at::timestamp with time zone,
        receipt.synced_at::timestamp with time zone,
        line.updated_at::timestamp with time zone,
        receipt.updated_at::timestamp with time zone
      ) >= p_started_at
      and coalesce(
        line.ref_date::timestamp with time zone,
        receipt.ref_date::timestamp with time zone,
        line.synced_at::timestamp with time zone,
        receipt.synced_at::timestamp with time zone,
        line.updated_at::timestamp with time zone,
        receipt.updated_at::timestamp with time zone
      ) < p_ended_at
  ),
  totals as (
    select
      coalesce(sum(units * ml_per_unit), 0) as sold_ml,
      coalesce(sum(units) filter (where category = 'regular'), 0) as regular_units,
      coalesce(sum(units * ml_per_unit) filter (where category = 'regular'), 0) as regular_sold_ml,
      coalesce(sum(units) filter (where category = 'tower'), 0) as tower_units,
      coalesce(sum(units * ml_per_unit) filter (where category = 'tower'), 0) as tower_sold_ml,
      coalesce(sum(units) filter (where category = 'other'), 0) as other_units,
      coalesce(sum(units * ml_per_unit) filter (where category = 'other'), 0) as other_sold_ml
    from matched_lines
    where match_rank = 1
  )
  select jsonb_build_object(
    'soldMl', round(sold_ml, 3),
    'expectedTotalMl', round(sold_ml, 3),
    'regularUnits', round(regular_units, 3),
    'regularSoldMl', round(regular_sold_ml, 3),
    'regularAverageMl', case when regular_units > 0 then round(regular_sold_ml / regular_units) else null end,
    'towerUnits', round(tower_units, 3),
    'towerSoldMl', round(tower_sold_ml, 3),
    'towerAverageMl', case when tower_units > 0 then round(tower_sold_ml / tower_units) else null end,
    'otherUnits', round(other_units, 3),
    'otherSoldMl', round(other_sold_ml, 3),
    'otherAverageMl', case when other_units > 0 then round(other_sold_ml / other_units) else null end
  )
  from totals;
$function$;

create or replace function public.replace_inventory_keg(
  p_item_id bigint,
  p_actor_username text,
  p_business_date date,
  p_expected_quantity numeric default null,
  p_replacement_at timestamp with time zone default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_actor record;
  v_item record;
  v_active_session record;
  v_current_quantity numeric;
  v_new_quantity numeric;
  v_capacity numeric;
  v_sales jsonb := '{}'::jsonb;
  v_sold_ml numeric := 0;
  v_loss_ml numeric := null;
  v_loss_rate numeric := null;
  v_usage_rate numeric := null;
  v_summary_note text;
  v_visible_note text := 'Keg 교체';
  v_log_id bigint;
  v_new_session_id bigint;
  v_replacement_at timestamp with time zone := coalesce(p_replacement_at, now());
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
    id, item_name, item_name_vi, part, category, category_vi, quantity,
    purchase_price, note, unit, code, supplier, low_stock_threshold,
    package_content_quantity, package_content_unit
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
  if p_expected_quantity is not null
    and v_current_quantity <> round(p_expected_quantity, 6)
  then
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
  if v_active_session.id is not null
    and v_replacement_at < v_active_session.started_at
  then
    raise exception 'Keg replacement time cannot be earlier than the active session start time' using errcode = 'P0001';
  end if;

  if v_active_session.id is not null then
    v_sales := public.calculate_inventory_keg_sales(
      p_item_id,
      v_active_session.started_at,
      v_replacement_at
    );
    v_sold_ml := round(coalesce((v_sales ->> 'soldMl')::numeric, 0), 3);
    v_loss_ml := greatest(v_capacity - v_sold_ml, 0);
    v_loss_rate := case when v_capacity > 0 then round(v_loss_ml / v_capacity, 6) else null end;
    v_usage_rate := case when v_capacity > 0 then round(v_sold_ml / v_capacity, 6) else null end;
    v_summary_note := format(
      'Keg 교체. 이전 Keg 판매기준 사용량 %sL / %sL (%s%%), 예상 미판매 로스 %sL (%s%%).',
      trim(to_char(v_sold_ml / 1000, 'FM999999990.999')),
      trim(to_char(v_capacity / 1000, 'FM999999990.999')),
      trim(to_char(coalesce(v_usage_rate, 0) * 100, 'FM999999990.9')),
      trim(to_char(v_loss_ml / 1000, 'FM999999990.999')),
      trim(to_char(coalesce(v_loss_rate, 0) * 100, 'FM999999990.9'))
    );
  else
    v_summary_note := 'Keg 교체.';
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
    item_id, item_name, item_name_vi, action, part, category, category_vi,
    prev_quantity, new_quantity, change_quantity,
    prev_purchase_price, new_purchase_price, prev_note, new_note,
    prev_supplier, new_supplier, prev_code, new_code, prev_unit, new_unit,
    prev_category, new_category, prev_category_vi, new_category_vi,
    prev_part, new_part, unit, code, actor_name, actor_username,
    prev_low_stock_threshold, new_low_stock_threshold, reason, source,
    business_date
  )
  values (
    v_item.id, v_item.item_name, v_item.item_name_vi, 'update', v_item.part,
    v_item.category, v_item.category_vi, v_current_quantity, v_new_quantity, -1,
    v_item.purchase_price, v_item.purchase_price, v_item.note, v_visible_note,
    v_item.supplier, v_item.supplier, v_item.code, v_item.code,
    v_item.unit, v_item.unit, v_item.category, v_item.category,
    v_item.category_vi, v_item.category_vi, v_item.part, v_item.part,
    v_item.unit, v_item.code, coalesce(v_actor.name, ''),
    coalesce(v_actor.username, ''), coalesce(v_item.low_stock_threshold, 1),
    coalesce(v_item.low_stock_threshold, 1), 'sale_deduction', 'keg_replace',
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
    inventory_item_id, status, started_at, started_business_date,
    started_log_id, capacity_quantity, capacity_unit, created_by,
    created_at, updated_at
  )
  values (
    p_item_id, 'active', v_replacement_at, p_business_date, v_log_id,
    v_capacity, 'ml', v_actor.username, now(), now()
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
        'summaryNote', v_summary_note,
        'salesBreakdown', v_sales
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
$function$;

create or replace function public.replace_inventory_keg(
  p_item_id bigint,
  p_actor_username text,
  p_business_date date,
  p_expected_quantity numeric default null
)
returns jsonb
language sql
security definer
set search_path = public
as $function$
  select public.replace_inventory_keg(
    p_item_id,
    p_actor_username,
    p_business_date,
    p_expected_quantity,
    null::timestamp with time zone
  );
$function$;

revoke execute on function public.calculate_inventory_keg_sales(
  bigint,
  timestamp with time zone,
  timestamp with time zone
) from public, anon, authenticated;
grant execute on function public.calculate_inventory_keg_sales(
  bigint,
  timestamp with time zone,
  timestamp with time zone
) to service_role, postgres;

revoke execute on function public.replace_inventory_keg(
  bigint, text, date, numeric
) from public, anon, authenticated;
grant execute on function public.replace_inventory_keg(
  bigint, text, date, numeric
) to service_role, postgres;

revoke execute on function public.replace_inventory_keg(
  bigint, text, date, numeric, timestamp with time zone
) from public, anon, authenticated;
grant execute on function public.replace_inventory_keg(
  bigint, text, date, numeric, timestamp with time zone
) to service_role, postgres;
