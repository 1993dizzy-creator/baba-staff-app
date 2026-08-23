-- Partner policy records commercial settlement frequency only. Exact settled
-- periods belong to future immutable Ledger settlement batches.
alter table public.business_partners
  add column settlement_mode text null,
  add column settlement_rule text null;

alter table public.business_partners
  drop constraint business_partners_payment_term_policy;

alter table public.business_partners
  add constraint business_partners_settlement_policy check (
    (
      payment_mode = 'immediate'
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

comment on column public.business_partners.settlement_mode is
  'Postpaid settlement mode: ad_hoc, scheduled, or NULL for legacy/unclassified rows.';
comment on column public.business_partners.settlement_rule is
  'Scheduled frequency rule: net_days, monthly_once, or monthly_twice. It does not define fixed cutoff dates or historical Ledger periods.';
comment on column public.business_partners.default_payment_term_days is
  'Net-day term used only when settlement_rule=net_days. A value on a legacy settlement_mode=NULL row is not interpreted as Net N.';

create function public.business_partner_create_v2(
  p_name text,
  p_partner_type text,
  p_payment_mode text,
  p_settlement_mode text,
  p_settlement_rule text,
  p_default_payment_term_days integer,
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
begin
  select lower(role::text) into v_role
  from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;

  if p_ledger_party_id is not null and not exists (
    select 1 from public.ledger_parties where id = p_ledger_party_id and is_active = true
  ) then
    return jsonb_build_object('status', 'invalid_ledger_party');
  end if;
  if p_ledger_party_id is not null and exists (
    select 1 from public.business_partner_ledger_parties where ledger_party_id = p_ledger_party_id
  ) then
    return jsonb_build_object('status', 'ledger_party_already_linked');
  end if;

  insert into public.business_partners(
    name, partner_type, payment_mode, settlement_mode, settlement_rule,
    default_payment_term_days, phone, contact_name, memo, is_active
  ) values (
    btrim(p_name), btrim(p_partner_type), p_payment_mode, p_settlement_mode,
    p_settlement_rule, p_default_payment_term_days, nullif(btrim(p_phone), ''),
    nullif(btrim(p_contact_name), ''), nullif(btrim(p_memo), ''), p_is_active
  ) returning id into v_id;

  if p_ledger_party_id is not null then
    insert into public.business_partner_ledger_parties(business_partner_id, ledger_party_id)
    values(v_id, p_ledger_party_id);
  end if;

  insert into public.business_partner_audit_logs(
    business_partner_id, actor_user_id, action, after_snapshot
  ) values (
    v_id, p_actor_user_id, 'created',
    (select to_jsonb(p) from public.business_partners p where p.id = v_id)
  );
  return jsonb_build_object('status', 'created', 'partnerId', v_id);
exception
  when unique_violation then return jsonb_build_object('status', 'duplicate_name');
  when check_violation or foreign_key_violation or not_null_violation then return jsonb_build_object('status', 'invalid_input');
end;
$$;

create function public.business_partner_update_v2(
  p_partner_id bigint,
  p_name text,
  p_partner_type text,
  p_payment_mode text,
  p_settlement_mode text,
  p_settlement_rule text,
  p_default_payment_term_days integer,
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
  v_previous_ledger_party_id bigint;
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

  if p_ledger_party_id is not null and not exists (
    select 1 from public.ledger_parties where id = p_ledger_party_id and is_active = true
  ) then
    return jsonb_build_object('status', 'invalid_ledger_party');
  end if;
  if p_ledger_party_id is not null and exists (
    select 1 from public.business_partner_ledger_parties
    where ledger_party_id = p_ledger_party_id and business_partner_id <> p_partner_id
  ) then
    return jsonb_build_object('status', 'ledger_party_already_linked');
  end if;

  select ledger_party_id into v_previous_ledger_party_id
  from public.business_partner_ledger_parties where business_partner_id = p_partner_id;

  update public.business_partners set
    name = btrim(p_name),
    partner_type = btrim(p_partner_type),
    payment_mode = p_payment_mode,
    settlement_mode = p_settlement_mode,
    settlement_rule = p_settlement_rule,
    default_payment_term_days = p_default_payment_term_days,
    phone = nullif(btrim(p_phone), ''),
    contact_name = nullif(btrim(p_contact_name), ''),
    memo = nullif(btrim(p_memo), ''),
    is_active = p_is_active,
    updated_at = now()
  where id = p_partner_id;

  if p_ledger_party_id is null then
    delete from public.business_partner_ledger_parties where business_partner_id = p_partner_id;
  else
    insert into public.business_partner_ledger_parties(business_partner_id, ledger_party_id, updated_at)
    values(p_partner_id, p_ledger_party_id, now())
    on conflict(business_partner_id) do update
      set ledger_party_id = excluded.ledger_party_id, updated_at = now();
  end if;

  insert into public.business_partner_audit_logs(
    business_partner_id, actor_user_id, action, before_snapshot, after_snapshot
  ) values (
    p_partner_id, p_actor_user_id, 'updated', v_before,
    (select to_jsonb(p) from public.business_partners p where p.id = p_partner_id)
  );
  if v_previous_ledger_party_id is distinct from p_ledger_party_id then
    insert into public.business_partner_audit_logs(
      business_partner_id, actor_user_id, action, before_snapshot, after_snapshot
    ) values (
      p_partner_id, p_actor_user_id,
      case when p_ledger_party_id is null then 'ledger_party_unlinked' else 'ledger_party_linked' end,
      case when v_previous_ledger_party_id is null then null else jsonb_build_object('ledgerPartyId', v_previous_ledger_party_id) end,
      case when p_ledger_party_id is null then null else jsonb_build_object('ledgerPartyId', p_ledger_party_id) end
    );
  end if;
  return jsonb_build_object('status', 'updated', 'partnerId', p_partner_id);
exception
  when unique_violation then return jsonb_build_object('status', 'duplicate_name');
  when check_violation or foreign_key_violation or not_null_violation then return jsonb_build_object('status', 'invalid_input');
end;
$$;

create function public.business_partner_review_supplier_alias_v2(
  p_alias_id bigint,
  p_action text,
  p_existing_partner_id bigint,
  p_name text,
  p_partner_type text,
  p_payment_mode text,
  p_settlement_mode text,
  p_settlement_rule text,
  p_default_payment_term_days integer,
  p_phone text,
  p_contact_name text,
  p_memo text,
  p_actor_user_id bigint
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
    insert into public.business_partners(
      name, partner_type, payment_mode, settlement_mode, settlement_rule,
      default_payment_term_days, phone, contact_name, memo, is_active
    ) values (
      btrim(p_name), btrim(p_partner_type), p_payment_mode, p_settlement_mode,
      p_settlement_rule, p_default_payment_term_days, nullif(btrim(p_phone), ''),
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

alter function public.business_partner_create_v2(text,text,text,text,text,integer,text,text,text,boolean,bigint,bigint) owner to postgres;
alter function public.business_partner_update_v2(bigint,text,text,text,text,text,integer,text,text,text,boolean,bigint,bigint) owner to postgres;
alter function public.business_partner_review_supplier_alias_v2(bigint,text,bigint,text,text,text,text,text,integer,text,text,text,bigint) owner to postgres;

revoke all on function public.business_partner_create_v2(text,text,text,text,text,integer,text,text,text,boolean,bigint,bigint) from public, anon, authenticated;
revoke all on function public.business_partner_update_v2(bigint,text,text,text,text,text,integer,text,text,text,boolean,bigint,bigint) from public, anon, authenticated;
revoke all on function public.business_partner_review_supplier_alias_v2(bigint,text,bigint,text,text,text,text,text,integer,text,text,text,bigint) from public, anon, authenticated;

grant execute on function public.business_partner_create_v2(text,text,text,text,text,integer,text,text,text,boolean,bigint,bigint) to service_role;
grant execute on function public.business_partner_update_v2(bigint,text,text,text,text,text,integer,text,text,text,boolean,bigint,bigint) to service_role;
grant execute on function public.business_partner_review_supplier_alias_v2(bigint,text,bigint,text,text,text,text,text,integer,text,text,text,bigint) to service_role;
