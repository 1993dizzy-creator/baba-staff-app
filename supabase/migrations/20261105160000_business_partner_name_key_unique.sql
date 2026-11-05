-- Regular partner duplicate guard: names that differ only by Vietnamese accents / tone-mark
-- position, case, spacing or Unicode composition are the same partner
-- (e.g. "THỦY NAM" = "Thuỷ Nam"). Same rule as lib/inventory/normalize.ts
-- normalizeVietnameseText: trim, lower, NFD, strip U+0300–U+036F, đ→d, collapse spaces.
--
-- - business_partners_name_key_unique covers active and inactive partners, so create,
--   rename and 등록대기 create_partner (business_partner_create_v4 / update_v4 /
--   review_supplier_alias_v4) hit unique_violation → their existing 'duplicate_name' status,
--   also under concurrent submits or retries. Those RPCs are unchanged.
-- - business_partner_resolve_inventory_supplier_v1 (inventory direct supplier input) now finds
--   the active partner / existing candidate by the same key instead of creating a new
--   등록대기 candidate for a spelling variant.
-- No existing row is changed: partner IDs, aliases, inventory, ledger, payables and audit logs
-- stay as they are. The migration stops if existing partners already collide.

create or replace function public.business_partner_name_key(p_name text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select nullif(regexp_replace(replace(regexp_replace(normalize(lower(btrim(coalesce(p_name, ''))), NFD),
    '[̀-ͯ]', '', 'g'), 'đ', 'd'), '\s+', ' ', 'g'), '')
$$;

do $$
declare v_collisions text;
begin
  select string_agg(format('%s: %s', key, ids), '; ') into v_collisions
  from (
    select public.business_partner_name_key(name) as key, string_agg('#' || id, ',' order by id) as ids
    from public.business_partners group by 1 having count(*) > 1
  ) duplicate_keys;
  if v_collisions is not null then
    raise exception 'business_partners already contain duplicate name keys: %', v_collisions;
  end if;
end;
$$;

create unique index business_partners_name_key_unique
  on public.business_partners (public.business_partner_name_key(name));

create or replace function public.business_partner_resolve_inventory_supplier_v1(p_supplier_name text, p_supplier_partner_id bigint, p_actor_user_id bigint)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_actor_exists boolean;
  v_name text := nullif(btrim(p_supplier_name), '');
  v_normalized text;
  v_key text;
  v_partner public.business_partners%rowtype;
  v_alias public.business_partner_supplier_aliases%rowtype;
  v_before jsonb;
begin
  select exists(
    select 1 from public.users
    where id = p_actor_user_id and is_active = true and app_login_enabled = true
  ) into v_actor_exists;
  if not v_actor_exists then return jsonb_build_object('status', 'forbidden'); end if;

  if p_supplier_partner_id is not null then
    select * into v_partner from public.business_partners
    where id = p_supplier_partner_id and is_active = true;
    if not found then return jsonb_build_object('status', 'invalid_partner'); end if;
    return jsonb_build_object('status', 'resolved', 'supplierName', v_partner.name, 'supplierPartnerId', v_partner.id);
  end if;

  if v_name is null then
    return jsonb_build_object('status', 'resolved', 'supplierName', null, 'supplierPartnerId', null);
  end if;
  v_normalized := lower(v_name);
  v_key := public.business_partner_name_key(v_name);

  -- An active regular partner with the same name key (accent/tone/case/space-insensitive).
  select * into v_partner from public.business_partners
  where public.business_partner_name_key(name) = v_key and is_active = true;
  if found then
    return jsonb_build_object('status', 'resolved', 'supplierName', v_partner.name, 'supplierPartnerId', v_partner.id);
  end if;

  -- Exact candidate first (unchanged), otherwise an existing candidate under the same key:
  -- a linked one first, then the oldest, so a spelling variant never opens a second 등록대기.
  -- Concurrent inputs of two spellings serialize on the key.
  perform pg_advisory_xact_lock(hashtext('business_partner_supplier_alias:' || v_key));
  select * into v_alias from public.business_partner_supplier_aliases
  where normalized_name = v_normalized for update;
  if not found then
    select * into v_alias from public.business_partner_supplier_aliases
    where public.business_partner_name_key(supplier_name) = v_key
    order by (status = 'linked') desc, (status = 'pending') desc, id
    limit 1 for update;
  end if;
  if found then
    if v_alias.status = 'archived' then
      v_before := to_jsonb(v_alias);
      update public.business_partner_supplier_aliases
        set status = 'pending', reviewed_at = null, reviewed_by = null, last_seen_at = now(), updated_at = now()
        where id = v_alias.id
        returning * into v_alias;
      insert into public.business_partner_supplier_alias_audit_logs(supplier_alias_id, actor_user_id, action, before_snapshot, after_snapshot)
      values(v_alias.id, p_actor_user_id, 'candidate_reactivated', v_before, to_jsonb(v_alias));
      return jsonb_build_object('status', 'resolved', 'supplierName', v_alias.supplier_name, 'supplierPartnerId', null, 'supplierAliasId', v_alias.id, 'aliasStatus', 'pending');
    end if;
    update public.business_partner_supplier_aliases
      set last_seen_at = now(), updated_at = now()
      where id = v_alias.id;
    if v_alias.status = 'linked' then
      select * into v_partner from public.business_partners
      where id = v_alias.business_partner_id and is_active = true;
      if found then
        return jsonb_build_object('status', 'resolved', 'supplierName', v_partner.name, 'supplierPartnerId', v_partner.id, 'supplierAliasId', v_alias.id, 'aliasStatus', 'linked');
      end if;
    end if;
    return jsonb_build_object('status', 'resolved', 'supplierName', v_alias.supplier_name, 'supplierPartnerId', null, 'supplierAliasId', v_alias.id, 'aliasStatus', v_alias.status);
  end if;

  insert into public.business_partner_supplier_aliases(supplier_name, normalized_name)
  values(v_name, v_normalized) returning * into v_alias;
  insert into public.business_partner_supplier_alias_audit_logs(supplier_alias_id, actor_user_id, action, after_snapshot)
  values(v_alias.id, p_actor_user_id, 'candidate_created', to_jsonb(v_alias));
  return jsonb_build_object('status', 'resolved', 'supplierName', v_alias.supplier_name, 'supplierPartnerId', null, 'supplierAliasId', v_alias.id, 'aliasStatus', 'pending');
exception
  when unique_violation then
    select * into v_alias from public.business_partner_supplier_aliases where normalized_name = v_normalized for update;
    if v_alias.status = 'archived' then
      v_before := to_jsonb(v_alias);
      update public.business_partner_supplier_aliases
        set status = 'pending', reviewed_at = null, reviewed_by = null, last_seen_at = now(), updated_at = now()
        where id = v_alias.id
        returning * into v_alias;
      insert into public.business_partner_supplier_alias_audit_logs(supplier_alias_id, actor_user_id, action, before_snapshot, after_snapshot)
      values(v_alias.id, p_actor_user_id, 'candidate_reactivated', v_before, to_jsonb(v_alias));
      return jsonb_build_object('status', 'resolved', 'supplierName', v_alias.supplier_name, 'supplierPartnerId', null, 'supplierAliasId', v_alias.id, 'aliasStatus', 'pending');
    end if;
    update public.business_partner_supplier_aliases set last_seen_at = now(), updated_at = now() where id = v_alias.id;
    if v_alias.status = 'linked' then
      select * into v_partner from public.business_partners where id = v_alias.business_partner_id and is_active = true;
      if found then
        return jsonb_build_object('status', 'resolved', 'supplierName', v_partner.name, 'supplierPartnerId', v_partner.id, 'supplierAliasId', v_alias.id, 'aliasStatus', 'linked');
      end if;
    end if;
    return jsonb_build_object('status', 'resolved', 'supplierName', v_alias.supplier_name, 'supplierPartnerId', null, 'supplierAliasId', v_alias.id, 'aliasStatus', v_alias.status);
end;
$function$;
