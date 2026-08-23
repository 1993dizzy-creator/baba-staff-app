-- Optional single user-facing display tag per Partner (e.g. "공식 공급처"), shown next to
-- the partner name in the UI. Independent of payment/settlement/fund-account policy;
-- stored and mutated separately so tagging a partner never touches those fields. Purely
-- additive: existing business_partners rows stay NULL, no backfill/DML.

alter table public.business_partners
  add column display_tag text null;

alter table public.business_partners
  add constraint business_partners_display_tag_length check (
    display_tag is null or length(btrim(display_tag)) between 1 and 30
  );

comment on column public.business_partners.display_tag is
  'Optional short user-facing tag shown next to the partner name (e.g. "공식 공급처"). NULL when unset. Single tag only -- not a multi-tag array, no color, no master list.';

create function public.business_partner_update_display_tag_v1(
  p_partner_id bigint,
  p_display_tag text,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_before jsonb;
  v_tag text := nullif(btrim(p_display_tag), '');
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

  update public.business_partners set
    display_tag = v_tag,
    updated_at = now()
  where id = p_partner_id;

  insert into public.business_partner_audit_logs(
    business_partner_id, actor_user_id, action, before_snapshot, after_snapshot
  ) values (
    p_partner_id, p_actor_user_id, 'updated', v_before,
    (select to_jsonb(p) from public.business_partners p where p.id = p_partner_id)
  );
  return jsonb_build_object('status', 'updated', 'partnerId', p_partner_id);
exception
  when check_violation or foreign_key_violation or not_null_violation then return jsonb_build_object('status', 'invalid_input');
end;
$$;

alter function public.business_partner_update_display_tag_v1(bigint, text, bigint) owner to postgres;
revoke all on function public.business_partner_update_display_tag_v1(bigint, text, bigint) from public, anon, authenticated;
grant execute on function public.business_partner_update_display_tag_v1(bigint, text, bigint) to service_role;

comment on function public.business_partner_update_display_tag_v1(bigint, text, bigint) is
  'Sets or clears a Partner''s display_tag only (blank/whitespace -> NULL). Does not touch payment/settlement/fund-account/contact fields. Reuses the existing action=''updated'' audit contract.';
