-- Historical classification and presentation correction. No transaction amount,
-- movement, payable allocation, or source_snapshot is changed.
do $historical_ledger_display$
declare
  v_legacy_category public.ledger_categories%rowtype;
  v_insurance_id bigint;
  v_welfare_id bigint;
  v_equipment public.ledger_categories%rowtype;
  v_rent public.ledger_categories%rowtype;
  v_actor_id bigint;
  v_tx public.ledger_transactions%rowtype;
  v_outing public.ledger_transactions%rowtype;
  v_rental public.ledger_transactions%rowtype;
  v_purchase public.ledger_transactions%rowtype;
  v_payment public.ledger_transactions%rowtype;
  v_difference public.ledger_transactions%rowtype;
  v_payable public.ledger_payables%rowtype;
  v_welfare_count integer := 0;
  v_reason text := 'Data migration: separate employee welfare from insurance and correct September historical ledger display; accounting amounts and movements unchanged';
begin
  perform pg_advisory_xact_lock(hashtext('ledger_month_close:2026-09'));
  if public.ledger_month_is_closed_v1(date '2026-09-01') then
    raise exception 'HISTORICAL_LEDGER_DISPLAY_MONTH_CLOSED';
  end if;

  select * into strict v_legacy_category from public.ledger_categories where id = 21;
  select * into strict v_rent from public.ledger_categories where id = 3;
  select * into strict v_equipment from public.ledger_categories where id = 26;
  if v_legacy_category.name <> '보험·복리후생' or v_legacy_category.kind <> 'expense'
     or v_legacy_category.is_active is distinct from true
     or v_legacy_category.parent_id is distinct from
       (select id from public.ledger_categories where name = '인건비' and kind = 'expense')
     or v_rent.name <> '임대료' or v_rent.kind <> 'expense'
     or v_equipment.name <> '설비·비품' or v_equipment.kind <> 'expense'
     or exists (select 1 from public.ledger_categories where kind = 'expense' and name in ('보험','복리후생')) then
    raise exception 'HISTORICAL_LEDGER_DISPLAY_CATEGORY_PRECONDITION_FAILED';
  end if;

  if (select count(*) from public.ledger_transactions
      where id in (1104,1110,1111) and category_id = 21
        and status = 'confirmed' and business_date >= date '2026-08-01'
        and business_date < date '2026-09-01' and source_type = 'legacy_sheet_detail') <> 3
     or (select count(*) from public.ledger_transactions
         where id in (1446,1447) and category_id = 21 and type = 'expense'
           and status = 'confirmed' and business_date >= date '2026-08-01'
           and business_date < date '2026-09-01'
           and lower(btrim(memo)) = 'bhxh') <> 2 then
    raise exception 'HISTORICAL_LEDGER_DISPLAY_AUGUST_LEGACY_PRECONDITION_FAILED';
  end if;

  if (select count(*) from public.ledger_transactions
      where id in (1644,1649,1650,1651,1659,1671,1672,1767)) <> 8 then
    raise exception 'HISTORICAL_LEDGER_DISPLAY_WELFARE_COUNT_PRECONDITION_FAILED';
  end if;

  select * into strict v_outing from public.ledger_transactions where id = 1767 for update;
  if v_outing.source_type <> 'manual' or v_outing.type <> 'expense'
     or v_outing.status <> 'confirmed' or v_outing.business_date <> date '2026-09-06'
     or v_outing.amount <> 515000 or v_outing.category_id <> 21
     or v_outing.display_snapshot->>'titleOverride' <> '야유회 돼지고기 구입'
     or (select count(*) from public.ledger_movements m
         join public.ledger_fund_accounts a on a.id = m.fund_account_id
         where m.transaction_id = 1767 and m.amount = -515000 and a.type = 'cash') <> 1 then
    raise exception 'HISTORICAL_LEDGER_DISPLAY_OUTING_PRECONDITION_FAILED';
  end if;

  select * into strict v_purchase from public.ledger_transactions where id = 931 for update;
  select * into strict v_payment from public.ledger_transactions where id = 1640 for update;
  select * into strict v_difference from public.ledger_transactions where id = 1643 for update;
  select * into strict v_payable from public.ledger_payables
  where expense_transaction_id = 931 for update;
  if v_purchase.type <> 'expense' or v_purchase.status <> 'confirmed'
     or v_purchase.business_date <> date '2026-09-11'
     or v_purchase.amount <> 11862000 or v_purchase.category_id is null
     or exists (select 1 from public.ledger_movements where transaction_id = 931)
     or v_payable.original_amount <> 11862000
     or v_payable.party_id is distinct from v_purchase.party_id
     or v_payment.type <> 'payable_payment' or v_payment.status <> 'confirmed'
     or v_payment.business_date <> date '2026-09-11'
     or v_payment.amount <> 11862000 or v_payment.category_id is not null
     or v_payment.party_id is distinct from v_purchase.party_id
     or (select coalesce(sum(a.allocated_amount),0) from public.ledger_payable_allocations a
         where a.payable_id = v_payable.id and a.payment_transaction_id = 1640) <> 11862000
     or (select count(*) from public.ledger_movements where transaction_id = 1640 and amount = -11862000) <> 1
     or v_difference.source_type <> 'manual' or v_difference.type <> 'expense'
     or v_difference.status <> 'confirmed' or v_difference.business_date <> date '2026-09-11'
     or v_difference.amount <> 600
     or not exists (select 1 from public.ledger_categories c
                    where c.id = v_difference.category_id and c.kind = 'expense')
     or (select count(*) from public.ledger_movements where transaction_id = 1643 and amount = -600) <> 1
     or (select fund_account_id from public.ledger_movements where transaction_id = 1640 and amount = -11862000 limit 1)
        is distinct from
        (select fund_account_id from public.ledger_movements where transaction_id = 1643 and amount = -600 limit 1)
     or not exists (select 1 from public.ledger_parties p
                    where p.id = v_payment.party_id and p.name = 'Mega Market') then
    raise exception 'HISTORICAL_LEDGER_DISPLAY_MEGA_PRECONDITION_FAILED';
  end if;

  select * into strict v_rental from public.ledger_transactions where id = 1657 for update;
  if v_rental.source_type <> 'manual' or v_rental.type <> 'expense'
     or v_rental.status <> 'confirmed' or v_rental.business_date <> date '2026-09-11'
     or v_rental.amount <> 2100000 or v_rental.category_id <> 3
     or (select count(*) from public.ledger_movements m
         join public.ledger_fund_accounts a on a.id = m.fund_account_id
         where m.transaction_id = 1657 and m.amount = -2100000
           and a.code = 'baba_corporate_bank') <> 1 then
    raise exception 'HISTORICAL_LEDGER_DISPLAY_RENTAL_PRECONDITION_FAILED';
  end if;

  -- Audit rows require an actor FK; the reason states that the migration made
  -- these changes, not the user whose id anchors the audit record.
  select id into v_actor_id from public.users
  where lower(role::text) in ('owner','master')
    and is_active = true and app_login_enabled = true
  order by id limit 1;
  if v_actor_id is null then raise exception 'HISTORICAL_LEDGER_DISPLAY_AUDIT_ACTOR_MISSING'; end if;

  insert into public.ledger_categories(name,kind,parent_id,cost_behavior,is_active)
  values ('보험','expense',v_legacy_category.parent_id,v_legacy_category.cost_behavior,true)
  returning id into v_insurance_id;
  insert into public.ledger_categories(name,kind,parent_id,cost_behavior,is_active)
  values ('복리후생','expense',v_legacy_category.parent_id,v_legacy_category.cost_behavior,true)
  returning id into v_welfare_id;
  update public.ledger_categories set is_active = false where id = 21;
  insert into public.ledger_audit_logs
    (actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
  values (v_actor_id,'ledger_insurance_welfare_category_split','category',21,
    to_jsonb(v_legacy_category),
    (select to_jsonb(c) from public.ledger_categories c where c.id = 21)
      || jsonb_build_object('newInsuranceCategoryId',v_insurance_id,'newWelfareCategoryId',v_welfare_id),v_reason);
  insert into public.ledger_audit_logs
    (actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
  values
    (v_actor_id,'ledger_insurance_category_created','category',v_insurance_id,null,
      (select to_jsonb(c) from public.ledger_categories c where c.id = v_insurance_id),v_reason),
    (v_actor_id,'ledger_welfare_category_created','category',v_welfare_id,null,
      (select to_jsonb(c) from public.ledger_categories c where c.id = v_welfare_id),v_reason);

  for v_tx in
    select * from public.ledger_transactions
    where id in (1644,1649,1650,1651,1659,1671,1672,1767)
    order by id for update
  loop
    if v_tx.category_id is distinct from 21 or v_tx.type is distinct from 'expense'
       or v_tx.status is distinct from 'confirmed'
       or v_tx.business_date is null or v_tx.business_date < date '2026-09-01'
       or v_tx.business_date >= date '2026-10-01'
       or v_tx.amount is null or v_tx.amount <= 0
       or v_tx.source_type is null or v_tx.source_type not in ('legacy_sheet_detail','manual')
       or coalesce(nullif(btrim(v_tx.memo),''),
                   nullif(btrim(v_tx.display_snapshot->>'titleOverride'),'')) is null
       or exists (select 1 from public.ledger_movements m
                  where m.transaction_id = v_tx.id
                  group by m.transaction_id having sum(m.amount) <> -v_tx.amount)
       or (v_tx.id = 1767 and (v_tx.source_type <> 'manual' or v_tx.amount <> 515000)) then
      raise exception 'HISTORICAL_LEDGER_DISPLAY_WELFARE_PRECONDITION_FAILED: %',v_tx.id;
    end if;
    update public.ledger_transactions
      set category_id = v_welfare_id, updated_at = now()
      where id = v_tx.id;
    insert into public.ledger_audit_logs
      (actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
    values (v_actor_id,'ledger_welfare_expense_reclassified','transaction',v_tx.id,
      to_jsonb(v_tx),
      (select to_jsonb(t) from public.ledger_transactions t where t.id = v_tx.id),v_reason);
    v_welfare_count := v_welfare_count + 1;
  end loop;
  if v_welfare_count <> 8 or
     (select count(*) from public.ledger_transactions
      where id in (1644,1649,1650,1651,1659,1671,1672,1767)
        and category_id = v_welfare_id) <> 8 or
     (select category_id from public.ledger_transactions where id = 1767) <> v_welfare_id then
    raise exception 'HISTORICAL_LEDGER_DISPLAY_OUTING_NOT_RECLASSIFIED';
  end if;

  update public.ledger_transactions
  set display_snapshot = coalesce(display_snapshot,'{}'::jsonb) ||
      jsonb_build_object('actualPaidAmount',11862600,
        'paymentDifferenceAmount',600,'linkedDifferenceTransactionId',1643),
      memo = 'Mega Market 실제 지급 · 차액 600₫ 포함',
      updated_at = now()
  where id = 1640;
  insert into public.ledger_audit_logs
    (actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
  values (v_actor_id,'ledger_mega_payment_display_linked','transaction',1640,
    to_jsonb(v_payment),
    (select to_jsonb(t) from public.ledger_transactions t where t.id = 1640),v_reason);

  update public.ledger_transactions
  set category_id = 26,
      display_snapshot = coalesce(display_snapshot,'{}'::jsonb) ||
        jsonb_build_object('titleOverride','정수기·필터기 임대'),
      updated_at = now()
  where id = 1657;
  insert into public.ledger_audit_logs
    (actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
  values (v_actor_id,'ledger_water_filter_equipment_reclassified','transaction',1657,
    to_jsonb(v_rental),
    (select to_jsonb(t) from public.ledger_transactions t where t.id = 1657),v_reason);
end;
$historical_ledger_display$;
