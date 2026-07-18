create or replace function public.bar_mutate_keeping_v5(
  p_id bigint,
  p_expected_version integer,
  p_action text,
  p_payload jsonb,
  p_actor_user_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb;
  v_action_note text;
  v_delegate_payload jsonb := p_payload;
  v_final_note text;
  v_log_id bigint;
  v_log_id_before bigint;
  v_new_log_count integer;
begin
  if p_action <> 'reactivate' then
    return public.bar_mutate_keeping_v4(
      p_id, p_expected_version, p_action, p_payload, p_actor_user_id
    );
  end if;

  v_action_note := nullif(btrim(p_payload->>'note'), '');
  -- The deployed base function does not validate reason, but it writes the
  -- legacy reason key to the reactivation log. Preserve that input contract
  -- while action_note remains the canonical value for new log rendering.
  v_delegate_payload := (p_payload - 'note') || jsonb_build_object(
    'reason', v_action_note
  );

  select coalesce(max(l.id), 0)
  into v_log_id_before
  from public.bar_activity_logs l
  where l.entity_type = 'keeping'
    and l.entity_id = p_id
    and l.action_type = 'keeping_reactivated';

  v_result := public.bar_mutate_keeping_v4(
    p_id,
    p_expected_version,
    p_action,
    v_delegate_payload,
    p_actor_user_id
  );
  if v_result->>'status' <> 'ok' then
    return v_result;
  end if;

  if v_action_note is not null then
    update public.bar_keepings
    set note = v_action_note
    where id = p_id;
  end if;

  select k.note into v_final_note
  from public.bar_keepings k
  where k.id = p_id;

  select count(*), max(l.id)
  into v_new_log_count, v_log_id
  from public.bar_activity_logs l
  where l.entity_type = 'keeping'
    and l.entity_id = p_id
    and l.action_type = 'keeping_reactivated'
    and l.actor_user_id = p_actor_user_id
    and l.id > v_log_id_before;

  if v_new_log_count <> 1 or v_log_id is null then
    raise exception 'expected one new keeping reactivation log for %, %, got %',
      p_id, p_actor_user_id, v_new_log_count;
  end if;

  if v_action_note is not null then
    update public.bar_activity_logs
    set after_data = coalesce(after_data, '{}'::jsonb) || jsonb_build_object(
      'action_note', v_action_note,
      'note', v_final_note
    )
    where id = v_log_id;

    if not found then
      raise exception 'keeping reactivation log update failed for %', v_log_id;
    end if;
  end if;

  return v_result;
end;
$$;

revoke all on function public.bar_mutate_keeping_v5(bigint, integer, text, jsonb, bigint)
  from public, anon, authenticated;
grant execute on function public.bar_mutate_keeping_v5(bigint, integer, text, jsonb, bigint)
  to service_role;

comment on function public.bar_mutate_keeping_v5(bigint, integer, text, jsonb, bigint) is
  'Extends v4 so reactivation atomically preserves an optional common note and action_note without another version increment.';
