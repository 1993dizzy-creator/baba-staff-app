-- Lets administrators clear stale pending Candidates (zero current Inventory
-- usage) out of the review lists without a physical DELETE, preserving the
-- existing audit trail. Archived candidates are hidden from both the
-- pending and ignored lists. If the same supplier name is seen in Inventory
-- again later, business_partner_resolve_inventory_supplier_v1 reactivates
-- the archived row back to pending automatically.

alter table public.business_partner_supplier_aliases
  drop constraint business_partner_supplier_aliases_status_check;
alter table public.business_partner_supplier_aliases
  add constraint business_partner_supplier_aliases_status_check
  check (status in ('pending', 'linked', 'ignored', 'archived'));

alter table public.business_partner_supplier_aliases
  drop constraint business_partner_supplier_alias_status_policy;
alter table public.business_partner_supplier_aliases
  add constraint business_partner_supplier_alias_status_policy check (
    (status = 'linked' and business_partner_id is not null and reviewed_at is not null and reviewed_by is not null)
    or (status = 'ignored' and business_partner_id is null and reviewed_at is not null and reviewed_by is not null)
    or (status = 'archived' and business_partner_id is null and reviewed_at is not null and reviewed_by is not null)
    or (status = 'pending' and business_partner_id is null and reviewed_at is null and reviewed_by is null)
  );

alter table public.business_partner_supplier_alias_audit_logs
  drop constraint business_partner_supplier_alias_audit_logs_action_check;
alter table public.business_partner_supplier_alias_audit_logs
  add constraint business_partner_supplier_alias_audit_logs_action_check
  check (action in (
    'candidate_created',
    'candidate_linked_new_partner',
    'candidate_linked_existing_partner',
    'candidate_ignored',
    'candidate_reopened',
    'candidate_archived',
    'candidate_reactivated'
  ));

comment on constraint business_partner_supplier_alias_status_policy on public.business_partner_supplier_aliases is
  'archived rows are stale pending candidates with zero current Inventory usage; they are hidden from the pending and ignored review lists and are reactivated to pending automatically if the supplier name reappears in Inventory.';

create function public.business_partner_archive_supplier_alias_v1(
  p_alias_id bigint,
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
  v_inventory_count integer;
begin
  select lower(role::text) into v_role from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then return jsonb_build_object('status', 'forbidden'); end if;

  select * into v_alias from public.business_partner_supplier_aliases where id = p_alias_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_alias.status <> 'pending' or v_alias.business_partner_id is not null then
    return jsonb_build_object('status', 'invalid_state');
  end if;

  select count(*) into v_inventory_count from public.inventory
  where lower(btrim(supplier)) = v_alias.normalized_name;
  if v_inventory_count > 0 then
    return jsonb_build_object('status', 'candidate_in_use', 'inventoryCount', v_inventory_count);
  end if;

  v_before := to_jsonb(v_alias);
  update public.business_partner_supplier_aliases
    set status = 'archived', reviewed_at = now(), reviewed_by = p_actor_user_id, updated_at = now()
    where id = p_alias_id
    returning * into v_alias;

  insert into public.business_partner_supplier_alias_audit_logs(supplier_alias_id, actor_user_id, action, before_snapshot, after_snapshot)
  values(p_alias_id, p_actor_user_id, 'candidate_archived', v_before, to_jsonb(v_alias));
  return jsonb_build_object('status', 'archived');
exception
  when check_violation or foreign_key_violation or not_null_violation then return jsonb_build_object('status', 'invalid_input');
end;
$$;

alter function public.business_partner_archive_supplier_alias_v1(bigint, bigint) owner to postgres;
revoke all on function public.business_partner_archive_supplier_alias_v1(bigint, bigint) from public, anon, authenticated;
grant execute on function public.business_partner_archive_supplier_alias_v1(bigint, bigint) to service_role;

create or replace function public.business_partner_resolve_inventory_supplier_v1(
  p_supplier_name text,
  p_supplier_partner_id bigint,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor_exists boolean;
  v_name text := nullif(btrim(p_supplier_name), '');
  v_normalized text;
  v_partner public.business_partners%rowtype;
  v_alias public.business_partner_supplier_aliases%rowtype;
  v_before jsonb;
begin
  select exists(
    select 1 from public.users
    where id = p_actor_user_id and is_active = true and app_login_enabled = true
  ) into v_actor_exists;
  if not v_actor_exists then return jsonb_build_object('status', 'forbidden'); end if;

  if p_supplier_partner_id is not null then
    select * into v_partner from public.business_partners
    where id = p_supplier_partner_id and is_active = true;
    if not found then return jsonb_build_object('status', 'invalid_partner'); end if;
    return jsonb_build_object('status', 'resolved', 'supplierName', v_partner.name, 'supplierPartnerId', v_partner.id);
  end if;

  if v_name is null then
    return jsonb_build_object('status', 'resolved', 'supplierName', null, 'supplierPartnerId', null);
  end if;
  v_normalized := lower(v_name);

  select * into v_partner from public.business_partners
  where lower(btrim(name)) = v_normalized and is_active = true;
  if found then
    return jsonb_build_object(
      'status', 'resolved',
      'supplierName', v_partner.name,
      'supplierPartnerId', v_partner.id
    );
  end if;

  select * into v_alias from public.business_partner_supplier_aliases
  where normalized_name = v_normalized for update;
  if found then
    if v_alias.status = 'archived' then
      v_before := to_jsonb(v_alias);
      update public.business_partner_supplier_aliases
        set status = 'pending', reviewed_at = null, reviewed_by = null, last_seen_at = now(), updated_at = now()
        where id = v_alias.id
        returning * into v_alias;
      insert into public.business_partner_supplier_alias_audit_logs(supplier_alias_id, actor_user_id, action, before_snapshot, after_snapshot)
      values(v_alias.id, p_actor_user_id, 'candidate_reactivated', v_before, to_jsonb(v_alias));
      return jsonb_build_object('status', 'resolved', 'supplierName', v_alias.supplier_name, 'supplierPartnerId', null, 'supplierAliasId', v_alias.id, 'aliasStatus', 'pending');
    end if;
    update public.business_partner_supplier_aliases
      set last_seen_at = now(), updated_at = now()
      where id = v_alias.id;
    if v_alias.status = 'linked' then
      select * into v_partner from public.business_partners
      where id = v_alias.business_partner_id and is_active = true;
      if found then
        return jsonb_build_object('status', 'resolved', 'supplierName', v_partner.name, 'supplierPartnerId', v_partner.id, 'supplierAliasId', v_alias.id, 'aliasStatus', 'linked');
      end if;
    end if;
    return jsonb_build_object('status', 'resolved', 'supplierName', v_alias.supplier_name, 'supplierPartnerId', null, 'supplierAliasId', v_alias.id, 'aliasStatus', v_alias.status);
  end if;

  insert into public.business_partner_supplier_aliases(supplier_name, normalized_name)
  values(v_name, v_normalized) returning * into v_alias;
  insert into public.business_partner_supplier_alias_audit_logs(supplier_alias_id, actor_user_id, action, after_snapshot)
  values(v_alias.id, p_actor_user_id, 'candidate_created', to_jsonb(v_alias));
  return jsonb_build_object('status', 'resolved', 'supplierName', v_alias.supplier_name, 'supplierPartnerId', null, 'supplierAliasId', v_alias.id, 'aliasStatus', 'pending');
exception
  when unique_violation then
    select * into v_alias from public.business_partner_supplier_aliases where normalized_name = v_normalized for update;
    if v_alias.status = 'archived' then
      v_before := to_jsonb(v_alias);
      update public.business_partner_supplier_aliases
        set status = 'pending', reviewed_at = null, reviewed_by = null, last_seen_at = now(), updated_at = now()
        where id = v_alias.id
        returning * into v_alias;
      insert into public.business_partner_supplier_alias_audit_logs(supplier_alias_id, actor_user_id, action, before_snapshot, after_snapshot)
      values(v_alias.id, p_actor_user_id, 'candidate_reactivated', v_before, to_jsonb(v_alias));
      return jsonb_build_object('status', 'resolved', 'supplierName', v_alias.supplier_name, 'supplierPartnerId', null, 'supplierAliasId', v_alias.id, 'aliasStatus', 'pending');
    end if;
    update public.business_partner_supplier_aliases set last_seen_at = now(), updated_at = now() where id = v_alias.id;
    if v_alias.status = 'linked' then
      select * into v_partner from public.business_partners where id = v_alias.business_partner_id and is_active = true;
      if found then
        return jsonb_build_object('status', 'resolved', 'supplierName', v_partner.name, 'supplierPartnerId', v_partner.id, 'supplierAliasId', v_alias.id, 'aliasStatus', 'linked');
      end if;
    end if;
    return jsonb_build_object('status', 'resolved', 'supplierName', v_alias.supplier_name, 'supplierPartnerId', null, 'supplierAliasId', v_alias.id, 'aliasStatus', v_alias.status);
end;
$$;

alter function public.business_partner_resolve_inventory_supplier_v1(text,bigint,bigint) owner to postgres;
revoke all on function public.business_partner_resolve_inventory_supplier_v1(text,bigint,bigint) from public, anon, authenticated;
grant execute on function public.business_partner_resolve_inventory_supplier_v1(text,bigint,bigint) to service_role;

comment on function public.business_partner_archive_supplier_alias_v1(bigint, bigint) is
  'Soft-deletes ("삭제" in the UI) a pending Candidate with zero current Inventory usage. Refuses non-pending rows or rows with linked Inventory.';
