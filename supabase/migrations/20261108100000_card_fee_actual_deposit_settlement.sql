-- Card fee policy: actual-deposit settlement. NOT APPLIED: production application needs separate approval.
-- * A card deposit moves only the real principal (card_clearing -> corporate bank) and keeps FIFO by
--   sale business date. The 1.8% / 2.15% / 2.5% planning and automatic fee finalization are removed.
-- * A sale month is settled only by an explicit "card payment complete" step after its last deposit
--   (ledger_complete_card_month_v1). The admin must confirm the month's final deposit and the exact fee
--   amount; the fee is that month's actual remainder (gross - deposits applied), booked once as before
--   (closure + allocation lines + expense), after blocking checks. Confirmer, time and amount are audited.
-- * The reused manual confirmation RPC uses the BABA business month (03:00 Asia/Ho_Chi_Minh boundary).
-- * Existing closures, allocation lines, expense rows, cancellation and audit paths are unchanged.
--   The P0 provisional guard (October #4119) is kept: such a month is never repaid nor settled again.
-- Verified before writing (2026-11-08, read-only): live prosrc of the deposit RPC, finalize_month and
-- allowed_transaction equals the local chain 20261001193526 + 20261107084849 (md5 match).
begin;

---------------------------------------------------------------------------
-- 1. Deposit: principal + FIFO only.
create or replace function public.ledger_create_card_deposit_auto_allocate_v1(
  p_deposit_at timestamptz,
  p_amount numeric,
  p_destination_account_id bigint,
  p_memo text,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_current_month date:=date_trunc('month',((now() at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date)::date;
  v_sale_month record; v_month_payment numeric; v_line jsonb; v_lock_month date;
  v_provisional numeric; v_reviews jsonb:='[]';
  v_clearing bigint;
  v_bank bigint;
  v_balance numeric;
  v_available numeric;
  v_remaining numeric;
  v_allocated numeric;
  v_transaction bigint;
  v_reconciliation bigint;
  v_operation uuid := gen_random_uuid();
  v_date date;
  v_month date;
  v_sale record;
  v_allocations jsonb := '[]'::jsonb;
begin
  select lower(role::text) into v_role
  from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_deposit_at is null or p_amount is null or p_amount <= 0 or scale(p_amount) > 3 then
    return jsonb_build_object('status', 'invalid_amount');
  end if;

  v_date := ((p_deposit_at at time zone 'Asia/Ho_Chi_Minh') - interval '3 hours')::date;
  v_month := date_trunc('month', v_date)::date;
  -- Same lock order as create/match/cancel/settle: month close, then card clearing balance.
  perform pg_advisory_xact_lock(hashtext('ledger_month_close_serial'));
  for v_lock_month in select m from (
   select distinct date_trunc('month',business_date)::date m from public.ledger_transactions
    where status='confirmed' and source_type='pos_sales_daily_payment' and source_key like 'pos:%:card' and business_date<=v_date
   union select v_month union select v_current_month
  ) months order by m loop
   perform pg_advisory_xact_lock(hashtext('ledger_month_close'),hashtext(v_lock_month::text));
   perform pg_advisory_xact_lock(hashtext('ledger_month_close:'||to_char(v_lock_month,'YYYY-MM')));
  end loop;
  if public.ledger_month_is_closed_v1(v_month) then
    return jsonb_build_object('status', 'month_closed');
  end if;
  perform pg_advisory_xact_lock(hashtext('ledger_card_clearing_balance'));

  select id into v_clearing
  from public.ledger_fund_accounts
  where code = 'card_clearing' and is_active = true
  for update;
  if v_clearing is null then return jsonb_build_object('status', 'card_clearing_missing'); end if;

  -- Card deposits always land in the BABA corporate bank account.
  select id into v_bank
  from public.ledger_fund_accounts
  where code = 'baba_corporate_bank' and is_active = true and type <> 'card_clearing';
  if v_bank is null then return jsonb_build_object('status', 'corporate_bank_missing'); end if;
  if p_destination_account_id is distinct from v_bank then
    return jsonb_build_object('status', 'invalid_destination');
  end if;

  select coalesce(sum(m.amount), 0) into v_balance
  from public.ledger_movements m
  join public.ledger_transactions t on t.id = m.transaction_id
  where m.fund_account_id = v_clearing and t.status = 'confirmed';
  if v_balance < p_amount then
    return jsonb_build_object('status', 'insufficient_card_pending', 'pendingBalance', v_balance);
  end if;

  -- Lock candidate sales in id order (the match RPC's order) before reading balances.
  perform 1
  from public.ledger_transactions
  where status = 'confirmed'
    and source_type = 'pos_sales_daily_payment'
    and source_key like 'pos:%:card'
    and business_date <= v_date
  order by id
  for update;

  -- Outstanding = sale gross minus every non-cancelled allocation and every active fee allocation.
  select coalesce(sum(outstanding), 0) into v_available
  from (
    select t.amount - public.ledger_card_sale_consumed_v1(t.id) as outstanding
    from public.ledger_transactions t
    where t.status = 'confirmed'
      and t.source_type = 'pos_sales_daily_payment'
      and t.source_key like 'pos:%:card'
      and t.business_date <= v_date
  ) c
  where c.outstanding > 0;
  if v_available < p_amount then
    return jsonb_build_object('status', 'insufficient_unsettled_card_sales', 'availableOutstanding', v_available, 'depositAmount', p_amount);
  end if;

  -- Corruption is never extended by a new deposit.
  if exists(select 1 from public.ledger_transactions t where t.status='confirmed' and t.source_type='pos_sales_daily_payment'
      and t.source_key like 'pos:%:card' and public.ledger_card_sale_consumed_v1(t.id)>t.amount)
     or exists(select 1 from public.ledger_card_reconciliations r where
      (r.status='auto_allocated' and r.deposit_amount<>(select coalesce(sum(l.allocated_gross_amount),0) from public.ledger_card_reconciliation_lines l where l.reconciliation_id=r.id))
      or (r.status='matched' and r.matched_gross_amount<>(select coalesce(sum(l.allocated_gross_amount),0) from public.ledger_card_reconciliation_lines l where l.reconciliation_id=r.id)))
     or exists(select 1 from public.ledger_card_fee_closures c where c.status='confirmed'
      and c.fee_amount<>(select coalesce(sum(f.allocated_fee_amount),0) from public.ledger_card_fee_allocation_lines f where f.closure_id=c.id))
  then return jsonb_build_object('status','card_data_invalid'); end if;

  -- Plan before writing: exact deposit principal, oldest sale month first. No fee is planned here.
  v_remaining:=p_amount;
  for v_sale_month in
   select date_trunc('month',t.business_date)::date sale_month,sum(t.amount) gross,
    sum(t.amount-public.ledger_card_sale_consumed_v1(t.id)) outstanding
   from public.ledger_transactions t where t.status='confirmed' and t.source_type='pos_sales_daily_payment'
    and t.source_key like 'pos:%:card' and t.business_date<=v_date
   group by 1 having sum(t.amount-public.ledger_card_sale_consumed_v1(t.id))>0 order by 1
  loop
   exit when v_remaining<=0;
   v_month_payment:=least(v_remaining,v_sale_month.outstanding);
   v_provisional:=ledger_card_fee_private.provisional_fee(v_sale_month.sale_month);
   -- Provisional manual fee (P0): only a prior, closed, unconfirmed month with an exact clearing
   -- outflow no larger than the remainder is unambiguous. Anything else could double count.
   if v_provisional is null or (v_provisional<>0 and (v_provisional<0 or v_provisional>v_sale_month.outstanding
      or not(v_sale_month.sale_month<v_month and v_sale_month.sale_month<v_current_month and public.ledger_month_is_closed_v1(v_sale_month.sale_month))
      or exists(select 1 from public.ledger_card_fee_closures c where c.fee_month=v_sale_month.sale_month and c.status='confirmed'))) then
    return jsonb_build_object('status','card_fee_review_required','feeMonth',v_sale_month.sale_month,'reason','provisional_fee_mismatch',
     'provisionalFee',v_provisional,'remainingAmount',v_sale_month.outstanding);
   elsif v_provisional<>0 then
    -- A legacy deposit that could still pay this month's sales makes the remainder unknown.
    if exists(select 1 from public.ledger_card_reconciliations r where r.status in('unmatched','partial') and r.deposit_date>=v_sale_month.sale_month) then
     return jsonb_build_object('status','card_fee_review_required','feeMonth',v_sale_month.sale_month,'reason','legacy_unallocated_deposits',
      'provisionalFee',v_provisional,'remainingAmount',v_sale_month.outstanding);
    end if;
    -- Already expensed and taken from card clearing: never repaid by a deposit.
    v_month_payment:=least(v_remaining,v_sale_month.outstanding-v_provisional);
    v_reviews:=v_reviews||jsonb_build_array(jsonb_build_object('month',v_sale_month.sale_month,'reason','provisional_fee',
     'provisionalFee',v_provisional,'remainingAmount',v_sale_month.outstanding));
   end if;
   v_remaining:=v_remaining-v_month_payment;
   for v_sale in select t.id,t.business_date,t.amount-public.ledger_card_sale_consumed_v1(t.id) outstanding
    from public.ledger_transactions t where t.status='confirmed' and t.source_type='pos_sales_daily_payment'
     and t.source_key like 'pos:%:card' and t.business_date<=v_date
     and date_trunc('month',t.business_date)::date=v_sale_month.sale_month
     and t.amount-public.ledger_card_sale_consumed_v1(t.id)>0 order by t.business_date,t.id
   loop
    exit when v_month_payment<=0;
    v_allocated:=least(v_month_payment,v_sale.outstanding);
    v_allocations:=v_allocations||jsonb_build_array(jsonb_build_object('transactionId',v_sale.id,'businessDate',v_sale.business_date,
     'outstandingBefore',v_sale.outstanding,'allocatedAmount',v_allocated,'outstandingAfter',v_sale.outstanding-v_allocated));
    v_month_payment:=v_month_payment-v_allocated;
   end loop;
  end loop;
  if v_remaining<>0 then
   return jsonb_build_object('status','insufficient_unsettled_card_sales','availableOutstanding',p_amount-v_remaining,'depositAmount',p_amount);
  end if;

  insert into public.ledger_transactions(
    operation_id, type, occurred_at, business_date, amount, status, source_type,
    source_snapshot, source_fingerprint, source_synced_at, memo, created_by, confirmed_by
  ) values (
    v_operation, 'card_settlement_deposit', p_deposit_at, v_date, p_amount, 'confirmed',
    'card_settlement_deposit',
    jsonb_build_object('depositAmount', p_amount, 'destinationFundAccountId', v_bank, 'allocationMode', 'fifo_auto'),
    md5(v_operation::text || ':' || p_amount::text), now(), nullif(btrim(p_memo), ''),
    p_actor_user_id, p_actor_user_id
  ) returning id into v_transaction;

  insert into public.ledger_movements(transaction_id, fund_account_id, amount)
  values (v_transaction, v_clearing, -p_amount), (v_transaction, v_bank, p_amount);

  insert into public.ledger_card_reconciliations(
    deposit_transaction_id, deposit_date, destination_fund_account_id, deposit_amount,
    matched_gross_amount, difference_amount, status, memo
  ) values (
    v_transaction, v_date, v_bank, p_amount, p_amount, 0, 'auto_allocated', nullif(btrim(p_memo), '')
  ) returning id into v_reconciliation;

  for v_line in select value from jsonb_array_elements(v_allocations) loop
   insert into public.ledger_card_reconciliation_lines(reconciliation_id,pos_card_transaction_id,allocated_gross_amount)
   values(v_reconciliation,(v_line->>'transactionId')::bigint,(v_line->>'allocatedAmount')::numeric);
  end loop;
  if (select sum(allocated_gross_amount) from public.ledger_card_reconciliation_lines where reconciliation_id=v_reconciliation)<>p_amount then
   raise exception 'CARD_DEPOSIT_ALLOCATION_MISMATCH';
  end if;

  insert into public.ledger_audit_logs(actor_user_id, action, entity_type, entity_id, after_snapshot, reason)
  values (
    p_actor_user_id, 'card_deposit_auto_allocated', 'card_reconciliation', v_reconciliation,
    jsonb_build_object(
      'depositTransactionId', v_transaction, 'bankAccountId', v_bank, 'depositAmount', p_amount,
      'beforePendingBalance', v_balance, 'afterPendingBalance', v_balance - p_amount,
      'autoFeeClosures', '[]'::jsonb, 'feeReviews', v_reviews, 'allocations', v_allocations,
      'matchedGrossAmount', p_amount, 'differenceAmount', 0, 'status', 'auto_allocated'
    ),
    nullif(btrim(p_memo), '')
  );
  -- autoFeeClosures stays in the response (always empty) for API compatibility.
  return jsonb_build_object(
    'status', 'created', 'reconciliationId', v_reconciliation, 'transactionId', v_transaction,
    'totalAllocated', p_amount, 'allocations', v_allocations, 'autoFeeClosures', '[]'::jsonb, 'feeReviews', v_reviews
  );
exception
  when check_violation or foreign_key_violation or not_null_violation then
    return jsonb_build_object('status', 'invalid_input');
end;
$$;

---------------------------------------------------------------------------
-- 2. Post-close finalizer: no rate window; the fee is the actual remainder. Only the settlement RPC
--    calls it now. The snapshot keeps autoConfirmed=true because the existing guards, the append-only
--    cancellation path and the post-close snapshot normalizer key on it (= post-close finalization).
create or replace function ledger_card_fee_private.allowed_transaction(p_tx public.ledger_transactions) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
 select exists(
  select 1 from ledger_card_fee_private.finalization_permissions p
  join public.ledger_card_reconciliations r on r.id=p.deposit_id and r.status='auto_allocated'
  join public.ledger_transactions deposit on deposit.id=r.deposit_transaction_id and deposit.status='confirmed'
  join public.ledger_categories category on category.id=p_tx.category_id and category.kind='expense' and category.name='카드 정산 차액'
  where p.xact_id=txid_current() and p.expense_id=p_tx.id and p.fee_month=p_tx.recognition_month
   and p.business_date=p_tx.business_date and p.fee_amount=p_tx.amount
   and p_tx.type='expense_recognition' and p_tx.status='confirmed' and p_tx.economic_effect_sign=1
   and p_tx.source_type='card_fee_month_close' and p_tx.source_key='card-fee-closure:'||p.closure_id
   and p_tx.created_by=p.actor_id and p_tx.confirmed_by=p.actor_id
   and p_tx.source_snapshot->>'autoConfirmed'='true'
   and (p_tx.source_snapshot->>'triggerDepositReconciliationId')::bigint=p.deposit_id
   and public.ledger_month_is_closed_v1(p.fee_month)
   and p.fee_month<date_trunc('month',p.business_date)::date
 )
$$;

create or replace function ledger_card_fee_private.finalize_month(p_month date,p_deposit bigint,p_actor bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 v_gross numeric; v_fee numeric; v_category bigint;
 v_closure bigint; v_tx bigint; v_clearing bigint; v_date date:=((now() at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date;
 v_sale record; v_meta jsonb; v_lines jsonb:='[]';
begin
 -- The settlement deposit is any confirmed deposit dated after the sale month (the month's last deposit).
 if not public.ledger_month_is_closed_v1(p_month) or p_month>=date_trunc('month',v_date)::date
    or not exists(select 1 from public.ledger_card_reconciliations r join public.ledger_transactions t on t.id=r.deposit_transaction_id
      where r.id=p_deposit and r.status='auto_allocated' and t.status='confirmed' and r.deposit_date>=(p_month+interval '1 month')::date)
 then raise exception 'CARD_FEE_AUTO_CONTEXT_INVALID'; end if;
 if ledger_card_fee_private.provisional_fee(p_month) is distinct from 0 then
  raise exception 'CARD_FEE_PROVISIONAL_EXISTS';
 end if;
 if exists(select 1 from public.ledger_card_fee_closures where fee_month=p_month and status='confirmed') then
  raise exception 'CARD_FEE_ALREADY_CONFIRMED';
 end if;
 select sum(t.amount),sum(t.amount-public.ledger_card_sale_consumed_v1(t.id)) into v_gross,v_fee
 from public.ledger_transactions t where t.status='confirmed' and t.source_type='pos_sales_daily_payment'
 and t.source_key like 'pos:%:card' and date_trunc('month',t.business_date)::date=p_month;
 if coalesce(v_gross,0)<=0 or coalesce(v_fee,0)<=0 then raise exception 'CARD_FEE_NOTHING_TO_SETTLE'; end if;
 perform public.ledger_assert_month_open_v1(date_trunc('month',v_date)::date);
 select id into v_category from public.ledger_categories where kind='expense' and name='카드 정산 차액' and is_active;
 select id into v_clearing from public.ledger_fund_accounts where code='card_clearing' and is_active;
 if v_category is null or v_clearing is null then raise exception 'CARD_FEE_ACCOUNT_OR_CATEGORY_MISSING'; end if;
 if (select coalesce(sum(m.amount),0) from public.ledger_movements m join public.ledger_transactions t on t.id=m.transaction_id
     where m.fund_account_id=v_clearing and t.status='confirmed')<v_fee then raise exception 'CARD_FEE_INSUFFICIENT_CLEARING'; end if;
 v_closure:=nextval(pg_get_serial_sequence('public.ledger_card_fee_closures','id'));
 v_tx:=nextval(pg_get_serial_sequence('public.ledger_transactions','id'));
 v_meta:=jsonb_build_object('closureId',v_closure,'feeMonth',p_month,'feeAmount',v_fee,'autoConfirmed',true,
  'settlementConfirmed',true,'settlementBasis','actual_deposits','triggerDepositReconciliationId',p_deposit);
 insert into ledger_card_fee_private.finalization_permissions values(txid_current(),p_month,v_closure,v_tx,p_deposit,p_actor,v_fee,v_date);
 -- Movement/business date is the actual settlement day. Only P&L recognition is historical.
 insert into public.ledger_transactions(id,operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,
  status,source_type,source_key,source_snapshot,source_fingerprint,source_synced_at,memo,created_by,confirmed_by)
 values(v_tx,gen_random_uuid(),'expense_recognition',now(),v_date,p_month,v_fee,v_category,'confirmed','card_fee_month_close',
  'card-fee-closure:'||v_closure,v_meta,md5(v_meta::text),now(),'Card payment settlement: actual fee',p_actor,p_actor);
 insert into public.ledger_movements(transaction_id,fund_account_id,amount) values(v_tx,v_clearing,-v_fee);
 insert into public.ledger_card_fee_closures(id,fee_month,fee_amount,expense_transaction_id,status,confirmed_at,confirmed_by,memo,finalization_business_date)
 values(v_closure,p_month,v_fee,v_tx,'confirmed',now(),p_actor,'settlementConfirmed: deposit '||p_deposit,v_date);
 for v_sale in select t.id,t.amount-public.ledger_card_sale_consumed_v1(t.id) outstanding
  from public.ledger_transactions t where t.status='confirmed' and t.source_type='pos_sales_daily_payment' and t.source_key like 'pos:%:card'
  and date_trunc('month',t.business_date)::date=p_month and t.amount-public.ledger_card_sale_consumed_v1(t.id)>0 order by t.business_date,t.id
 loop
  insert into public.ledger_card_fee_allocation_lines(closure_id,pos_card_transaction_id,allocated_fee_amount) values(v_closure,v_sale.id,v_sale.outstanding);
  v_lines:=v_lines||jsonb_build_array(jsonb_build_object('transactionId',v_sale.id,'allocatedFeeAmount',v_sale.outstanding));
 end loop;
 if (select coalesce(sum(allocated_fee_amount),0) from public.ledger_card_fee_allocation_lines where closure_id=v_closure)<>v_fee then
  raise exception 'CARD_FEE_ALLOCATION_MISMATCH';
 end if;
 insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,after_snapshot,reason)
 values(p_actor,'card_fee_month_confirmed','card_fee_closure',v_closure,v_meta||jsonb_build_object('cardGross',v_gross,'expenseTransactionId',v_tx,'lines',v_lines),'Card payment settlement completed');
 delete from ledger_card_fee_private.finalization_permissions where xact_id=txid_current();
 return v_meta||jsonb_build_object('status','confirmed','expenseTransactionId',v_tx);
end $$;

-- The rate policy has no remaining caller.
drop function ledger_card_fee_private.policy();

---------------------------------------------------------------------------
-- 3. Manual month confirmation (reused for open past months): month boundary = BABA business day
--    (03:00 Asia/Ho_Chi_Minh), like every other card RPC. Only this declaration changes; the anchor
--    occurs exactly once in the live definition (checked read-only 2026-11-08).
do $confirm_business_day$
declare v_definition text; v_anchor text:=$a$  v_current_month date := date_trunc('month', now() at time zone 'Asia/Ho_Chi_Minh')::date;$a$;
begin
 v_definition:=pg_get_functiondef('public.ledger_confirm_card_fee_month_v1(date,text,bigint)'::regprocedure);
 if (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 then raise exception 'CARD_FEE_CONFIRM_BUSINESS_DAY_ANCHOR_MISMATCH'; end if;
 v_definition:=replace(v_definition,v_anchor,
  $r$  v_current_month date := date_trunc('month', ((now() at time zone 'Asia/Ho_Chi_Minh') - interval '3 hours')::date)::date;$r$);
 execute v_definition;
end $confirm_business_day$;

---------------------------------------------------------------------------
-- 4. Settlement after the month's last deposit ("카드대금 정산완료"). Never automatic: the admin must
--    explicitly confirm the month's final deposit and the exact fee amount shown to them. Confirmer,
--    time and amount are written to ledger_audit_logs ('card_payment_settlement_confirmed').
create function public.ledger_complete_card_month_v1(
  p_month date, p_last_deposit_confirmed boolean, p_confirmed_fee numeric, p_memo text, p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_current date:=date_trunc('month',((now() at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date)::date;
  v_lock_month date; v_closure public.ledger_card_fee_closures%rowtype; v_legacy bigint; v_earlier date;
  v_gross numeric; v_outstanding numeric; v_deposit bigint; v_result jsonb; v_path text;
begin
  select lower(role::text) into v_role from public.users where id=p_actor_user_id and is_active and app_login_enabled;
  if coalesce(v_role,'') not in ('owner','master') then return jsonb_build_object('status','forbidden'); end if;
  if p_month is null or p_month<>date_trunc('month',p_month)::date then return jsonb_build_object('status','invalid_month'); end if;
  -- Explicit confirmation of the month's final deposit and of the amount; a bare remainder never settles.
  if p_last_deposit_confirmed is not true then return jsonb_build_object('status','last_deposit_confirmation_required'); end if;
  if p_confirmed_fee is null or p_confirmed_fee<=0 or scale(p_confirmed_fee)>3 then return jsonb_build_object('status','invalid_confirmed_fee'); end if;
  -- The running business month's deposits are still arriving.
  if p_month>=v_current then
    return jsonb_build_object('status', case when p_month=v_current then 'current_month' else 'future_month' end);
  end if;

  if not public.ledger_month_is_closed_v1(p_month) then
    -- An open past month books the same actual remainder through the existing manual confirmation,
    -- which locks and recomputes it. The amount must still be the one the admin confirmed.
    select coalesce(sum(t.amount-public.ledger_card_sale_consumed_v1(t.id)),0) into v_outstanding
    from public.ledger_transactions t where t.status='confirmed' and t.source_type='pos_sales_daily_payment' and t.source_key like 'pos:%:card'
      and date_trunc('month',t.business_date)::date=p_month;
    if v_outstanding<>p_confirmed_fee then
      return jsonb_build_object('status','confirmed_fee_mismatch','feeAmount',v_outstanding,'confirmedFee',p_confirmed_fee);
    end if;
    v_result:=public.ledger_confirm_card_fee_month_v1(p_month, p_memo, p_actor_user_id);
    if v_result->>'status' is distinct from 'confirmed' then return v_result; end if;
    -- Recomputed under lock: a change after the pre-check rolls everything back.
    if (v_result->>'feeAmount')::numeric<>p_confirmed_fee then raise exception 'CARD_FEE_CONFIRMED_AMOUNT_CHANGED'; end if;
    v_path:='open_month_manual_confirmation';
  else
    -- Same lock order as deposit/cancel: month close (ascending), then card clearing.
    perform pg_advisory_xact_lock(hashtext('ledger_month_close_serial'));
    for v_lock_month in select distinct m from (values(p_month),(v_current)) months(m) order by m loop
      perform pg_advisory_xact_lock(hashtext('ledger_month_close'),hashtext(v_lock_month::text));
      perform pg_advisory_xact_lock(hashtext('ledger_month_close:'||to_char(v_lock_month,'YYYY-MM')));
    end loop;
    perform pg_advisory_xact_lock(hashtext('ledger_card_clearing_balance'));
    if public.ledger_month_is_closed_v1(v_current) then return jsonb_build_object('status','month_closed'); end if;

    select * into v_closure from public.ledger_card_fee_closures where fee_month=p_month and status='confirmed';
    if v_closure.id is not null then
      return jsonb_build_object('status','already_confirmed','closureId',v_closure.id,'feeAmount',v_closure.fee_amount);
    end if;
    -- October #4119 style provisional fee: settled later by a current-month correction, never here.
    if ledger_card_fee_private.provisional_fee(p_month) is distinct from 0 then
      return jsonb_build_object('status','provisional_fee_exists','provisionalFee',ledger_card_fee_private.provisional_fee(p_month));
    end if;
    -- A legacy deposit that could still pay this month's sales would be booked as fee.
    select count(*) into v_legacy from public.ledger_card_reconciliations where status in('unmatched','partial') and deposit_date>=p_month;
    if v_legacy>0 then return jsonb_build_object('status','legacy_unallocated_deposits','count',v_legacy); end if;
    -- FIFO: an older month with unpaid principal (beyond its provisional fee) is settled first.
    select min(e.sale_month) into v_earlier from (
      select date_trunc('month',t.business_date)::date sale_month, sum(t.amount-public.ledger_card_sale_consumed_v1(t.id)) outstanding
      from public.ledger_transactions t where t.status='confirmed' and t.source_type='pos_sales_daily_payment' and t.source_key like 'pos:%:card'
        and t.business_date<p_month group by 1
    ) e
    where e.outstanding-coalesce(ledger_card_fee_private.provisional_fee(e.sale_month),0)>0
      and not exists(select 1 from public.ledger_card_fee_closures c where c.status='confirmed' and c.fee_month=e.sale_month);
    if v_earlier is not null then return jsonb_build_object('status','earlier_month_unconfirmed','month',v_earlier); end if;

    select coalesce(sum(t.amount),0),coalesce(sum(t.amount-public.ledger_card_sale_consumed_v1(t.id)),0) into v_gross,v_outstanding
    from public.ledger_transactions t where t.status='confirmed' and t.source_type='pos_sales_daily_payment' and t.source_key like 'pos:%:card'
      and date_trunc('month',t.business_date)::date=p_month;
    if v_gross<=0 then return jsonb_build_object('status','no_card_sales'); end if;
    if v_outstanding<=0 then return jsonb_build_object('status','nothing_to_settle'); end if;
    -- Under lock: the amount must be exactly the one the admin confirmed.
    if v_outstanding<>p_confirmed_fee then
      return jsonb_build_object('status','confirmed_fee_mismatch','feeAmount',v_outstanding,'confirmedFee',p_confirmed_fee);
    end if;
    -- The month's last deposit: the latest deposit after month end that paid this month's sales.
    select r.id into v_deposit
    from public.ledger_card_reconciliations r
    join public.ledger_card_reconciliation_lines l on l.reconciliation_id=r.id
    join public.ledger_transactions s on s.id=l.pos_card_transaction_id
    where r.status='auto_allocated' and r.deposit_date>=(p_month+interval '1 month')::date
      and date_trunc('month',s.business_date)::date=p_month
    order by r.deposit_date desc, r.id desc limit 1;
    if v_deposit is null then return jsonb_build_object('status','no_settlement_deposit'); end if;
    v_result:=ledger_card_fee_private.finalize_month(p_month, v_deposit, p_actor_user_id)
      ||jsonb_build_object('settlementDepositReconciliationId',v_deposit,'cardGross',v_gross);
    v_path:='closed_month_post_close_settlement';
  end if;

  -- Who confirmed the month's final deposit, when, and for which amount (same transaction).
  insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,after_snapshot,reason)
  values(p_actor_user_id,'card_payment_settlement_confirmed','card_fee_closure',(v_result->>'closureId')::bigint,
    jsonb_build_object('feeMonth',p_month,'lastDepositConfirmed',true,'confirmedBy',p_actor_user_id,'confirmedAt',now(),
      'confirmedFee',p_confirmed_fee,'feeAmount',(v_result->>'feeAmount')::numeric,'path',v_path,
      'settlementDepositReconciliationId',v_result->'settlementDepositReconciliationId','expenseTransactionId',v_result->'expenseTransactionId'),
    coalesce(nullif(btrim(p_memo),''),'Final card deposit confirmed by admin'));
  return v_result||jsonb_build_object('lastDepositConfirmed',true,'confirmedBy',p_actor_user_id,'confirmedFee',p_confirmed_fee,'path',v_path);
end $$;

revoke all on function ledger_card_fee_private.allowed_transaction(public.ledger_transactions) from public,anon,authenticated,service_role;
revoke all on function ledger_card_fee_private.finalize_month(date,bigint,bigint) from public,anon,authenticated,service_role;
revoke all on function public.ledger_create_card_deposit_auto_allocate_v1(timestamptz,numeric,bigint,text,bigint) from public,anon,authenticated;
grant execute on function public.ledger_create_card_deposit_auto_allocate_v1(timestamptz,numeric,bigint,text,bigint) to service_role;
revoke all on function public.ledger_confirm_card_fee_month_v1(date,text,bigint) from public,anon,authenticated;
grant execute on function public.ledger_confirm_card_fee_month_v1(date,text,bigint) to service_role;
revoke all on function public.ledger_complete_card_month_v1(date,boolean,numeric,text,bigint) from public,anon,authenticated;
grant execute on function public.ledger_complete_card_month_v1(date,boolean,numeric,text,bigint) to service_role;
comment on function public.ledger_create_card_deposit_auto_allocate_v1(timestamptz,numeric,bigint,text,bigint) is
 'Registers actual bank principal and allocates it FIFO by sale date. Never books a card fee; provisional-fee months are skipped.';
comment on function public.ledger_complete_card_month_v1(date,boolean,numeric,text,bigint) is
 'Card payment settlement: the admin explicitly confirms the month''s final deposit and the exact remainder, which is booked once as the card fee and audited.';
commit;
