-- A title override is presentation data; source_snapshot remains source evidence.
alter table public.ledger_transactions
  add column display_snapshot jsonb not null default '{}'::jsonb
  constraint ledger_transactions_display_snapshot_object check (jsonb_typeof(display_snapshot) = 'object');

create function public.ledger_edit_manual_transaction_display_v1(
  p_transaction_id bigint,
  p_title text,
  p_memo text,
  p_reason text,
  p_actor_user_id bigint
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_role text;
  v_date date;
  v_transaction public.ledger_transactions%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_title text := nullif(btrim(p_title), '');
  v_memo text := nullif(btrim(p_memo), '');
  v_reason text := nullif(btrim(p_reason), '');
begin
  select lower(role::text) into v_role from public.users
    where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_transaction_id is null or v_title is null or length(v_title) > 160
     or length(coalesce(p_memo, '')) > 2000
     or v_reason is null or length(v_reason) > 500 then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  select business_date into v_date from public.ledger_transactions where id = p_transaction_id;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  perform pg_advisory_xact_lock(hashtext('ledger_month_close:' || to_char(v_date, 'YYYY-MM')));
  select * into v_transaction from public.ledger_transactions where id = p_transaction_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_transaction.source_type <> 'manual'
     or v_transaction.status <> 'confirmed'
     or v_transaction.type not in ('income', 'expense', 'transfer')
     or v_transaction.correction_of_id is not null
     or v_transaction.business_date <> v_date then
    return jsonb_build_object('status', 'unsupported_transaction');
  end if;
  if public.ledger_month_is_closed_v1(date_trunc('month', v_date)::date) then
    return jsonb_build_object('status', 'month_closed');
  end if;
  if v_transaction.display_snapshot ->> 'titleOverride' is not distinct from v_title
     and v_transaction.memo is not distinct from v_memo then
    return jsonb_build_object('status', 'unchanged');
  end if;

  v_before := to_jsonb(v_transaction);
  update public.ledger_transactions
    set display_snapshot = coalesce(display_snapshot, '{}'::jsonb) || jsonb_build_object('titleOverride', v_title),
        memo = v_memo,
        updated_at = now()
    where id = p_transaction_id
    returning * into v_transaction;
  v_after := to_jsonb(v_transaction);
  insert into public.ledger_audit_logs(
    actor_user_id, action, entity_type, entity_id, before_snapshot, after_snapshot, reason
  ) values (
    p_actor_user_id, 'manual_transaction_display_edited', 'transaction', p_transaction_id,
    v_before, v_after, v_reason
  );
  return jsonb_build_object('status', 'updated', 'transactionId', p_transaction_id);
end $$;

revoke all on function public.ledger_edit_manual_transaction_display_v1(bigint, text, text, text, bigint) from public, anon, authenticated;
grant execute on function public.ledger_edit_manual_transaction_display_v1(bigint, text, text, text, bigint) to service_role;
