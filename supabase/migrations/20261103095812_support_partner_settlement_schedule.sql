-- Partner metadata only. No backfill, historical due dates or accounting changes.
begin;
alter table public.business_partners add column settlement_days integer[] null;
comment on column public.business_partners.settlement_days is
  'Metadata only: weekly [ISO weekday 1..7]; monthly [day] or [day,day], 0=end of month. Days 29..31 mean month end in shorter months. NULL preserves legacy undated policies. Does not set transaction due dates.';
alter table public.business_partners drop constraint business_partners_settlement_policy;
alter table public.business_partners add constraint business_partners_settlement_policy check (
  coalesce((
    (payment_mode in ('unspecified','immediate') and settlement_mode is null and settlement_rule is null and default_payment_term_days is null and settlement_days is null)
    or (payment_mode = 'postpaid' and (
      (settlement_mode is null and settlement_rule is null and (default_payment_term_days is null or default_payment_term_days between 0 and 3650) and settlement_days is null)
      or (settlement_mode = 'ad_hoc' and settlement_rule is null and default_payment_term_days is null and settlement_days is null)
      or (settlement_mode = 'scheduled' and (
        (settlement_rule = 'net_days' and default_payment_term_days is not null and default_payment_term_days between 0 and 3650 and settlement_days is null)
        or (default_payment_term_days is null and (
          (settlement_rule = 'weekly' and settlement_days is not null and array_dims(settlement_days) = '[1:1]' and settlement_days[1] between 1 and 7)
          or (settlement_rule in ('monthly_once','monthly_twice') and (
            settlement_days is null or (
              array_dims(settlement_days) = case when settlement_rule = 'monthly_once' then '[1:1]' else '[1:2]' end
              and settlement_days[1] between 0 and 31
              and (settlement_rule = 'monthly_once' or (settlement_days[2] between 0 and 31 and settlement_days[1] <> settlement_days[2]))
            )
          ))
        ))
      ))
    ))
  ), false)
);
comment on column public.business_partners.settlement_rule is
  'Scheduled metadata rule: weekly, monthly_once, monthly_twice, net_days. Not a transaction due-date or historical Ledger-period rule.';

drop function public.business_partner_create_v4(text,text,text,text,text,integer,bigint,bigint,text,text,text,boolean,bigint,bigint);
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
  p_actor_user_id bigint,
  p_settlement_days integer[] default null
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
    name, partner_type, payment_mode, settlement_mode, settlement_rule, settlement_days,
    default_payment_term_days, default_fund_account_id, partner_subtype_id,
    phone, contact_name, memo, is_active
  ) values (
    btrim(p_name), btrim(p_partner_type), p_payment_mode, p_settlement_mode,
    p_settlement_rule, p_settlement_days, p_default_payment_term_days, p_default_fund_account_id,
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
alter function public.business_partner_create_v4(text,text,text,text,text,integer,bigint,bigint,text,text,text,boolean,bigint,bigint,integer[]) owner to postgres;
revoke all on function public.business_partner_create_v4(text,text,text,text,text,integer,bigint,bigint,text,text,text,boolean,bigint,bigint,integer[]) from public, anon, authenticated;
grant execute on function public.business_partner_create_v4(text,text,text,text,text,integer,bigint,bigint,text,text,text,boolean,bigint,bigint,integer[]) to service_role;

drop function public.business_partner_update_v4(bigint,text,text,text,text,text,integer,bigint,bigint,text,text,text,boolean,bigint,bigint);
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
  p_actor_user_id bigint,
  p_settlement_days integer[] default null
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
    settlement_days = p_settlement_days,
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
alter function public.business_partner_update_v4(bigint,text,text,text,text,text,integer,bigint,bigint,text,text,text,boolean,bigint,bigint,integer[]) owner to postgres;
revoke all on function public.business_partner_update_v4(bigint,text,text,text,text,text,integer,bigint,bigint,text,text,text,boolean,bigint,bigint,integer[]) from public, anon, authenticated;
grant execute on function public.business_partner_update_v4(bigint,text,text,text,text,text,integer,bigint,bigint,text,text,text,boolean,bigint,bigint,integer[]) to service_role;

drop function public.business_partner_review_supplier_alias_v4(bigint,text,bigint,text,text,text,text,text,integer,bigint,bigint,text,text,text,bigint);
create function public.business_partner_review_supplier_alias_v4(
  p_alias_id bigint,
  p_action text,
  p_existing_partner_id bigint,
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
  p_actor_user_id bigint,
  p_settlement_days integer[] default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_alias public.business_partner_supplier_aliases%rowtype;
  v_before jsonb;
  v_partner_id bigint;
  v_audit_action text;
  v_inventory_count integer := 0;
begin
  select lower(role::text) into v_role from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then return jsonb_build_object('status', 'forbidden'); end if;

  select * into v_alias from public.business_partner_supplier_aliases where id = p_alias_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  v_before := to_jsonb(v_alias);

  if p_action = 'create_partner' then
    if v_alias.status <> 'pending' then return jsonb_build_object('status', 'invalid_state'); end if;
    if not public.business_partner_fund_account_is_eligible_v1(p_default_fund_account_id) then
      return jsonb_build_object('status', 'invalid_fund_account');
    end if;
    if not public.business_partner_subtype_is_eligible_v1(p_partner_subtype_id, btrim(p_partner_type)) then
      return jsonb_build_object('status', 'invalid_partner_subtype');
    end if;
    insert into public.business_partners(
      name, partner_type, payment_mode, settlement_mode, settlement_rule, settlement_days,
      default_payment_term_days, default_fund_account_id, partner_subtype_id, phone, contact_name, memo, is_active
    ) values (
      btrim(p_name), btrim(p_partner_type), p_payment_mode, p_settlement_mode,
      p_settlement_rule, p_settlement_days, p_default_payment_term_days, p_default_fund_account_id, p_partner_subtype_id, nullif(btrim(p_phone), ''),
      nullif(btrim(p_contact_name), ''), nullif(btrim(p_memo), ''), true
    ) returning id into v_partner_id;
    insert into public.business_partner_audit_logs(business_partner_id, actor_user_id, action, after_snapshot)
    values(v_partner_id, p_actor_user_id, 'created', (select to_jsonb(p) from public.business_partners p where p.id = v_partner_id));
    v_audit_action := 'candidate_linked_new_partner';
  elsif p_action = 'link_existing' then
    if v_alias.status <> 'pending' then return jsonb_build_object('status', 'invalid_state'); end if;
    select id into v_partner_id from public.business_partners where id = p_existing_partner_id and is_active = true;
    if v_partner_id is null then return jsonb_build_object('status', 'invalid_partner'); end if;
    v_audit_action := 'candidate_linked_existing_partner';
  elsif p_action = 'ignore' then
    if v_alias.status <> 'pending' then return jsonb_build_object('status', 'invalid_state'); end if;
    update public.business_partner_supplier_aliases set status='ignored', business_partner_id=null, reviewed_at=now(), reviewed_by=p_actor_user_id, updated_at=now() where id=p_alias_id returning * into v_alias;
    v_audit_action := 'candidate_ignored';
  elsif p_action = 'reopen' then
    if v_alias.status <> 'ignored' then return jsonb_build_object('status', 'invalid_state'); end if;
    update public.business_partner_supplier_aliases set status='pending', business_partner_id=null, reviewed_at=null, reviewed_by=null, updated_at=now() where id=p_alias_id returning * into v_alias;
    v_audit_action := 'candidate_reopened';
  else
    return jsonb_build_object('status', 'invalid_action');
  end if;

  if p_action in ('create_partner','link_existing') then
    update public.business_partner_supplier_aliases set status='linked', business_partner_id=v_partner_id, reviewed_at=now(), reviewed_by=p_actor_user_id, updated_at=now() where id=p_alias_id returning * into v_alias;
    update public.inventory set supplier_partner_id=v_partner_id where lower(btrim(supplier))=v_alias.normalized_name and supplier_partner_id is null;
    get diagnostics v_inventory_count = row_count;
  end if;

  insert into public.business_partner_supplier_alias_audit_logs(supplier_alias_id, actor_user_id, action, before_snapshot, after_snapshot)
  values(p_alias_id, p_actor_user_id, v_audit_action, v_before, to_jsonb(v_alias));
  return jsonb_build_object('status', 'reviewed', 'partnerId', v_partner_id, 'inventoryLinkedCount', v_inventory_count);
exception
  when unique_violation then return jsonb_build_object('status', 'duplicate_name');
  when check_violation or foreign_key_violation or not_null_violation then return jsonb_build_object('status', 'invalid_input');
end;
$$;
alter function public.business_partner_review_supplier_alias_v4(bigint,text,bigint,text,text,text,text,text,integer,bigint,bigint,text,text,text,bigint,integer[]) owner to postgres;
revoke all on function public.business_partner_review_supplier_alias_v4(bigint,text,bigint,text,text,text,text,text,integer,bigint,bigint,text,text,text,bigint,integer[]) from public, anon, authenticated;
grant execute on function public.business_partner_review_supplier_alias_v4(bigint,text,bigint,text,text,text,text,text,integer,bigint,bigint,text,text,text,bigint,integer[]) to service_role;

commit;
