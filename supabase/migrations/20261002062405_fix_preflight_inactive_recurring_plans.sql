CREATE OR REPLACE FUNCTION public.ledger_close_preflight_v1(p_month date, p_actor_user_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare v_role text;v_blockers jsonb:='[]';v_warnings jsonb:='[]';v_token text;v_count bigint;v_amount numeric;v_card_gross numeric;v_card_outstanding numeric;
begin
 select lower(role::text) into v_role from public.users where id=p_actor_user_id and is_active=true and app_login_enabled=true;
 if coalesce(v_role,'') not in('owner','master') then return jsonb_build_object('status','forbidden');end if;
 if p_month is null or p_month<>date_trunc('month',p_month)::date then return jsonb_build_object('status','invalid_month');end if;
 if p_month>=date_trunc('month',now() at time zone 'Asia/Ho_Chi_Minh')::date then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code',case when p_month=date_trunc('month',now() at time zone 'Asia/Ho_Chi_Minh')::date then'CURRENT_MONTH'else'FUTURE_MONTH'end));end if;
 if public.ledger_month_is_closed_v1(p_month) then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','ALREADY_CLOSED'));end if;
 select count(*) into v_count from public.ledger_candidates where proposed_recognition_month=p_month and status='pending'and candidate_type in('inventory_purchase','employee_meal');if v_count>0 then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','PENDING_CANDIDATES','count',v_count));end if;
 if exists(select 1 from public.payroll_payment_batches where payroll_month=p_month and status<>'completed')or((select min(payroll_month)from public.payroll_payment_batches)<=p_month and not exists(select 1 from public.payroll_payment_batches where payroll_month=p_month and status='completed')) then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','PAYROLL_NOT_COMPLETED'));end if;
 select count(*) into v_count from public.ledger_recurring_expense_plans p where p.is_active=true and p.effective_from<=p_month and(p.effective_to is null or p.effective_to>=p_month)and not exists(select 1 from public.ledger_transactions t where t.source_type='recurring_expense'and t.source_key='recurring:'||p.id||':'||to_char(p_month,'YYYY-MM')and t.status in('confirmed','cancelled'));if v_count>0 then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','RECURRING_NOT_SYNCED','count',v_count));end if;
 select count(*) into v_count from public.ledger_candidates where proposed_recognition_month=p_month and status='confirmed'and resolved_transaction_id is null;if v_count>0 then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','CANDIDATE_LINK_BROKEN','count',v_count));end if;
 if exists(select 1 from public.ledger_transactions t where t.type='transfer'and(t.recognition_month=p_month or date_trunc('month',t.business_date)::date=p_month)and coalesce((select sum(m.amount)from public.ledger_movements m where m.transaction_id=t.id),0)<>0) then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','TRANSFER_UNBALANCED'));end if;
 if exists(select 1 from public.ledger_transactions t where((t.source_type='manual'and t.type in('expense','income'))or t.type in('payroll_payment','payable_payment','prepaid_expense_payment','card_settlement_deposit'))and(t.recognition_month=p_month or date_trunc('month',t.business_date)::date=p_month)and not exists(select 1 from public.ledger_movements m where m.transaction_id=t.id))then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','REQUIRED_MOVEMENT_MISSING'));end if;
 if exists(select 1 from public.ledger_payables p where(select coalesce(sum(a.allocated_amount),0)from public.ledger_payable_allocations a where a.payable_id=p.id)>p.original_amount)then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','PAYABLE_OVERALLOCATED'));end if;
 if exists(select 1 from(select l.pos_card_transaction_id id from public.ledger_card_reconciliation_lines l union select f.pos_card_transaction_id from public.ledger_card_fee_allocation_lines f)s join public.ledger_transactions t on t.id=s.id where public.ledger_card_sale_consumed_v1(t.id)>t.amount)then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','CARD_OVERALLOCATED'));end if;
 if exists(select source_type,source_key from public.ledger_transactions where source_key is not null and status='confirmed' group by source_type,source_key having count(*)>1)then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','DUPLICATE_ACTIVE_SOURCE'));end if;
 select count(*),coalesce(sum(r.deposit_amount),0) into v_count,v_amount from public.ledger_card_reconciliations r where r.status in('unmatched','partial')and date_trunc('month',r.deposit_date)::date=p_month;if v_count>0 then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','CARD_UNMATCHED','count',v_count,'amount',v_amount));end if; select coalesce(sum(t.amount),0),coalesce(sum(greatest(t.amount-public.ledger_card_sale_consumed_v1(t.id),0)),0) into v_card_gross,v_card_outstanding from public.ledger_transactions t where t.status='confirmed'and t.source_type='pos_sales_daily_payment'and t.source_key like 'pos:%:card'and date_trunc('month',t.business_date)::date=p_month;if v_card_gross>0 and not exists(select 1 from public.ledger_card_fee_closures c where c.fee_month=p_month and c.status='confirmed')then v_warnings:=v_warnings||jsonb_build_array(jsonb_build_object('code','CARD_FEE_PENDING','amount',v_card_outstanding));end if;
 select coalesce(sum(p.original_amount)-sum(coalesce((select sum(a.allocated_amount)from public.ledger_payable_allocations a join public.ledger_transactions pt on pt.id=a.payment_transaction_id where a.payable_id=p.id and pt.business_date<(p_month+interval'1 month')::date),0)),0) into v_amount from public.ledger_payables p join public.ledger_transactions t on t.id=p.expense_transaction_id where t.business_date<(p_month+interval'1 month')::date and p.status<>'cancelled' and coalesce(t.source_snapshot->>'paymentVerification','')<>'pending';if v_amount>0 then v_warnings:=v_warnings||jsonb_build_array(jsonb_build_object('code','PAYABLE_OUTSTANDING','amount',v_amount));end if;
 select count(*) into v_count from public.ledger_transactions where type='balance_adjustment'and date_trunc('month',business_date)::date=p_month;if v_count>0 then v_warnings:=v_warnings||jsonb_build_array(jsonb_build_object('code','BALANCE_ADJUSTMENT','count',v_count));end if;
 select count(*) into v_count from public.ledger_reserve_plans p where p.is_active and coalesce((select sum(case e.entry_type when'allocate'then e.amount when'release'then-e.amount when'consume'then-e.amount else e.amount end)from public.ledger_reserve_entries e where e.reserve_plan_id=p.id and e.occurred_at<((p_month+interval'1 month')::date+time'03:00')at time zone'Asia/Ho_Chi_Minh'),0)<p.target_amount;if v_count>0 then v_warnings:=v_warnings||jsonb_build_array(jsonb_build_object('code','RESERVE_SHORTFALL','count',v_count));end if;
 select count(*) into v_count from public.ledger_candidates where candidate_type='source_drift'and status='pending'and(source_snapshot->>'affectedClosedMonth')::date=p_month;if v_count>0 then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','CONFIRMED_SOURCE_DRIFT','count',v_count));end if;

 select count(*),coalesce(sum(greatest(0,p.original_amount-coalesce((
   select sum(a.allocated_amount) from public.ledger_payable_allocations a
   join public.ledger_transactions payment on payment.id=a.payment_transaction_id and payment.status='confirmed'
   where a.payable_id=p.id
 ),0))),0) into v_count,v_amount
 from public.ledger_payables p join public.ledger_transactions expense on expense.id=p.expense_transaction_id
 where expense.status='confirmed' and expense.business_date>=p_month
   and expense.business_date<(p_month+interval '1 month')::date
   and expense.source_snapshot->>'paymentVerification'='pending'
   and p.status<>'cancelled'
   and p.original_amount>coalesce((
     select sum(a.allocated_amount) from public.ledger_payable_allocations a
     join public.ledger_transactions payment on payment.id=a.payment_transaction_id and payment.status='confirmed'
     where a.payable_id=p.id
   ),0);
 if v_count>0 then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object(
   'code','PAYMENT_VERIFICATION_UNRESOLVED','count',v_count,'amount',v_amount));end if;
 select count(*),coalesce(sum(greatest(0,p.original_amount-coalesce((
   select sum(a.allocated_amount) from public.ledger_payable_allocations a
   join public.ledger_transactions payment on payment.id=a.payment_transaction_id and payment.status='confirmed'
   where a.payable_id=p.id and payment.business_date<(p_month+interval '1 month')::date
 ),0))),0) into v_count,v_amount
 from public.ledger_payables p join public.ledger_transactions expense on expense.id=p.expense_transaction_id
 where expense.status='confirmed' and expense.business_date>=p_month
   and expense.business_date<(p_month+interval '1 month')::date
   and expense.source_snapshot->>'paymentVerification'='pending'
   and p.status<>'cancelled'
   and p.original_amount<=coalesce((
     select sum(a.allocated_amount) from public.ledger_payable_allocations a
     join public.ledger_transactions payment on payment.id=a.payment_transaction_id and payment.status='confirmed'
     where a.payable_id=p.id
   ),0)
   and p.original_amount>coalesce((
     select sum(a.allocated_amount) from public.ledger_payable_allocations a
     join public.ledger_transactions payment on payment.id=a.payment_transaction_id and payment.status='confirmed'
     where a.payable_id=p.id and payment.business_date<(p_month+interval '1 month')::date
   ),0);
 if v_count>0 then v_warnings:=v_warnings||jsonb_build_array(jsonb_build_object(
   'code','PAYMENT_VERIFICATION_LATER_PAID','count',v_count,'amount',v_amount));end if;

 if (select coalesce(sum(m.amount),0) from public.ledger_movements m join public.ledger_transactions t on t.id=m.transaction_id
     join public.ledger_fund_accounts f on f.id=m.fund_account_id where f.code='card_clearing' and t.status='confirmed')<0 then
  v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','CARD_CLEARING_NEGATIVE'));end if;
 if exists(select 1 from public.ledger_card_reconciliations r where
  (r.status='auto_allocated' and r.deposit_amount<>(select coalesce(sum(l.allocated_gross_amount),0) from public.ledger_card_reconciliation_lines l where l.reconciliation_id=r.id))
  or (r.status='matched' and r.matched_gross_amount<>(select coalesce(sum(l.allocated_gross_amount),0) from public.ledger_card_reconciliation_lines l where l.reconciliation_id=r.id))) then
  v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','CARD_ALLOCATION_MISMATCH'));end if;
 if exists(select 1 from public.ledger_card_fee_closures c where c.status='confirmed' and
  c.fee_amount<>(select coalesce(sum(f.allocated_fee_amount),0) from public.ledger_card_fee_allocation_lines f where f.closure_id=c.id)) then
  v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','CARD_FEE_ALLOCATION_MISMATCH'));end if;
 v_token:=md5((jsonb_build_object('month',p_month,'blockers',v_blockers,'warnings',v_warnings,'transactionState',(select coalesce(jsonb_agg(jsonb_build_array(id,updated_at,amount,status,source_fingerprint)order by id),'[]')from public.ledger_transactions where recognition_month=p_month or date_trunc('month',business_date)::date=p_month),'candidateState',(select coalesce(jsonb_agg(jsonb_build_array(id,updated_at,status,source_fingerprint)order by id),'[]')from public.ledger_candidates where proposed_recognition_month=p_month),'cardState',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'updatedAt',r.updated_at,'status',r.status,'matchedGrossAmount',r.matched_gross_amount,'differenceAmount',r.difference_amount,'lines',coalesce((select jsonb_agg(jsonb_build_array(l.pos_card_transaction_id,l.allocated_gross_amount)order by l.pos_card_transaction_id)from public.ledger_card_reconciliation_lines l where l.reconciliation_id=r.id),'[]'::jsonb))order by r.id),'[]'::jsonb)from public.ledger_card_reconciliations r where date_trunc('month',r.deposit_date)::date=p_month),'cardFeeState',(select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'updatedAt',c.updated_at,'status',c.status,'feeAmount',c.fee_amount,'lines',coalesce((select jsonb_agg(jsonb_build_array(f.pos_card_transaction_id,f.allocated_fee_amount)order by f.pos_card_transaction_id)from public.ledger_card_fee_allocation_lines f where f.closure_id=c.id),'[]'::jsonb))order by c.id),'[]'::jsonb)from public.ledger_card_fee_closures c where c.fee_month=p_month))::text)||md5('ledger-close-v1:'||jsonb_build_object('month',p_month,'blockers',v_blockers,'warnings',v_warnings)::text));
 return jsonb_build_object('status','ok','month',p_month,'canClose',jsonb_array_length(v_blockers)=0,'blockers',v_blockers,'warnings',v_warnings,'preflightHash',v_token);
end$function$
