begin;

-- Future source-only exception. No subtype creation, partner move or historical backfill.
create table inventory_ledger_private.purchase_category_rules (
  item_id bigint not null references public.inventory(id) on delete restrict,
  supplier_partner_id bigint not null references public.business_partners(id) on delete restrict,
  category_id bigint not null references public.ledger_categories(id) on delete restrict,
  starts_at timestamptz not null default clock_timestamp(),
  primary key (item_id, supplier_partner_id)
);
alter table inventory_ledger_private.purchase_category_rules enable row level security;
revoke all on table inventory_ledger_private.purchase_category_rules from public, anon, authenticated, service_role;

-- Fail rather than silently treating a reused ID as the gas rule.
do $dependencies$
begin
  if not exists(select 1 from public.inventory where id=342 and supplier_partner_id=21)
    or not exists(select 1 from public.business_partners where id=21 and name='Cửa hàng gas petrolimex chính hãng' and is_active and payment_mode='postpaid')
    or not exists(select 1 from public.business_partner_ledger_parties where business_partner_id=21 and ledger_party_id=21)
    or not exists(select 1 from public.ledger_parties where id=21 and default_category_id=23 and is_active)
    or not exists(select 1 from public.ledger_categories where id=23 and name='가스비' and kind='expense' and is_active)
  then raise exception 'GAS_PURCHASE_CATEGORY_DEPENDENCY_MISMATCH'; end if;
end;
$dependencies$;
insert into inventory_ledger_private.purchase_category_rules(item_id,supplier_partner_id,category_id) values(342,21,23);

-- Use the immutable original receipt's explicit IDs, never supplier-name matching or
-- current inventory master values. Backdated receipts and pre-rollout receipts fall back.
create function inventory_ledger_private.purchase_category_for_new_source_v1(p_snapshot jsonb,p_fallback bigint)
returns bigint language sql stable security invoker set search_path=pg_catalog,public as $$
  select coalesce((
    select r.category_id
    from public.inventory_logs l
    join inventory_ledger_private.purchase_category_rules r
      on r.item_id=l.item_id and r.supplier_partner_id=l.purchase_supplier_partner_id
    join public.ledger_categories c on c.id=r.category_id and c.kind='expense' and c.is_active
    where l.id=(p_snapshot->>'inventory_log_id')::bigint
      and l.item_id=(p_snapshot->>'item_id')::bigint
      and l.purchase_supplier_partner_id=(p_snapshot->>'purchase_supplier_partner_id')::bigint
      and l.correction_of_inventory_log_id is null and l.reason='purchase' and l.change_quantity>0
      and l.created_at>=r.starts_at
      and l.business_date>=((r.starts_at at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date
    limit 1
  ),p_fallback);
$$;
alter function inventory_ledger_private.purchase_category_for_new_source_v1(jsonb,bigint) owner to postgres;
revoke all on function inventory_ledger_private.purchase_category_for_new_source_v1(jsonb,bigint) from public,anon,authenticated,service_role;

-- Amend ONLY the known Production bodies in place at the category lookup. Preserve all
-- existing locking, permission, month-close, metadata, correction, payable and audit code.
-- Important: pg_get_functiondef() currently returns CRLF inside both deployed bodies;
-- SQL file dollar-quoted anchors may use LF or CRLF. Normalize ONLY the anchor/addition, NEVER the
-- deployed function definition. Abort the transaction on ANY unexpected body/anchor.
do $contract$
declare
  signature text;
  definition text;
  expected_md5 text;
  matched_anchor text;
  matched_addition text;
  anchor text := $anchor$    select ledger_category_id into v_category_id
    from public.ledger_inventory_category_mappings
    where is_active = true
      and lower(btrim(inventory_category)) = lower(btrim(v_snapshot->>'category'))
    limit 1;$anchor$;
  addition text := $addition$
    if v_latest.id is null then
      v_category_id := inventory_ledger_private.purchase_category_for_new_source_v1(v_snapshot,v_category_id);
    end if;$addition$;
begin
  -- Normalize migration literals before deriving either stored-body format.
  anchor := replace(anchor,chr(13)||chr(10),chr(10));
  addition := replace(addition,chr(13)||chr(10),chr(10));
  foreach signature in array array[
    'inventory_ledger_private.sync_candidate(jsonb,bigint)',
    'public.ledger_sync_inventory_candidates_core_v1(jsonb,bigint)'
  ] loop
    definition := pg_get_functiondef(signature::regprocedure);
    expected_md5 := case signature
      when 'inventory_ledger_private.sync_candidate(jsonb,bigint)'
        then 'fe28c88c30a1a3a55f756018a25eeec9'
      when 'public.ledger_sync_inventory_candidates_core_v1(jsonb,bigint)'
        then '3a5059d9faf63b73d9c116414d538a17'
      else null
    end;
    if expected_md5 is null or md5(definition) <> expected_md5 then
      raise exception 'GAS_PURCHASE_FUNCTION_VERSION_MISMATCH: %',signature;
    end if;

    -- Match LF or CRLF as actually stored, without rewriting unrelated function text.
    matched_anchor := case
      when strpos(definition,anchor)>0 then anchor
      when strpos(definition,replace(anchor,chr(10),chr(13)||chr(10)))>0
        then replace(anchor,chr(10),chr(13)||chr(10))
      else null
    end;
    if matched_anchor is null
      or (length(definition)-length(replace(definition,matched_anchor,'')))/length(matched_anchor)<>1 then
      raise exception 'GAS_PURCHASE_CATEGORY_CONTRACT_MISMATCH: %',signature;
    end if;
    matched_addition := case when matched_anchor=anchor then addition
      else replace(addition,chr(10),chr(13)||chr(10)) end;
    execute replace(definition,matched_anchor,matched_anchor||matched_addition);

    if signature='public.ledger_sync_inventory_candidates_core_v1(jsonb,bigint)' then
      definition := pg_get_functiondef(signature::regprocedure);
      anchor := $party$    if coalesce(v_snapshot->>'item_id', '') ~ '^[0-9]+$' then$party$;
      if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
        raise exception 'GAS_PURCHASE_PARTY_CONTRACT_MISMATCH: %',signature;
      end if;
      addition := $party$    if inventory_ledger_private.purchase_category_for_new_source_v1(v_snapshot,null)=23 then
      select blp.ledger_party_id into v_party_id
      from public.inventory_logs l
      join public.business_partners bp on bp.id=l.purchase_supplier_partner_id and bp.is_active
      join public.business_partner_ledger_parties blp on blp.business_partner_id=bp.id
      where l.id=(v_snapshot->>'inventory_log_id')::bigint;
    elsif coalesce(v_snapshot->>'item_id', '') ~ '^[0-9]+$' then$party$;
      addition := replace(addition,chr(13)||chr(10),chr(10));
      -- Preserve the stored-body format for the inserted party block too.
      if matched_anchor<>replace(matched_anchor,chr(13)||chr(10),chr(10)) then
        addition := replace(addition,chr(10),chr(13)||chr(10));
      end if;
      execute replace(definition,anchor,addition);
    end if;
  end loop;
end;
$contract$;
commit;
