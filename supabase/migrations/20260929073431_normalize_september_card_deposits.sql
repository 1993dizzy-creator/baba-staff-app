-- Rebuild the September 2026 card deposits using the current FIFO principal rule.
-- This is deliberately tied to the observed Production state and aborts on drift.
-- Historical transactions and movements remain in place for audit purposes.
do $normalize_september_card_deposits$
declare
  v_month constant date := date '2026-09-01';
  v_next_month constant date := date '2026-10-01';
  v_difference constant numeric := 2103353;
  v_clearing_id bigint;
  v_actor_id bigint;
  v_before_balance numeric;
  v_after_balance numeric;
  v_before_september_outstanding numeric;
  v_after_september_outstanding numeric;
  v_count integer;
  v_legacy_count integer;
  v_auto_count integer;
  v_difference_count integer;
  v_difference_total numeric;
  v_remaining numeric;
  v_allocation numeric;
  v_rec record;
  v_sale record;
  v_reason constant text := '20260929110000: replace legacy September card gross matching with date-ordered FIFO deposit principal; defer the historical difference to month-end card fee confirmation';
begin
  -- Keep the same lock order as the card deposit and month-close RPCs.
  perform pg_advisory_xact_lock(hashtext('ledger_month_close:2026-09'));
  if public.ledger_month_is_closed_v1(v_month) then
    raise exception 'SEPTEMBER_CARD_NORMALIZATION_MONTH_CLOSED';
  end if;
  perform pg_advisory_xact_lock(hashtext('ledger_card_clearing_balance'));

  select id into v_clearing_id
  from public.ledger_fund_accounts
  where code = 'card_clearing' and is_active = true
  for update;
  if v_clearing_id is null then
    raise exception 'SEPTEMBER_CARD_NORMALIZATION_CLEARING_MISSING';
  end if;
  if exists (
    select 1 from public.ledger_card_fee_closures
    where fee_month = v_month and status = 'confirmed'
  ) then
    raise exception 'SEPTEMBER_CARD_NORMALIZATION_FEE_ALREADY_CONFIRMED';
  end if;

  perform 1 from public.ledger_card_reconciliations
  where deposit_date >= v_month and deposit_date < v_next_month and status <> 'cancelled'
  order by id for update;
  perform 1 from public.ledger_transactions
  where status = 'confirmed' and source_type = 'pos_sales_daily_payment'
    and source_key like 'pos:%:card' and business_date < v_next_month
  order by id for update;

  select count(*), count(*) filter (where status = 'matched'),
         count(*) filter (where status = 'auto_allocated')
  into v_count, v_legacy_count, v_auto_count
  from public.ledger_card_reconciliations
  where deposit_date >= v_month and deposit_date < v_next_month and status <> 'cancelled';
  if v_count <> 15 or v_legacy_count <> 6 or v_auto_count <> 9 then
    raise exception 'SEPTEMBER_CARD_NORMALIZATION_RECONCILIATION_DRIFT: %, %, %',
      v_count, v_legacy_count, v_auto_count;
  end if;
  if exists (
    select 1 from public.ledger_card_reconciliations r
    left join public.ledger_card_reconciliation_lines l on l.reconciliation_id = r.id
    where r.deposit_date >= v_month and r.deposit_date < v_next_month
      and r.status <> 'cancelled'
    group by r.id
    having coalesce(sum(l.allocated_gross_amount), 0) <> r.matched_gross_amount
      or (r.status = 'matched' and r.difference_amount <> r.matched_gross_amount - r.deposit_amount)
      or (r.status = 'auto_allocated' and (r.difference_amount <> 0
        or r.matched_gross_amount <> r.deposit_amount))
  ) then
    raise exception 'SEPTEMBER_CARD_NORMALIZATION_LINE_DRIFT';
  end if;

  select count(*), coalesce(sum(amount), 0)
  into v_difference_count, v_difference_total
  from public.ledger_transactions
  where source_type = 'card_settlement_difference'
    and status = 'confirmed' and business_date >= v_month and business_date < v_next_month;
  if v_difference_count <> 6 or v_difference_total <> v_difference then
    raise exception 'SEPTEMBER_CARD_NORMALIZATION_DIFFERENCE_DRIFT: %, %',
      v_difference_count, v_difference_total;
  end if;
  if exists (
    select 1 from public.ledger_card_reconciliations r
    left join public.ledger_transactions d
      on d.source_type = 'card_settlement_difference'
     and d.source_key = 'card-reconciliation:' || r.id || ':difference'
     and d.status = 'confirmed'
    where r.deposit_date >= v_month and r.deposit_date < v_next_month
      and r.status = 'matched'
      and (d.id is null or d.amount <> r.difference_amount
        or d.recognition_month <> v_month
        or d.source_snapshot->>'reconciliationId' <> r.id::text)
  ) then
    raise exception 'SEPTEMBER_CARD_NORMALIZATION_DIFFERENCE_LINK_DRIFT';
  end if;
  if exists (
    select 1 from public.ledger_card_reconciliations r
    join public.ledger_transactions d
      on d.id = r.deposit_transaction_id
    where r.deposit_date >= v_month and r.deposit_date < v_next_month
      and r.status <> 'cancelled'
      and (d.status <> 'confirmed' or d.source_type <> 'card_settlement_deposit'
        or d.amount <> r.deposit_amount or d.business_date <> r.deposit_date)
  ) then
    raise exception 'SEPTEMBER_CARD_NORMALIZATION_DEPOSIT_DRIFT';
  end if;

  -- Snapshots are temporary; the audit rows below retain before/after JSON permanently.
  create temporary table september_card_recs_before on commit drop as
  select r.*,
    coalesce((select jsonb_agg(to_jsonb(l) order by l.id)
              from public.ledger_card_reconciliation_lines l
              where l.reconciliation_id = r.id), '[]'::jsonb) as lines_before,
    to_jsonb(d) as deposit_before,
    coalesce((select jsonb_agg(to_jsonb(m) order by m.id)
              from public.ledger_movements m
              where m.transaction_id = d.id), '[]'::jsonb) as deposit_movements_before
  from public.ledger_card_reconciliations r
  join public.ledger_transactions d on d.id = r.deposit_transaction_id
  where r.deposit_date >= v_month and r.deposit_date < v_next_month
    and r.status <> 'cancelled';

  create temporary table september_card_differences_before on commit drop as
  select t.*,
    coalesce((select jsonb_agg(to_jsonb(m) order by m.id)
              from public.ledger_movements m where m.transaction_id = t.id), '[]'::jsonb) as movements_before
  from public.ledger_transactions t
  where t.source_type = 'card_settlement_difference'
    and t.status = 'confirmed' and t.business_date >= v_month and t.business_date < v_next_month;

  create temporary table september_card_august_consumed_before on commit drop as
  select t.id, public.ledger_card_sale_consumed_v1(t.id) as consumed_before
  from public.ledger_transactions t
  where t.source_type = 'pos_sales_daily_payment'
    and t.source_key like 'pos:%:card' and t.business_date < v_month;

  select coalesce(sum(t.amount - public.ledger_card_sale_consumed_v1(t.id)), 0)
  into v_before_september_outstanding
  from public.ledger_transactions t
  where t.status = 'confirmed' and t.source_type = 'pos_sales_daily_payment'
    and t.source_key like 'pos:%:card'
    and t.business_date >= v_month and t.business_date < v_next_month;

  select coalesce(sum(m.amount), 0) into v_before_balance
  from public.ledger_movements m
  join public.ledger_transactions t on t.id = m.transaction_id
  where m.fund_account_id = v_clearing_id and t.status = 'confirmed';
  if v_before_balance <> 26217549 then
    raise exception 'SEPTEMBER_CARD_NORMALIZATION_BALANCE_DRIFT: %', v_before_balance;
  end if;

  -- Other months' reconciliation and fee lines remain in place; they form the
  -- already-consumed amount read by ledger_card_sale_consumed_v1 for each sale.
  delete from public.ledger_card_reconciliation_lines l
  using september_card_recs_before b
  where l.reconciliation_id = b.id;

  update public.ledger_transactions t
  set status = 'cancelled', updated_at = now()
  from september_card_differences_before b
  where t.id = b.id;

  update public.ledger_card_reconciliations r
  set status = 'auto_allocated', matched_gross_amount = r.deposit_amount,
      difference_amount = 0, confirmed_at = null, confirmed_by = null,
      updated_at = now()
  from september_card_recs_before b
  where r.id = b.id;

  -- Identical principal rule to ledger_create_card_deposit_auto_allocate_v1:
  -- sales on/before deposit date, business_date/id FIFO, outstanding after all
  -- non-cancelled deposit lines and active fee lines, min(remaining, outstanding).
  for v_rec in
    select id, deposit_date, deposit_amount
    from september_card_recs_before
    order by deposit_date, id
  loop
    v_remaining := v_rec.deposit_amount;
    for v_sale in
      select t.id, t.amount - public.ledger_card_sale_consumed_v1(t.id) as outstanding
      from public.ledger_transactions t
      where t.status = 'confirmed' and t.source_type = 'pos_sales_daily_payment'
        and t.source_key like 'pos:%:card' and t.business_date <= v_rec.deposit_date
        and t.amount - public.ledger_card_sale_consumed_v1(t.id) > 0
      order by t.business_date, t.id
    loop
      exit when v_remaining <= 0;
      v_allocation := least(v_remaining, v_sale.outstanding);
      insert into public.ledger_card_reconciliation_lines
        (reconciliation_id, pos_card_transaction_id, allocated_gross_amount)
      values (v_rec.id, v_sale.id, v_allocation);
      v_remaining := v_remaining - v_allocation;
    end loop;
    if v_remaining <> 0 then
      raise exception 'SEPTEMBER_CARD_NORMALIZATION_INSUFFICIENT_SALES: reconciliation %, remainder %',
        v_rec.id, v_remaining;
    end if;
  end loop;

  if exists (
    select 1 from september_card_recs_before b
    join public.ledger_card_reconciliations r on r.id = b.id
    left join public.ledger_card_reconciliation_lines l on l.reconciliation_id = r.id
    group by r.id, r.status, r.deposit_amount, r.matched_gross_amount,
      r.difference_amount, r.confirmed_at, r.confirmed_by
    having r.status <> 'auto_allocated' or r.matched_gross_amount <> r.deposit_amount
      or r.difference_amount <> 0 or r.confirmed_at is not null or r.confirmed_by is not null
      or coalesce(sum(l.allocated_gross_amount), 0) <> r.deposit_amount
  ) then
    raise exception 'SEPTEMBER_CARD_NORMALIZATION_RECONCILIATION_POSTCHECK_FAILED';
  end if;
  if exists (
    select 1 from september_card_differences_before b
    join public.ledger_transactions t on t.id = b.id
    where t.status <> 'cancelled'
      or (to_jsonb(t) - 'status' - 'updated_at')
         <> (to_jsonb(b) - 'status' - 'updated_at' - 'movements_before')
      or b.movements_before is distinct from
        coalesce((select jsonb_agg(to_jsonb(m) order by m.id)
                  from public.ledger_movements m where m.transaction_id = t.id), '[]'::jsonb)
  ) or exists (
    select 1 from public.ledger_transactions
    where source_type = 'card_settlement_difference' and status = 'confirmed'
      and business_date >= v_month and business_date < v_next_month
  ) then
    raise exception 'SEPTEMBER_CARD_NORMALIZATION_DIFFERENCE_POSTCHECK_FAILED';
  end if;
  if exists (
    select 1 from september_card_recs_before b
    join public.ledger_card_reconciliations r on r.id = b.id
    join public.ledger_transactions d on d.id = r.deposit_transaction_id
    where to_jsonb(d) <> b.deposit_before
      or b.deposit_movements_before is distinct from
        coalesce((select jsonb_agg(to_jsonb(m) order by m.id)
                  from public.ledger_movements m where m.transaction_id = d.id), '[]'::jsonb)
  ) then
    raise exception 'SEPTEMBER_CARD_NORMALIZATION_DEPOSIT_CHANGED';
  end if;
  if exists (
    select 1 from public.ledger_transactions t
    where t.source_type = 'pos_sales_daily_payment'
      and t.source_key like 'pos:%:card'
      and public.ledger_card_sale_consumed_v1(t.id) > t.amount
  ) then
    raise exception 'SEPTEMBER_CARD_NORMALIZATION_CARD_OVERALLOCATED';
  end if;
  if exists (
    select 1 from september_card_august_consumed_before b
    where public.ledger_card_sale_consumed_v1(b.id) <> b.consumed_before
  ) then
    raise exception 'SEPTEMBER_CARD_NORMALIZATION_AUGUST_CONSUMPTION_CHANGED';
  end if;

  select coalesce(sum(m.amount), 0) into v_after_balance
  from public.ledger_movements m
  join public.ledger_transactions t on t.id = m.transaction_id
  where m.fund_account_id = v_clearing_id and t.status = 'confirmed';
  if v_after_balance <> v_before_balance + v_difference or v_after_balance <> 28320902 then
    raise exception 'SEPTEMBER_CARD_NORMALIZATION_BALANCE_POSTCHECK_FAILED: %', v_after_balance;
  end if;
  select coalesce(sum(t.amount - public.ledger_card_sale_consumed_v1(t.id)), 0)
  into v_after_september_outstanding
  from public.ledger_transactions t
  where t.status = 'confirmed' and t.source_type = 'pos_sales_daily_payment'
    and t.source_key like 'pos:%:card'
    and t.business_date >= v_month and t.business_date < v_next_month;
  if v_after_september_outstanding <> v_before_september_outstanding + v_difference then
    raise exception 'SEPTEMBER_CARD_NORMALIZATION_FEE_OUTSTANDING_POSTCHECK_FAILED: %',
      v_after_september_outstanding;
  end if;

  -- An existing owner/master supplies the required actor FK; the reason makes
  -- clear that these writes were executed by this data migration.
  select u.id into v_actor_id from public.users u
  where lower(u.role::text) in ('owner', 'master')
    and u.is_active = true and u.app_login_enabled = true
  order by u.id limit 1;
  if v_actor_id is null then
    raise exception 'SEPTEMBER_CARD_NORMALIZATION_AUDIT_ACTOR_MISSING';
  end if;

  insert into public.ledger_audit_logs
    (actor_user_id, action, entity_type, entity_id, before_snapshot, after_snapshot, reason)
  select v_actor_id, 'september_card_deposit_fifo_normalized', 'card_reconciliation', b.id,
    jsonb_build_object('reconciliation', to_jsonb(b) - 'lines_before' - 'deposit_before' - 'deposit_movements_before',
      'lines', b.lines_before, 'depositTransaction', b.deposit_before,
      'depositMovements', b.deposit_movements_before),
    jsonb_build_object('reconciliation', to_jsonb(r),
      'lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.id)
                         from public.ledger_card_reconciliation_lines l
                         where l.reconciliation_id = r.id), '[]'::jsonb),
      'depositTransaction', to_jsonb(d),
      'depositMovements', coalesce((select jsonb_agg(to_jsonb(m) order by m.id)
                                    from public.ledger_movements m
                                    where m.transaction_id = d.id), '[]'::jsonb)),
    v_reason
  from september_card_recs_before b
  join public.ledger_card_reconciliations r on r.id = b.id
  join public.ledger_transactions d on d.id = r.deposit_transaction_id;

  insert into public.ledger_audit_logs
    (actor_user_id, action, entity_type, entity_id, before_snapshot, after_snapshot, reason)
  select v_actor_id, 'september_legacy_card_difference_cancelled', 'ledger_transaction', b.id,
    jsonb_build_object('transaction', to_jsonb(b) - 'movements_before', 'movements', b.movements_before),
    jsonb_build_object('transaction', to_jsonb(t),
      'movements', coalesce((select jsonb_agg(to_jsonb(m) order by m.id)
                            from public.ledger_movements m
                            where m.transaction_id = t.id), '[]'::jsonb)),
    v_reason
  from september_card_differences_before b
  join public.ledger_transactions t on t.id = b.id;

  insert into public.ledger_audit_logs
    (actor_user_id, action, entity_type, before_snapshot, after_snapshot, reason)
  values (v_actor_id, 'september_card_deposits_normalized', 'card_reconciliation_month',
    jsonb_build_object('month', v_month, 'reconciliationCount', v_count,
      'legacyDifferenceCount', v_difference_count, 'legacyDifferenceTotal', v_difference_total,
      'cardClearingBalance', v_before_balance,
      'septemberCardSaleOutstanding', v_before_september_outstanding),
    jsonb_build_object('month', v_month, 'reconciliationCount', v_count,
      'confirmedLegacyDifferenceCount', 0, 'cardClearingBalance', v_after_balance,
      'septemberCardSaleOutstanding', v_after_september_outstanding), v_reason);
end;
$normalize_september_card_deposits$;
