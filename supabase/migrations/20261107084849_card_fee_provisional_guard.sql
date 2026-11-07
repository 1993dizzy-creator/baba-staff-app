-- P0 card fee guard. Applied to production as migration 20261107084849 (2026-11-07).
-- * A confirmed manual card-fee expense (category 카드 정산 차액, source_type manual,
--   recognition_month = sale month) is a provisional fee. It already left card
--   clearing, so a deposit must never repay that part of the month's sales and no
--   automatic or manual closure may book the month's fee a second time.
-- * A closed month below the reference range no longer blocks a deposit: its
--   remainder is left untouched for review and FIFO continues with later months.
-- * No table, no data change, no backfill. Only three function bodies are patched in place
--   (anchor replacement, the repository's established pattern), so every other contract
--   of the live definitions is preserved and a drifted definition aborts the migration.
begin;

-- Sum of the month's provisional manual card fees, or NULL when a row is not a plain
-- single card_clearing outflow (then the sales/clearing link is unknown: review).
create function ledger_card_fee_private.provisional_fee(p_month date) returns numeric
language sql stable security definer set search_path=pg_catalog,public as $$
 select case when count(*)=0 then 0
  when bool_and(t.type='expense' and mv.n=1 and mv.clearing=-(t.amount*t.economic_effect_sign)) then sum(t.amount*t.economic_effect_sign)
  else null end
 from public.ledger_transactions t
 join public.ledger_categories c on c.id=t.category_id and c.kind='expense' and c.name='카드 정산 차액'
 cross join lateral (
  select count(*) n,coalesce(sum(m.amount) filter(where f.code='card_clearing'),0) clearing
  from public.ledger_movements m join public.ledger_fund_accounts f on f.id=m.fund_account_id where m.transaction_id=t.id
 ) mv
 where t.status='confirmed' and t.source_type='manual' and t.recognition_month=p_month
$$;
revoke all on function ledger_card_fee_private.provisional_fee(date) from public,anon,authenticated,service_role;

do $guard$
declare v_definition text; v_anchor text; v_replacement text;
begin
 ---------------------------------------------------------------------------
 -- 1. Deposit RPC: provisional months and below-range months.
 v_definition:=pg_get_functiondef('public.ledger_create_card_deposit_auto_allocate_v1(timestamptz,numeric,bigint,text,bigint)'::regprocedure);
 v_anchor:=$a$  v_clearing bigint;
  v_bank bigint;$a$;
 if (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 then raise exception 'CARD_FEE_GUARD_DECLARE_ANCHOR_MISMATCH'; end if;
 v_definition:=replace(v_definition,v_anchor,$r$  v_provisional numeric; v_reviews jsonb:='[]';
$r$||v_anchor);

 v_anchor:=$a$   v_month_payment:=least(v_remaining,v_sale_month.outstanding);
   if v_sale_month.sale_month<v_month and v_sale_month.sale_month<v_current_month
     and public.ledger_month_is_closed_v1(v_sale_month.sale_month)
     and not exists(select 1 from public.ledger_card_fee_closures c where c.fee_month=v_sale_month.sale_month and c.status='confirmed') then
    if exists(select 1 from public.ledger_card_reconciliations r where r.status in('unmatched','partial') and r.deposit_date>=v_sale_month.sale_month)
       or v_sale_month.gross<=0 or v_sale_month.outstanding/v_sale_month.gross<(v_policy->>'minRate')::numeric then
     return jsonb_build_object('status','card_fee_review_required','feeMonth',v_sale_month.sale_month,'remainingAmount',v_sale_month.outstanding);
    end if;
    if v_sale_month.outstanding/v_sale_month.gross<=(v_policy->>'maxRate')::numeric then$a$;
 if (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 then raise exception 'CARD_FEE_GUARD_PLAN_ANCHOR_MISMATCH'; end if;
 v_replacement:=$r$   v_month_payment:=least(v_remaining,v_sale_month.outstanding);
   v_provisional:=ledger_card_fee_private.provisional_fee(v_sale_month.sale_month);
   -- Provisional manual fee: only a prior, closed, unconfirmed month with an exact clearing
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
    -- Already expensed and taken from card clearing: never repaid by a deposit, never fee'd again.
    -- The rest of the month (if any) is still ordinary FIFO principal.
    v_month_payment:=least(v_remaining,v_sale_month.outstanding-v_provisional);
    v_reviews:=v_reviews||jsonb_build_array(jsonb_build_object('month',v_sale_month.sale_month,'reason','provisional_fee',
     'provisionalFee',v_provisional,'remainingAmount',v_sale_month.outstanding));
   elsif v_sale_month.sale_month<v_month and v_sale_month.sale_month<v_current_month
     and public.ledger_month_is_closed_v1(v_sale_month.sale_month)
     and not exists(select 1 from public.ledger_card_fee_closures c where c.fee_month=v_sale_month.sale_month and c.status='confirmed') then
    if exists(select 1 from public.ledger_card_reconciliations r where r.status in('unmatched','partial') and r.deposit_date>=v_sale_month.sale_month)
       or v_sale_month.gross<=0 then
     return jsonb_build_object('status','card_fee_review_required','feeMonth',v_sale_month.sale_month,'remainingAmount',v_sale_month.outstanding);
    end if;
    if v_sale_month.outstanding/v_sale_month.gross<(v_policy->>'minRate')::numeric then
     -- Below the reference range is a review reason, not a deposit blocker: the remainder is
     -- neither paid nor booked as fee, and later months continue FIFO.
     v_month_payment:=0;
     v_reviews:=v_reviews||jsonb_build_array(jsonb_build_object('month',v_sale_month.sale_month,'reason','below_min_rate',
      'remainingAmount',v_sale_month.outstanding,'rate',round(v_sale_month.outstanding/v_sale_month.gross,6)));
    elsif v_sale_month.outstanding/v_sale_month.gross<=(v_policy->>'maxRate')::numeric then$r$;
 v_definition:=replace(v_definition,v_anchor,v_replacement);

 v_anchor:=$a$      'autoFeeClosures', v_fee_result,
      'allocations', v_allocations,$a$;
 if (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 then raise exception 'CARD_FEE_GUARD_AUDIT_ANCHOR_MISMATCH'; end if;
 v_definition:=replace(v_definition,v_anchor,$r$      'autoFeeClosures', v_fee_result,
      'feeReviews', v_reviews,
      'allocations', v_allocations,$r$);
 v_anchor:=$a$    'autoFeeClosures', v_fee_result
  );$a$;
 if (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 then raise exception 'CARD_FEE_GUARD_RETURN_ANCHOR_MISMATCH'; end if;
 v_definition:=replace(v_definition,v_anchor,$r$    'autoFeeClosures', v_fee_result,
    'feeReviews', v_reviews
  );$r$);
 execute v_definition;

 ---------------------------------------------------------------------------
 -- 2. Automatic finalizer: defence in depth against a direct second fee.
 v_definition:=pg_get_functiondef('ledger_card_fee_private.finalize_month(date,bigint,bigint)'::regprocedure);
 v_anchor:=$a$ if exists(select 1 from public.ledger_card_fee_closures where fee_month=p_month and status='confirmed') then
  raise exception 'CARD_FEE_ALREADY_CONFIRMED';$a$;
 if (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 then raise exception 'CARD_FEE_GUARD_FINALIZE_ANCHOR_MISMATCH'; end if;
 v_definition:=replace(v_definition,v_anchor,$r$ if ledger_card_fee_private.provisional_fee(p_month) is distinct from 0 then
  raise exception 'CARD_FEE_PROVISIONAL_EXISTS';
 end if;
$r$||v_anchor);
 execute v_definition;

 ---------------------------------------------------------------------------
 -- 3. Manual month confirmation (open months): same duplicate guard.
 v_definition:=pg_get_functiondef('public.ledger_confirm_card_fee_month_v1(date,text,bigint)'::regprocedure);
 v_anchor:=$a$  -- A legacy deposit that could still pay this month's sales has not been allocated yet;$a$;
 if (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 then raise exception 'CARD_FEE_GUARD_CONFIRM_ANCHOR_MISMATCH'; end if;
 v_definition:=replace(v_definition,v_anchor,$r$  -- A provisional manual card-fee expense already booked this month's fee.
  v_fee:=ledger_card_fee_private.provisional_fee(p_month);
  if v_fee is distinct from 0 then
    return jsonb_build_object('status', 'provisional_fee_exists', 'provisionalFee', v_fee);
  end if;
$r$||v_anchor);
 execute v_definition;
end $guard$;

revoke all on function ledger_card_fee_private.provisional_fee(date) from public,anon,authenticated,service_role;
revoke all on function public.ledger_create_card_deposit_auto_allocate_v1(timestamptz,numeric,bigint,text,bigint) from public,anon,authenticated;
grant execute on function public.ledger_create_card_deposit_auto_allocate_v1(timestamptz,numeric,bigint,text,bigint) to service_role;
commit;
