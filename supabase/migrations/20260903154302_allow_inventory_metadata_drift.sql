alter function public.ledger_sync_inventory_candidates_v1(jsonb, bigint)
  rename to ledger_sync_inventory_candidates_core_v1;

alter function public.ledger_sync_inventory_candidates_core_v1(jsonb, bigint)
  owner to postgres;

revoke all on function public.ledger_sync_inventory_candidates_core_v1(jsonb, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.ledger_sync_inventory_candidates_core_v1(jsonb, bigint)
  to postgres, service_role;

create or replace function public.ledger_sync_inventory_candidates_v2(
  p_rows jsonb,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_role text;
  v_item jsonb;
  v_forward_rows jsonb := '[]'::jsonb;
  v_key text;
  v_fingerprint text;
  v_snapshot jsonb;
  v_date date;
  v_amount numeric;
  v_latest public.ledger_candidates%rowtype;
  v_result jsonb;
  v_metadata_drift_count integer := 0;
  v_metadata_drift_unchanged_count integer := 0;
begin
  select lower(role::text) into v_role
  from public.users
  where id = p_actor_user_id
    and is_active = true
    and app_login_enabled = true;

  if coalesce(v_role, '') not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception using errcode = '22023', message = 'INVALID_ROWS';
  end if;

  for v_item in select value from jsonb_array_elements(p_rows) loop
    begin
      v_key := v_item->>'sourceKey';
      v_fingerprint := v_item->>'fingerprint';
      v_snapshot := v_item->'snapshot';
      v_date := (v_item->>'businessDate')::date;
      v_amount := (v_item->>'amount')::numeric;
    exception when others then
      raise exception using errcode = '22023', message = 'INVALID_ROWS';
    end;

    if v_key is null
       or v_fingerprint is null
       or v_snapshot is null
       or v_date is null
       or v_amount is null
       or v_key !~ '^inventory-log:[0-9]+$'
       or length(v_fingerprint) <> 64
       or jsonb_typeof(v_snapshot) <> 'object'
       or v_amount <= 0 then
      raise exception using errcode = '22023', message = 'INVALID_ROWS';
    end if;

    perform pg_advisory_xact_lock(
      hashtext('ledger_inventory_candidate:' || v_key)
    );

    v_latest := null;

    select * into v_latest
    from public.ledger_candidates
    where source_type = 'inventory_purchase_log'
      and source_key = v_key
      and status = 'confirmed'
    order by id desc
    limit 1
    for update;

    if v_latest.id is not null
       and v_latest.source_fingerprint is distinct from v_fingerprint
       and v_latest.proposed_amount = v_amount
       and jsonb_typeof(v_latest.source_snapshot) = 'object'
       and (
         v_latest.source_snapshot
         - array['item_name','category','category_vi']::text[]
       ) = (
         v_snapshot
         - array['item_name','category','category_vi']::text[]
       ) then

      if v_latest.source_drift_fingerprint = v_fingerprint
         and v_latest.source_drift_snapshot is not distinct from v_snapshot then

        v_metadata_drift_unchanged_count :=
          v_metadata_drift_unchanged_count + 1;

      else

        update public.ledger_candidates
        set source_drift_detected_at = now(),
            source_drift_fingerprint = v_fingerprint,
            source_drift_snapshot = v_snapshot,
            updated_at = now()
        where id = v_latest.id;

        insert into public.ledger_audit_logs(
          actor_user_id,
          action,
          entity_type,
          entity_id,
          before_snapshot,
          after_snapshot,
          reason
        ) values (
          p_actor_user_id,
          'inventory_metadata_drift_acknowledged',
          'candidate',
          v_latest.id,
          jsonb_build_object(
            'sourceFingerprint', v_latest.source_fingerprint,
            'sourceSnapshot', v_latest.source_snapshot,
            'sourceDriftFingerprint', v_latest.source_drift_fingerprint,
            'sourceDriftSnapshot', v_latest.source_drift_snapshot
          ),
          jsonb_build_object(
            'sourceFingerprint', v_latest.source_fingerprint,
            'sourceSnapshot', v_latest.source_snapshot,
            'sourceDriftFingerprint', v_fingerprint,
            'sourceDriftSnapshot', v_snapshot,
            'detectedAt', now()
          ),
          'Inventory source changed only in display metadata; economic posting preserved'
        );

        v_metadata_drift_count := v_metadata_drift_count + 1;
      end if;

      continue;
    end if;

    v_forward_rows :=
      v_forward_rows || jsonb_build_array(v_item);
  end loop;

  v_result :=
    public.ledger_sync_inventory_candidates_core_v1(
      v_forward_rows,
      p_actor_user_id
    );

  return coalesce(v_result, '{}'::jsonb)
    || jsonb_build_object(
      'metadataDriftCount', v_metadata_drift_count,
      'metadataDriftUnchangedCount', v_metadata_drift_unchanged_count,
      'forwardedCount', jsonb_array_length(v_forward_rows)
    );
end;
$function$;

alter function public.ledger_sync_inventory_candidates_v2(jsonb, bigint)
  owner to postgres;

revoke all on function public.ledger_sync_inventory_candidates_v2(jsonb, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.ledger_sync_inventory_candidates_v2(jsonb, bigint)
  to postgres, service_role;
