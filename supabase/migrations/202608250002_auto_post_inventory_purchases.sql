-- Inventory purchase candidates remain the idempotency/provenance boundary, while
-- complete partner/category/payment defaults are posted in the same sync transaction.
create or replace function public.ledger_sync_inventory_candidates_v1(
  p_rows jsonb,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_item jsonb;
  v_key text;
  v_fingerprint text;
  v_snapshot jsonb;
  v_date date;
  v_amount numeric;
  v_pending public.ledger_candidates%rowtype;
  v_latest public.ledger_candidates%rowtype;
  v_category_id bigint;
  v_party_id bigint;
  v_business_partner public.business_partners%rowtype;
  v_result jsonb;
  v_force_review boolean := false;
  v_scanned integer := 0;
  v_created integer := 0;
  v_unchanged integer := 0;
  v_superseded integer := 0;
  v_auto_immediate integer := 0;
  v_auto_payable integer := 0;
  v_pending_review integer := 0;
begin
  select lower(role::text) into v_role
  from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception using
      errcode = '22023',
      message = 'INVALID_ROWS';
  end if;

  for v_item in select value from jsonb_array_elements(p_rows) loop
    v_scanned := v_scanned + 1;
    begin
      v_key := v_item->>'sourceKey';
      v_fingerprint := v_item->>'fingerprint';
      v_snapshot := v_item->'snapshot';
      v_date := (v_item->>'businessDate')::date;
      v_amount := (v_item->>'amount')::numeric;
    exception when others then
      raise exception using
        errcode = '22023',
        message = 'INVALID_ROWS';
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
      raise exception using
        errcode = '22023',
        message = 'INVALID_ROWS';
    end if;

    perform pg_advisory_xact_lock(hashtext('ledger_inventory_candidate:' || v_key));
    v_latest := null; v_pending := null; v_category_id := null;
    v_party_id := null; v_business_partner := null; v_result := null;
    v_force_review := false;

    select * into v_latest
    from public.ledger_candidates
    where source_type = 'inventory_purchase_log' and source_key = v_key
    order by id desc limit 1 for update;
    if v_latest.status = 'confirmed' then
      if v_latest.source_fingerprint = v_fingerprint then
        v_unchanged := v_unchanged + 1;
        continue;
      end if;
      raise exception using
        errcode = '55000',
        message = 'SOURCE_CHANGED_AFTER_POST';
    end if;
    if v_latest.status = 'dismissed' then
      if v_latest.source_fingerprint = v_fingerprint then
        v_unchanged := v_unchanged + 1;
        continue;
      end if;
      v_force_review := true;
    end if;
    if v_latest.status = 'pending'
       and exists (
         select 1
         from public.ledger_candidates history
         where history.source_type = v_latest.source_type
           and history.source_key = v_latest.source_key
           and history.id < v_latest.id
           and history.status = 'dismissed'
           and history.source_fingerprint is distinct from v_latest.source_fingerprint
       ) then
      v_force_review := true;
    end if;

    select ledger_category_id into v_category_id
    from public.ledger_inventory_category_mappings
    where is_active = true
      and lower(btrim(inventory_category)) = lower(btrim(v_snapshot->>'category'))
    limit 1;

    if coalesce(v_snapshot->>'item_id', '') ~ '^[0-9]+$' then
      select blp.ledger_party_id into v_party_id
      from public.inventory i
      join public.business_partners bp on bp.id = i.supplier_partner_id and bp.is_active = true
      join public.business_partner_ledger_parties blp on blp.business_partner_id = bp.id
      where i.id = (v_snapshot->>'item_id')::bigint limit 1;
    end if;
    if v_party_id is null and nullif(btrim(v_snapshot->>'supplier'), '') is not null then
      select blp.ledger_party_id into v_party_id
      from public.business_partner_supplier_aliases a
      join public.business_partners bp on bp.id = a.business_partner_id and bp.is_active = true
      join public.business_partner_ledger_parties blp on blp.business_partner_id = bp.id
      where a.status = 'linked'
        and a.normalized_name = lower(btrim(v_snapshot->>'supplier')) limit 1;
    end if;
    if v_party_id is null and nullif(btrim(v_snapshot->>'supplier'), '') is not null then
      select blp.ledger_party_id into v_party_id
      from public.business_partners bp
      join public.business_partner_ledger_parties blp on blp.business_partner_id = bp.id
      where bp.is_active = true
        and lower(btrim(bp.name)) = lower(btrim(v_snapshot->>'supplier')) limit 1;
    end if;
    if v_party_id is null then
      select party_id into v_party_id
      from public.ledger_supplier_party_mappings
      where is_active = true
        and lower(btrim(supplier_name)) = lower(btrim(v_snapshot->>'supplier')) limit 1;
    end if;

    select * into v_pending
    from public.ledger_candidates
    where source_type = 'inventory_purchase_log' and source_key = v_key and status = 'pending'
    for update;
    if v_pending.id is not null and v_pending.source_fingerprint = v_fingerprint then
      update public.ledger_candidates
      set proposed_category_id = v_category_id, proposed_party_id = v_party_id,
          updated_at = case when proposed_category_id is distinct from v_category_id
            or proposed_party_id is distinct from v_party_id then now() else updated_at end
      where id = v_pending.id returning * into v_pending;
      v_unchanged := v_unchanged + 1;
    else
      if v_pending.id is not null then
        update public.ledger_candidates set status = 'superseded', resolved_at = now(), updated_at = now()
        where id = v_pending.id;
        v_superseded := v_superseded + 1;
      end if;
      insert into public.ledger_candidates(
        candidate_type, source_type, source_key, business_date, proposed_amount,
        proposed_category_id, proposed_party_id, proposed_recognition_month,
        source_snapshot, source_fingerprint
      ) values (
        'inventory_purchase', 'inventory_purchase_log', v_key, v_date, v_amount,
        v_category_id, v_party_id, date_trunc('month', v_date)::date,
        v_snapshot, v_fingerprint
      ) returning * into v_pending;
      v_created := v_created + 1;
    end if;

    if v_force_review then
      v_pending_review := v_pending_review + 1;
      continue;
    end if;

    if v_pending.candidate_type <> 'inventory_purchase'
       or v_pending.proposed_category_id is null
       or v_pending.proposed_party_id is null then
      v_pending_review := v_pending_review + 1;
      continue;
    end if;
    select bp.* into v_business_partner
    from public.business_partner_ledger_parties blp
    join public.business_partners bp on bp.id = blp.business_partner_id
    where blp.ledger_party_id = v_pending.proposed_party_id and bp.is_active = true
    limit 1;
    if v_business_partner.id is null or v_business_partner.payment_mode not in ('immediate', 'postpaid') then
      v_pending_review := v_pending_review + 1;
      continue;
    end if;

    if v_business_partner.payment_mode = 'immediate' then
      if v_business_partner.default_fund_account_id is null
         or not public.business_partner_fund_account_is_eligible_v1(v_business_partner.default_fund_account_id)
         or not exists (
           select 1
           from public.ledger_fund_accounts account
           where account.id = v_business_partner.default_fund_account_id
             and account.is_active = true
             and account.is_business_fund = true
             and account.type <> 'card_clearing'
             and account.active_from <= v_pending.business_date
             and (account.active_to is null or account.active_to >= v_pending.business_date)
         ) then
        v_pending_review := v_pending_review + 1;
        continue;
      end if;
      v_result := public.ledger_resolve_inventory_candidate_v1(
        v_pending.id, 'immediate', v_pending.proposed_category_id,
        v_pending.proposed_party_id, v_business_partner.default_fund_account_id,
        null, null, 'Inventory sync auto-post: immediate', p_actor_user_id
      );
      if v_result->>'status' = 'confirmed' then v_auto_immediate := v_auto_immediate + 1;
      else v_pending_review := v_pending_review + 1; end if;
    else
      v_result := public.ledger_resolve_inventory_candidate_v1(
        v_pending.id, 'payable', v_pending.proposed_category_id,
        v_pending.proposed_party_id, null,
        case when v_business_partner.default_payment_term_days is null then null
          else v_pending.business_date + v_business_partner.default_payment_term_days end,
        null, 'Inventory sync auto-post: postpaid', p_actor_user_id
      );
      if v_result->>'status' = 'confirmed' then v_auto_payable := v_auto_payable + 1;
      else v_pending_review := v_pending_review + 1; end if;
    end if;
  end loop;

  return jsonb_build_object(
    'status', 'ok', 'scannedLogs', v_scanned, 'createdCount', v_created,
    'unchangedCount', v_unchanged, 'supersededCount', v_superseded,
    'autoConfirmedImmediateCount', v_auto_immediate,
    'autoConfirmedPayableCount', v_auto_payable,
    'pendingReviewCount', v_pending_review
  );
end;
$$;

alter function public.ledger_sync_inventory_candidates_v1(jsonb, bigint) owner to postgres;
revoke all on function public.ledger_sync_inventory_candidates_v1(jsonb, bigint)
  from public, anon, authenticated;
grant execute on function public.ledger_sync_inventory_candidates_v1(jsonb, bigint)
  to service_role;

comment on function public.ledger_sync_inventory_candidates_v1(jsonb, bigint) is
  'Synchronizes Inventory purchase candidates and auto-posts complete immediate/postpaid purchases through ledger_resolve_inventory_candidate_v1; unresolved exceptions remain pending.';
