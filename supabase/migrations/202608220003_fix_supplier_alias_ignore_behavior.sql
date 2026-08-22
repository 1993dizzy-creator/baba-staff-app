create or replace function public.business_partner_review_supplier_alias_v1(
  p_alias_id bigint,
  p_action text,
  p_existing_partner_id bigint,
  p_name text,
  p_partner_type text,
  p_payment_mode text,
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
    insert into public.business_partners(name, partner_type, payment_mode, default_payment_term_days, phone, contact_name, memo, is_active)
    values(btrim(p_name), btrim(p_partner_type), p_payment_mode, p_default_payment_term_days, nullif(btrim(p_phone), ''), nullif(btrim(p_contact_name), ''), nullif(btrim(p_memo), ''), true)
    returning id into v_partner_id;
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

alter function public.business_partner_review_supplier_alias_v1(bigint,text,bigint,text,text,text,integer,text,text,text,bigint) owner to postgres;
revoke all on function public.business_partner_review_supplier_alias_v1(bigint,text,bigint,text,text,text,integer,text,text,text,bigint) from public, anon, authenticated;
grant execute on function public.business_partner_review_supplier_alias_v1(bigint,text,bigint,text,text,text,integer,text,text,text,bigint) to service_role;
