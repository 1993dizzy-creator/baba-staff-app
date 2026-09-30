-- Edit only confirmed, open-month manual income, expense and transfer entries.
create function public.ledger_edit_manual_transaction_v1(
  p_transaction_id bigint, p_title text, p_amount numeric, p_memo text,
  p_reason text, p_actor_user_id bigint
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_role text;
  v_date date;
  v_transaction public.ledger_transactions%rowtype;
  v_movement public.ledger_movements%rowtype;
  v_title text := nullif(btrim(p_title), '');
  v_memo text := nullif(btrim(p_memo), '');
  v_reason text := nullif(btrim(p_reason), '');
  v_before_transaction jsonb;
  v_before_movements jsonb := '[]'::jsonb;
  v_after_movements jsonb;
  v_count integer := 0;
  v_positive integer := 0;
  v_negative integer := 0;
begin
  select lower(role::text) into v_role from public.users
    where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_transaction_id is null or v_title is null or length(v_title) > 160
     or length(coalesce(p_memo, '')) > 2000
     or v_reason is null or length(v_reason) > 500
     or p_amount is null or p_amount <= 0 or p_amount <> trunc(p_amount)
     or p_amount > 9999999999999 then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  select business_date into v_date from public.ledger_transactions where id = p_transaction_id;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  perform pg_advisory_xact_lock(hashtext('ledger_month_close:' || to_char(v_date, 'YYYY-MM')));
  select * into v_transaction from public.ledger_transactions where id = p_transaction_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_transaction.business_date <> v_date or v_transaction.source_type <> 'manual'
     or v_transaction.status <> 'confirmed'
     or v_transaction.type not in ('income', 'expense', 'transfer')
     or v_transaction.correction_of_id is not null then
    return jsonb_build_object('status', 'unsupported_transaction');
  end if;
  if public.ledger_month_is_closed_v1(date_trunc('month', v_date)::date) then
    return jsonb_build_object('status', 'month_closed');
  end if;
  if exists (select 1 from public.ledger_transactions child
    where child.correction_of_id = p_transaction_id and child.status = 'confirmed') then
    return jsonb_build_object('status', 'already_corrected');
  end if;

  -- Lock and verify every movement before writing the transaction or any movement.
  for v_movement in select * from public.ledger_movements
    where transaction_id = p_transaction_id order by id for update loop
    v_count := v_count + 1;
    v_before_movements := v_before_movements || jsonb_build_array(to_jsonb(v_movement));
    if v_movement.amount = v_transaction.amount then v_positive := v_positive + 1;
    elsif v_movement.amount = -v_transaction.amount then v_negative := v_negative + 1;
    end if;
  end loop;
  if (v_transaction.type = 'income' and (v_count <> 1 or v_positive <> 1))
     or (v_transaction.type = 'expense' and (v_count <> 1 or v_negative <> 1))
     or (v_transaction.type = 'transfer' and (v_count <> 2 or v_positive <> 1 or v_negative <> 1)) then
    return jsonb_build_object('status', 'invalid_movements');
  end if;
  if v_transaction.amount = p_amount
     and coalesce(v_transaction.display_snapshot ->> 'titleOverride', nullif(btrim(v_transaction.memo), ''))
       is not distinct from v_title
     and v_transaction.memo is not distinct from v_memo then
    return jsonb_build_object('status', 'unchanged');
  end if;

  v_before_transaction := to_jsonb(v_transaction);
  update public.ledger_transactions
    set amount = p_amount,
        display_snapshot = coalesce(display_snapshot, '{}'::jsonb) || jsonb_build_object('titleOverride', v_title),
        memo = v_memo, updated_at = now()
    where id = p_transaction_id returning * into v_transaction;
  update public.ledger_movements
    set amount = case when amount < 0 then -p_amount else p_amount end
    where transaction_id = p_transaction_id;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.id), '[]'::jsonb) into v_after_movements
    from public.ledger_movements m where m.transaction_id = p_transaction_id;
  insert into public.ledger_audit_logs(
    actor_user_id, action, entity_type, entity_id, before_snapshot, after_snapshot, reason
  ) values (
    p_actor_user_id, 'manual_transaction_edited', 'transaction', p_transaction_id,
    jsonb_build_object('transaction', v_before_transaction, 'movements', v_before_movements),
    jsonb_build_object('transaction', to_jsonb(v_transaction), 'movements', v_after_movements), v_reason
  );
  return jsonb_build_object('status', 'updated', 'transactionId', p_transaction_id);
end $$;

alter function public.ledger_edit_manual_transaction_v1(bigint, text, numeric, text, text, bigint)
  owner to postgres;
revoke all on function public.ledger_edit_manual_transaction_v1(bigint, text, numeric, text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.ledger_edit_manual_transaction_v1(bigint, text, numeric, text, text, bigint)
  to service_role;
