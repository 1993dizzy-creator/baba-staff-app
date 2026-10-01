-- Ledger-only shared party: no business partner, supplier alias, or source mapping.
-- Repeatable by marker; no database ID is assumed.
do $ad_hoc_party$
begin
  perform pg_advisory_xact_lock(hashtext('ledger_party:system:ad_hoc_payable'));
  insert into public.ledger_parties(name,type,is_active,memo)
  select '기타 (khác)','other',true,'system:ad_hoc_payable'
  where not exists(select 1 from public.ledger_parties where memo='system:ad_hoc_payable');
end;
$ad_hoc_party$;

-- Preserve the installed payment implementation and permissions. Only this
-- system party must supply explicit allocations; ordinary party FIFO is unchanged.
do $ad_hoc_payment$
declare
  v_function regprocedure := 'public.ledger_pay_payables_v1(bigint,bigint,timestamptz,numeric,jsonb,text,bigint)'::regprocedure;
  v_definition text;
  v_guard text := $guard$
 if p_allocations is null and exists(
   select 1 from public.ledger_parties where id=p_party_id and memo='system:ad_hoc_payable'
 ) then return jsonb_build_object('status','explicit_allocations_required');end if;
$guard$;
begin
  v_definition := pg_get_functiondef(v_function);
  if position('explicit_allocations_required' in v_definition)=0 then
    if position(' if p_allocations is null then' in v_definition)=0 then
      raise exception 'AD_HOC_PAYABLE_PAYMENT_CONTRACT_MISMATCH';
    end if;
    v_definition := replace(v_definition,' if p_allocations is null then',v_guard || ' if p_allocations is null then');
    execute v_definition;
  end if;
end;
$ad_hoc_payment$;
