-- Partner classification emoji is display identity, independent of Ledger categories.
alter table public.business_partner_subtypes
  add column emoji text null
  constraint business_partner_subtypes_emoji_check
    check (emoji is null or (length(emoji) between 1 and 32 and emoji = btrim(emoji)));

comment on column public.business_partner_subtypes.emoji is
  'Optional subtype display emoji. NULL inherits its partner_type emoji in the application.';

-- Replace the two existing management signatures; the optional final argument keeps
-- pre-deployment callers working without creating an ambiguous RPC overload.
drop function public.business_partner_subtype_create_v1(text,text,text,integer,bigint);
create function public.business_partner_subtype_create_v1(
  p_partner_type text,
  p_name_ko text,
  p_name_vi text,
  p_sort_order integer,
  p_actor_user_id bigint,
  p_emoji text default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_id bigint;
begin
  select lower(role::text) into v_role
  from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;

  if nullif(btrim(p_name_ko), '') is null and nullif(btrim(p_name_vi), '') is null then
    return jsonb_build_object('status', 'invalid_name');
  end if;

  -- Keep the existing generated code and identity contract.
  v_id := nextval('public.business_partner_subtypes_id_seq');
  insert into public.business_partner_subtypes(id, code, partner_type, name_ko, name_vi, sort_order, is_active, emoji)
  values (v_id, 'custom_' || v_id, btrim(p_partner_type), nullif(btrim(p_name_ko), ''), nullif(btrim(p_name_vi), ''), coalesce(p_sort_order, 0), true, nullif(btrim(p_emoji), ''));

  return jsonb_build_object('status', 'created', 'subtypeId', v_id, 'code', 'custom_' || v_id);
exception
  when check_violation or not_null_violation then return jsonb_build_object('status', 'invalid_input');
end;
$$;

drop function public.business_partner_subtype_update_v1(bigint,text,text,integer,boolean,bigint);
create function public.business_partner_subtype_update_v1(
  p_subtype_id bigint,
  p_name_ko text,
  p_name_vi text,
  p_sort_order integer,
  p_is_active boolean,
  p_actor_user_id bigint,
  p_emoji text default '__keep_existing_emoji__'
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_before jsonb;
begin
  select lower(role::text) into v_role
  from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;

  select to_jsonb(s) into v_before
  from public.business_partner_subtypes s where s.id = p_subtype_id for update;
  if v_before is null then return jsonb_build_object('status', 'not_found'); end if;

  if nullif(btrim(p_name_ko), '') is null and nullif(btrim(p_name_vi), '') is null then
    return jsonb_build_object('status', 'invalid_name');
  end if;

  -- partner_type and code remain immutable, including for an inactive subtype.
  update public.business_partner_subtypes set
    name_ko = nullif(btrim(p_name_ko), ''),
    name_vi = nullif(btrim(p_name_vi), ''),
    sort_order = coalesce(p_sort_order, sort_order),
    is_active = p_is_active,
    emoji = case when p_emoji = '__keep_existing_emoji__' then emoji else nullif(btrim(p_emoji), '') end,
    updated_at = now()
  where id = p_subtype_id;

  return jsonb_build_object('status', 'updated', 'subtypeId', p_subtype_id);
exception
  when check_violation or not_null_violation then return jsonb_build_object('status', 'invalid_input');
end;
$$;

alter function public.business_partner_subtype_create_v1(text,text,text,integer,bigint,text) owner to postgres;
alter function public.business_partner_subtype_update_v1(bigint,text,text,integer,boolean,bigint,text) owner to postgres;
revoke all on function public.business_partner_subtype_create_v1(text,text,text,integer,bigint,text) from public, anon, authenticated;
revoke all on function public.business_partner_subtype_update_v1(bigint,text,text,integer,boolean,bigint,text) from public, anon, authenticated;
grant execute on function public.business_partner_subtype_create_v1(text,text,text,integer,bigint,text) to service_role;
grant execute on function public.business_partner_subtype_update_v1(bigint,text,text,integer,boolean,bigint,text) to service_role;

-- Update only the existing stable subtype codes. general_food remains NULL and
-- inherits the food parent emoji (🛒) in the application.
update public.business_partner_subtypes set emoji = '🍺', updated_at = now()
where code = 'alcohol_other' and partner_type = 'alcohol' and emoji is distinct from '🍺';
update public.business_partner_subtypes set emoji = '🥩', updated_at = now()
where code = 'meat' and partner_type = 'food' and emoji is distinct from '🥩';
update public.business_partner_subtypes set emoji = '🥬', updated_at = now()
where code = 'vegetable_fruit' and partner_type = 'food' and emoji is distinct from '🥬';
update public.business_partner_subtypes set emoji = '🦑', updated_at = now()
where code = 'dry_food' and partner_type = 'food' and emoji is distinct from '🦑';

notify pgrst, 'reload schema';
