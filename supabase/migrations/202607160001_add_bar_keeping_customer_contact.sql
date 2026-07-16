-- Add an optional free-form customer contact and preserve existing keeping policies.
-- Apply after 202607150004_add_bar_keeping_use_count_fixed_expiry.sql.

alter table public.bar_keepings
  add column customer_contact text,
  add constraint bar_keepings_customer_contact_check
    check (customer_contact is null or char_length(customer_contact) <= 120);

-- New overload: delegate creation to the current policy-owning function, then attach
-- the contact and enrich the creation log in the same transaction.
create or replace function public.bar_create_keeping(
  p_customer_name text, p_customer_contact text, p_customer_identifier text,
  p_liquor_source text, p_inventory_item_id bigint, p_liquor_name text, p_note text,
  p_zone_code text, p_remaining_percent integer, p_image_path text, p_thumbnail_path text,
  p_stored_at date, p_expires_at date, p_actor_user_id bigint
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_result jsonb; v_id bigint; v_contact text;
begin
  v_contact := nullif(btrim(p_customer_contact), '');
  if v_contact is not null and char_length(v_contact) > 120 then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  v_result := public.bar_create_keeping(
    p_customer_name, p_customer_identifier, p_liquor_source, p_inventory_item_id,
    p_liquor_name, p_note, p_zone_code, p_remaining_percent, p_image_path,
    p_thumbnail_path, p_stored_at, p_expires_at, p_actor_user_id
  );
  if v_result->>'status' <> 'ok' then return v_result; end if;

  v_id := (v_result->>'id')::bigint;
  update public.bar_keepings set customer_contact = v_contact where id = v_id;
  update public.bar_activity_logs
    set after_data = after_data || jsonb_build_object('customer_contact', v_contact)
    where id = (
      select l.id from public.bar_activity_logs l
      where l.entity_type = 'keeping' and l.entity_id = v_id and l.action_type = 'keeping_created'
      order by l.created_at desc, l.id desc limit 1
    );
  return v_result;
exception when check_violation or invalid_text_representation then
  return jsonb_build_object('status', 'invalid_input');
end $$;

-- v3 keeps v2's locking, audit log, fixed-expiry and use-count behavior intact.
create or replace function public.bar_mutate_keeping_v3(
  p_id bigint, p_expected_version integer, p_action text, p_payload jsonb, p_actor_user_id bigint
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_result jsonb; v_contact text; v_log_id bigint;
begin
  if p_action = 'update' then
    v_contact := nullif(btrim(p_payload->>'customer_contact'), '');
    if v_contact is not null and char_length(v_contact) > 120 then
      return jsonb_build_object('status', 'invalid_input');
    end if;
  end if;

  v_result := public.bar_mutate_keeping_v2(
    p_id, p_expected_version, p_action, p_payload, p_actor_user_id
  );
  if v_result->>'status' <> 'ok' or p_action <> 'update' then return v_result; end if;

  update public.bar_keepings set customer_contact = v_contact where id = p_id;
  select l.id into v_log_id from public.bar_activity_logs l
    where l.entity_type = 'keeping' and l.entity_id = p_id
      and l.action_type = 'keeping_updated' and l.actor_user_id = p_actor_user_id
    order by l.created_at desc, l.id desc limit 1;
  if v_log_id is not null then
    update public.bar_activity_logs
      set after_data = after_data || jsonb_build_object('customer_contact', v_contact)
      where id = v_log_id;
  end if;
  return v_result;
exception when check_violation or invalid_text_representation then
  return jsonb_build_object('status', 'invalid_input');
end $$;

revoke all on function public.bar_create_keeping(text,text,text,text,bigint,text,text,text,integer,text,text,date,date,bigint) from public, anon, authenticated;
revoke all on function public.bar_mutate_keeping_v3(bigint,integer,text,jsonb,bigint) from public, anon, authenticated;
grant execute on function public.bar_create_keeping(text,text,text,text,bigint,text,text,text,integer,text,text,date,date,bigint) to service_role;
grant execute on function public.bar_mutate_keeping_v3(bigint,integer,text,jsonb,bigint) to service_role;
