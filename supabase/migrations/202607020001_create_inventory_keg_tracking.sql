create table if not exists public.inventory_keg_sessions (
  id bigserial primary key,
  inventory_item_id bigint not null references public.inventory(id) on delete restrict,
  status text not null default 'active',
  started_at timestamptz not null default now(),
  started_business_date date not null,
  started_log_id bigint null references public.inventory_logs(id) on delete set null,
  ended_at timestamptz null,
  ended_business_date date null,
  ended_log_id bigint null references public.inventory_logs(id) on delete set null,
  capacity_quantity numeric not null,
  capacity_unit text not null default 'ml',
  sold_quantity numeric null,
  sold_unit text null,
  loss_quantity numeric null,
  loss_rate numeric null,
  summary_note text null,
  created_by text null,
  closed_by text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_keg_sessions_status_check
    check (status in ('active', 'closed')),
  constraint inventory_keg_sessions_capacity_check
    check (capacity_quantity > 0 and capacity_unit = 'ml'),
  constraint inventory_keg_sessions_sold_check
    check (sold_quantity is null or sold_quantity >= 0),
  constraint inventory_keg_sessions_loss_check
    check (loss_quantity is null or loss_quantity >= 0),
  constraint inventory_keg_sessions_loss_rate_check
    check (loss_rate is null or (loss_rate >= 0 and loss_rate <= 1)),
  constraint inventory_keg_sessions_closed_check
    check (
      (status = 'active' and ended_at is null and ended_business_date is null)
      or
      (status = 'closed' and ended_at is not null and ended_business_date is not null)
    )
);

create unique index if not exists inventory_keg_sessions_one_active_uidx
  on public.inventory_keg_sessions (inventory_item_id)
  where status = 'active';

create index if not exists inventory_keg_sessions_item_started_idx
  on public.inventory_keg_sessions (inventory_item_id, started_at desc);

create table if not exists public.inventory_keg_tracking_mappings (
  id bigserial primary key,
  inventory_item_id bigint not null references public.inventory(id) on delete restrict,
  target_type text not null,
  pos_product_id bigint not null references public.pos_products(id) on delete restrict,
  pos_option_id text null,
  quantity_per_pos_unit numeric not null,
  unit text not null default 'ml',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text null,
  constraint inventory_keg_tracking_mappings_target_type_check
    check (target_type in ('product', 'option')),
  constraint inventory_keg_tracking_mappings_quantity_check
    check (quantity_per_pos_unit > 0 and unit = 'ml'),
  constraint inventory_keg_tracking_mappings_target_check
    check (
      (target_type = 'product' and pos_option_id is null)
      or
      (target_type = 'option' and pos_option_id is not null)
    )
);

create unique index if not exists inventory_keg_tracking_product_active_uidx
  on public.inventory_keg_tracking_mappings (pos_product_id)
  where target_type = 'product' and is_active = true;

create unique index if not exists inventory_keg_tracking_option_active_uidx
  on public.inventory_keg_tracking_mappings (pos_product_id, pos_option_id)
  where target_type = 'option' and is_active = true;

create index if not exists inventory_keg_tracking_item_active_idx
  on public.inventory_keg_tracking_mappings (inventory_item_id, is_active);

create or replace function public.replace_inventory_keg(
  p_item_id bigint,
  p_actor_username text,
  p_business_date date,
  p_expected_quantity numeric default null
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
  v_log_id bigint;
  v_new_session_id bigint;
begin
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
      ) >= v_active_session.started_at;

    v_sold_ml := round(coalesce(v_sold_ml, 0), 3);
    v_loss_ml := greatest(v_capacity - v_sold_ml, 0);
    v_loss_rate := case when v_capacity > 0 then round(v_loss_ml / v_capacity, 6) else null end;
    v_usage_rate := case when v_capacity > 0 then round(v_sold_ml / v_capacity, 6) else null end;

    v_summary_note := format(
      '[KEG] 케그 교체. 이전 케그 판매기준 사용량 %sL / %sL (%s%%), 예상 미판매/로스 %sL (%s%%). 새 케그 시작.',
      trim(to_char(v_sold_ml / 1000, 'FM999999990.999')),
      trim(to_char(v_capacity / 1000, 'FM999999990.999')),
      trim(to_char(coalesce(v_usage_rate, 0) * 100, 'FM999999990.9')),
      trim(to_char(v_loss_ml / 1000, 'FM999999990.999')),
      trim(to_char(coalesce(v_loss_rate, 0) * 100, 'FM999999990.9'))
    );
  else
    v_summary_note := '[KEG] 케그 교체. 이전 active session 없음. 새 케그 시작.';
  end if;

  v_new_quantity := round(v_current_quantity - 1, 6);

  update public.inventory
  set
    quantity = v_new_quantity,
    note = v_summary_note,
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
    v_summary_note,
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
    'other',
    'keg_replace',
    p_business_date
  )
  returning id into v_log_id;

  if v_active_session.id is not null then
    update public.inventory_keg_sessions
    set
      status = 'closed',
      ended_at = now(),
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
    now(),
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
      'startedBusinessDate', p_business_date
    )
  );
end;
$$;
