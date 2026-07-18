create or replace function public.bar_delete_active_keeping_v1(
  p_id bigint,
  p_expected_version integer,
  p_actor_user_id bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_old public.bar_keepings%rowtype;
  v_actor_name text;
  v_actor_active boolean;
  v_actor_role text;
begin
  select u.is_active, u.role::text
    into v_actor_active, v_actor_role
  from public.users u
  where u.id = p_actor_user_id;

  if not found
    or v_actor_active is not true
    or coalesce(lower(btrim(v_actor_role)) in ('owner', 'master'), false) is not true
  then
    return jsonb_build_object('status', 'forbidden');
  end if;

  select coalesce(
    nullif(btrim(u.name), ''),
    nullif(btrim(u.full_name), ''),
    nullif(btrim(u.username), ''),
    '#' || u.id::text
  ) into v_actor_name
  from public.users u
  where u.id = p_actor_user_id;

  select * into v_old
  from public.bar_keepings
  where id = p_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_old.version <> p_expected_version then
    return jsonb_build_object('status', 'conflict', 'version', v_old.version);
  end if;
  if v_old.status <> 'active' then
    return jsonb_build_object('status', 'invalid_state');
  end if;

  delete from public.bar_keepings where id = v_old.id;

  insert into public.bar_activity_logs(
    entity_type, entity_id, entity_code_snapshot, action_type,
    before_data, after_data, actor_user_id, actor_name_snapshot, created_at
  ) values (
    'keeping', v_old.id, '#' || v_old.id::text || ' · ' || v_old.liquor_name, 'keeping_deleted',
    jsonb_build_object(
      'zone_code', v_old.zone_code,
      'liquor_source', v_old.liquor_source,
      'inventory_item_id', v_old.inventory_item_id,
      'liquor_name', v_old.liquor_name,
      'status', v_old.status,
      'version', v_old.version
    ),
    jsonb_build_object('deleted', true),
    p_actor_user_id, v_actor_name, clock_timestamp()
  );

  return jsonb_build_object(
    'status', 'ok',
    'id', v_old.id,
    'zone_code', v_old.zone_code,
    'old_image_path', v_old.image_path,
    'old_thumbnail_path', v_old.thumbnail_path
  );
end;
$$;

revoke all on function public.bar_delete_active_keeping_v1(bigint, integer, bigint)
  from public, anon, authenticated;
grant execute on function public.bar_delete_active_keeping_v1(bigint, integer, bigint)
  to service_role;
