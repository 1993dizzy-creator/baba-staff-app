-- Restore FIFO sale allocations for the eight November 2026 card deposits that were registered through
-- the legacy ledger_create_card_deposit_v1 (status 'unmatched', no allocation lines).
-- NOT APPLIED: production application is reviewed by GPT and needs separate Owner approval.
--
-- Targets (verified read-only on Production 2026-11-20):
--   reconciliation #80..#87 / deposit transactions #4858, #4859, #5138..#5143, 8 deposits, 123,671,891 VND.
-- Result: each target becomes 'auto_allocated' with lines that equal its deposit, planned exactly like
-- ledger_create_card_deposit_auto_allocate_v1 (20261108100000): sales dated on/before the deposit's
-- business date (03:00 Asia/Ho_Chi_Minh boundary, already stored as deposit_date), oldest sale month first,
-- business_date/id FIFO inside a month, a provisional manual fee (October #4119) is never repaid, and
-- no card fee is booked.
--
-- Unchanged by design: the deposit transactions and their movements (so every account balance), every
-- other reconciliation and its lines, card fee closures/lines/expenses, month closures and every existing
-- audit row. Nothing is cancelled or re-registered. One audit row per restored deposit plus one summary
-- row are added. Any drift from the verified state aborts the whole migration without a partial write.
-- A second run after a successful one is a no-op (it changes nothing and adds no allocation).
do $restore_november_card_deposits$
declare
  v_targets constant jsonb := '[
    {"id":80,"tx":4858,"date":"2026-11-06","amount":3094700},
    {"id":81,"tx":4859,"date":"2026-11-09","amount":37059996},
    {"id":82,"tx":5138,"date":"2026-11-10","amount":9103126},
    {"id":83,"tx":5139,"date":"2026-11-11","amount":14114289},
    {"id":84,"tx":5140,"date":"2026-11-12","amount":3877273},
    {"id":85,"tx":5141,"date":"2026-11-13","amount":12762670},
    {"id":86,"tx":5142,"date":"2026-11-16","amount":35625303},
    {"id":87,"tx":5143,"date":"2026-11-17","amount":8034534}
  ]';
  v_count constant integer := 8;
  v_total constant numeric := 123671891;
  v_month constant date := date '2026-11-01';
  v_last_date constant date := date '2026-11-17';
  v_action constant text := 'card_deposit_allocation_restored';
  v_reason constant text := '20261120121505: restore FIFO sale allocation for legacy unmatched November 2026 card deposits (#80-#87); deposits, movements and balances unchanged';
  v_current_month date := date_trunc('month', ((now() at time zone 'Asia/Ho_Chi_Minh') - interval '3 hours')::date)::date;
  v_lock_month date;
  v_clearing bigint;
  v_bank bigint;
  v_actor bigint;
  v_target record;
  v_sale_month record;
  v_sale record;
  v_line jsonb;
  v_remaining numeric;
  v_month_payment numeric;
  v_allocated numeric;
  v_provisional numeric;
  v_allocations jsonb;
  v_reviews jsonb;
  v_before jsonb;
  v_restored integer;
  v_before_clearing numeric; v_after_clearing numeric;
  v_before_bank numeric; v_after_bank numeric;
  v_before_tx bigint; v_before_mv bigint;
  v_before_month_outstanding numeric; v_after_month_outstanding numeric;
  v_before_other_recs text; v_before_fees text; v_before_audits text; v_before_audit_max bigint;
begin
  if jsonb_array_length(v_targets) <> v_count
     or (select sum((x->>'amount')::numeric) from jsonb_array_elements(v_targets) x) <> v_total then
    raise exception 'NOVEMBER_CARD_RESTORE_TARGET_LIST_INVALID';
  end if;

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
  if public.ledger_month_is_closed_v1(v_month) then
    raise exception 'NOVEMBER_CARD_RESTORE_MONTH_CLOSED';
  end if;
  perform pg_advisory_xact_lock(hashtext('ledger_card_clearing_balance'));

  select id into v_clearing from public.ledger_fund_accounts where code = 'card_clearing' and is_active = true for update;
  select id into v_bank from public.ledger_fund_accounts where code = 'baba_corporate_bank' and is_active = true and type <> 'card_clearing';
  if v_clearing is null or v_bank is null then
    raise exception 'NOVEMBER_CARD_RESTORE_ACCOUNT_MISSING';
  end if;

  create temporary table november_card_restore_targets on commit drop as
  select (x->>'id')::bigint as id, (x->>'tx')::bigint as tx, (x->>'date')::date as deposit_date, (x->>'amount')::numeric as amount
  from jsonb_array_elements(v_targets) x;

  perform 1 from public.ledger_card_reconciliations where id in (select id from november_card_restore_targets) order by id for update;
  perform 1 from public.ledger_transactions
  where status = 'confirmed' and source_type = 'pos_sales_daily_payment' and source_key like 'pos:%:card' and business_date <= v_last_date
  order by id for update;

  -- Already restored by this migration: no-op, never a second allocation.
  if (select count(distinct a.entity_id) from public.ledger_audit_logs a
      where a.action = v_action and a.entity_type = 'card_reconciliation'
        and a.entity_id in (select id from november_card_restore_targets)) = v_count
     and not exists (
      select 1 from november_card_restore_targets t
      join public.ledger_card_reconciliations r on r.id = t.id
      where r.status <> 'auto_allocated' or r.deposit_amount <> t.amount
        or r.deposit_amount <> (select coalesce(sum(l.allocated_gross_amount), 0) from public.ledger_card_reconciliation_lines l where l.reconciliation_id = r.id))
  then
    raise notice 'NOVEMBER_CARD_RESTORE_ALREADY_APPLIED';
    return;
  end if;

  ---------------------------------------------------------------------------
  -- Pre-checks: the exact verified legacy state, nothing else.
  if (select count(*) from november_card_restore_targets t join public.ledger_card_reconciliations r on r.id = t.id) <> v_count then
    raise exception 'NOVEMBER_CARD_RESTORE_TARGET_MISSING';
  end if;
  if exists (
    select 1 from november_card_restore_targets t
    join public.ledger_card_reconciliations r on r.id = t.id
    where r.deposit_transaction_id <> t.tx or r.deposit_date <> t.deposit_date or r.deposit_amount <> t.amount
      or r.status <> 'unmatched' or r.matched_gross_amount <> 0 or r.difference_amount <> 0
      or r.confirmed_at is not null or r.confirmed_by is not null or r.cancelled_at is not null or r.cancelled_by is not null
      or r.destination_fund_account_id <> v_bank
      or date_trunc('month', r.deposit_date)::date <> v_month
      or exists (select 1 from public.ledger_card_reconciliation_lines l where l.reconciliation_id = r.id)
  ) then
    raise exception 'NOVEMBER_CARD_RESTORE_RECONCILIATION_DRIFT';
  end if;
  if exists (
    select 1 from november_card_restore_targets t
    left join public.ledger_transactions d on d.id = t.tx
    where d.id is null or d.status <> 'confirmed' or d.type <> 'card_settlement_deposit' or d.source_type <> 'card_settlement_deposit'
      or d.amount <> t.amount or d.business_date <> t.deposit_date
      or (select count(*) from public.ledger_movements m where m.transaction_id = t.tx) <> 2
      or not exists (select 1 from public.ledger_movements m where m.transaction_id = t.tx and m.fund_account_id = v_clearing and m.amount = -t.amount)
      or not exists (select 1 from public.ledger_movements m where m.transaction_id = t.tx and m.fund_account_id = v_bank and m.amount = t.amount)
  ) then
    raise exception 'NOVEMBER_CARD_RESTORE_DEPOSIT_DRIFT';
  end if;
  -- Any other unresolved legacy deposit could be money for the same sales: stop instead of guessing.
  if exists (select 1 from public.ledger_card_reconciliations r
             where r.status in ('unmatched', 'partial') and r.id not in (select id from november_card_restore_targets)) then
    raise exception 'NOVEMBER_CARD_RESTORE_OTHER_LEGACY_DEPOSITS';
  end if;
  if exists (select 1 from public.ledger_card_fee_closures c where c.status = 'confirmed' and c.fee_month >= v_month) then
    raise exception 'NOVEMBER_CARD_RESTORE_FEE_ALREADY_CONFIRMED';
  end if;
  -- Same corruption checks as the deposit RPC (card_data_invalid).
  if exists (select 1 from public.ledger_transactions t where t.status = 'confirmed' and t.source_type = 'pos_sales_daily_payment'
        and t.source_key like 'pos:%:card' and public.ledger_card_sale_consumed_v1(t.id) > t.amount)
     or exists (select 1 from public.ledger_card_reconciliations r where
        (r.status = 'auto_allocated' and r.deposit_amount <> (select coalesce(sum(l.allocated_gross_amount), 0) from public.ledger_card_reconciliation_lines l where l.reconciliation_id = r.id))
        or (r.status = 'matched' and r.matched_gross_amount <> (select coalesce(sum(l.allocated_gross_amount), 0) from public.ledger_card_reconciliation_lines l where l.reconciliation_id = r.id)))
     or exists (select 1 from public.ledger_card_fee_closures c where c.status = 'confirmed'
        and c.fee_amount <> (select coalesce(sum(f.allocated_fee_amount), 0) from public.ledger_card_fee_allocation_lines f where f.closure_id = c.id))
  then
    raise exception 'NOVEMBER_CARD_RESTORE_CARD_DATA_INVALID';
  end if;

  ---------------------------------------------------------------------------
  -- Evidence before writing (kept in the audit rows; compared after writing).
  create temporary table november_card_restore_before on commit drop as
  select t.id, to_jsonb(r) as reconciliation, to_jsonb(d) as deposit,
    (select jsonb_agg(to_jsonb(m) order by m.id) from public.ledger_movements m where m.transaction_id = d.id) as movements
  from november_card_restore_targets t
  join public.ledger_card_reconciliations r on r.id = t.id
  join public.ledger_transactions d on d.id = t.tx;

  create temporary table november_card_restore_prior_consumed on commit drop as
  select t.id, public.ledger_card_sale_consumed_v1(t.id) as consumed
  from public.ledger_transactions t
  where t.source_type = 'pos_sales_daily_payment' and t.source_key like 'pos:%:card' and t.business_date < v_month;

  select coalesce(sum(m.amount) filter (where m.fund_account_id = v_clearing), 0), coalesce(sum(m.amount) filter (where m.fund_account_id = v_bank), 0)
  into v_before_clearing, v_before_bank
  from public.ledger_movements m join public.ledger_transactions t on t.id = m.transaction_id where t.status = 'confirmed';
  select count(*) into v_before_tx from public.ledger_transactions;
  select count(*) into v_before_mv from public.ledger_movements;
  select coalesce(sum(t.amount - public.ledger_card_sale_consumed_v1(t.id)), 0) into v_before_month_outstanding
  from public.ledger_transactions t where t.status = 'confirmed' and t.source_type = 'pos_sales_daily_payment'
    and t.source_key like 'pos:%:card' and date_trunc('month', t.business_date)::date = v_month;
  select md5(coalesce(string_agg(x, '|' order by x), '')) into v_before_other_recs from (
    select to_jsonb(r)::text x from public.ledger_card_reconciliations r where r.id not in (select id from november_card_restore_targets)
    union all select to_jsonb(l)::text from public.ledger_card_reconciliation_lines l where l.reconciliation_id not in (select id from november_card_restore_targets)) s;
  select md5(coalesce(string_agg(x, '|' order by x), '')) into v_before_fees from (
    select to_jsonb(c)::text x from public.ledger_card_fee_closures c
    union all select to_jsonb(f)::text from public.ledger_card_fee_allocation_lines f) s;
  select coalesce(max(id), 0) into v_before_audit_max from public.ledger_audit_logs;
  select md5(coalesce(string_agg(to_jsonb(a)::text, '|' order by a.id), '')) into v_before_audits from public.ledger_audit_logs a;

  select u.id into v_actor from public.users u
  where lower(u.role::text) in ('owner', 'master') and u.is_active = true and u.app_login_enabled = true
  order by u.id limit 1;
  if v_actor is null then
    raise exception 'NOVEMBER_CARD_RESTORE_AUDIT_ACTOR_MISSING';
  end if;

  ---------------------------------------------------------------------------
  -- Restore deposit by deposit in deposit order; each is planned exactly like the deposit RPC would have
  -- planned it at that point (earlier restored deposits already consume their sales).
  for v_target in select * from november_card_restore_targets order by deposit_date, id loop
    v_remaining := v_target.amount;
    v_allocations := '[]'::jsonb;
    v_reviews := '[]'::jsonb;
    for v_sale_month in
      select date_trunc('month', t.business_date)::date sale_month, sum(t.amount - public.ledger_card_sale_consumed_v1(t.id)) outstanding
      from public.ledger_transactions t
      where t.status = 'confirmed' and t.source_type = 'pos_sales_daily_payment' and t.source_key like 'pos:%:card'
        and t.business_date <= v_target.deposit_date
      group by 1 having sum(t.amount - public.ledger_card_sale_consumed_v1(t.id)) > 0 order by 1
    loop
      exit when v_remaining <= 0;
      v_month_payment := least(v_remaining, v_sale_month.outstanding);
      v_provisional := ledger_card_fee_private.provisional_fee(v_sale_month.sale_month);
      if v_provisional is null or (v_provisional <> 0 and (v_provisional < 0 or v_provisional > v_sale_month.outstanding
         or not (v_sale_month.sale_month < v_month and v_sale_month.sale_month < v_current_month and public.ledger_month_is_closed_v1(v_sale_month.sale_month))
         or exists (select 1 from public.ledger_card_fee_closures c where c.fee_month = v_sale_month.sale_month and c.status = 'confirmed'))) then
        raise exception 'NOVEMBER_CARD_RESTORE_PROVISIONAL_FEE_MISMATCH: %', v_sale_month.sale_month;
      elsif v_provisional <> 0 then
        -- Already expensed and taken from card clearing (October #4119): never repaid by a deposit.
        v_month_payment := least(v_remaining, v_sale_month.outstanding - v_provisional);
        v_reviews := v_reviews || jsonb_build_array(jsonb_build_object('month', v_sale_month.sale_month, 'reason', 'provisional_fee',
          'provisionalFee', v_provisional, 'remainingAmount', v_sale_month.outstanding));
      end if;
      -- Verified state: every earlier month is settled or covered by its provisional fee.
      if v_month_payment > 0 and v_sale_month.sale_month <> v_month then
        raise exception 'NOVEMBER_CARD_RESTORE_UNEXPECTED_MONTH: %', v_sale_month.sale_month;
      end if;
      v_remaining := v_remaining - v_month_payment;
      for v_sale in
        select t.id, t.business_date, t.amount - public.ledger_card_sale_consumed_v1(t.id) outstanding
        from public.ledger_transactions t
        where t.status = 'confirmed' and t.source_type = 'pos_sales_daily_payment' and t.source_key like 'pos:%:card'
          and t.business_date <= v_target.deposit_date and date_trunc('month', t.business_date)::date = v_sale_month.sale_month
          and t.amount - public.ledger_card_sale_consumed_v1(t.id) > 0
        order by t.business_date, t.id
      loop
        exit when v_month_payment <= 0;
        v_allocated := least(v_month_payment, v_sale.outstanding);
        v_allocations := v_allocations || jsonb_build_array(jsonb_build_object('transactionId', v_sale.id, 'businessDate', v_sale.business_date,
          'outstandingBefore', v_sale.outstanding, 'allocatedAmount', v_allocated, 'outstandingAfter', v_sale.outstanding - v_allocated));
        v_month_payment := v_month_payment - v_allocated;
      end loop;
    end loop;
    if v_remaining <> 0 then
      raise exception 'NOVEMBER_CARD_RESTORE_INSUFFICIENT_SALES: reconciliation %, remainder %', v_target.id, v_remaining;
    end if;

    select reconciliation into v_before from november_card_restore_before where id = v_target.id;
    for v_line in select value from jsonb_array_elements(v_allocations) loop
      insert into public.ledger_card_reconciliation_lines(reconciliation_id, pos_card_transaction_id, allocated_gross_amount)
      values (v_target.id, (v_line->>'transactionId')::bigint, (v_line->>'allocatedAmount')::numeric);
    end loop;
    update public.ledger_card_reconciliations
    set status = 'auto_allocated', matched_gross_amount = deposit_amount, difference_amount = 0, updated_at = now()
    where id = v_target.id and status = 'unmatched';
    get diagnostics v_restored = row_count;
    if v_restored <> 1 or (select coalesce(sum(allocated_gross_amount), 0) from public.ledger_card_reconciliation_lines where reconciliation_id = v_target.id) <> v_target.amount then
      raise exception 'NOVEMBER_CARD_RESTORE_ALLOCATION_MISMATCH: reconciliation %', v_target.id;
    end if;

    -- Same after_snapshot keys as the deposit RPC's card_deposit_auto_allocated audit.
    insert into public.ledger_audit_logs(actor_user_id, action, entity_type, entity_id, before_snapshot, after_snapshot, reason)
    values (v_actor, v_action, 'card_reconciliation', v_target.id,
      jsonb_build_object('reconciliation', v_before, 'lines', '[]'::jsonb),
      jsonb_build_object('depositTransactionId', v_target.tx, 'bankAccountId', v_bank, 'depositAmount', v_target.amount,
        'autoFeeClosures', '[]'::jsonb, 'feeReviews', v_reviews, 'allocations', v_allocations,
        'matchedGrossAmount', v_target.amount, 'differenceAmount', 0, 'status', 'auto_allocated',
        'restoredFromStatus', 'unmatched', 'depositTransactionUnchanged', true),
      v_reason);
  end loop;

  ---------------------------------------------------------------------------
  -- Post-checks: anything unexpected rolls everything back.
  if exists (
    select 1 from november_card_restore_targets t
    join public.ledger_card_reconciliations r on r.id = t.id
    where r.status <> 'auto_allocated' or r.matched_gross_amount <> t.amount or r.difference_amount <> 0
      or r.confirmed_at is not null or r.cancelled_at is not null
      or (select coalesce(sum(l.allocated_gross_amount), 0) from public.ledger_card_reconciliation_lines l where l.reconciliation_id = r.id) <> t.amount
      or exists (select 1 from public.ledger_card_reconciliation_lines l join public.ledger_transactions s on s.id = l.pos_card_transaction_id
                 where l.reconciliation_id = r.id and (s.business_date > t.deposit_date or date_trunc('month', s.business_date)::date <> v_month
                   or s.status <> 'confirmed' or s.source_type <> 'pos_sales_daily_payment' or s.source_key not like 'pos:%:card'))
  ) then
    raise exception 'NOVEMBER_CARD_RESTORE_RECONCILIATION_POSTCHECK_FAILED';
  end if;
  if exists (
    select 1 from november_card_restore_before b
    join public.ledger_transactions d on d.id = (b.reconciliation->>'deposit_transaction_id')::bigint
    where to_jsonb(d) <> b.deposit
      or b.movements is distinct from (select jsonb_agg(to_jsonb(m) order by m.id) from public.ledger_movements m where m.transaction_id = d.id)
  ) then
    raise exception 'NOVEMBER_CARD_RESTORE_DEPOSIT_CHANGED';
  end if;
  if exists (select 1 from public.ledger_transactions t where t.source_type = 'pos_sales_daily_payment'
             and t.source_key like 'pos:%:card' and public.ledger_card_sale_consumed_v1(t.id) > t.amount) then
    raise exception 'NOVEMBER_CARD_RESTORE_CARD_OVERALLOCATED';
  end if;
  if exists (select 1 from november_card_restore_prior_consumed b where public.ledger_card_sale_consumed_v1(b.id) <> b.consumed) then
    raise exception 'NOVEMBER_CARD_RESTORE_PRIOR_MONTH_CONSUMPTION_CHANGED';
  end if;
  select coalesce(sum(m.amount) filter (where m.fund_account_id = v_clearing), 0), coalesce(sum(m.amount) filter (where m.fund_account_id = v_bank), 0)
  into v_after_clearing, v_after_bank
  from public.ledger_movements m join public.ledger_transactions t on t.id = m.transaction_id where t.status = 'confirmed';
  if v_after_clearing <> v_before_clearing or v_after_bank <> v_before_bank
     or (select count(*) from public.ledger_transactions) <> v_before_tx
     or (select count(*) from public.ledger_movements) <> v_before_mv then
    raise exception 'NOVEMBER_CARD_RESTORE_LEDGER_CHANGED';
  end if;
  select coalesce(sum(t.amount - public.ledger_card_sale_consumed_v1(t.id)), 0) into v_after_month_outstanding
  from public.ledger_transactions t where t.status = 'confirmed' and t.source_type = 'pos_sales_daily_payment'
    and t.source_key like 'pos:%:card' and date_trunc('month', t.business_date)::date = v_month;
  if v_after_month_outstanding <> v_before_month_outstanding - v_total then
    raise exception 'NOVEMBER_CARD_RESTORE_OUTSTANDING_POSTCHECK_FAILED: %', v_after_month_outstanding;
  end if;
  if v_before_other_recs <> (select md5(coalesce(string_agg(x, '|' order by x), '')) from (
       select to_jsonb(r)::text x from public.ledger_card_reconciliations r where r.id not in (select id from november_card_restore_targets)
       union all select to_jsonb(l)::text from public.ledger_card_reconciliation_lines l where l.reconciliation_id not in (select id from november_card_restore_targets)) s)
     or v_before_fees <> (select md5(coalesce(string_agg(x, '|' order by x), '')) from (
       select to_jsonb(c)::text x from public.ledger_card_fee_closures c
       union all select to_jsonb(f)::text from public.ledger_card_fee_allocation_lines f) s)
     or v_before_audits <> (select md5(coalesce(string_agg(to_jsonb(a)::text, '|' order by a.id), '')) from public.ledger_audit_logs a where a.id <= v_before_audit_max)
  then
    raise exception 'NOVEMBER_CARD_RESTORE_UNRELATED_DATA_CHANGED';
  end if;
  if exists (select 1 from public.ledger_card_reconciliations where status in ('unmatched', 'partial')) then
    raise exception 'NOVEMBER_CARD_RESTORE_LEGACY_REMAINS';
  end if;

  insert into public.ledger_audit_logs(actor_user_id, action, entity_type, before_snapshot, after_snapshot, reason)
  values (v_actor, 'november_card_deposit_allocations_restored', 'card_reconciliation_month',
    jsonb_build_object('month', v_month, 'reconciliationIds', (select jsonb_agg(id order by id) from november_card_restore_targets),
      'depositTotal', v_total, 'status', 'unmatched', 'cardClearingBalance', v_before_clearing, 'corporateBankBalance', v_before_bank,
      'monthCardSaleOutstanding', v_before_month_outstanding),
    jsonb_build_object('month', v_month, 'reconciliationIds', (select jsonb_agg(id order by id) from november_card_restore_targets),
      'depositTotal', v_total, 'status', 'auto_allocated', 'cardClearingBalance', v_after_clearing, 'corporateBankBalance', v_after_bank,
      'monthCardSaleOutstanding', v_after_month_outstanding, 'newTransactions', 0, 'newMovements', 0, 'newFeeClosures', 0),
    v_reason);
end;
$restore_november_card_deposits$;
