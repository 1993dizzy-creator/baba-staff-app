-- Regular partner duplicate guard: names that differ only by Vietnamese accents / tone-mark
-- position, case, spacing or Unicode composition are the same partner name
-- (e.g. "THỦY NAM" = "Thuỷ Nam"). Same rule as lib/inventory/normalize.ts
-- normalizeVietnameseText: trim, lower, NFD, strip U+0300–U+036F, đ→d, collapse spaces.
--
-- - business_partners_name_key_unique covers active and inactive partners, so create,
--   rename and 등록대기 create_partner (business_partner_create_v4 / update_v4 /
--   review_supplier_alias_v4) hit unique_violation → their existing 'duplicate_name' status,
--   also under concurrent submits or retries. Those RPCs are unchanged.
-- - business_partner_resolve_inventory_supplier_v1 (inventory direct supplier input) is NOT
--   changed: it still links only an explicitly chosen partner, an exact (case/trim) name match
--   or an exact candidate an admin already linked. A name that matches only after removing
--   accents (Thuy Nam → Thuỷ Nam, Cho → Chợ) is never linked automatically; it stays a 등록대기
--   candidate and the screen suggests the existing partner for the staff to choose.
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
