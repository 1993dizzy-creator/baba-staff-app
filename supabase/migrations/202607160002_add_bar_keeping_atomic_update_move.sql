-- Atomically preserve the existing information-update and zone-move actions/logs.
-- Apply after 202607160001_add_bar_keeping_customer_contact.sql.

create or replace function public.bar_update_and_move_keeping(
  p_id bigint,
  p_expected_version integer,
  p_update_payload jsonb,
  p_move_payload jsonb,
  p_actor_user_id bigint
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_update_result jsonb;
  v_move_result jsonb;
  v_next_version integer;
begin
  v_update_result := public.bar_mutate_keeping_v3(
    p_id, p_expected_version, 'update', p_update_payload, p_actor_user_id
  );
  if v_update_result->>'status' <> 'ok' then return v_update_result; end if;

  v_next_version := (v_update_result->>'version')::integer;
  v_move_result := public.bar_mutate_keeping_v3(
    p_id, v_next_version, 'move', p_move_payload, p_actor_user_id
  );

  if v_move_result->>'status' <> 'ok' then
    raise exception 'atomic keeping move failed: %', v_move_result->>'status';
  end if;
  return v_move_result;
end $$;

revoke all on function public.bar_update_and_move_keeping(bigint,integer,jsonb,jsonb,bigint)
  from public, anon, authenticated;
grant execute on function public.bar_update_and_move_keeping(bigint,integer,jsonb,jsonb,bigint)
  to service_role;
