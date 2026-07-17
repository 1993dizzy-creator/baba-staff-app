-- Unify optional keeping action notes without removing the legacy close_note column.
-- Apply after 202607160002_add_bar_keeping_atomic_update_move.sql.

update public.bar_keepings
set note = nullif(btrim(close_note), '')
where nullif(btrim(note), '') is null
  and nullif(btrim(close_note), '') is not null;

create or replace function public.bar_mutate_keeping_v4(
  p_id bigint,
  p_expected_version integer,
  p_action text,
  p_payload jsonb,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb;
  v_action_note text;
  v_delegate_payload jsonb := p_payload;
  v_action_type text;
  v_final_note text;
  v_log_id bigint;
begin
  -- close_note is accepted only as a temporary compatibility fallback.
  if p_action = 'close' then
    v_action_note := nullif(
      btrim(coalesce(p_payload->>'note', p_payload->>'close_note')),
      ''
    );
  else
    v_action_note := nullif(btrim(p_payload->>'note'), '');
  end if;

  -- The legacy base function writes use.note into close_note on automatic
  -- finish, and writes close.close_note directly. v4 owns action-note storage,
  -- so omit those legacy inputs before delegating while retaining their value
  -- in v_action_note for the common note and audit log below.
  if p_action = 'use'
    and coalesce((p_payload->>'finish')::boolean, false)
  then
    v_delegate_payload := v_delegate_payload - 'note';
  elsif p_action = 'close' then
    v_delegate_payload := v_delegate_payload - 'close_note';
  end if;

  v_result := public.bar_mutate_keeping_v3(
    p_id,
    p_expected_version,
    p_action,
    v_delegate_payload,
    p_actor_user_id
  );
  if v_result->>'status' <> 'ok' then
    return v_result;
  end if;

  v_action_type := case p_action
    when 'use' then 'keeping_used'
    when 'correct_remaining' then 'keeping_remaining_corrected'
    when 'close' then 'keeping_closed'
    else null
  end;
  if v_action_type is null then
    return v_result;
  end if;

  -- Do not increment version again. v3 already performed the locked mutation.
  if v_action_note is not null then
    update public.bar_keepings
    set note = v_action_note
    where id = p_id;
  end if;

  select k.note
  into v_final_note
  from public.bar_keepings k
  where k.id = p_id;

  select l.id
  into v_log_id
  from public.bar_activity_logs l
  where l.entity_type = 'keeping'
    and l.entity_id = p_id
    and l.action_type = v_action_type
    and l.actor_user_id = p_actor_user_id
  order by l.created_at desc, l.id desc
  limit 1;

  if v_log_id is null then
    raise exception 'keeping action log not found for %, %, %',
      p_id, v_action_type, p_actor_user_id;
  end if;

  update public.bar_activity_logs
  set after_data = coalesce(after_data, '{}'::jsonb) || jsonb_build_object(
    'action_note', v_action_note,
    'note', v_final_note
  )
  where id = v_log_id;

  if not found then
    raise exception 'keeping action log update failed for %', v_log_id;
  end if;

  return v_result;
end
$$;

revoke all on function public.bar_mutate_keeping_v4(bigint,integer,text,jsonb,bigint)
  from public, anon, authenticated;
grant execute on function public.bar_mutate_keeping_v4(bigint,integer,text,jsonb,bigint)
  to service_role;

comment on function public.bar_mutate_keeping_v4(bigint,integer,text,jsonb,bigint) is
  'Delegates to v3, then atomically preserves optional use/correction/close notes in the keeping and action log.';
