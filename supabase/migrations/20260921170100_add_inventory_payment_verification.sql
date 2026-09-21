-- Future inventory syncs must not turn a partner's default payment mode into
-- proof of an actual cash payment. This migration does not alter existing rows.
-- A verification-pending purchase is an expense plus a payable, with no fund
-- movement. Its immutable source snapshot marks it for a separate UI section.
do $payment_verification$
declare
  v_oid regprocedure;
  v_definition text;
  v_before text;
  v_guard text;
begin
  foreach v_oid in array array[
    'inventory_ledger_private.resolve_candidate(bigint,text,bigint,bigint,bigint,date,text,text,bigint)'::regprocedure,
    'public.ledger_resolve_inventory_candidate_v1(bigint,text,bigint,bigint,bigint,date,text,text,bigint)'::regprocedure
  ] loop
    v_definition := pg_get_functiondef(v_oid);
    v_before := v_definition;
    if position('p_resolution not in(''immediate'',''payable'')' in v_definition) = 0
       or position('if p_resolution=''payable'' and' in v_definition) = 0
       or position('''candidate:''||v_candidate.id,v_candidate.source_snapshot,v_candidate.source_fingerprint' in v_definition) = 0
       or position('case when p_resolution=''immediate'' then ''candidate_confirmed_immediate'' else ''candidate_confirmed_payable'' end' in v_definition) = 0 then
      raise exception 'INVENTORY_VERIFICATION_RESOLVER_CONTRACT_MISMATCH: %', v_oid;
    end if;
    v_definition := replace(v_definition,
      'p_resolution not in(''immediate'',''payable'')',
      'p_resolution not in(''immediate'',''payable'',''verification_pending'')');
    v_definition := replace(v_definition,
      'if p_resolution=''payable'' and',
      'if p_resolution in(''payable'',''verification_pending'') and');
    v_definition := replace(v_definition,
      '''candidate:''||v_candidate.id,v_candidate.source_snapshot,v_candidate.source_fingerprint',
      '''candidate:''||v_candidate.id,case when p_resolution=''verification_pending'' then (coalesce(v_candidate.source_snapshot,''{}''::jsonb)-''paymentVerification'')||jsonb_build_object(''paymentVerification'',''pending'') else v_candidate.source_snapshot-''paymentVerification'' end,v_candidate.source_fingerprint');
    v_definition := replace(v_definition,
      'case when p_resolution=''immediate'' then ''candidate_confirmed_immediate'' else ''candidate_confirmed_payable'' end',
      'case when p_resolution=''immediate'' then ''candidate_confirmed_immediate'' when p_resolution=''verification_pending'' then ''candidate_confirmed_verification_pending'' else ''candidate_confirmed_payable'' end');
    if v_definition = v_before then raise exception 'INVENTORY_VERIFICATION_RESOLVER_UNCHANGED: %', v_oid; end if;
    execute v_definition;
  end loop;

  -- The current reconciliation entry point calls this private sync function.
  -- Only the automatic immediate branch changes; confirmed postpaid purchases
  -- continue through the ordinary payable path.
  v_oid := 'inventory_ledger_private.sync_candidate(jsonb,bigint)'::regprocedure;
  v_definition := pg_get_functiondef(v_oid);
  v_guard := $guard$      if v_business_partner.default_fund_account_id is null
         or not public.business_partner_fund_account_is_eligible_v1(v_business_partner.default_fund_account_id)
         or not exists (
           select 1
           from public.ledger_fund_accounts account
           where account.id = v_business_partner.default_fund_account_id
             and account.is_active = true
             and account.is_business_fund = true
             and account.type <> 'card_clearing'
             and account.active_from <= v_pending.business_date
             and (account.active_to is null or account.active_to >= v_pending.business_date)
         ) then
        v_pending_review := v_pending_review + 1;
        continue;
      end if;
$guard$;
  if position('v_pending.id, ''immediate'', v_pending.proposed_category_id' in v_definition) = 0
     or position(v_guard in v_definition) = 0
     or position('v_auto_immediate integer := 0;' in v_definition) = 0 then
    raise exception 'INVENTORY_VERIFICATION_SYNC_CONTRACT_MISMATCH';
  end if;
  v_definition := replace(v_definition, v_guard, '');
  v_definition := replace(v_definition,
    'v_pending.id, ''immediate'', v_pending.proposed_category_id',
    'v_pending.id, ''verification_pending'', v_pending.proposed_category_id');
  v_definition := replace(v_definition,
    'v_auto_immediate integer := 0;',
    'v_auto_immediate integer := 0; v_auto_verification integer := 0;');
  v_definition := replace(v_definition,
    'then v_auto_immediate := v_auto_immediate + 1;',
    'then v_auto_verification := v_auto_verification + 1;');
  v_definition := replace(v_definition,
    '''autoConfirmedImmediateCount'', v_auto_immediate,',
    '''autoConfirmedImmediateCount'', v_auto_immediate, ''autoVerificationCount'', v_auto_verification,');
  execute v_definition;

  -- Rebooking derives both the payable/movement and snapshot marker from the
  -- final payment mode. The old marker alone cannot determine a new mode.
  v_oid := 'inventory_ledger_private.rebook_source(bigint,text,bigint,bigint,date,numeric,text,text,bigint,jsonb,text,bigint,date)'::regprocedure;
  v_definition := pg_get_functiondef(v_oid);
  if position('p_payment_mode not in (''immediate'', ''payable'')' in v_definition) = 0
     or position('if p_payment_mode = ''payable''' in v_definition) = 0
     or position('p_source_snapshot, p_source_fingerprint, now(), v_original.id,' in v_definition) = 0
     or position('if p_payment_mode = ''immediate'' then' in v_definition) = 0 then
    raise exception 'INVENTORY_VERIFICATION_REBOOK_CONTRACT_MISMATCH';
  end if;
  v_definition := replace(v_definition,
    'p_payment_mode not in (''immediate'', ''payable'')',
    'p_payment_mode not in (''immediate'', ''payable'', ''verification_pending'')');
  v_definition := replace(v_definition,
    'if p_payment_mode = ''payable''',
    'if p_payment_mode in (''payable'', ''verification_pending'')');
  v_definition := replace(v_definition,
    'p_source_snapshot, p_source_fingerprint, now(), v_original.id,',
    'case when p_payment_mode=''verification_pending'' then (coalesce(p_source_snapshot,''{}''::jsonb)-''paymentVerification'')||jsonb_build_object(''paymentVerification'',''pending'') else p_source_snapshot-''paymentVerification'' end, p_source_fingerprint, now(), v_original.id,');
  execute v_definition;

  -- Supplier changes select the new partner's payment semantics. Without a
  -- supplier change, retain the original verified/unverified payment mode.
  v_oid := 'public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'::regprocedure;
  v_definition := pg_get_functiondef(v_oid);
  if position('v_mode := case when v_payable.id is null then ''immediate'' else ''payable'' end;' in v_definition) = 0
     or position('v_mode := case when v_partner.payment_mode = ''postpaid'' then ''payable'' else ''immediate'' end;' in v_definition) = 0 then
    raise exception 'INVENTORY_VERIFICATION_PROJECTION_CONTRACT_MISMATCH';
  end if;
  v_definition := replace(v_definition,
    'v_mode := case when v_payable.id is null then ''immediate'' else ''payable'' end;',
    'v_mode := case when v_payable.id is null then ''immediate'' when v_tx.source_snapshot->>''paymentVerification''=''pending'' then ''verification_pending'' else ''payable'' end;');
  v_definition := replace(v_definition,
    'v_mode := case when v_partner.payment_mode = ''postpaid'' then ''payable'' else ''immediate'' end;',
    'v_mode := case when v_partner.payment_mode = ''postpaid'' then ''payable'' else ''verification_pending'' end;');
  execute v_definition;

  -- Keep the existing preflight hash and close RPC contract. Unresolved
  -- verification is a blocker; a later linked payment leaves an as-of warning
  -- for the original month without permanently blocking that month.
  v_oid := 'public.ledger_close_preflight_v1(date,bigint)'::regprocedure;
  v_definition := pg_get_functiondef(v_oid);
  if position(' v_token:=md5(' in v_definition) = 0
     or position('and p.status<>''cancelled'';if v_amount>0 then v_warnings' in v_definition) = 0 then
    raise exception 'INVENTORY_VERIFICATION_PREFLIGHT_CONTRACT_MISMATCH';
  end if;
  v_definition := replace(v_definition,
    'and p.status<>''cancelled'';if v_amount>0 then v_warnings',
    'and p.status<>''cancelled'' and coalesce(t.source_snapshot->>''paymentVerification'','''')<>''pending'';if v_amount>0 then v_warnings');
  v_definition := replace(v_definition, ' v_token:=md5(', $check$
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
 v_token:=md5($check$);
  execute v_definition;
end;
$payment_verification$;
