-- Correct identity and presentation for two existing September 6 expenses.
-- No amount, date, account movement, payable, or source evidence is changed.
do $september_6_identity$
declare
  v_manual public.ledger_transactions%rowtype;
  v_inventory public.ledger_transactions%rowtype;
  v_cho_party_id bigint;
  v_welfare_category_id bigint;
  v_shopee_party_id bigint;
  v_actor_id bigint;
begin
  perform pg_advisory_xact_lock(hashtext('ledger_month_close:2026-09'));
  perform pg_advisory_xact_lock(hashtext('ledger_inventory_candidate:inventory-log:10423'));
  if public.ledger_month_is_closed_v1(date '2026-09-01') then
    raise exception 'SEPTEMBER_6_IDENTITY_MONTH_CLOSED';
  end if;

  select id into strict v_cho_party_id
  from public.ledger_parties
  where name = 'Chợ' and is_active = true;
  select id into strict v_welfare_category_id
  from public.ledger_categories
  where name = '보험·복리후생' and kind = 'expense' and is_active = true;
  select mapping.party_id into strict v_shopee_party_id
  from public.ledger_supplier_party_mappings mapping
  join public.ledger_parties party on party.id = mapping.party_id
  where lower(btrim(mapping.supplier_name)) = 'shopee'
    and lower(btrim(party.name)) = 'shopee'
    and mapping.is_active = true and party.is_active = true;

  select * into strict v_manual
  from public.ledger_transactions where id = 1767 for update;
  if v_manual.source_type <> 'manual' or v_manual.type <> 'expense'
     or v_manual.status <> 'confirmed' or v_manual.correction_of_id is not null
     or v_manual.business_date <> date '2026-09-06'
     or v_manual.amount <> 515000
     or (select count(*) from public.ledger_movements movement
         join public.ledger_fund_accounts account on account.id = movement.fund_account_id
         where movement.transaction_id = v_manual.id
           and movement.amount = -515000 and account.type = 'cash') <> 1 then
    raise exception 'SEPTEMBER_6_MANUAL_PRECONDITION_FAILED';
  end if;

  select * into strict v_inventory
  from public.ledger_transactions t
  where t.source_snapshot->>'inventory_log_id' = '10423'
    and t.status = 'confirmed'
  for update;
  if v_inventory.source_type not in ('inventory_purchase_candidate', 'inventory_purchase_rebook')
     or v_inventory.type <> 'expense'
     or v_inventory.business_date <> date '2026-09-06'
     or v_inventory.amount <> 153000
     or v_inventory.party_id is not null and v_inventory.party_id <> v_shopee_party_id
     or not exists (
       select 1 from public.inventory_logs log
       where log.id = 10423 and log.item_id = 591
         and log.business_date = date '2026-09-06'
         and log.reason = 'purchase'
     )
     or not exists (
       select 1 from public.inventory_logs log
       where log.id = 10427 and log.item_id = 591
         and log.business_date = date '2026-09-06'
         and log.source = 'edit_form'
         and lower(btrim(log.new_supplier)) = 'shopee'
     )
     or not exists (
       select 1 from public.ledger_candidates candidate
       where candidate.source_type = 'inventory_purchase_log'
         and candidate.source_key = 'inventory-log:10423'
         and candidate.status = 'confirmed'
         and candidate.resolved_transaction_id = v_inventory.id
     )
     or exists (select 1 from public.ledger_payables payable
                where payable.expense_transaction_id = v_inventory.id) then
    raise exception 'SEPTEMBER_6_SHOPEE_PRECONDITION_FAILED';
  end if;

  -- The audit table requires an actor FK. Identify a current owner/master and
  -- state in the reason that this data migration, not that user, made the change.
  select id into v_actor_id from public.users
  where lower(role::text) in ('owner', 'master')
    and is_active = true and app_login_enabled = true
  order by id limit 1;
  if v_actor_id is null then raise exception 'SEPTEMBER_6_AUDIT_ACTOR_MISSING'; end if;

  update public.ledger_transactions
  set display_snapshot = coalesce(display_snapshot, '{}'::jsonb)
        || jsonb_build_object('titleOverride', '야유회 돼지고기 구입'),
      memo = '7~8일 직원 야유회용 시장 구매',
      party_id = v_cho_party_id,
      category_id = v_welfare_category_id,
      updated_at = now()
  where id = v_manual.id;
  insert into public.ledger_audit_logs
    (actor_user_id, action, entity_type, entity_id, before_snapshot, after_snapshot, reason)
  values (v_actor_id, 'september_6_manual_identity_corrected', 'transaction', v_manual.id,
    to_jsonb(v_manual),
    (select to_jsonb(t) from public.ledger_transactions t where t.id = v_manual.id),
    'Data migration: September 6 pork was bought for the September 7–8 employee outing; no Inventory purchase was created.');

  if v_inventory.party_id is distinct from v_shopee_party_id then
    update public.ledger_transactions
    set party_id = v_shopee_party_id, updated_at = now()
    where id = v_inventory.id;
    insert into public.ledger_audit_logs
      (actor_user_id, action, entity_type, entity_id, before_snapshot, after_snapshot, reason)
    values (v_actor_id, 'september_6_inventory_supplier_linked', 'transaction', v_inventory.id,
      to_jsonb(v_inventory),
      (select to_jsonb(t) from public.ledger_transactions t where t.id = v_inventory.id),
      'Data migration: Inventory log #10423 supplier was updated to Shopee after confirmation; source evidence and economics remain unchanged.');
  end if;
end;
$september_6_identity$;
