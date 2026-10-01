do $rollback$
declare
  v_function regprocedure := 'public.ledger_pay_payables_v1(bigint,bigint,timestamptz,numeric,jsonb,text,bigint)'::regprocedure;
  v_definition text;
  v_guard text := $guard$
 if p_allocations is null and exists(
   select 1 from public.ledger_parties where id=p_party_id and memo='system:ad_hoc_payable'
 ) then return jsonb_build_object('status','explicit_allocations_required');end if;
$guard$;
begin
  -- Exact safety checks: abort the whole migration if Production is not in the
  -- known ad-hoc state that was created on 2026-10-01.
  if (select count(*) from public.ledger_payable_allocations where payable_id=962) <> 0 then
    raise exception 'ROLLBACK_ABORTED: payable 962 has allocations';
  end if;
  if (select count(*) from public.ledger_movements where transaction_id=2168) <> 0 then
    raise exception 'ROLLBACK_ABORTED: transaction 2168 has movements';
  end if;
  if (select count(*) from public.ledger_transactions where correction_of_id=2168) <> 0 then
    raise exception 'ROLLBACK_ABORTED: transaction 2168 has corrections';
  end if;
  if (select count(*) from public.business_partner_ledger_parties where ledger_party_id=28) <> 0 then
    raise exception 'ROLLBACK_ABORTED: party 28 has business partner links';
  end if;
  if (select count(*) from public.ledger_payables where party_id=28) <> 1 then
    raise exception 'ROLLBACK_ABORTED: unexpected payable count for party 28';
  end if;
  if (select count(*) from public.ledger_transactions where party_id=28) <> 1 then
    raise exception 'ROLLBACK_ABORTED: unexpected transaction count for party 28';
  end if;
  if not exists(
    select 1 from public.ledger_candidates
    where id=1450 and status='confirmed' and resolved_transaction_id=2168
  ) then
    raise exception 'ROLLBACK_ABORTED: candidate 1450 state mismatch';
  end if;
  if not exists(
    select 1 from public.ledger_payables
    where id=962 and party_id=28 and expense_transaction_id=2168
      and original_amount=2400000 and status='unpaid'
  ) then
    raise exception 'ROLLBACK_ABORTED: payable 962 state mismatch';
  end if;
  if not exists(
    select 1 from public.ledger_transactions
    where id=2168 and party_id=28 and source_key='candidate:1450'
      and amount=2400000 and status='confirmed'
  ) then
    raise exception 'ROLLBACK_ABORTED: transaction 2168 state mismatch';
  end if;
  if not exists(
    select 1 from public.ledger_parties
    where id=28 and memo='system:ad_hoc_payable'
  ) then
    raise exception 'ROLLBACK_ABORTED: party 28 marker mismatch';
  end if;

  -- Restore payment RPC exactly by removing only the injected ad-hoc guard.
  v_definition := pg_get_functiondef(v_function);
  if position('explicit_allocations_required' in v_definition) > 0 then
    if position(v_guard in v_definition) = 0 then
      raise exception 'ROLLBACK_ABORTED: ad-hoc guard text mismatch';
    end if;
    v_definition := replace(v_definition, v_guard, '');
    execute v_definition;
  end if;

  -- Restore candidate #1450 to the exact pre-confirmation state recorded in audit #4377.
  update public.ledger_candidates
  set status='pending',
      updated_at='2026-09-30T17:47:38.580149+00:00'::timestamptz,
      resolved_at=null,
      resolved_by=null,
      resolved_transaction_id=null,
      dismissal_reason=null,
      proposed_party_id=null
  where id=1450;

  delete from public.ledger_payables where id=962;
  delete from public.ledger_transactions where id=2168;
  delete from public.ledger_parties where id=28 and memo='system:ad_hoc_payable';
end;
$rollback$;