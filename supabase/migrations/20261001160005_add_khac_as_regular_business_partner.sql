do $khac$
declare
  v_partner_id bigint;
  v_subtype_id bigint;
  v_ledger_party_id bigint;
  v_result jsonb;
begin
  select id into v_partner_id
  from public.business_partners
  where lower(btrim(name))='khác'
  order by id
  limit 1;

  select id into v_subtype_id
  from public.business_partner_subtypes
  where code='other_misc' and partner_type='other' and is_active=true
  limit 1;

  if v_subtype_id is null then
    raise exception 'KHAC_PARTNER_ABORTED: other_misc subtype missing';
  end if;

  if v_partner_id is null then
    select public.business_partner_create_v4(
      'khác',
      'other',
      'postpaid',
      'ad_hoc',
      null,
      null,
      null,
      v_subtype_id,
      null,
      null,
      '기타/미지정 구매 거래처',
      true,
      null,
      1
    ) into v_result;

    if coalesce(v_result->>'status','') <> 'created' then
      raise exception 'KHAC_PARTNER_ABORTED: create status %', v_result;
    end if;

    select id into v_partner_id
    from public.business_partners
    where lower(btrim(name))='khác'
    order by id
    limit 1;
  else
    update public.business_partners
    set partner_type='other',
        partner_subtype_id=v_subtype_id,
        payment_mode='postpaid',
        settlement_mode='ad_hoc',
        settlement_rule=null,
        default_payment_term_days=null,
        default_fund_account_id=null,
        memo=coalesce(memo,'기타/미지정 구매 거래처'),
        is_active=true,
        updated_at=now()
    where id=v_partner_id;
  end if;

  if v_partner_id is null then
    raise exception 'KHAC_PARTNER_ABORTED: partner not resolved';
  end if;

  select ledger_party_id into v_ledger_party_id
  from public.business_partner_ledger_parties
  where business_partner_id=v_partner_id;

  if v_ledger_party_id is null then
    v_ledger_party_id := public.business_partner_ensure_ledger_party_v1(v_partner_id);
  end if;

  if v_ledger_party_id is null then
    raise exception 'KHAC_PARTNER_ABORTED: ledger party not resolved';
  end if;

  update public.business_partner_supplier_aliases
  set status='linked',
      business_partner_id=v_partner_id,
      reviewed_at=coalesce(reviewed_at,now()),
      reviewed_by=coalesce(reviewed_by,1),
      updated_at=now()
  where normalized_name='khác';

  if not exists(
    select 1 from public.business_partner_supplier_aliases
    where normalized_name='khác'
      and status='linked'
      and business_partner_id=v_partner_id
  ) then
    raise exception 'KHAC_PARTNER_ABORTED: supplier alias link failed';
  end if;

  update public.inventory
  set supplier_partner_id=v_partner_id,
      updated_at=now()
  where lower(btrim(coalesce(supplier,'')))='khác'
    and supplier_partner_id is distinct from v_partner_id;

  update public.ledger_candidates
  set proposed_party_id=v_ledger_party_id,
      updated_at=now()
  where status='pending'
    and candidate_type='inventory_purchase'
    and lower(btrim(coalesce(source_snapshot->>'supplier','')))='khác'
    and proposed_party_id is distinct from v_ledger_party_id;
end;
$khac$;