alter table public.bar_zones
  add column image_updated_at timestamptz null;

with latest_photo_log as (
  select distinct on (entity_code_snapshot)
    entity_code_snapshot as code,
    created_at
  from public.bar_activity_logs
  where entity_type = 'zone'
    and action_type in ('zone_photo_added', 'zone_photo_replaced')
    and entity_code_snapshot is not null
  order by entity_code_snapshot, created_at desc, id desc
)
update public.bar_zones as zone
set image_updated_at = log.created_at
from latest_photo_log as log
where zone.code = log.code
  and zone.image_path is not null;

create or replace function public.bar_update_zone_photo(
  p_code text,
  p_expected_version integer,
  p_image_path text,
  p_actor_user_id bigint,
  p_actor_name text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_zone public.bar_zones%rowtype;
  v_action text;
  v_new_version integer;
  v_changed_at timestamptz;
begin
  select * into v_zone from public.bar_zones where code = p_code for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_zone.version <> p_expected_version then
    return jsonb_build_object('status', 'conflict', 'version', v_zone.version);
  end if;
  if v_zone.image_path is not distinct from p_image_path then
    return jsonb_build_object('status', 'ok', 'version', v_zone.version, 'changed', false, 'old_image_path', v_zone.image_path);
  end if;

  v_action := case
    when v_zone.image_path is null then 'zone_photo_added'
    when p_image_path is null then 'zone_photo_removed'
    else 'zone_photo_replaced'
  end;
  v_changed_at := clock_timestamp();

  update public.bar_zones set
    image_path = p_image_path,
    image_updated_at = case when p_image_path is null then null else v_changed_at end,
    version = version + 1,
    updated_at = v_changed_at,
    updated_by_user_id = p_actor_user_id
  where id = v_zone.id
  returning version into v_new_version;

  insert into public.bar_activity_logs (
    entity_type, entity_id, entity_code_snapshot, action_type,
    before_data, after_data, actor_user_id, actor_name_snapshot, created_at
  ) values (
    'zone', v_zone.id, v_zone.code, v_action,
    jsonb_build_object('image_path', v_zone.image_path),
    jsonb_build_object('image_path', p_image_path),
    p_actor_user_id, p_actor_name, v_changed_at
  );

  return jsonb_build_object(
    'status', 'ok', 'version', v_new_version, 'changed', true,
    'old_image_path', v_zone.image_path
  );
end;
$$;

revoke all on function public.bar_update_zone_photo(text, integer, text, bigint, text) from public, anon, authenticated;
grant execute on function public.bar_update_zone_photo(text, integer, text, bigint, text) to service_role;
