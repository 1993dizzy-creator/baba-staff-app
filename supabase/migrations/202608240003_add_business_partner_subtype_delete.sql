-- Physically deletes only an unused business-partner subtype. Existing subtype create/update
-- RPCs intentionally remain unchanged, and deactivation remains the data-preserving option.
create function public.business_partner_subtype_delete_v1(
  p_subtype_id bigint,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_subtype_id bigint;
begin
  select lower(role::text) into v_role
  from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;

  -- Lock the master row before checking references. FK checks for concurrent Partner writes
  -- conflict with the following delete; the DELETE/FK remains the final race-safe decision.
  select id into v_subtype_id
  from public.business_partner_subtypes
  where id = p_subtype_id
  for update;
  if v_subtype_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  if exists (
    select 1 from public.business_partners
    where partner_subtype_id = p_subtype_id
  ) then
    return jsonb_build_object('status', 'in_use');
  end if;

  delete from public.business_partner_subtypes
  where id = p_subtype_id;
  return jsonb_build_object('status', 'deleted', 'subtypeId', p_subtype_id);
exception
  when foreign_key_violation then
    return jsonb_build_object('status', 'in_use');
end;
$$;

alter function public.business_partner_subtype_delete_v1(bigint,bigint) owner to postgres;
revoke all on function public.business_partner_subtype_delete_v1(bigint,bigint) from public, anon, authenticated, service_role;
grant execute on function public.business_partner_subtype_delete_v1(bigint,bigint) to postgres, service_role;

comment on function public.business_partner_subtype_delete_v1(bigint,bigint) is
  'Deletes an owner/master-authorized subtype only when no business_partner references it; otherwise returns in_use. Subtype create/update have no master audit log, so delete follows the same audit policy.';
