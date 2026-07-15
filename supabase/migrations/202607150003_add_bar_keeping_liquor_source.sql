-- Preserve the liquor source and optional BAR inventory link without classifying legacy rows.
-- Apply after 202607150002_create_bar_keeping_management.sql.

alter table public.bar_keepings
  add column liquor_source text,
  add column inventory_item_id bigint;

alter table public.bar_keepings
  add constraint bar_keepings_liquor_source_check
    check (liquor_source is null or liquor_source in ('inventory', 'external')),
  add constraint bar_keepings_liquor_source_item_check
    check (
      (liquor_source is null and inventory_item_id is null)
      or (liquor_source = 'external' and inventory_item_id is null)
      or (liquor_source = 'inventory')
    ),
  add constraint bar_keepings_inventory_item_fkey
    foreign key (inventory_item_id) references public.inventory(id) on delete set null;

create index bar_keepings_inventory_item_idx
  on public.bar_keepings(inventory_item_id)
  where inventory_item_id is not null;

create or replace function public.bar_create_keeping(
  p_customer_name text, p_customer_identifier text, p_liquor_source text, p_inventory_item_id bigint,
  p_liquor_name text, p_note text, p_zone_code text, p_remaining_percent integer,
  p_image_path text, p_thumbnail_path text, p_stored_at date, p_expires_at date, p_actor_user_id bigint
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_zone public.bar_zones%rowtype; v_row public.bar_keepings%rowtype;
  v_now timestamptz := clock_timestamp(); v_actor_name text; v_liquor_name text;
begin
  select coalesce(nullif(u.name, ''), nullif(u.full_name, ''), u.username)
    into v_actor_name from public.users u where u.id = p_actor_user_id and u.is_active = true;
  if not found or v_actor_name is null then return jsonb_build_object('status','invalid_actor'); end if;
  select * into v_zone from public.bar_zones where code = p_zone_code;
  if not found or not v_zone.is_active or not v_zone.selectable_for_keeping then return jsonb_build_object('status','invalid_zone'); end if;

  if p_liquor_source = 'inventory' then
    select coalesce(nullif(btrim(i.item_name), ''), nullif(btrim(i.item_name_vi), ''))
      into v_liquor_name from public.inventory i
      where i.id = p_inventory_item_id and i.part = 'bar' and i.is_active = true;
    if not found or v_liquor_name is null then return jsonb_build_object('status','invalid_inventory_item'); end if;
  elsif p_liquor_source = 'external' and p_inventory_item_id is null then
    v_liquor_name := nullif(btrim(p_liquor_name), '');
    if v_liquor_name is null then return jsonb_build_object('status','invalid_input'); end if;
  else return jsonb_build_object('status','invalid_input'); end if;

  insert into public.bar_keepings(customer_name,customer_identifier,liquor_name,liquor_source,inventory_item_id,note,zone_code,remaining_percent,
    image_path,thumbnail_path,image_updated_at,stored_at,expires_at,created_by_user_id,updated_by_user_id,created_at,updated_at)
  values (btrim(p_customer_name),nullif(btrim(p_customer_identifier),''),v_liquor_name,p_liquor_source,p_inventory_item_id,
    nullif(btrim(p_note),''),p_zone_code,p_remaining_percent,p_image_path,p_thumbnail_path,v_now,p_stored_at,p_expires_at,
    p_actor_user_id,p_actor_user_id,v_now,v_now) returning * into v_row;

  insert into public.bar_activity_logs(entity_type,entity_id,entity_code_snapshot,action_type,before_data,after_data,actor_user_id,actor_name_snapshot,created_at)
  values ('keeping',v_row.id,left(v_row.customer_name || ' · ' || v_row.liquor_name,240),'keeping_created',null,
    jsonb_build_object('customer_name',v_row.customer_name,'liquor_name',v_row.liquor_name,'liquor_source',v_row.liquor_source,
      'inventory_item_id',v_row.inventory_item_id,'zone_code',v_row.zone_code,'remaining_percent',v_row.remaining_percent),
    p_actor_user_id,v_actor_name,v_now);
  return jsonb_build_object('status','ok','id',v_row.id,'version',v_row.version);
exception when check_violation or invalid_text_representation then
  return jsonb_build_object('status','invalid_input');
end $$;

-- The v2 wrapper keeps the audited/locked mutation implementation from 202607150002,
-- and enriches only general-information updates in the same transaction.
create or replace function public.bar_mutate_keeping_v2(
  p_id bigint, p_expected_version integer, p_action text, p_payload jsonb, p_actor_user_id bigint
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_result jsonb; v_payload jsonb := p_payload; v_name text; v_source text; v_item_id bigint; v_log_id bigint;
begin
  if p_action = 'update' then
    v_source := p_payload->>'liquor_source';
    if v_source = 'inventory' then
      v_item_id := nullif(p_payload->>'inventory_item_id','')::bigint;
      select coalesce(nullif(btrim(i.item_name), ''), nullif(btrim(i.item_name_vi), '')) into v_name
        from public.inventory i where i.id = v_item_id and i.part = 'bar' and i.is_active = true;
      if not found or v_name is null then return jsonb_build_object('status','invalid_inventory_item'); end if;
    elsif v_source = 'external' then
      v_item_id := null; v_name := nullif(btrim(p_payload->>'liquor_name'),'');
      if v_name is null then return jsonb_build_object('status','invalid_input'); end if;
    else return jsonb_build_object('status','invalid_input'); end if;
    v_payload := v_payload || jsonb_build_object('liquor_name',v_name);
  end if;

  v_result := public.bar_mutate_keeping(p_id,p_expected_version,p_action,v_payload,p_actor_user_id);
  if v_result->>'status' <> 'ok' or p_action <> 'update' then return v_result; end if;

  update public.bar_keepings set liquor_source=v_source,inventory_item_id=v_item_id where id=p_id;
  select l.id into v_log_id from public.bar_activity_logs l
    where l.entity_type='keeping' and l.entity_id=p_id and l.action_type='keeping_updated' and l.actor_user_id=p_actor_user_id
    order by l.created_at desc,l.id desc limit 1;
  if v_log_id is not null then
    update public.bar_activity_logs set after_data=after_data || jsonb_build_object(
      'liquor_source',v_source,'inventory_item_id',v_item_id,'liquor_name',v_name) where id=v_log_id;
  end if;
  return v_result;
exception when check_violation or invalid_text_representation then
  return jsonb_build_object('status','invalid_input');
end $$;

revoke all on function public.bar_create_keeping(text,text,text,bigint,text,text,text,integer,text,text,date,date,bigint) from public,anon,authenticated;
revoke all on function public.bar_mutate_keeping_v2(bigint,integer,text,jsonb,bigint) from public,anon,authenticated;
revoke execute on function public.bar_create_keeping(text,text,text,text,text,integer,text,text,date,date,bigint) from service_role;
grant execute on function public.bar_create_keeping(text,text,text,bigint,text,text,text,integer,text,text,date,date,bigint) to service_role;
grant execute on function public.bar_mutate_keeping_v2(bigint,integer,text,jsonb,bigint) to service_role;
