-- Business Partner is the user-facing source of truth for Ledger counterparties.
-- ledger_parties and ledger_supplier_party_mappings remain internal compatibility records.

-- 1) Add the missing second personal-custody account and normalize display order.
insert into public.ledger_fund_accounts(
  code, type, holder_name, display_name, is_active, active_from, sort_order, is_business_fund
)
select
  'vuong_personal_custody', 'personal_custody', 'Vương', 'Vương 개인계좌 (BABA 소유분)',
  true, date '2026-08-01', 20, true
where not exists (
  select 1 from public.ledger_fund_accounts where code = 'vuong_personal_custody'
);

update public.ledger_fund_accounts
set sort_order = case code
  when 'store_cash' then 10
  when 'vuong_personal_custody' then 20
  when 'cho_personal_custody' then 30
  when 'baba_corporate_bank' then 40
  when 'card_clearing' then 50
  else sort_order
end
where code in (
  'store_cash','vuong_personal_custody','cho_personal_custody','baba_corporate_bank','card_clearing'
);

-- 2) Managed one-to-one Business Partner -> Ledger Party bridge.
create or replace function public.business_partner_ensure_ledger_party_v1(
  p_business_partner_id bigint
) returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_partner public.business_partners%rowtype;
  v_ledger_party_id bigint;
begin
  if p_business_partner_id is null then return null; end if;
  perform pg_advisory_xact_lock(hashtext('business_partner_ledger:' || p_business_partner_id::text));

  select * into v_partner
  from public.business_partners
  where id = p_business_partner_id;
  if not found then return null; end if;

  select ledger_party_id into v_ledger_party_id
  from public.business_partner_ledger_parties
  where business_partner_id = p_business_partner_id;

  if v_ledger_party_id is null then
    insert into public.ledger_parties(
      name, type, default_payment_term_days, is_active
    ) values (
      v_partner.name, 'supplier', v_partner.default_payment_term_days, v_partner.is_active
    ) returning id into v_ledger_party_id;

    insert into public.business_partner_ledger_parties(business_partner_id, ledger_party_id)
    values(p_business_partner_id, v_ledger_party_id);
  else
    update public.ledger_parties
    set name = v_partner.name,
        type = 'supplier',
        default_payment_term_days = v_partner.default_payment_term_days,
        is_active = v_partner.is_active,
        updated_at = now()
    where id = v_ledger_party_id;
  end if;

  return v_ledger_party_id;
end;
$$;

revoke all on function public.business_partner_ensure_ledger_party_v1(bigint)
  from public, anon, authenticated, service_role;

create or replace function public.business_partner_sync_ledger_party_trigger_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.business_partner_ensure_ledger_party_v1(new.id);
  return new;
end;
$$;

revoke all on function public.business_partner_sync_ledger_party_trigger_v1()
  from public, anon, authenticated, service_role;

drop trigger if exists business_partner_sync_ledger_party_trg on public.business_partners;
create trigger business_partner_sync_ledger_party_trg
after insert or update of name, default_payment_term_days, is_active
on public.business_partners
for each row execute function public.business_partner_sync_ledger_party_trigger_v1();

-- Existing Business Partners are backfilled without hardcoded IDs.
do $$
declare
  v_partner_id bigint;
begin
  for v_partner_id in select id from public.business_partners order by id loop
    perform public.business_partner_ensure_ledger_party_v1(v_partner_id);
  end loop;
end;
$$;

-- 3) Supplier aliases automatically maintain the legacy Ledger mapping cache.
create or replace function public.business_partner_sync_supplier_ledger_mapping_trigger_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_ledger_party_id bigint;
begin
  if tg_op = 'UPDATE' and old.normalized_name is distinct from new.normalized_name then
    update public.ledger_supplier_party_mappings
    set is_active = false
    where lower(btrim(supplier_name)) = old.normalized_name;
  end if;

  if new.status = 'linked' and new.business_partner_id is not null then
    v_ledger_party_id := public.business_partner_ensure_ledger_party_v1(new.business_partner_id);
    if v_ledger_party_id is null then
      raise exception 'linked Business Partner has no managed Ledger party';
    end if;

    insert into public.ledger_supplier_party_mappings(supplier_name, party_id, is_active)
    values(new.supplier_name, v_ledger_party_id, true)
    on conflict (supplier_name) do update
    set party_id = excluded.party_id,
        is_active = true;

    update public.ledger_candidates c
    set proposed_party_id = v_ledger_party_id,
        updated_at = now()
    where c.status = 'pending'
      and c.candidate_type = 'inventory_purchase'
      and lower(btrim(coalesce(c.source_snapshot->>'supplier',''))) = new.normalized_name
      and c.proposed_party_id is distinct from v_ledger_party_id;
  else
    update public.ledger_supplier_party_mappings
    set is_active = false
    where lower(btrim(supplier_name)) = new.normalized_name;
  end if;

  return new;
end;
$$;

revoke all on function public.business_partner_sync_supplier_ledger_mapping_trigger_v1()
  from public, anon, authenticated, service_role;

drop trigger if exists business_partner_sync_supplier_ledger_mapping_trg
  on public.business_partner_supplier_aliases;
create trigger business_partner_sync_supplier_ledger_mapping_trg
after insert or update of supplier_name, normalized_name, status, business_partner_id
on public.business_partner_supplier_aliases
for each row execute function public.business_partner_sync_supplier_ledger_mapping_trigger_v1();

-- Backfill linked aliases into the compatibility cache.
insert into public.ledger_supplier_party_mappings(supplier_name, party_id, is_active)
select a.supplier_name, blp.ledger_party_id, bp.is_active
from public.business_partner_supplier_aliases a
join public.business_partners bp on bp.id = a.business_partner_id
join public.business_partner_ledger_parties blp on blp.business_partner_id = bp.id
where a.status = 'linked' and a.business_partner_id is not null
on conflict (supplier_name) do update
set party_id = excluded.party_id,
    is_active = excluded.is_active;

-- Existing pending purchase candidates inherit the normalized partner immediately.
update public.ledger_candidates c
set proposed_party_id = blp.ledger_party_id,
    updated_at = now()
from public.inventory i
join public.business_partners bp on bp.id = i.supplier_partner_id and bp.is_active = true
join public.business_partner_ledger_parties blp on blp.business_partner_id = bp.id
where c.status = 'pending'
  and c.candidate_type = 'inventory_purchase'
  and coalesce(c.source_snapshot->>'item_id','') ~ '^[0-9]+$'
  and i.id = (c.source_snapshot->>'item_id')::bigint
  and c.proposed_party_id is distinct from blp.ledger_party_id;

update public.ledger_candidates c
set proposed_party_id = blp.ledger_party_id,
    updated_at = now()
from public.business_partner_supplier_aliases a
join public.business_partners bp on bp.id = a.business_partner_id and bp.is_active = true
join public.business_partner_ledger_parties blp on blp.business_partner_id = bp.id
where c.status = 'pending'
  and c.candidate_type = 'inventory_purchase'
  and c.proposed_party_id is null
  and a.status = 'linked'
  and a.normalized_name = lower(btrim(coalesce(c.source_snapshot->>'supplier','')));

-- 4) Current Partner RPCs keep their signatures, but Ledger linkage is no longer user-managed.
create or replace function public.business_partner_create_v4(
  p_name text,
  p_partner_type text,
  p_payment_mode text,
  p_settlement_mode text,
  p_settlement_rule text,
  p_default_payment_term_days integer,
  p_default_fund_account_id bigint,
  p_partner_subtype_id bigint,
  p_phone text,
  p_contact_name text,
  p_memo text,
  p_is_active boolean,
  p_ledger_party_id bigint,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_id bigint;
  v_ledger_party_id bigint;
begin
  select lower(role::text) into v_role
  from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;

  if not public.business_partner_fund_account_is_eligible_v1(p_default_fund_account_id) then
    return jsonb_build_object('status', 'invalid_fund_account');
  end if;
  if not public.business_partner_subtype_is_eligible_v1(p_partner_subtype_id, btrim(p_partner_type)) then
    return jsonb_build_object('status', 'invalid_partner_subtype');
  end if;

  insert into public.business_partners(
    name, partner_type, payment_mode, settlement_mode, settlement_rule,
    default_payment_term_days, default_fund_account_id, partner_subtype_id,
    phone, contact_name, memo, is_active
  ) values (
    btrim(p_name), btrim(p_partner_type), p_payment_mode, p_settlement_mode,
    p_settlement_rule, p_default_payment_term_days, p_default_fund_account_id,
    p_partner_subtype_id, nullif(btrim(p_phone), ''), nullif(btrim(p_contact_name), ''),
    nullif(btrim(p_memo), ''), p_is_active
  ) returning id into v_id;

  select ledger_party_id into v_ledger_party_id
  from public.business_partner_ledger_parties
  where business_partner_id = v_id;
  if v_ledger_party_id is null then
    v_ledger_party_id := public.business_partner_ensure_ledger_party_v1(v_id);
  end if;

  insert into public.business_partner_audit_logs(
    business_partner_id, actor_user_id, action, after_snapshot
  ) values (
    v_id, p_actor_user_id, 'created',
    (select to_jsonb(p) from public.business_partners p where p.id = v_id)
  );

  return jsonb_build_object('status', 'created', 'partnerId', v_id, 'ledgerPartyId', v_ledger_party_id);
exception
  when unique_violation then return jsonb_build_object('status', 'duplicate_name');
  when check_violation or foreign_key_violation or not_null_violation then return jsonb_build_object('status', 'invalid_input');
end;
$$;

create or replace function public.business_partner_update_v4(
  p_partner_id bigint,
  p_name text,
  p_partner_type text,
  p_payment_mode text,
  p_settlement_mode text,
  p_settlement_rule text,
  p_default_payment_term_days integer,
  p_default_fund_account_id bigint,
  p_partner_subtype_id bigint,
  p_phone text,
  p_contact_name text,
  p_memo text,
  p_is_active boolean,
  p_ledger_party_id bigint,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_before jsonb;
  v_current_subtype_id bigint;
  v_ledger_party_id bigint;
begin
  select lower(role::text) into v_role
  from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;

  select to_jsonb(p) into v_before
  from public.business_partners p where p.id = p_partner_id for update;
  if v_before is null then return jsonb_build_object('status', 'not_found'); end if;
  v_current_subtype_id := (v_before->>'partner_subtype_id')::bigint;

  if not public.business_partner_fund_account_is_eligible_v1(p_default_fund_account_id) then
    return jsonb_build_object('status', 'invalid_fund_account');
  end if;
  if not public.business_partner_subtype_is_eligible_v1(
    p_partner_subtype_id, btrim(p_partner_type), v_current_subtype_id
  ) then
    return jsonb_build_object('status', 'invalid_partner_subtype');
  end if;

  update public.business_partners set
    name = btrim(p_name),
    partner_type = btrim(p_partner_type),
    payment_mode = p_payment_mode,
    settlement_mode = p_settlement_mode,
    settlement_rule = p_settlement_rule,
    default_payment_term_days = p_default_payment_term_days,
    default_fund_account_id = p_default_fund_account_id,
    partner_subtype_id = p_partner_subtype_id,
    phone = nullif(btrim(p_phone), ''),
    contact_name = nullif(btrim(p_contact_name), ''),
    memo = nullif(btrim(p_memo), ''),
    is_active = p_is_active,
    updated_at = now()
  where id = p_partner_id;

  select ledger_party_id into v_ledger_party_id
  from public.business_partner_ledger_parties
  where business_partner_id = p_partner_id;
  if v_ledger_party_id is null then
    v_ledger_party_id := public.business_partner_ensure_ledger_party_v1(p_partner_id);
  end if;

  insert into public.business_partner_audit_logs(
    business_partner_id, actor_user_id, action, before_snapshot, after_snapshot
  ) values (
    p_partner_id, p_actor_user_id, 'updated', v_before,
    (select to_jsonb(p) from public.business_partners p where p.id = p_partner_id)
  );

  return jsonb_build_object('status', 'updated', 'partnerId', p_partner_id, 'ledgerPartyId', v_ledger_party_id);
exception
  when unique_violation then return jsonb_build_object('status', 'duplicate_name');
  when check_violation or foreign_key_violation or not_null_violation then return jsonb_build_object('status', 'invalid_input');
end;
$$;

-- 5) Inventory candidate sync resolves parties from normalized Business Partner identity first.
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
  v_scanned integer := 0;
  v_created integer := 0;
  v_unchanged integer := 0;
  v_superseded integer := 0;
begin
  select lower(role::text) into v_role
  from public.users
  where id=p_actor_user_id and is_active=true and app_login_enabled=true;
  if coalesce(v_role,'') not in('owner','master') then return jsonb_build_object('status','forbidden'); end if;
  if jsonb_typeof(p_rows)<>'array' then return jsonb_build_object('status','invalid_rows'); end if;

  for v_item in select value from jsonb_array_elements(p_rows) loop
    v_scanned := v_scanned + 1;
    begin
      v_key := v_item->>'sourceKey';
      v_fingerprint := v_item->>'fingerprint';
      v_snapshot := v_item->'snapshot';
      v_date := (v_item->>'businessDate')::date;
      v_amount := (v_item->>'amount')::numeric;
    exception when others then
      return jsonb_build_object('status','invalid_rows');
    end;

    if v_key !~ '^inventory-log:[0-9]+$'
       or length(v_fingerprint) <> 64
       or jsonb_typeof(v_snapshot) <> 'object'
       or v_amount <= 0 then
      return jsonb_build_object('status','invalid_rows');
    end if;

    perform pg_advisory_xact_lock(hashtext('ledger_inventory_candidate:'||v_key));
    v_latest := null; v_pending := null; v_category_id := null; v_party_id := null;

    select * into v_latest
    from public.ledger_candidates
    where source_type='inventory_purchase_log' and source_key=v_key
    order by id desc limit 1 for update;
    if v_latest.status in ('confirmed','dismissed') then
      v_unchanged := v_unchanged + 1;
      continue;
    end if;

    select ledger_category_id into v_category_id
    from public.ledger_inventory_category_mappings
    where is_active=true
      and lower(btrim(inventory_category))=lower(btrim(v_snapshot->>'category'))
    limit 1;

    if coalesce(v_snapshot->>'item_id','') ~ '^[0-9]+$' then
      select blp.ledger_party_id into v_party_id
      from public.inventory i
      join public.business_partners bp on bp.id = i.supplier_partner_id and bp.is_active = true
      join public.business_partner_ledger_parties blp on blp.business_partner_id = bp.id
      where i.id = (v_snapshot->>'item_id')::bigint
      limit 1;
    end if;

    if v_party_id is null and nullif(btrim(v_snapshot->>'supplier'),'') is not null then
      select blp.ledger_party_id into v_party_id
      from public.business_partner_supplier_aliases a
      join public.business_partners bp on bp.id = a.business_partner_id and bp.is_active = true
      join public.business_partner_ledger_parties blp on blp.business_partner_id = bp.id
      where a.status='linked'
        and a.normalized_name = lower(btrim(v_snapshot->>'supplier'))
      limit 1;
    end if;

    if v_party_id is null and nullif(btrim(v_snapshot->>'supplier'),'') is not null then
      select blp.ledger_party_id into v_party_id
      from public.business_partners bp
      join public.business_partner_ledger_parties blp on blp.business_partner_id = bp.id
      where bp.is_active = true
        and lower(btrim(bp.name)) = lower(btrim(v_snapshot->>'supplier'))
      limit 1;
    end if;

    if v_party_id is null then
      select party_id into v_party_id
      from public.ledger_supplier_party_mappings
      where is_active=true
        and lower(btrim(supplier_name))=lower(btrim(v_snapshot->>'supplier'))
      limit 1;
    end if;

    select * into v_pending
    from public.ledger_candidates
    where source_type='inventory_purchase_log'
      and source_key=v_key
      and status='pending'
    for update;

    if v_pending.id is not null and v_pending.source_fingerprint=v_fingerprint then
      update public.ledger_candidates
      set proposed_category_id = v_category_id,
          proposed_party_id = v_party_id,
          updated_at = case
            when proposed_category_id is distinct from v_category_id
              or proposed_party_id is distinct from v_party_id
            then now() else updated_at end
      where id = v_pending.id;
      v_unchanged := v_unchanged + 1;
      continue;
    end if;

    if v_pending.id is not null then
      update public.ledger_candidates
      set status='superseded', resolved_at=now(), updated_at=now()
      where id=v_pending.id;
      v_superseded := v_superseded + 1;
    end if;

    insert into public.ledger_candidates(
      candidate_type, source_type, source_key, business_date, proposed_amount,
      proposed_category_id, proposed_party_id, proposed_recognition_month,
      source_snapshot, source_fingerprint
    ) values (
      'inventory_purchase','inventory_purchase_log',v_key,v_date,v_amount,
      v_category_id,v_party_id,date_trunc('month',v_date)::date,v_snapshot,v_fingerprint
    );
    v_created := v_created + 1;
  end loop;

  return jsonb_build_object(
    'status','ok','scannedLogs',v_scanned,'createdCount',v_created,
    'unchangedCount',v_unchanged,'supersededCount',v_superseded
  );
end;
$$;

-- Preserve the current external RPC surface and permissions.
revoke all on function public.business_partner_create_v4(text,text,text,text,text,integer,bigint,bigint,text,text,text,boolean,bigint,bigint)
  from public, anon, authenticated;
revoke all on function public.business_partner_update_v4(bigint,text,text,text,text,text,integer,bigint,bigint,text,text,text,boolean,bigint,bigint)
  from public, anon, authenticated;
revoke all on function public.ledger_sync_inventory_candidates_v1(jsonb,bigint)
  from public, anon, authenticated;

grant execute on function public.business_partner_create_v4(text,text,text,text,text,integer,bigint,bigint,text,text,text,boolean,bigint,bigint)
  to service_role;
grant execute on function public.business_partner_update_v4(bigint,text,text,text,text,text,integer,bigint,bigint,text,text,text,boolean,bigint,bigint)
  to service_role;
grant execute on function public.ledger_sync_inventory_candidates_v1(jsonb,bigint)
  to service_role;

comment on function public.business_partner_ensure_ledger_party_v1(bigint)
  is 'Internal compatibility helper: every Business Partner owns exactly one managed Ledger party.';
comment on table public.business_partner_ledger_parties
  is 'Managed one-to-one compatibility bridge. Business Partner is the user-facing source of truth; Ledger party is synchronized automatically.';
comment on table public.ledger_supplier_party_mappings
  is 'Derived legacy compatibility cache for supplier-name to Ledger-party mapping. Do not manage as a separate user-facing master.';
