-- Backfill the missing 2026-11-18 / 2026-11-19 card deposits and put the three late-November deposits
-- (11/18, 11/19 and the already registered 11/20 #88) into deposit-date FIFO order.
-- NOT APPLIED: production application is reviewed by GPT and needs separate Owner approval.
-- Requires 20261120121505 (restoration of #80-#87) to be applied first.
--
-- Evidence (Owner sheet, verified with Production read-only on 2026-11-20):
--   11월!K291  2026-11-18  10,087,054 VND  -> not registered (no transaction / reconciliation with this amount)
--   11월!K306  2026-11-19  14,545,476 VND  -> not registered
--   11월!K327  2026-11-20   6,837,115 VND  -> registered by the app: transaction #5200 / reconciliation #88,
--                                            FIFO lines #262-#264 on the 11/15, 11/16, 11/17 sales
--   Card clearing 29,425,456 = outstanding card sales 11/17 5,395,356 + 11/18 20,167,700 + 11/19 3,862,400.
--
-- What the existing RPC covers and what it does not:
--   * Both deposits are created by the official ledger_create_card_deposit_auto_allocate_v1 (transaction,
--     card_clearing -> corporate bank movements, 'auto_allocated' reconciliation, its own audit row).
--     Because #88 already consumed the 11/15-11/17 sales, the RPC lets the 11/18 deposit take 11/17-11/18 and
--     the 11/19 deposit take 11/18. The per-sale consumption is then already the date-ordered result
--     (sale 11/18 keeps 930,526 and 11/19 keeps 3,862,400 = 4,792,926 = card clearing); only the
--     deposit owning each line is out of date order.
--   * The extra correction (the only non-RPC write): the allocation lines of exactly these three
--     reconciliations are re-planned in (deposit_date, id) order with the RPC's FIFO rule (sales dated on or
--     before the deposit's business date, business_date/id order). Each sale's total consumption is identical
--     before and after, so no balance, outstanding or fee figure moves. Expected result:
--       11/18 deposit: 11/15 226,971 + 11/16 1,717,600 + 11/17 8,142,483
--       11/19 deposit: 11/17 2,145,417 + 11/18 12,400,059
--       #88 (11/20):   11/18 6,837,115
--
-- Unchanged: #88's reconciliation row, deposit transaction #5200 and its movements; #80-#87 and every other
-- reconciliation and line; card fee closures/lines/expenses (Sept #1, October provisional #4119, audit #8257);
-- month closures; every existing audit row. No fee, no cancellation, no re-registration.
-- New audit rows: the RPC's two 'card_deposit_auto_allocated' rows, one 'card_deposit_allocation_resequenced'
-- row per re-planned reconciliation (before/after lines) and one 'november_card_deposits_backfilled' summary.
-- Any drift from the verified state aborts the whole migration without a partial write; a second run after a
-- successful one is a no-op.
do $backfill_november_card_deposits$
declare
  v_month constant date := date '2026-11-01';
  v_last_date constant date := date '2026-11-20';
  v_total constant numeric := 24632530;
  v_rec88 constant bigint := 88;
  v_tx88 constant bigint := 5200;
  v_amount88 constant numeric := 6837115;
  v_summary_action constant text := 'november_card_deposits_backfilled';
  v_line_action constant text := 'card_deposit_allocation_resequenced';
  v_reason constant text := '20261120134158: backfill sheet 11월!K291 (11/18) and K306 (11/19) card deposits and re-plan #88 and both in deposit-date FIFO order; balances and per-sale consumption unchanged';
  -- [deposit date, amount, sheet cell]
  v_deposits constant jsonb := '[
    {"date":"2026-11-18","amount":10087054,"cell":"K291"},
    {"date":"2026-11-19","amount":14545476,"cell":"K306"}
  ]';
  -- #88 as registered by the app (sale transaction id -> allocated gross).
  v_rec88_lines constant jsonb := '[{"sale":4985,"amount":226971},{"sale":5022,"amount":1717600},{"sale":5050,"amount":4892544}]';
  -- Late-November card sales: id, business date, gross, outstanding now (before this migration).
  v_sales constant jsonb := '[
    {"sale":4985,"date":"2026-11-15","amount":12890800,"outstanding":0},
    {"sale":5022,"date":"2026-11-16","amount":1717600,"outstanding":0},
    {"sale":5050,"date":"2026-11-17","amount":10287900,"outstanding":5395356},
    {"sale":5109,"date":"2026-11-18","amount":20167700,"outstanding":20167700},
    {"sale":5173,"date":"2026-11-19","amount":3862400,"outstanding":3862400}
  ]';
  -- Expected final lines by deposit date (independently computed; the migration's own plan must equal it).
  v_expected constant jsonb := '[
    {"date":"2026-11-18","sale":4985,"amount":226971},{"date":"2026-11-18","sale":5022,"amount":1717600},{"date":"2026-11-18","sale":5050,"amount":8142483},
    {"date":"2026-11-19","sale":5050,"amount":2145417},{"date":"2026-11-19","sale":5109,"amount":12400059},
    {"date":"2026-11-20","sale":5109,"amount":6837115}
  ]';
  v_expected_outstanding constant numeric := 4792926;
  v_current_month date := date_trunc('month', ((now() at time zone 'Asia/Ho_Chi_Minh') - interval '3 hours')::date)::date;
  v_lock_month date;
  v_clearing bigint;
  v_bank bigint;
  v_actor bigint;
  v_deposit jsonb;
  v_result jsonb;
  v_created jsonb := '[]'::jsonb;
  v_rec record;
  v_sale record;
  v_remaining numeric;
  v_take numeric;
  v_allocations jsonb;
  v_before_clearing numeric; v_after_clearing numeric;
  v_before_bank numeric; v_after_bank numeric;
  v_before_tx bigint; v_before_mv bigint;
  v_before_other text; v_before_fees text; v_before_audits text; v_before_audit_max bigint; v_before_rec88 text;
begin
  -- Same lock order as the deposit/match/cancel/settle RPCs: month close (ascending), then card clearing.
  perform pg_advisory_xact_lock(hashtext('ledger_month_close_serial'));
  for v_lock_month in select m from (
    select distinct date_trunc('month', business_date)::date m from public.ledger_transactions
    where status = 'confirmed' and source_type = 'pos_sales_daily_payment' and source_key like 'pos:%:card' and business_date <= v_last_date
    union select v_month union select v_current_month
  ) months order by m loop
    perform pg_advisory_xact_lock(hashtext('ledger_month_close'), hashtext(v_lock_month::text));
    perform pg_advisory_xact_lock(hashtext('ledger_month_close:' || to_char(v_lock_month, 'YYYY-MM')));
  end loop;
  perform pg_advisory_xact_lock(hashtext('ledger_card_clearing_balance'));

  select id into v_clearing from public.ledger_fund_accounts where code = 'card_clearing' and is_active = true;
  select id into v_bank from public.ledger_fund_accounts where code = 'baba_corporate_bank' and is_active = true and type <> 'card_clearing';
  if v_clearing is null or v_bank is null then
    raise exception 'NOVEMBER_CARD_BACKFILL_ACCOUNT_MISSING';
  end if;

  -- Already applied: the summary row exists and every line is the expected one. Never a second deposit.
  if exists (select 1 from public.ledger_audit_logs where action = v_summary_action) then
    if (select count(*) from public.ledger_card_reconciliations r
        where r.status = 'auto_allocated' and r.deposit_date in ('2026-11-18', '2026-11-19')
          and r.deposit_amount in (10087054, 14545476)) = 2
       and (select md5(string_agg(r.deposit_date::text || ':' || l.pos_card_transaction_id || ':' || trim_scale(l.allocated_gross_amount), '|'
              order by r.deposit_date, l.pos_card_transaction_id))
            from public.ledger_card_reconciliation_lines l join public.ledger_card_reconciliations r on r.id = l.reconciliation_id
            where r.id = v_rec88 or (r.status = 'auto_allocated' and r.deposit_date in ('2026-11-18', '2026-11-19') and r.deposit_amount in (10087054, 14545476)))
         = (select md5(string_agg((x->>'date') || ':' || (x->>'sale') || ':' || trim_scale((x->>'amount')::numeric), '|' order by x->>'date', (x->>'sale')::bigint))
            from jsonb_array_elements(v_expected) x)
    then
      raise notice 'NOVEMBER_CARD_BACKFILL_ALREADY_APPLIED';
      return;
    end if;
    raise exception 'NOVEMBER_CARD_BACKFILL_APPLIED_STATE_DRIFT';
  end if;

  ---------------------------------------------------------------------------
  -- Pre-checks: the exact verified state, nothing else.
  if public.ledger_month_is_closed_v1(v_month) then
    raise exception 'NOVEMBER_CARD_BACKFILL_MONTH_CLOSED';
  end if;
  if exists (select 1 from public.ledger_card_fee_closures c where c.status = 'confirmed' and c.fee_month >= v_month) then
    raise exception 'NOVEMBER_CARD_BACKFILL_FEE_ALREADY_CONFIRMED';
  end if;
  -- 20261120121505 must have run: no unresolved legacy deposit may remain.
  if exists (select 1 from public.ledger_card_reconciliations where status in ('unmatched', 'partial'))
     or (select count(*) from public.ledger_audit_logs where action = 'november_card_deposit_allocations_restored') <> 1 then
    raise exception 'NOVEMBER_CARD_BACKFILL_RESTORE_NOT_APPLIED';
  end if;
  -- Duplicate registration: no deposit, reconciliation or card transaction with either amount.
  if exists (select 1 from public.ledger_card_reconciliations r where r.deposit_amount in (10087054, 14545476))
     or exists (select 1 from public.ledger_transactions t where t.type = 'card_settlement_deposit' and t.amount in (10087054, 14545476)) then
    raise exception 'NOVEMBER_CARD_BACKFILL_DUPLICATE_DEPOSIT';
  end if;
  -- #88 exactly as registered; it must be the only live deposit dated on/after 11/18 (date order scope).
  perform 1 from public.ledger_card_reconciliations where id = v_rec88 for update;
  if not exists (
       select 1 from public.ledger_card_reconciliations r join public.ledger_transactions d on d.id = r.deposit_transaction_id
       where r.id = v_rec88 and r.deposit_transaction_id = v_tx88 and r.deposit_date = v_last_date and r.deposit_amount = v_amount88
         and r.status = 'auto_allocated' and r.matched_gross_amount = v_amount88 and r.destination_fund_account_id = v_bank
         and d.status = 'confirmed' and d.type = 'card_settlement_deposit' and d.amount = v_amount88 and d.business_date = v_last_date
         and (select count(*) from public.ledger_movements m where m.transaction_id = d.id) = 2
         and exists (select 1 from public.ledger_movements m where m.transaction_id = d.id and m.fund_account_id = v_clearing and m.amount = -v_amount88)
         and exists (select 1 from public.ledger_movements m where m.transaction_id = d.id and m.fund_account_id = v_bank and m.amount = v_amount88))
     or (select md5(string_agg(l.pos_card_transaction_id || ':' || trim_scale(l.allocated_gross_amount), '|' order by l.pos_card_transaction_id))
         from public.ledger_card_reconciliation_lines l where l.reconciliation_id = v_rec88)
        is distinct from (select md5(string_agg((x->>'sale') || ':' || trim_scale((x->>'amount')::numeric), '|' order by (x->>'sale')::bigint)) from jsonb_array_elements(v_rec88_lines) x)
  then
    raise exception 'NOVEMBER_CARD_BACKFILL_RECONCILIATION_88_DRIFT';
  end if;
  if exists (select 1 from public.ledger_card_reconciliations r where r.status <> 'cancelled' and r.deposit_date >= date '2026-11-18' and r.id <> v_rec88) then
    raise exception 'NOVEMBER_CARD_BACKFILL_OTHER_LATE_DEPOSIT';
  end if;
  -- Card sales: the five late-November sales as verified; every other November sale through 11/19 settled.
  perform 1 from public.ledger_transactions
  where status = 'confirmed' and source_type = 'pos_sales_daily_payment' and source_key like 'pos:%:card' and business_date <= v_last_date
  order by id for update;
  if exists (
       select 1 from jsonb_array_elements(v_sales) x left join public.ledger_transactions t on t.id = (x->>'sale')::bigint
       where t.id is null or t.status <> 'confirmed' or t.source_type <> 'pos_sales_daily_payment' or t.source_key not like 'pos:%:card'
         or t.business_date <> (x->>'date')::date or t.amount <> (x->>'amount')::numeric
         or t.amount - public.ledger_card_sale_consumed_v1(t.id) <> (x->>'outstanding')::numeric)
     or exists (
       select 1 from public.ledger_transactions t
       where t.status = 'confirmed' and t.source_type = 'pos_sales_daily_payment' and t.source_key like 'pos:%:card'
         and t.business_date >= v_month and t.business_date < date '2026-11-20'
         and t.id not in (select (x->>'sale')::bigint from jsonb_array_elements(v_sales) x)
         and t.amount - public.ledger_card_sale_consumed_v1(t.id) <> 0)
  then
    raise exception 'NOVEMBER_CARD_BACKFILL_SALE_DRIFT';
  end if;

  select u.id into v_actor from public.users u
  where lower(u.role::text) in ('owner', 'master') and u.is_active = true and u.app_login_enabled = true
  order by u.id limit 1;
  if v_actor is null then
    raise exception 'NOVEMBER_CARD_BACKFILL_AUDIT_ACTOR_MISSING';
  end if;

  ---------------------------------------------------------------------------
  -- Evidence before writing.
  select coalesce(sum(m.amount) filter (where m.fund_account_id = v_clearing), 0), coalesce(sum(m.amount) filter (where m.fund_account_id = v_bank), 0)
  into v_before_clearing, v_before_bank
  from public.ledger_movements m join public.ledger_transactions t on t.id = m.transaction_id where t.status = 'confirmed';
  select count(*) into v_before_tx from public.ledger_transactions;
  select count(*) into v_before_mv from public.ledger_movements;
  select md5(coalesce(string_agg(x, '|' order by x), '')) into v_before_other from (
    select to_jsonb(r)::text x from public.ledger_card_reconciliations r where r.id <> v_rec88
    union all select to_jsonb(l)::text from public.ledger_card_reconciliation_lines l where l.reconciliation_id <> v_rec88
    union all select to_jsonb(t)::text from public.ledger_transactions t
    union all select to_jsonb(m)::text from public.ledger_movements m) s;
  select md5(coalesce(string_agg(x, '|' order by x), '')) into v_before_fees from (
    select to_jsonb(c)::text x from public.ledger_card_fee_closures c
    union all select to_jsonb(f)::text from public.ledger_card_fee_allocation_lines f
    union all select to_jsonb(mc)::text from public.ledger_month_closures mc) s;
  select coalesce(max(id), 0) into v_before_audit_max from public.ledger_audit_logs;
  select md5(coalesce(string_agg(to_jsonb(a)::text, '|' order by a.id), '')) into v_before_audits from public.ledger_audit_logs a;
  select to_jsonb(r)::text into v_before_rec88 from public.ledger_card_reconciliations r where r.id = v_rec88;

  ---------------------------------------------------------------------------
  -- 1. The two deposits through the official RPC (12:00 local is bookkeeping time; the bank time is unknown).
  for v_deposit in select value from jsonb_array_elements(v_deposits) loop
    v_result := public.ledger_create_card_deposit_auto_allocate_v1(
      ((v_deposit->>'date') || ' 12:00:00+07')::timestamptz, (v_deposit->>'amount')::numeric, v_bank,
      'BABA sheet 11월!' || (v_deposit->>'cell') || ' ' || (v_deposit->>'date') || ' card settlement deposit; backfilled by 20261120134158 in deposit-date FIFO order. Bank time unavailable; 12:00 is bookkeeping time only.',
      v_actor);
    if v_result->>'status' is distinct from 'created' then
      raise exception 'NOVEMBER_CARD_BACKFILL_RPC_REJECTED %: %', v_deposit->>'date', v_result::text;
    end if;
    v_created := v_created || jsonb_build_array(v_result || jsonb_build_object('depositDate', v_deposit->>'date', 'sheetCell', '11월!' || (v_deposit->>'cell')));
  end loop;

  -- 2. Re-plan the lines of the three late deposits in deposit-date order over the very same sale amounts.
  create temporary table november_card_backfill_recs on commit drop as
  select r.id, r.deposit_date, r.deposit_amount,
    (select jsonb_agg(jsonb_build_object('lineId', l.id, 'transactionId', l.pos_card_transaction_id, 'allocatedAmount', l.allocated_gross_amount) order by l.id)
     from public.ledger_card_reconciliation_lines l where l.reconciliation_id = r.id) as before_lines
  from public.ledger_card_reconciliations r
  where r.id = v_rec88 or r.id in (select (x->>'reconciliationId')::bigint from jsonb_array_elements(v_created) x);
  if (select count(*) from november_card_backfill_recs) <> 3 then
    raise exception 'NOVEMBER_CARD_BACKFILL_RECONCILIATION_SET_INVALID';
  end if;

  create temporary table november_card_backfill_pool on commit drop as
  select l.pos_card_transaction_id as sale_id, t.business_date, sum(l.allocated_gross_amount) as consumed, sum(l.allocated_gross_amount) as left_amount
  from public.ledger_card_reconciliation_lines l join public.ledger_transactions t on t.id = l.pos_card_transaction_id
  where l.reconciliation_id in (select id from november_card_backfill_recs)
  group by l.pos_card_transaction_id, t.business_date;

  create temporary table november_card_backfill_plan (reconciliation_id bigint, sale_id bigint, business_date date, amount numeric) on commit drop;
  for v_rec in select * from november_card_backfill_recs order by deposit_date, id loop
    v_remaining := v_rec.deposit_amount;
    for v_sale in select * from november_card_backfill_pool where left_amount > 0 and business_date <= v_rec.deposit_date order by business_date, sale_id loop
      exit when v_remaining <= 0;
      v_take := least(v_remaining, v_sale.left_amount);
      insert into november_card_backfill_plan values (v_rec.id, v_sale.sale_id, v_sale.business_date, v_take);
      update november_card_backfill_pool set left_amount = left_amount - v_take where sale_id = v_sale.sale_id;
      v_remaining := v_remaining - v_take;
    end loop;
    if v_remaining <> 0 then
      raise exception 'NOVEMBER_CARD_BACKFILL_PLAN_INCOMPLETE %', v_rec.id;
    end if;
  end loop;
  if exists (select 1 from november_card_backfill_pool where left_amount <> 0)
     or (select md5(string_agg(p.business_date::text || ':' || r.deposit_date || ':' || p.sale_id || ':' || trim_scale(p.amount), '|' order by r.deposit_date, p.sale_id))
         from november_card_backfill_plan p join november_card_backfill_recs r on r.id = p.reconciliation_id)
        is distinct from (select md5(string_agg(t.business_date::text || ':' || (x->>'date') || ':' || (x->>'sale') || ':' || trim_scale((x->>'amount')::numeric), '|' order by x->>'date', (x->>'sale')::bigint))
         from jsonb_array_elements(v_expected) x join public.ledger_transactions t on t.id = (x->>'sale')::bigint)
  then
    raise exception 'NOVEMBER_CARD_BACKFILL_PLAN_UNEXPECTED';
  end if;

  delete from public.ledger_card_reconciliation_lines where reconciliation_id in (select id from november_card_backfill_recs);
  insert into public.ledger_card_reconciliation_lines(reconciliation_id, pos_card_transaction_id, allocated_gross_amount)
  select reconciliation_id, sale_id, amount from november_card_backfill_plan order by reconciliation_id, business_date, sale_id;

  for v_rec in select * from november_card_backfill_recs order by deposit_date, id loop
    select jsonb_agg(jsonb_build_object('lineId', l.id, 'transactionId', l.pos_card_transaction_id, 'businessDate', t.business_date,
             'allocatedAmount', l.allocated_gross_amount) order by t.business_date, l.pos_card_transaction_id)
    into v_allocations
    from public.ledger_card_reconciliation_lines l join public.ledger_transactions t on t.id = l.pos_card_transaction_id
    where l.reconciliation_id = v_rec.id;
    insert into public.ledger_audit_logs(actor_user_id, action, entity_type, entity_id, before_snapshot, after_snapshot, reason)
    values (v_actor, v_line_action, 'card_reconciliation', v_rec.id,
      jsonb_build_object('allocations', v_rec.before_lines, 'status', 'auto_allocated', 'depositAmount', v_rec.deposit_amount, 'depositDate', v_rec.deposit_date),
      jsonb_build_object('allocations', v_allocations, 'status', 'auto_allocated', 'depositAmount', v_rec.deposit_amount, 'depositDate', v_rec.deposit_date,
        'matchedGrossAmount', v_rec.deposit_amount, 'differenceAmount', 0, 'allocationOrder', 'deposit_date_fifo'),
      v_reason);
  end loop;

  ---------------------------------------------------------------------------
  -- Post-checks.
  if exists (
       select 1 from november_card_backfill_recs b join public.ledger_card_reconciliations r on r.id = b.id
       where r.status <> 'auto_allocated' or r.matched_gross_amount <> r.deposit_amount or r.difference_amount <> 0
         or r.deposit_amount <> (select coalesce(sum(l.allocated_gross_amount), 0) from public.ledger_card_reconciliation_lines l where l.reconciliation_id = r.id)
         or exists (select 1 from public.ledger_card_reconciliation_lines l join public.ledger_transactions t on t.id = l.pos_card_transaction_id
                    where l.reconciliation_id = r.id and (t.business_date > r.deposit_date or date_trunc('month', t.business_date)::date <> v_month)))
     or (select to_jsonb(r)::text from public.ledger_card_reconciliations r where r.id = v_rec88) <> v_before_rec88
  then
    raise exception 'NOVEMBER_CARD_BACKFILL_RESULT_INVALID';
  end if;
  -- Each sale's consumption equals what the RPC calls left (the re-plan only moves ownership).
  if exists (
       select 1 from november_card_backfill_pool p
       where p.consumed <> (select sum(l.allocated_gross_amount) from public.ledger_card_reconciliation_lines l
                            where l.pos_card_transaction_id = p.sale_id and l.reconciliation_id in (select id from november_card_backfill_recs)))
     or exists (select 1 from public.ledger_transactions t where t.status = 'confirmed' and t.source_type = 'pos_sales_daily_payment'
                and t.source_key like 'pos:%:card' and public.ledger_card_sale_consumed_v1(t.id) > t.amount)
     or (select coalesce(sum(t.amount - public.ledger_card_sale_consumed_v1(t.id)), 0) from public.ledger_transactions t
         where t.status = 'confirmed' and t.source_type = 'pos_sales_daily_payment' and t.source_key like 'pos:%:card'
           and t.business_date >= v_month and t.business_date < date '2026-11-20') <> v_expected_outstanding
     or (select t.amount - public.ledger_card_sale_consumed_v1(t.id) from public.ledger_transactions t where t.id = 5109) <> 930526
     or (select t.amount - public.ledger_card_sale_consumed_v1(t.id) from public.ledger_transactions t where t.id = 5173) <> 3862400
  then
    raise exception 'NOVEMBER_CARD_BACKFILL_SALE_CONSUMPTION_INVALID';
  end if;
  select coalesce(sum(m.amount) filter (where m.fund_account_id = v_clearing), 0), coalesce(sum(m.amount) filter (where m.fund_account_id = v_bank), 0)
  into v_after_clearing, v_after_bank
  from public.ledger_movements m join public.ledger_transactions t on t.id = m.transaction_id where t.status = 'confirmed';
  if v_after_clearing <> v_before_clearing - v_total or v_after_bank <> v_before_bank + v_total
     or (select count(*) from public.ledger_transactions) <> v_before_tx + 2
     or (select count(*) from public.ledger_movements) <> v_before_mv + 4
     or (select count(*) from public.ledger_transactions t
         where t.id in (select (x->>'transactionId')::bigint from jsonb_array_elements(v_created) x)
           and t.type = 'card_settlement_deposit' and t.status = 'confirmed'
           and (select count(*) from public.ledger_movements m where m.transaction_id = t.id) = 2
           and exists (select 1 from public.ledger_movements m where m.transaction_id = t.id and m.fund_account_id = v_clearing and m.amount = -t.amount)
           and exists (select 1 from public.ledger_movements m where m.transaction_id = t.id and m.fund_account_id = v_bank and m.amount = t.amount)) <> 2
  then
    raise exception 'NOVEMBER_CARD_BACKFILL_BALANCE_INVALID';
  end if;
  -- Everything outside the two new deposits and the three re-planned line sets is byte-identical.
  if (select md5(coalesce(string_agg(x, '|' order by x), '')) from (
        select to_jsonb(r)::text x from public.ledger_card_reconciliations r where r.id <> v_rec88 and r.id not in (select id from november_card_backfill_recs)
        union all select to_jsonb(l)::text from public.ledger_card_reconciliation_lines l where l.reconciliation_id not in (select id from november_card_backfill_recs)
        union all select to_jsonb(t)::text from public.ledger_transactions t where t.id not in (select (x->>'transactionId')::bigint from jsonb_array_elements(v_created) x)
        union all select to_jsonb(m)::text from public.ledger_movements m where m.transaction_id not in (select (x->>'transactionId')::bigint from jsonb_array_elements(v_created) x)) s)
     <> v_before_other
  then
    raise exception 'NOVEMBER_CARD_BACKFILL_UNRELATED_DATA_CHANGED';
  end if;
  if (select md5(coalesce(string_agg(x, '|' order by x), '')) from (
        select to_jsonb(c)::text x from public.ledger_card_fee_closures c
        union all select to_jsonb(f)::text from public.ledger_card_fee_allocation_lines f
        union all select to_jsonb(mc)::text from public.ledger_month_closures mc) s) <> v_before_fees
     or (select md5(coalesce(string_agg(to_jsonb(a)::text, '|' order by a.id), '')) from public.ledger_audit_logs a where a.id <= v_before_audit_max) <> v_before_audits
  then
    raise exception 'NOVEMBER_CARD_BACKFILL_FEE_OR_AUDIT_CHANGED';
  end if;

  insert into public.ledger_audit_logs(actor_user_id, action, entity_type, before_snapshot, after_snapshot, reason)
  values (v_actor, v_summary_action, 'card_reconciliation_month',
    jsonb_build_object('month', v_month, 'cardClearingBalance', v_before_clearing, 'corporateBankBalance', v_before_bank,
      'reconciliation88', v_rec88_lines),
    jsonb_build_object('month', v_month, 'cardClearingBalance', v_after_clearing, 'corporateBankBalance', v_after_bank,
      'createdDeposits', v_created, 'totalDeposited', v_total, 'resequencedReconciliations', (select jsonb_agg(id order by deposit_date, id) from november_card_backfill_recs),
      'novemberOutstandingThrough1119', v_expected_outstanding, 'newFeeClosures', 0),
    v_reason);
end;
$backfill_november_card_deposits$;
