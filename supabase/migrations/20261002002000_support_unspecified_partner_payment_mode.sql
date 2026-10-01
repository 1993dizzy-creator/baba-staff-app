-- Explicit unset payment policy. Local migration only; requires separate approval to apply.
begin;
alter table public.business_partners drop constraint business_partners_payment_mode_check;
alter table public.business_partners add constraint business_partners_payment_mode_check
  check (payment_mode in ('unspecified', 'immediate', 'postpaid'));
alter table public.business_partners drop constraint business_partners_settlement_policy;
alter table public.business_partners
  add constraint business_partners_settlement_policy check (
    (
      payment_mode in ('unspecified', 'immediate')
      and settlement_mode is null
      and settlement_rule is null
      and default_payment_term_days is null
    )
    or
    (
      payment_mode = 'postpaid'
      and settlement_mode is null
      and settlement_rule is null
      and default_payment_term_days between 0 and 3650
    )
    or
    (
      payment_mode = 'postpaid'
      and settlement_mode = 'ad_hoc'
      and settlement_rule is null
      and default_payment_term_days is null
    )
    or
    (
      payment_mode = 'postpaid'
      and settlement_mode = 'scheduled'
      and settlement_rule = 'net_days'
      and default_payment_term_days is not null
      and default_payment_term_days between 0 and 3650
    )
    or
    (
      payment_mode = 'postpaid'
      and settlement_mode = 'scheduled'
      and settlement_rule in ('monthly_once', 'monthly_twice')
      and default_payment_term_days is null
    )
  );


create or replace function public.business_partner_create_v4(
  p_name text,
  p_partner_type text,
  p_payment_mode text,
  p_settlement_mode text,
  p_settlement_rule text,
  p_default_payment_term_days integer,
  p_default_fund_account_id bigint,
  p_partner_subtype_id bigint,
  p_phone text,
  p_contact_name text,
  p_memo text,
  p_is_active boolean,
  p_ledger_party_id bigint,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_id bigint;
  v_ledger_party_id bigint;
begin
  select lower(role::text) into v_role
  from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;

  if p_payment_mode = 'unspecified' and
     (p_settlement_mode is not null or p_settlement_rule is not null or p_default_payment_term_days is not null) then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  if not public.business_partner_fund_account_is_eligible_v1(p_default_fund_account_id) then
    return jsonb_build_object('status', 'invalid_fund_account');
  end if;
  if not public.business_partner_subtype_is_eligible_v1(p_partner_subtype_id, btrim(p_partner_type)) then
    return jsonb_build_object('status', 'invalid_partner_subtype');
  end if;

  insert into public.business_partners(
    name, partner_type, payment_mode, settlement_mode, settlement_rule,
    default_payment_term_days, default_fund_account_id, partner_subtype_id,
    phone, contact_name, memo, is_active
  ) values (
    btrim(p_name), btrim(p_partner_type), p_payment_mode, p_settlement_mode,
    p_settlement_rule, p_default_payment_term_days, p_default_fund_account_id,
    p_partner_subtype_id, nullif(btrim(p_phone), ''), nullif(btrim(p_contact_name), ''),
    nullif(btrim(p_memo), ''), p_is_active
  ) returning id into v_id;

  select ledger_party_id into v_ledger_party_id
  from public.business_partner_ledger_parties
  where business_partner_id = v_id;
  if v_ledger_party_id is null then
    v_ledger_party_id := public.business_partner_ensure_ledger_party_v1(v_id);
  end if;

  insert into public.business_partner_audit_logs(
    business_partner_id, actor_user_id, action, after_snapshot
  ) values (
    v_id, p_actor_user_id, 'created',
    (select to_jsonb(p) from public.business_partners p where p.id = v_id)
  );

  return jsonb_build_object('status', 'created', 'partnerId', v_id, 'ledgerPartyId', v_ledger_party_id);
exception
  when unique_violation then return jsonb_build_object('status', 'duplicate_name');
  when check_violation or foreign_key_violation or not_null_violation then return jsonb_build_object('status', 'invalid_input');
end;
$$;

create or replace function public.business_partner_update_v4(
  p_partner_id bigint,
  p_name text,
  p_partner_type text,
  p_payment_mode text,
  p_settlement_mode text,
  p_settlement_rule text,
  p_default_payment_term_days integer,
  p_default_fund_account_id bigint,
  p_partner_subtype_id bigint,
  p_phone text,
  p_contact_name text,
  p_memo text,
  p_is_active boolean,
  p_ledger_party_id bigint,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_before jsonb;
  v_current_subtype_id bigint;
  v_ledger_party_id bigint;
begin
  select lower(role::text) into v_role
  from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;

  select to_jsonb(p) into v_before
  from public.business_partners p where p.id = p_partner_id for update;
  if v_before is null then return jsonb_build_object('status', 'not_found'); end if;
  v_current_subtype_id := (v_before->>'partner_subtype_id')::bigint;

  if p_payment_mode = 'unspecified' and
     (p_settlement_mode is not null or p_settlement_rule is not null or p_default_payment_term_days is not null) then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  if not public.business_partner_fund_account_is_eligible_v1(p_default_fund_account_id) then
    return jsonb_build_object('status', 'invalid_fund_account');
  end if;
  if not public.business_partner_subtype_is_eligible_v1(
    p_partner_subtype_id, btrim(p_partner_type), v_current_subtype_id
  ) then
    return jsonb_build_object('status', 'invalid_partner_subtype');
  end if;

  update public.business_partners set
    name = btrim(p_name),
    partner_type = btrim(p_partner_type),
    payment_mode = p_payment_mode,
    settlement_mode = p_settlement_mode,
    settlement_rule = p_settlement_rule,
    default_payment_term_days = p_default_payment_term_days,
    default_fund_account_id = p_default_fund_account_id,
    partner_subtype_id = p_partner_subtype_id,
    phone = nullif(btrim(p_phone), ''),
    contact_name = nullif(btrim(p_contact_name), ''),
    memo = nullif(btrim(p_memo), ''),
    is_active = p_is_active,
    updated_at = now()
  where id = p_partner_id;

  select ledger_party_id into v_ledger_party_id
  from public.business_partner_ledger_parties
  where business_partner_id = p_partner_id;
  if v_ledger_party_id is null then
    v_ledger_party_id := public.business_partner_ensure_ledger_party_v1(p_partner_id);
  end if;

  insert into public.business_partner_audit_logs(
    business_partner_id, actor_user_id, action, before_snapshot, after_snapshot
  ) values (
    p_partner_id, p_actor_user_id, 'updated', v_before,
    (select to_jsonb(p) from public.business_partners p where p.id = p_partner_id)
  );

  return jsonb_build_object('status', 'updated', 'partnerId', p_partner_id, 'ledgerPartyId', v_ledger_party_id);
exception
  when unique_violation then return jsonb_build_object('status', 'duplicate_name');
  when check_violation or foreign_key_violation or not_null_violation then return jsonb_build_object('status', 'invalid_input');
end;
$$;


-- Same signatures, authorization, auto-linking, audits and service-only access.
alter function public.business_partner_create_v4(text,text,text,text,text,integer,bigint,bigint,text,text,text,boolean,bigint,bigint) owner to postgres;
revoke all on function public.business_partner_create_v4(text,text,text,text,text,integer,bigint,bigint,text,text,text,boolean,bigint,bigint) from public, anon, authenticated;
grant execute on function public.business_partner_create_v4(text,text,text,text,text,integer,bigint,bigint,text,text,text,boolean,bigint,bigint) to service_role;
alter function public.business_partner_update_v4(bigint,text,text,text,text,text,integer,bigint,bigint,text,text,text,boolean,bigint,bigint) owner to postgres;
revoke all on function public.business_partner_update_v4(bigint,text,text,text,text,text,integer,bigint,bigint,text,text,text,boolean,bigint,bigint) from public, anon, authenticated;
grant execute on function public.business_partner_update_v4(bigint,text,text,text,text,text,integer,bigint,bigint,text,text,text,boolean,bigint,bigint) to service_role;

-- The only existing partner data changed by this migration.
update public.business_partners
set payment_mode = 'unspecified', settlement_mode = null, settlement_rule = null,
    default_payment_term_days = null, updated_at = now()
where lower(btrim(name)) = 'khác' and payment_mode = 'postpaid';
commit;
