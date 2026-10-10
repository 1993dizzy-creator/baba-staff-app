-- Apply ONLY after the utilities-capable app has been deployed and verified.
-- Use one migration session with baba.migration_actor_user_id set to the actual
-- active owner/master performing this change. Never guess or impersonate an actor.
begin;
do $move$
declare
  partner public.business_partners%rowtype;
  actor_id bigint;
  before_snapshot jsonb;
begin
  select * into partner from public.business_partners where id=21 for update;
  if partner.id is null or partner.name<>'Cửa hàng gas petrolimex chính hãng'
    or partner.payment_mode<>'postpaid' or not partner.is_active then
    raise exception 'PETROLIMEX_PARTNER_IDENTITY_MISMATCH';
  end if;
  perform 1 from public.business_partner_subtypes
    where id=43 and code='utility_gas' and partner_type='utilities' and is_active for share;
  if not found then raise exception 'PETROLIMEX_UTILITY_GAS_SUBTYPE_MISMATCH'; end if;
  perform 1 from public.business_partner_ledger_parties
    where business_partner_id=21 and ledger_party_id=21 for share;
  if not found then raise exception 'PETROLIMEX_LEDGER_BRIDGE_MISMATCH'; end if;
  perform 1 from public.inventory where id=342 and supplier_partner_id=21 for share;
  if not found then raise exception 'PETROLIMEX_INVENTORY_BRIDGE_MISMATCH'; end if;
  perform 1 from public.ledger_parties where id=21 and default_category_id=23 and is_active for share;
  if not found then raise exception 'PETROLIMEX_LEDGER_CATEGORY_MISMATCH'; end if;
  if not exists(select 1 from inventory_ledger_private.purchase_category_rules
    where item_id=342 and supplier_partner_id=21 and category_id=23) then
    raise exception 'PETROLIMEX_CATEGORY_RULE_NOT_INSTALLED';
  end if;
  -- Safe no-op if a manager has already moved this exact partner using the new UI.
  if partner.partner_type='utilities' and partner.partner_subtype_id=43 then return; end if;
  if partner.partner_type<>'consumable' or partner.partner_subtype_id is not null then
    raise exception 'PETROLIMEX_CLASSIFICATION_CHANGED';
  end if;
  actor_id := nullif(current_setting('baba.migration_actor_user_id',true),'')::bigint;
  if actor_id is null or not exists(select 1 from public.users
    where id=actor_id and lower(role::text) in ('owner','master') and is_active and app_login_enabled) then
    raise exception 'PETROLIMEX_MIGRATION_OWNER_ACTOR_REQUIRED';
  end if;
  before_snapshot := to_jsonb(partner);
  update public.business_partners
    set partner_type='utilities',partner_subtype_id=43,updated_at=now() where id=21;
  insert into public.business_partner_audit_logs(business_partner_id,actor_user_id,action,before_snapshot,after_snapshot)
    values(21,actor_id,'updated',before_snapshot,
      (select to_jsonb(p) from public.business_partners p where p.id=21));
  -- All payment/settlement fields, links and historical receipts remain untouched.
end;
$move$;
commit;
