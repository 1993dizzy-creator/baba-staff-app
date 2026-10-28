-- Manual ledger transactions: full edit (v2) and audited cancel ("삭제" in the UI).
--
-- Scope: confirmed source_type='manual' income / expense / transfer rows with no special
-- metadata (empty source_snapshot), no correction parent/child and no row in any table
-- that references ledger_transactions (payables, payment allocations/requests, card
-- settlement, owner investments, candidates, recurring/rent payments, ...). Everything
-- else keeps its own module's correction flow.
--
-- Edit changes only the fields sent in p_changes (occurredAt, type, amount, categoryId,
-- partyId, fromAccountId, toAccountId, title, memo), in place, with a full before/after
-- audit row. Cancel sets status='cancelled' and keeps the row and its movements: every
-- P&L, cash and balance query reads status='confirmed' only, so the amounts leave income,
-- expense, transfer and account balances exactly once, and the original stays readable.
--
-- Both refuse a closed month (old and new business/recognition months), a stale
-- expected_updated_at (concurrent edit), and serialize on the same month-close advisory
-- locks as ledger_edit_manual_transaction_v1 (taken in month order, so no lock cycle).
-- Business date = occurred_at in Asia/Ho_Chi_Minh minus 3 hours (03:00 cut-off).
-- No existing row, function or grant is changed.

-- Shared eligibility check (row must already be locked by the caller).
create function public.ledger_manual_transaction_blocker_v1(p_transaction public.ledger_transactions)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_ref record;
  v_linked boolean;
begin
  if p_transaction.status = 'cancelled' then return 'already_cancelled'; end if;
  if p_transaction.status <> 'confirmed' or p_transaction.source_type <> 'manual'
     or p_transaction.type not in ('income', 'expense', 'transfer') then
    return 'unsupported_transaction';
  end if;
  if p_transaction.correction_of_id is not null
     or coalesce(p_transaction.source_snapshot, '{}'::jsonb) <> '{}'::jsonb then
    return 'special_transaction';
  end if;
  if exists (select 1 from public.ledger_transactions child
    where child.correction_of_id = p_transaction.id and child.status = 'confirmed') then
    return 'already_corrected';
  end if;
  -- Any other table that points at this transaction makes it a linked transaction.
  for v_ref in
    select c.conrelid::regclass as tbl, a.attname as col
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.confrelid = 'public.ledger_transactions'::regclass
      and c.conrelid not in ('public.ledger_movements'::regclass, 'public.ledger_transactions'::regclass)
  loop
    execute format('select exists (select 1 from %s where %I = $1)', v_ref.tbl, v_ref.col)
      into v_linked using p_transaction.id;
    if v_linked then return 'linked_transaction'; end if;
  end loop;
  return null;
end
$$;

-- Movements of an income/expense/transfer must be exactly one -amount (from) and/or one
-- +amount (to). Returns the from/to account ids or null when the shape is unexpected.
create function public.ledger_manual_transaction_accounts_v1(p_transaction public.ledger_transactions)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_from bigint; v_to bigint; v_count int := 0; v_neg int := 0; v_pos int := 0; m record;
begin
  for m in select fund_account_id, amount from public.ledger_movements where transaction_id = p_transaction.id loop
    v_count := v_count + 1;
    if m.amount = -p_transaction.amount then v_neg := v_neg + 1; v_from := m.fund_account_id;
    elsif m.amount = p_transaction.amount then v_pos := v_pos + 1; v_to := m.fund_account_id;
    end if;
  end loop;
  if (p_transaction.type = 'expense' and (v_count <> 1 or v_neg <> 1))
     or (p_transaction.type = 'income' and (v_count <> 1 or v_pos <> 1))
     or (p_transaction.type = 'transfer' and (v_count <> 2 or v_neg <> 1 or v_pos <> 1)) then
    return null;
  end if;
  return jsonb_build_object('from', v_from, 'to', v_to);
end
$$;

create function public.ledger_update_manual_transaction_v2(
  p_transaction_id bigint,
  p_expected_updated_at timestamptz,
  p_changes jsonb,
  p_reason text,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_reason text := nullif(btrim(p_reason), '');
  v_tx public.ledger_transactions%rowtype;
  v_before jsonb;
  v_before_movements jsonb;
  v_after_movements jsonb;
  v_accounts jsonb;
  v_blocker text;
  v_peek record;
  v_occurred timestamptz; v_business date; v_type text; v_amount numeric; v_category bigint; v_party bigint;
  v_from bigint; v_to bigint; v_title text; v_memo text; v_recognition date; v_kind text;
  v_old_title text; v_changed text[] := '{}';
  v_months date[];
  v_month date;
begin
  select lower(role::text) into v_role from public.users
    where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then return jsonb_build_object('status', 'forbidden'); end if;
  if p_transaction_id is null or p_expected_updated_at is null or v_reason is null or length(v_reason) > 500
     or p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb
     or exists (select 1 from jsonb_object_keys(p_changes) k
       where k not in ('occurredAt', 'type', 'amount', 'categoryId', 'partyId', 'fromAccountId', 'toAccountId', 'title', 'memo')) then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  -- Peek (no lock) to know which months to lock, then lock months in order, then the row.
  select business_date, recognition_month into v_peek from public.ledger_transactions where id = p_transaction_id;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  begin
    v_occurred := case when p_changes ? 'occurredAt' then (p_changes ->> 'occurredAt')::timestamptz end;
  exception when others then return jsonb_build_object('status', 'invalid_date');
  end;
  if p_changes ? 'occurredAt' and v_occurred is null then return jsonb_build_object('status', 'invalid_date'); end if;
  v_months := array(select distinct m from unnest(array[
      date_trunc('month', v_peek.business_date)::date,
      v_peek.recognition_month,
      case when v_occurred is not null then date_trunc('month', ((v_occurred at time zone 'Asia/Ho_Chi_Minh') - interval '3 hours')::date)::date end
    ]) m where m is not null order by m);
  foreach v_month in array v_months loop
    perform pg_advisory_xact_lock(hashtext('ledger_month_close:' || to_char(v_month, 'YYYY-MM')));
  end loop;

  select * into v_tx from public.ledger_transactions where id = p_transaction_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_tx.business_date <> v_peek.business_date or v_tx.recognition_month is distinct from v_peek.recognition_month
     or v_tx.updated_at is distinct from p_expected_updated_at then
    return jsonb_build_object('status', 'stale', 'updatedAt', v_tx.updated_at);
  end if;
  v_blocker := public.ledger_manual_transaction_blocker_v1(v_tx);
  if v_blocker is not null then return jsonb_build_object('status', v_blocker); end if;
  perform 1 from public.ledger_movements where transaction_id = v_tx.id order by id for update;
  v_accounts := public.ledger_manual_transaction_accounts_v1(v_tx);
  if v_accounts is null then return jsonb_build_object('status', 'invalid_movements'); end if;

  -- Final values: sent fields replace, the rest stay as they are.
  begin
    v_type := coalesce(p_changes ->> 'type', v_tx.type);
    v_amount := case when p_changes ? 'amount' then (p_changes ->> 'amount')::numeric else v_tx.amount end;
    v_category := case when p_changes ? 'categoryId' then (p_changes ->> 'categoryId')::bigint else v_tx.category_id end;
    v_party := case when p_changes ? 'partyId' then (p_changes ->> 'partyId')::bigint else v_tx.party_id end;
    v_from := case when p_changes ? 'fromAccountId' then (p_changes ->> 'fromAccountId')::bigint else (v_accounts ->> 'from')::bigint end;
    v_to := case when p_changes ? 'toAccountId' then (p_changes ->> 'toAccountId')::bigint else (v_accounts ->> 'to')::bigint end;
  exception when others then return jsonb_build_object('status', 'invalid_input');
  end;
  v_occurred := coalesce(v_occurred, v_tx.occurred_at);
  v_business := ((v_occurred at time zone 'Asia/Ho_Chi_Minh') - interval '3 hours')::date;
  v_old_title := v_tx.display_snapshot ->> 'titleOverride';
  v_title := case when p_changes ? 'title' then nullif(btrim(p_changes ->> 'title'), '') else v_old_title end;
  v_memo := case when p_changes ? 'memo' then nullif(btrim(p_changes ->> 'memo'), '') else v_tx.memo end;

  if v_type not in ('income', 'expense', 'transfer') then return jsonb_build_object('status', 'invalid_type'); end if;
  if v_amount is null or v_amount <= 0 or v_amount <> trunc(v_amount) or v_amount > 9999999999999 then
    return jsonb_build_object('status', 'invalid_amount');
  end if;
  if length(coalesce(v_title, '')) > 160 or length(coalesce(v_memo, '')) > 2000 then return jsonb_build_object('status', 'invalid_input'); end if;
  if v_type in ('income', 'expense') then
    select kind into v_kind from public.ledger_categories where id = v_category and is_active = true;
    if v_kind is distinct from v_type then return jsonb_build_object('status', 'invalid_category'); end if;
  else
    v_category := null;
  end if;
  -- A supplier belongs to an expense only (same rule as manual creation).
  if v_type <> 'expense' then
    if p_changes ? 'partyId' and (p_changes ->> 'partyId') is not null then return jsonb_build_object('status', 'invalid_party'); end if;
    v_party := null;
  elsif v_party is not null and not exists (select 1 from public.ledger_parties where id = v_party and is_active = true) then
    return jsonb_build_object('status', 'invalid_party');
  end if;
  if v_type = 'expense' then v_to := null; end if;
  if v_type = 'income' then v_from := null; end if;
  if (v_type = 'expense' and v_from is null) or (v_type = 'income' and v_to is null)
     or (v_type = 'transfer' and (v_from is null or v_to is null or v_from = v_to))
     or exists (select 1 from (values (v_from), (v_to)) a(id) where id is not null
       and not exists (select 1 from public.ledger_fund_accounts f where f.id = a.id and f.is_active = true)) then
    return jsonb_build_object('status', 'invalid_accounts');
  end if;
  -- Recognition month follows the business month when the date or the P&L type changes.
  -- (It is then always one of the months already locked above.)
  v_recognition := case
    when v_type = 'transfer' then null
    when v_tx.type = 'transfer' or date_trunc('month', v_business) <> date_trunc('month', v_tx.business_date)
      then date_trunc('month', v_business)::date
    else v_tx.recognition_month end;
  -- Both the previous and the new months must be open.
  foreach v_month in array array[date_trunc('month', v_tx.business_date)::date, v_tx.recognition_month,
      date_trunc('month', v_business)::date, v_recognition] loop
    if v_month is not null and public.ledger_month_is_closed_v1(v_month) then
      return jsonb_build_object('status', 'month_closed', 'month', v_month);
    end if;
  end loop;

  if v_occurred is distinct from v_tx.occurred_at then v_changed := array_append(v_changed, 'occurredAt'); end if;
  if v_type <> v_tx.type then v_changed := array_append(v_changed, 'type'); end if;
  if v_amount <> v_tx.amount then v_changed := array_append(v_changed, 'amount'); end if;
  if v_category is distinct from v_tx.category_id then v_changed := array_append(v_changed, 'categoryId'); end if;
  if v_party is distinct from v_tx.party_id then v_changed := array_append(v_changed, 'partyId'); end if;
  if v_from is distinct from (v_accounts ->> 'from')::bigint then v_changed := array_append(v_changed, 'fromAccountId'); end if;
  if v_to is distinct from (v_accounts ->> 'to')::bigint then v_changed := array_append(v_changed, 'toAccountId'); end if;
  if v_title is distinct from v_old_title then v_changed := array_append(v_changed, 'title'); end if;
  if v_memo is distinct from v_tx.memo then v_changed := array_append(v_changed, 'memo'); end if;
  if cardinality(v_changed) = 0 then return jsonb_build_object('status', 'unchanged'); end if;

  v_before := to_jsonb(v_tx);
  select coalesce(jsonb_agg(to_jsonb(m) order by m.id), '[]'::jsonb) into v_before_movements
    from public.ledger_movements m where m.transaction_id = v_tx.id;

  update public.ledger_transactions set
    occurred_at = v_occurred, business_date = v_business, type = v_type, amount = v_amount,
    recognition_month = v_recognition, category_id = v_category, party_id = v_party, memo = v_memo,
    display_snapshot = case when v_title is null then coalesce(display_snapshot, '{}'::jsonb) - 'titleOverride'
      else coalesce(display_snapshot, '{}'::jsonb) || jsonb_build_object('titleOverride', v_title) end,
    updated_at = now()
  where id = v_tx.id returning * into v_tx;

  -- Movements: keep the existing rows where the side still exists, update account and
  -- amount in place; remove a side that no longer exists; add a missing side.
  update public.ledger_movements set fund_account_id = v_from, amount = -v_amount
    where transaction_id = v_tx.id and amount < 0 and v_from is not null;
  update public.ledger_movements set fund_account_id = v_to, amount = v_amount
    where transaction_id = v_tx.id and amount > 0 and v_to is not null;
  delete from public.ledger_movements where transaction_id = v_tx.id
    and ((amount < 0 and v_from is null) or (amount > 0 and v_to is null));
  if v_from is not null and not exists (select 1 from public.ledger_movements where transaction_id = v_tx.id and amount < 0) then
    insert into public.ledger_movements(transaction_id, fund_account_id, amount) values (v_tx.id, v_from, -v_amount);
  end if;
  if v_to is not null and not exists (select 1 from public.ledger_movements where transaction_id = v_tx.id and amount > 0) then
    insert into public.ledger_movements(transaction_id, fund_account_id, amount) values (v_tx.id, v_to, v_amount);
  end if;
  if public.ledger_manual_transaction_accounts_v1(v_tx) is null then
    raise exception using errcode = 'P0001', message = 'MANUAL_TRANSACTION_MOVEMENT_SHAPE';
  end if;

  select coalesce(jsonb_agg(to_jsonb(m) order by m.id), '[]'::jsonb) into v_after_movements
    from public.ledger_movements m where m.transaction_id = v_tx.id;
  insert into public.ledger_audit_logs(actor_user_id, action, entity_type, entity_id, before_snapshot, after_snapshot, reason)
  values (p_actor_user_id, 'manual_transaction_updated', 'transaction', v_tx.id,
    jsonb_build_object('transaction', v_before, 'movements', v_before_movements),
    jsonb_build_object('transaction', to_jsonb(v_tx), 'movements', v_after_movements, 'changedFields', to_jsonb(v_changed)),
    v_reason);
  return jsonb_build_object('status', 'updated', 'transactionId', v_tx.id, 'updatedAt', v_tx.updated_at,
    'businessDate', v_tx.business_date, 'changedFields', to_jsonb(v_changed));
end
$$;

create function public.ledger_cancel_manual_transaction_v1(
  p_transaction_id bigint,
  p_expected_updated_at timestamptz,
  p_reason text,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_reason text := nullif(btrim(p_reason), '');
  v_tx public.ledger_transactions%rowtype;
  v_peek record;
  v_before jsonb;
  v_movements jsonb;
  v_blocker text;
  v_month date;
begin
  select lower(role::text) into v_role from public.users
    where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then return jsonb_build_object('status', 'forbidden'); end if;
  if p_transaction_id is null or p_expected_updated_at is null or v_reason is null or length(v_reason) > 500 then
    return jsonb_build_object('status', 'invalid_input');
  end if;
  select business_date, recognition_month into v_peek from public.ledger_transactions where id = p_transaction_id;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  foreach v_month in array array(select distinct m from unnest(array[date_trunc('month', v_peek.business_date)::date, v_peek.recognition_month]) m
      where m is not null order by m) loop
    perform pg_advisory_xact_lock(hashtext('ledger_month_close:' || to_char(v_month, 'YYYY-MM')));
  end loop;
  select * into v_tx from public.ledger_transactions where id = p_transaction_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  -- A second "삭제" of the same row reports already_cancelled, whatever its timestamp.
  if v_tx.status = 'cancelled' then return jsonb_build_object('status', 'already_cancelled'); end if;
  if v_tx.updated_at is distinct from p_expected_updated_at then
    return jsonb_build_object('status', 'stale', 'updatedAt', v_tx.updated_at);
  end if;
  v_blocker := public.ledger_manual_transaction_blocker_v1(v_tx);
  if v_blocker is not null then return jsonb_build_object('status', v_blocker); end if;
  if public.ledger_month_is_closed_v1(date_trunc('month', v_tx.business_date)::date)
     or public.ledger_month_is_closed_v1(v_tx.recognition_month) then
    return jsonb_build_object('status', 'month_closed');
  end if;
  perform 1 from public.ledger_movements where transaction_id = v_tx.id order by id for update;
  if public.ledger_manual_transaction_accounts_v1(v_tx) is null then return jsonb_build_object('status', 'invalid_movements'); end if;

  v_before := to_jsonb(v_tx);
  select coalesce(jsonb_agg(to_jsonb(m) order by m.id), '[]'::jsonb) into v_movements
    from public.ledger_movements m where m.transaction_id = v_tx.id;
  -- Status only: the row, its amounts and its movements stay as recorded.
  update public.ledger_transactions set status = 'cancelled', updated_at = now()
    where id = v_tx.id returning * into v_tx;
  insert into public.ledger_audit_logs(actor_user_id, action, entity_type, entity_id, before_snapshot, after_snapshot, reason)
  values (p_actor_user_id, 'manual_transaction_cancelled', 'transaction', v_tx.id,
    jsonb_build_object('transaction', v_before, 'movements', v_movements),
    jsonb_build_object('transaction', to_jsonb(v_tx), 'movements', v_movements), v_reason);
  return jsonb_build_object('status', 'cancelled', 'transactionId', v_tx.id, 'updatedAt', v_tx.updated_at);
end
$$;

revoke all on function public.ledger_manual_transaction_blocker_v1(public.ledger_transactions) from public, anon, authenticated, service_role;
revoke all on function public.ledger_manual_transaction_accounts_v1(public.ledger_transactions) from public, anon, authenticated, service_role;
revoke all on function public.ledger_update_manual_transaction_v2(bigint, timestamptz, jsonb, text, bigint) from public, anon, authenticated;
revoke all on function public.ledger_cancel_manual_transaction_v1(bigint, timestamptz, text, bigint) from public, anon, authenticated;
grant execute on function public.ledger_update_manual_transaction_v2(bigint, timestamptz, jsonb, text, bigint) to service_role;
grant execute on function public.ledger_cancel_manual_transaction_v1(bigint, timestamptz, text, bigint) to service_role;
