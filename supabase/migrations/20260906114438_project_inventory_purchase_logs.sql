-- Source-only automation; no production backfill. Existing public management contracts remain unchanged.
create schema inventory_ledger_private authorization postgres;
revoke all on schema inventory_ledger_private from public, anon, authenticated, service_role;

-- Adapted from the existing audited resolver/sync/rebook policies. These helpers are
-- owner-only and cannot be invoked by API roles, even service_role.
create or replace function inventory_ledger_private.resolve_candidate(p_candidate_id bigint,p_resolution text,p_category_id bigint,p_party_id bigint,p_fund_account_id bigint,p_due_date date,p_memo text,p_reason text,p_actor_user_id bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_role text;v_candidate public.ledger_candidates%rowtype;v_transaction_id bigint;v_payable_id bigint;v_operation uuid:=gen_random_uuid();
begin
 select lower(role::text) into v_role from public.users where id=p_actor_user_id and is_active=true and app_login_enabled=true;if coalesce(v_role,'') = '' then return jsonb_build_object('status','forbidden');end if;
 select * into v_candidate from public.ledger_candidates where id=p_candidate_id for update;if v_candidate.id is null then return jsonb_build_object('status','not_found');end if;if v_candidate.status<>'pending' then return jsonb_build_object('status','already_resolved');end if;
 if p_resolution='dismiss' then if nullif(btrim(p_reason),'') is null then return jsonb_build_object('status','reason_required');end if;update public.ledger_candidates set status='dismissed',resolved_by=p_actor_user_id,resolved_at=now(),dismissal_reason=btrim(p_reason),updated_at=now() where id=p_candidate_id;insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)values(p_actor_user_id,'candidate_dismissed','candidate',p_candidate_id,to_jsonb(v_candidate),(select to_jsonb(c) from public.ledger_candidates c where c.id=p_candidate_id),btrim(p_reason));return jsonb_build_object('status','dismissed');end if;
 if p_resolution not in('immediate','payable') then return jsonb_build_object('status','invalid_resolution');end if;
 if not exists(select 1 from public.ledger_categories where id=p_category_id and kind='expense' and is_active=true) then return jsonb_build_object('status','invalid_category');end if;
 if p_resolution='immediate' and not exists(select 1 from public.ledger_fund_accounts where id=p_fund_account_id and is_active=true) then return jsonb_build_object('status','invalid_account');end if;
 if p_resolution='payable' and (p_party_id is null or not exists(select 1 from public.ledger_parties where id=p_party_id and is_active=true)) then return jsonb_build_object('status','party_required');end if;
 insert into public.ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,party_id,status,source_type,source_key,source_snapshot,source_fingerprint,source_synced_at,memo,created_by,confirmed_by)
 values(v_operation,'expense',(v_candidate.business_date+time '03:00') at time zone 'Asia/Ho_Chi_Minh',v_candidate.business_date,v_candidate.proposed_recognition_month,v_candidate.proposed_amount,p_category_id,p_party_id,'confirmed','inventory_purchase_candidate','candidate:'||v_candidate.id,v_candidate.source_snapshot,v_candidate.source_fingerprint,now(),nullif(btrim(p_memo),''),p_actor_user_id,p_actor_user_id)returning id into v_transaction_id;
 if p_resolution='immediate' then insert into public.ledger_movements(transaction_id,fund_account_id,amount)values(v_transaction_id,p_fund_account_id,-v_candidate.proposed_amount);else insert into public.ledger_payables(expense_transaction_id,party_id,original_amount,due_date)values(v_transaction_id,p_party_id,v_candidate.proposed_amount,p_due_date)returning id into v_payable_id;end if;
 update public.ledger_candidates set status='confirmed',resolved_transaction_id=v_transaction_id,resolved_by=p_actor_user_id,resolved_at=now(),updated_at=now() where id=p_candidate_id;
 insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)values(p_actor_user_id,case when p_resolution='immediate' then 'candidate_confirmed_immediate' else 'candidate_confirmed_payable' end,'candidate',p_candidate_id,to_jsonb(v_candidate),(select to_jsonb(c) from public.ledger_candidates c where c.id=p_candidate_id),nullif(btrim(p_memo),''));
 return jsonb_build_object('status','confirmed','transactionId',v_transaction_id,'payableId',v_payable_id);
exception when unique_violation then return jsonb_build_object('status','already_resolved');
end $$;

create or replace function inventory_ledger_private.sync_candidate(
  p_rows jsonb,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_item jsonb;
  v_key text;
  v_fingerprint text;
  v_snapshot jsonb;
  v_date date;
  v_amount numeric;
  v_pending public.ledger_candidates%rowtype;
  v_latest public.ledger_candidates%rowtype;
  v_category_id bigint;
  v_party_id bigint;
  v_business_partner public.business_partners%rowtype;
  v_result jsonb;
  v_force_review boolean := false;
  v_scanned integer := 0;
  v_created integer := 0;
  v_unchanged integer := 0;
  v_superseded integer := 0;
  v_auto_immediate integer := 0;
  v_auto_payable integer := 0;
  v_pending_review integer := 0;
begin
  select lower(role::text) into v_role
  from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') = '' then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception using
      errcode = '22023',
      message = 'INVALID_ROWS';
  end if;

  for v_item in select value from jsonb_array_elements(p_rows) loop
    v_scanned := v_scanned + 1;
    begin
      v_key := v_item->>'sourceKey';
      v_fingerprint := v_item->>'fingerprint';
      v_snapshot := v_item->'snapshot';
      v_date := (v_item->>'businessDate')::date;
      v_amount := (v_item->>'amount')::numeric;
    exception when others then
      raise exception using
        errcode = '22023',
        message = 'INVALID_ROWS';
    end;
    if v_key is null
       or v_fingerprint is null
       or v_snapshot is null
       or v_date is null
       or v_amount is null
       or v_key !~ '^inventory-log:[0-9]+$'
       or length(v_fingerprint) <> 64
       or jsonb_typeof(v_snapshot) <> 'object'
       or v_amount <= 0 then
      raise exception using
        errcode = '22023',
        message = 'INVALID_ROWS';
    end if;

    perform pg_advisory_xact_lock(hashtext('ledger_inventory_candidate:' || v_key));
    v_latest := null; v_pending := null; v_category_id := null;
    v_party_id := null; v_business_partner := null; v_result := null;
    v_force_review := false;

    select * into v_latest
    from public.ledger_candidates
    where source_type = 'inventory_purchase_log' and source_key = v_key
    order by id desc limit 1 for update;
    if v_latest.id is not null and (
      v_latest.source_snapshot = v_snapshot
      or (v_latest.status = 'dismissed'
        and not v_latest.source_snapshot ? 'item_name_vi'
        and not v_latest.source_snapshot ? 'unit'
        and v_latest.source_snapshot = v_snapshot - array['item_name_vi','unit']::text[])
    ) then
      v_fingerprint := v_latest.source_fingerprint;
    end if;
    if v_latest.status = 'confirmed' then
      if v_latest.source_fingerprint = v_fingerprint then
        v_unchanged := v_unchanged + 1;
        continue;
      end if;
      raise exception using
        errcode = '55000',
        message = 'SOURCE_CHANGED_AFTER_POST';
    end if;
    if v_latest.status = 'dismissed' then
      if v_latest.source_fingerprint = v_fingerprint then
        v_unchanged := v_unchanged + 1;
        continue;
      end if;
      v_force_review := true;
    end if;
    if v_latest.status = 'pending'
       and exists (
         select 1
         from public.ledger_candidates history
         where history.source_type = v_latest.source_type
           and history.source_key = v_latest.source_key
           and history.id < v_latest.id
           and history.status = 'dismissed'
           and history.source_fingerprint is distinct from v_latest.source_fingerprint
       ) then
      v_force_review := true;
    end if;

    v_category_id := v_latest.proposed_category_id;
    if v_category_id is null then
    select ledger_category_id into v_category_id
    from public.ledger_inventory_category_mappings
    where is_active = true
      and lower(btrim(inventory_category)) = lower(btrim(v_snapshot->>'category'))
    limit 1;

    end if;
    select blp.ledger_party_id into v_party_id
      from public.inventory_logs source_log
      join public.business_partners bp on bp.id = source_log.purchase_supplier_partner_id and bp.is_active = true
      join public.business_partner_ledger_parties blp on blp.business_partner_id = bp.id
      where source_log.id = (v_snapshot->>'inventory_log_id')::bigint;
    if v_party_id is null and nullif(btrim(v_snapshot->>'supplier'), '') is not null then
      select blp.ledger_party_id into v_party_id
      from public.business_partner_supplier_aliases a
      join public.business_partners bp on bp.id = a.business_partner_id and bp.is_active = true
      join public.business_partner_ledger_parties blp on blp.business_partner_id = bp.id
      where a.status = 'linked'
        and a.normalized_name = lower(btrim(v_snapshot->>'supplier')) limit 1;
    end if;
    if v_party_id is null and nullif(btrim(v_snapshot->>'supplier'), '') is not null then
      select blp.ledger_party_id into v_party_id
      from public.business_partners bp
      join public.business_partner_ledger_parties blp on blp.business_partner_id = bp.id
      where bp.is_active = true
        and lower(btrim(bp.name)) = lower(btrim(v_snapshot->>'supplier')) limit 1;
    end if;
    if v_party_id is null then
      select party_id into v_party_id
      from public.ledger_supplier_party_mappings
      where is_active = true
        and lower(btrim(supplier_name)) = lower(btrim(v_snapshot->>'supplier')) limit 1;
    end if;

    select * into v_pending
    from public.ledger_candidates
    where source_type = 'inventory_purchase_log' and source_key = v_key and status = 'pending'
    for update;
    if v_pending.id is not null and v_pending.source_fingerprint = v_fingerprint then
      update public.ledger_candidates
      set proposed_category_id = v_category_id, proposed_party_id = v_party_id,
          updated_at = case when proposed_category_id is distinct from v_category_id
            or proposed_party_id is distinct from v_party_id then now() else updated_at end
      where id = v_pending.id returning * into v_pending;
      v_unchanged := v_unchanged + 1;
    else
      if v_pending.id is not null then
        update public.ledger_candidates set status = 'superseded', resolved_at = now(), updated_at = now()
        where id = v_pending.id;
        v_superseded := v_superseded + 1;
      end if;
      insert into public.ledger_candidates(
        candidate_type, source_type, source_key, business_date, proposed_amount,
        proposed_category_id, proposed_party_id, proposed_recognition_month,
        source_snapshot, source_fingerprint
      ) values (
        'inventory_purchase', 'inventory_purchase_log', v_key, v_date, v_amount,
        v_category_id, v_party_id, date_trunc('month', v_date)::date,
        v_snapshot, v_fingerprint
      ) returning * into v_pending;
      v_created := v_created + 1;
    end if;

    if v_force_review then
      v_pending_review := v_pending_review + 1;
      continue;
    end if;

    if v_pending.candidate_type <> 'inventory_purchase'
       or v_pending.proposed_category_id is null
       or v_pending.proposed_party_id is null then
      v_pending_review := v_pending_review + 1;
      continue;
    end if;
    select bp.* into v_business_partner
    from public.business_partner_ledger_parties blp
    join public.business_partners bp on bp.id = blp.business_partner_id
    where blp.ledger_party_id = v_pending.proposed_party_id and bp.is_active = true
    limit 1;
    if v_business_partner.id is null or v_business_partner.payment_mode not in ('immediate', 'postpaid') then
      v_pending_review := v_pending_review + 1;
      continue;
    end if;

    if v_business_partner.payment_mode = 'immediate' then
      if v_business_partner.default_fund_account_id is null
         or not public.business_partner_fund_account_is_eligible_v1(v_business_partner.default_fund_account_id)
         or not exists (
           select 1
           from public.ledger_fund_accounts account
           where account.id = v_business_partner.default_fund_account_id
             and account.is_active = true
             and account.is_business_fund = true
             and account.type <> 'card_clearing'
             and account.active_from <= v_pending.business_date
             and (account.active_to is null or account.active_to >= v_pending.business_date)
         ) then
        v_pending_review := v_pending_review + 1;
        continue;
      end if;
      v_result := inventory_ledger_private.resolve_candidate(
        v_pending.id, 'immediate', v_pending.proposed_category_id,
        v_pending.proposed_party_id, v_business_partner.default_fund_account_id,
        null, null, 'Inventory sync auto-post: immediate', p_actor_user_id
      );
      if v_result->>'status' = 'confirmed' then v_auto_immediate := v_auto_immediate + 1;
      else v_pending_review := v_pending_review + 1; end if;
    else
      v_result := inventory_ledger_private.resolve_candidate(
        v_pending.id, 'payable', v_pending.proposed_category_id,
        v_pending.proposed_party_id, null,
        case when v_business_partner.default_payment_term_days is null then null
          else v_pending.business_date + v_business_partner.default_payment_term_days end,
        null, 'Inventory sync auto-post: postpaid', p_actor_user_id
      );
      if v_result->>'status' = 'confirmed' then v_auto_payable := v_auto_payable + 1;
      else v_pending_review := v_pending_review + 1; end if;
    end if;
  end loop;

  return jsonb_build_object(
    'status', 'ok', 'scannedLogs', v_scanned, 'createdCount', v_created,
    'unchangedCount', v_unchanged, 'supersededCount', v_superseded,
    'autoConfirmedImmediateCount', v_auto_immediate,
    'autoConfirmedPayableCount', v_auto_payable,
    'pendingReviewCount', v_pending_review
  );
end;
$$;


create or replace function inventory_ledger_private.rebook_source(
  p_original_transaction_id bigint,
  p_payment_mode text,
  p_category_id bigint,
  p_fund_account_id bigint,
  p_due_date date,
  p_amount numeric,
  p_memo text,
  p_reason text,
  p_actor_user_id bigint,
  p_source_snapshot jsonb,
  p_source_fingerprint text,
  p_party_id bigint,
  p_business_date date
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_original public.ledger_transactions%rowtype;
  v_candidate public.ledger_candidates%rowtype;
  v_old_payable public.ledger_payables%rowtype;
  v_old_allocated numeric(16,3) := 0;
  v_reversal_id bigint;
  v_rebook_id bigint;
  v_new_payable_id bigint;
  v_operation uuid := gen_random_uuid();
  v_before jsonb;
begin
  select lower(role::text) into v_role
  from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') = '' then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_payment_mode is null or p_payment_mode not in ('immediate', 'payable') then
    return jsonb_build_object('status', 'invalid_payment_mode');
  end if;
  if p_amount is null or p_amount <= 0 or scale(p_amount) > 3 then
    return jsonb_build_object('status', 'invalid_amount');
  end if;
  if nullif(btrim(p_reason), '') is null then
    return jsonb_build_object('status', 'reason_required');
  end if;

  perform pg_advisory_xact_lock(hashtext('ledger_inventory_rebook:' || p_original_transaction_id::text));
  select * into v_original
  from public.ledger_transactions
  where id = p_original_transaction_id
  for update;
  if v_original.id is null then return jsonb_build_object('status', 'not_found'); end if;
  if v_original.status <> 'confirmed'
     or v_original.type <> 'expense'
     or v_original.source_type not in ('inventory_purchase_candidate', 'inventory_purchase_rebook') then
    return jsonb_build_object('status', 'not_editable');
  end if;
  select * into v_candidate
  from public.ledger_candidates
  where candidate_type = 'inventory_purchase'
    and status = 'confirmed'
    and resolved_transaction_id = v_original.id
  order by id
  limit 1
  for update;
  if v_candidate.id is null then
    return jsonb_build_object('status', 'invalid_original_state');
  end if;
  perform pg_advisory_xact_lock(
    hashtext('ledger_month_close:' || to_char(date_trunc('month', v_original.business_date), 'YYYY-MM'))
  );
  if public.ledger_month_is_closed_v1(date_trunc('month', v_original.business_date)::date) then
    return jsonb_build_object('status', 'month_closed');
  end if;
  perform pg_advisory_xact_lock(hashtext('ledger_month_close:' || to_char(p_business_date, 'YYYY-MM')));
  if public.ledger_month_is_closed_v1(date_trunc('month', p_business_date)::date)
     or public.ledger_month_is_closed_v1(v_original.recognition_month) then
    return jsonb_build_object('status', 'month_closed');
  end if;
  if exists (
    select 1 from public.ledger_transactions
    where correction_of_id = v_original.id
      and source_type in ('inventory_purchase_reversal', 'inventory_purchase_rebook')
  ) then
    return jsonb_build_object('status', 'already_rebooked');
  end if;
  if not exists (
    select 1 from public.ledger_categories
    where id = p_category_id and kind = 'expense' and is_active = true
  ) then
    return jsonb_build_object('status', 'invalid_category');
  end if;
  if p_payment_mode = 'immediate' and not exists (
    select 1 from public.ledger_fund_accounts
    where id = p_fund_account_id
      and is_active = true and is_business_fund = true and type <> 'card_clearing'
      and active_from <= p_business_date
      and (active_to is null or active_to >= p_business_date)
  ) then
    return jsonb_build_object('status', 'invalid_account');
  end if;
  if p_payment_mode = 'payable'
     and (p_party_id is null or not exists (
       select 1 from public.ledger_parties where id = p_party_id and is_active = true
     )) then
    return jsonb_build_object('status', 'party_required');
  end if;

  select * into v_old_payable
  from public.ledger_payables
  where expense_transaction_id = v_original.id
  for update;
  if v_old_payable.id is not null then
    select coalesce(sum(allocated_amount), 0) into v_old_allocated
    from public.ledger_payable_allocations
    where payable_id = v_old_payable.id;
    if v_old_allocated > 0 or v_old_payable.status in ('partially_paid', 'paid') then
      return jsonb_build_object('status', 'payable_already_paid');
    end if;
    if v_old_payable.status <> 'unpaid'
       or v_old_payable.party_id is distinct from v_original.party_id
       or v_old_payable.original_amount <> v_original.amount
       or exists (select 1 from public.ledger_movements where transaction_id = v_original.id) then
      return jsonb_build_object('status', 'invalid_original_state');
    end if;
  elsif (select count(*) from public.ledger_movements where transaction_id = v_original.id and amount < 0) <> 1
     or (select count(*) from public.ledger_movements where transaction_id = v_original.id) <> 1 then
    return jsonb_build_object('status', 'invalid_original_state');
  end if;

  v_before := jsonb_build_object(
    'transaction', to_jsonb(v_original),
    'movements', coalesce((select jsonb_agg(to_jsonb(m) order by m.id) from public.ledger_movements m where m.transaction_id = v_original.id), '[]'::jsonb),
    'payable', case when v_old_payable.id is null then null else to_jsonb(v_old_payable) end,
    'candidate', to_jsonb(v_candidate)
  );

  insert into public.ledger_transactions(
    operation_id, type, occurred_at, business_date, recognition_month, amount,
    category_id, party_id, status, source_type, source_key, source_snapshot,
    source_fingerprint, source_synced_at, correction_of_id, memo,
    created_by, confirmed_by, economic_effect_sign
  ) values (
    v_operation, 'expense', v_original.occurred_at, v_original.business_date,
    v_original.recognition_month, v_original.amount, v_original.category_id,
    v_original.party_id, 'confirmed', 'inventory_purchase_reversal',
    'inventory-reversal:' || v_original.id || ':' || v_operation::text,
    v_original.source_snapshot,
    v_original.source_fingerprint, now(), v_original.id,
    'Reversal: ' || btrim(p_reason), p_actor_user_id, p_actor_user_id, -1
  ) returning id into v_reversal_id;

  insert into public.ledger_movements(transaction_id, fund_account_id, amount)
  select v_reversal_id, fund_account_id, -amount
  from public.ledger_movements
  where transaction_id = v_original.id;

  if v_old_payable.id is not null then
    update public.ledger_payables
    set status = 'cancelled', updated_at = now()
    where id = v_old_payable.id;
  end if;

  insert into public.ledger_transactions(
    operation_id, type, occurred_at, business_date, recognition_month, amount,
    category_id, party_id, status, source_type, source_key, source_snapshot,
    source_fingerprint, source_synced_at, correction_of_id, memo,
    created_by, confirmed_by, economic_effect_sign
  ) values (
    v_operation, 'expense', (p_business_date + time '03:00') at time zone 'Asia/Ho_Chi_Minh', p_business_date,
    date_trunc('month', p_business_date)::date, p_amount, p_category_id, p_party_id,
    'confirmed', 'inventory_purchase_rebook',
    'inventory-rebook:' || v_original.id || ':' || v_operation::text,
    p_source_snapshot, p_source_fingerprint, now(), v_original.id,
    nullif(btrim(p_memo), ''), p_actor_user_id, p_actor_user_id, 1
  ) returning id into v_rebook_id;

  if p_payment_mode = 'immediate' then
    insert into public.ledger_movements(transaction_id, fund_account_id, amount)
    values(v_rebook_id, p_fund_account_id, -p_amount);
  else
    insert into public.ledger_payables(expense_transaction_id, party_id, original_amount, due_date)
    values(v_rebook_id, p_party_id, p_amount, p_due_date)
    returning id into v_new_payable_id;
  end if;

  update public.ledger_candidates
  set resolved_transaction_id = v_rebook_id, source_snapshot = p_source_snapshot,
      source_fingerprint = p_source_fingerprint, source_drift_snapshot = null,
      source_drift_fingerprint = null, source_drift_detected_at = null,
      business_date = p_business_date, proposed_recognition_month = date_trunc('month', p_business_date)::date,
      proposed_amount = p_amount, proposed_party_id = p_party_id, updated_at = now()
  where id = v_candidate.id;

  insert into public.ledger_audit_logs(
    actor_user_id, action, entity_type, entity_id,
    before_snapshot, after_snapshot, reason
  ) values (
    p_actor_user_id, 'inventory_source_rebooked', 'transaction', v_rebook_id,
    v_before,
    jsonb_build_object(
      'originalTransactionId', v_original.id,
      'reversalTransactionId', v_reversal_id,
      'rebookTransactionId', v_rebook_id,
      'operationId', v_operation,
      'paymentMode', p_payment_mode,
      'categoryId', p_category_id,
      'fundAccountId', case when p_payment_mode = 'immediate' then p_fund_account_id else null end,
      'payableId', v_new_payable_id,
      'dueDate', p_due_date,
      'amount', p_amount,
      'replacementTransaction', (select to_jsonb(t) from public.ledger_transactions t where t.id = v_rebook_id),
      'replacementMovements', coalesce((select jsonb_agg(to_jsonb(m) order by m.id) from public.ledger_movements m where m.transaction_id = v_rebook_id), '[]'::jsonb),
      'replacementPayable', (select to_jsonb(p) from public.ledger_payables p where p.id = v_new_payable_id),
      'candidate', (select to_jsonb(c) from public.ledger_candidates c where c.id = v_candidate.id)
    ), btrim(p_reason)
  );

  return jsonb_build_object(
    'status', 'rebooked', 'originalTransactionId', v_original.id,
    'reversalTransactionId', v_reversal_id,
    'transactionId', v_rebook_id, 'payableId', v_new_payable_id,
    'operationId', v_operation
  );
end;
$$;


revoke all on all functions in schema inventory_ledger_private from public, anon, authenticated, service_role;

alter table public.inventory_logs
  add column purchase_supplier_partner_id bigint references public.business_partners(id),
  add column source_actor_user_id bigint references public.users(id);

create table public.ledger_inventory_projection_status (
  inventory_log_id bigint primary key references public.inventory_logs(id) on delete cascade,
  status text not null check (status in ('synced','pending','review_required','failed')),
  code text not null,
  source_fingerprint text,
  request_actor_user_id bigint references public.users(id),
  updated_at timestamptz not null default now()
);
alter table public.ledger_inventory_projection_status enable row level security;
revoke all on public.ledger_inventory_projection_status from public, anon, authenticated, service_role;
grant select on public.ledger_inventory_projection_status to service_role;
create index ledger_candidates_inventory_source_idx on public.ledger_candidates(source_key,id desc)
  where source_type = 'inventory_purchase_log';
create index inventory_logs_purchase_supplier_partner_idx on public.inventory_logs(purchase_supplier_partner_id)
  where purchase_supplier_partner_id is not null;
create index inventory_logs_source_actor_idx on public.inventory_logs(source_actor_user_id)
  where source_actor_user_id is not null;
create index ledger_inventory_projection_actor_idx on public.ledger_inventory_projection_status(request_actor_user_id);

-- Explicit economic comparison also handles legacy snapshots without the new display keys.
create function inventory_ledger_private.economics(p_snapshot jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, public as $$
  select p_snapshot - array['item_name','item_name_vi','category','category_vi','unit']::text[];
$$;
revoke all on function inventory_ledger_private.economics(jsonb) from public, anon, authenticated, service_role;

-- One transaction must reserve its complete Source set before taking any month
-- or Ledger row lock. Monthly/v2 calls materialize that set once, then reuse it.
-- Only affected Sources are locked; there is no global or month-batch mutex.
create function inventory_ledger_private.lock_sources(p_keys text[], p_extra_months date[] default '{}')
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_key text; v_month date; v_id bigint; v_keys text[]; v_log_ids bigint[];
begin
  select coalesce(array_agg(k order by k collate "C"),'{}') into v_keys
    from (select distinct unnest(p_keys) k) s where k is not null;
  foreach v_key in array v_keys loop
    perform pg_advisory_xact_lock(hashtext('ledger_inventory_candidate:' || v_key));
  end loop;
  -- Legacy core accepts syntactically valid keys even without a bigint Source.
  -- Such keys still get their advisory lock, but cannot identify an Inventory row.
  select coalesce(array_agg(case when length(substring(k from 15)) <= 19
    and substring(k from 15)::numeric <= 9223372036854775807
    then substring(k from 15)::bigint end),'{}') into v_log_ids
    from unnest(v_keys) k where k ~ '^inventory-log:[0-9]+$';
  -- Stabilize purchase dates before discovering all affected months.
  perform 1 from public.inventory_logs
    where id = any(v_log_ids) order by id for update;
  for v_month in
    select distinct date_trunc('month',d)::date from (
      select unnest(p_extra_months) d
      union all select business_date from public.inventory_logs where id=any(v_log_ids)
      union all select business_date from public.ledger_candidates where source_type='inventory_purchase_log' and source_key=any(v_keys)
      union all select proposed_recognition_month from public.ledger_candidates where source_type='inventory_purchase_log' and source_key=any(v_keys)
      union all select t.business_date from public.ledger_transactions t join public.ledger_candidates c on c.resolved_transaction_id=t.id where c.source_type='inventory_purchase_log' and c.source_key=any(v_keys)
      union all select t.recognition_month from public.ledger_transactions t join public.ledger_candidates c on c.resolved_transaction_id=t.id where c.source_type='inventory_purchase_log' and c.source_key=any(v_keys)
    ) months where d is not null order by 1
  loop
    perform pg_advisory_xact_lock(hashtext('ledger_month_close:' || to_char(v_month,'YYYY-MM')));
  end loop;
  for v_id in select distinct resolved_transaction_id from public.ledger_candidates
    where source_type='inventory_purchase_log' and source_key=any(v_keys)
      and resolved_transaction_id is not null order by 1
  loop
    perform pg_advisory_xact_lock(hashtext('ledger_inventory_rebook:' || v_id));
  end loop;
  perform 1 from public.ledger_transactions where id in
    (select resolved_transaction_id from public.ledger_candidates where source_type='inventory_purchase_log' and source_key=any(v_keys))
    order by id for update;
  perform 1 from public.ledger_candidates where source_type='inventory_purchase_log'
    and source_key=any(v_keys) order by id for update;
end;
$$;
alter function inventory_ledger_private.lock_sources(text[],date[]) owner to postgres;
revoke all on function inventory_ledger_private.lock_sources(text[],date[]) from public,anon,authenticated,service_role;

create function public.ledger_project_inventory_purchase_log_v1(
  p_inventory_log_id bigint,
  p_request_actor_user_id bigint
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_log public.inventory_logs%rowtype;
  v_candidate public.ledger_candidates%rowtype;
  v_tx public.ledger_transactions%rowtype;
  v_payable public.ledger_payables%rowtype;
  v_partner public.business_partners%rowtype;
  v_snapshot jsonb;
  v_fingerprint text;
  v_amount numeric;
  v_party_id bigint;
  v_account_id bigint;
  v_mode text;
  v_due_date date;
  v_result jsonb;
  v_status text := 'synced';
  v_code text := 'UNCHANGED';
  v_key text := 'inventory-log:' || p_inventory_log_id;
  v_previous public.ledger_inventory_projection_status%rowtype;
  v_month date;
begin
  if not exists (select 1 from public.users where id = p_request_actor_user_id
    and is_active = true and app_login_enabled = true) then
    return jsonb_build_object('status','failed','code','FORBIDDEN');
  end if;
  perform inventory_ledger_private.lock_sources(array[v_key]);
  select * into v_log from public.inventory_logs where id = p_inventory_log_id for update;
  if v_log.id is null then return jsonb_build_object('status','failed','code','SOURCE_NOT_FOUND'); end if;
  select * into v_previous from public.ledger_inventory_projection_status where inventory_log_id = p_inventory_log_id;

  -- Everything Ledger does is a subtransaction. On error only projection effects roll back.
  begin
    select * into v_candidate from public.ledger_candidates
      where source_type = 'inventory_purchase_log' and source_key = v_key
      order by id desc limit 1 for update;
    -- Share the month-close lock used by closing/rebook; lock multiple months in date order.
    for v_month in
      select date_trunc('month',v_log.business_date)::date
      union select v_candidate.proposed_recognition_month
      union select date_trunc('month',business_date)::date from public.ledger_transactions where id = v_candidate.resolved_transaction_id
      union select recognition_month from public.ledger_transactions where id = v_candidate.resolved_transaction_id
      order by 1
    loop
      if v_month is not null then
        perform pg_advisory_xact_lock(hashtext('ledger_month_close:' || to_char(v_month,'YYYY-MM')));
      end if;
    end loop;
    v_amount := round(v_log.change_quantity::numeric * v_log.new_purchase_price::numeric, 3);
    if coalesce(v_log.reason,'') <> 'purchase' or coalesce(v_log.change_quantity,0) <= 0
       or v_log.business_date is null or v_amount is null or v_amount <= 0 then
      if v_candidate.id is not null then
        v_status := 'review_required'; v_code := 'SOURCE_NO_LONGER_PURCHASE';
      else
        v_code := 'NOT_A_PURCHASE';
      end if;
    else
      -- Same economic fields and numeric semantics as the legacy JS source loader.
      -- New display fields may change the hash, never the economic comparison.
      v_snapshot := jsonb_build_object(
        'inventory_log_id',v_log.id,'item_id',v_log.item_id,
        'item_name',coalesce(nullif(v_log.item_name,''),nullif(v_log.item_name_vi,''),'-'),
        'item_name_vi',v_log.item_name_vi,'category',v_log.category,'category_vi',v_log.category_vi,
        'unit',v_log.unit,'change_quantity',v_log.change_quantity::numeric,
        'purchase_price',v_log.new_purchase_price::numeric,'purchase_amount',v_amount,
        'supplier',nullif(btrim(v_log.new_supplier),''),'business_date',v_log.business_date,
        'inventory_log_created_at',to_char(v_log.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00',
        'source',v_log.source,'reason',v_log.reason);
      if v_log.purchase_supplier_partner_id is not null then
        v_snapshot := v_snapshot || jsonb_build_object('purchase_supplier_partner_id',v_log.purchase_supplier_partner_id);
      end if;
      -- PostgREST timestamp formatting varied historically. Preserve the immutable original
      -- timestamp representation so a serializer migration cannot cause economic drift.
      if v_candidate.id is not null then
        v_snapshot := jsonb_set(v_snapshot,'{inventory_log_created_at}',coalesce(v_candidate.source_snapshot->'inventory_log_created_at','null'::jsonb));
      end if;
      v_fingerprint := encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex');

      if v_candidate.status = 'confirmed' then
        select * into v_tx from public.ledger_transactions where id = v_candidate.resolved_transaction_id for update;
        if inventory_ledger_private.economics(v_candidate.source_snapshot) = inventory_ledger_private.economics(v_snapshot) then
          -- Preserve the original transaction AND source fingerprint, including manual amount edits.
          if v_candidate.source_drift_snapshot is distinct from v_snapshot then
            update public.ledger_candidates set source_drift_snapshot = v_snapshot,
              source_drift_fingerprint = v_fingerprint, source_drift_detected_at = now(), updated_at = now()
              where id = v_candidate.id;
            v_code := 'METADATA_SYNCED';
          end if;
        else
          -- Never silently undo an owner's manual economic edit.
          if v_tx.amount is distinct from v_candidate.proposed_amount then
            v_status := 'review_required'; v_code := 'MANUAL_LEDGER_OVERRIDE';
          elsif public.ledger_month_is_closed_v1(date_trunc('month',v_tx.business_date)::date)
             or public.ledger_month_is_closed_v1(v_tx.recognition_month)
             or public.ledger_month_is_closed_v1(date_trunc('month',v_log.business_date)::date) then
            v_status := 'review_required'; v_code := 'MONTH_CLOSED';
          else
            -- Keep the established payment/account/category unless the purchase supplier changed.
            select * into v_payable from public.ledger_payables where expense_transaction_id = v_tx.id for update;
            v_party_id := v_tx.party_id;
            v_mode := case when v_payable.id is null then 'immediate' else 'payable' end;
            v_due_date := v_payable.due_date;
            select fund_account_id into v_account_id from public.ledger_movements where transaction_id = v_tx.id and amount < 0;
            if v_candidate.source_snapshot->>'supplier' is distinct from v_snapshot->>'supplier'
               or v_candidate.source_snapshot->'purchase_supplier_partner_id' is distinct from v_snapshot->'purchase_supplier_partner_id' then
              select bp.* into v_partner from public.business_partners bp
                where bp.is_active = true and (
                  (v_log.purchase_supplier_partner_id is not null and bp.id = v_log.purchase_supplier_partner_id)
                  or (v_log.purchase_supplier_partner_id is null and lower(btrim(bp.name)) = lower(btrim(v_log.new_supplier)))
                  or (v_log.purchase_supplier_partner_id is null and exists (select 1 from public.business_partner_supplier_aliases a
                    where a.business_partner_id = bp.id and a.status = 'linked' and a.normalized_name = lower(btrim(v_log.new_supplier)))))
                order by bp.id limit 1;
              select ledger_party_id into v_party_id from public.business_partner_ledger_parties where business_partner_id = v_partner.id;
              if v_party_id is null or v_partner.payment_mode not in ('immediate','postpaid') then
                v_status := 'review_required'; v_code := 'SUPPLIER_PAYMENT_MAPPING_REQUIRED';
              else
                v_mode := case when v_partner.payment_mode = 'postpaid' then 'payable' else 'immediate' end;
                v_account_id := v_partner.default_fund_account_id;
                v_due_date := v_log.business_date + v_partner.default_payment_term_days;
              end if;
            end if;
            if v_status = 'synced' then
              v_result := inventory_ledger_private.rebook_source(v_tx.id,v_mode,v_tx.category_id,v_account_id,
                v_due_date,v_amount,v_tx.memo,'Inventory source correction',p_request_actor_user_id,
                v_snapshot,v_fingerprint,v_party_id,v_log.business_date);
              if v_result->>'status' <> 'rebooked' then
                v_status := 'review_required'; v_code := upper(v_result->>'status');
              else
                v_code := 'REBOOKED';
              end if;
            end if;
          end if;
          if v_status = 'review_required' then
            update public.ledger_candidates set source_drift_snapshot = v_snapshot,
              source_drift_fingerprint = v_fingerprint, source_drift_detected_at = now(), updated_at = now()
              where id = v_candidate.id;
          end if;
        end if;
      elsif public.ledger_month_is_closed_v1(date_trunc('month',v_log.business_date)::date)
         or (v_candidate.id is not null and public.ledger_month_is_closed_v1(v_candidate.proposed_recognition_month)) then
        v_status := 'review_required'; v_code := 'MONTH_CLOSED';
      else
        v_result := inventory_ledger_private.sync_candidate(jsonb_build_array(jsonb_build_object(
          'sourceKey',v_key,'businessDate',v_log.business_date,'amount',v_amount,
          'snapshot',v_snapshot,'fingerprint',v_fingerprint)),p_request_actor_user_id);
        if v_result->>'status' <> 'ok' then raise exception 'PROJECTION_CONTRACT_FAILED'; end if;
        select * into v_candidate from public.ledger_candidates
          where source_type = 'inventory_purchase_log' and source_key = v_key order by id desc limit 1;
        if v_candidate.status = 'pending' then v_status := 'pending'; v_code := 'RESOLUTION_REQUIRED';
        elsif v_candidate.status = 'dismissed' then v_status := 'review_required'; v_code := 'DISMISSED_SOURCE';
        else v_code := 'PROJECTED'; end if;
      end if;
    end if;
  exception when others then
    v_status := 'failed'; v_code := SQLSTATE;
    -- Deliberately omit raw exception text/source data from application logs.
  end;

  insert into public.ledger_inventory_projection_status(inventory_log_id,status,code,source_fingerprint,request_actor_user_id)
    values(p_inventory_log_id,v_status,v_code,v_fingerprint,p_request_actor_user_id)
    on conflict (inventory_log_id) do update set status = excluded.status, code = excluded.code,
      source_fingerprint = excluded.source_fingerprint, request_actor_user_id = excluded.request_actor_user_id, updated_at = now();
  if v_previous.inventory_log_id is null or v_previous.status is distinct from v_status
     or v_previous.code is distinct from v_code or v_previous.source_fingerprint is distinct from v_fingerprint then
    insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
      values(p_request_actor_user_id,'inventory_source_projected','inventory_log',p_inventory_log_id,
        jsonb_build_object('projection',to_jsonb(v_previous),'candidate',to_jsonb(v_candidate)),
        jsonb_build_object('execution','automatic_inventory_projection','sourceActorUserId',v_log.source_actor_user_id,
          'sourceActorUsername',v_log.actor_username,'requestActorUserId',p_request_actor_user_id,
          'sourceKey',v_key,'sourceFingerprint',v_fingerprint,'sourceSnapshot',v_snapshot,'status',v_status,'code',v_code),
        'Trusted committed Inventory source projection');
  end if;
  return jsonb_build_object('status',v_status,'code',v_code,'inventoryLogId',p_inventory_log_id,
    'candidateId',v_candidate.id,
    'transactionId',case when v_status = 'synced' and v_result->>'status' = 'rebooked'
      then (v_result->>'transactionId')::bigint else v_candidate.resolved_transaction_id end,
    'createdCount',coalesce((v_result->>'createdCount')::integer,0),
    'supersededCount',coalesce((v_result->>'supersededCount')::integer,0),
    'unchangedCount',coalesce((v_result->>'unchangedCount')::integer,case when v_code = 'UNCHANGED' then 1 else 0 end),
    'autoConfirmedImmediateCount',coalesce((v_result->>'autoConfirmedImmediateCount')::integer,0),
    'autoConfirmedPayableCount',coalesce((v_result->>'autoConfirmedPayableCount')::integer,0));
end;
$$;

-- Recovery uses the identical source-only entry point, including logs moved out of this month.
create function public.ledger_reconcile_inventory_month_v1(p_month date,p_request_actor_user_id bigint)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_id bigint; v_ids bigint[]; v_result jsonb; v_issues jsonb := '[]'::jsonb;
  v_scanned integer := 0; v_created integer := 0; v_superseded integer := 0; v_unchanged integer := 0;
  v_immediate integer := 0; v_payable integer := 0; v_pending integer := 0; v_review integer := 0;
  v_failed integer := 0; v_metadata integer := 0; v_rebooked integer := 0;
begin
  if not exists(select 1 from public.users where id = p_request_actor_user_id and is_active = true
    and app_login_enabled = true and lower(role::text) in ('owner','master')) then
    return jsonb_build_object('status','forbidden');
  end if;
  if p_month is null or p_month <> date_trunc('month',p_month)::date then
    return jsonb_build_object('status','invalid_month');
  end if;
  select coalesce(array_agg(id order by id),'{}') into v_ids from (
    select id from public.inventory_logs where business_date >= p_month
      and business_date < (p_month + interval '1 month')::date and reason = 'purchase'
    union
    select substring(source_key from 15)::bigint from public.ledger_candidates
      where source_type = 'inventory_purchase_log' and source_key ~ '^inventory-log:[0-9]+$'
      and business_date >= p_month and business_date < (p_month + interval '1 month')::date
  ) sources;
  perform inventory_ledger_private.lock_sources(array(select 'inventory-log:' || id from unnest(v_ids) id));
  foreach v_id in array v_ids
  loop
    v_result := public.ledger_project_inventory_purchase_log_v1(v_id,p_request_actor_user_id);
    v_scanned := v_scanned + 1;
    v_created := v_created + coalesce((v_result->>'createdCount')::integer,0);
    v_superseded := v_superseded + coalesce((v_result->>'supersededCount')::integer,0);
    v_unchanged := v_unchanged + coalesce((v_result->>'unchangedCount')::integer,0);
    v_immediate := v_immediate + coalesce((v_result->>'autoConfirmedImmediateCount')::integer,0);
    v_payable := v_payable + coalesce((v_result->>'autoConfirmedPayableCount')::integer,0);
    if v_result->>'status' = 'pending' then v_pending := v_pending + 1; end if;
    if v_result->>'status' = 'review_required' then v_review := v_review + 1; end if;
    if v_result->>'status' = 'failed' then v_failed := v_failed + 1; end if;
    if v_result->>'code' = 'METADATA_SYNCED' then v_metadata := v_metadata + 1; end if;
    if v_result->>'code' = 'REBOOKED' then v_rebooked := v_rebooked + 1; end if;
    if v_result->>'status' <> 'synced' then v_issues := v_issues || jsonb_build_array(v_result); end if;
  end loop;
  return jsonb_build_object('status','ok','scannedLogs',v_scanned,'createdCount',v_created,
    'supersededCount',v_superseded,'unchangedCount',v_unchanged,'ignoredCount',0,
    'autoConfirmedImmediateCount',v_immediate,'autoConfirmedPayableCount',v_payable,
    'pendingReviewCount',v_pending,'reviewRequiredCount',v_review,'failedCount',v_failed,
    'metadataDriftCount',v_metadata,'rebookedCount',v_rebooked,'issues',v_issues);
end;
$$;
alter function public.ledger_reconcile_inventory_month_v1(date,bigint) owner to postgres;
revoke all on function public.ledger_reconcile_inventory_month_v1(date,bigint) from public, anon, authenticated, service_role;
grant execute on function public.ledger_reconcile_inventory_month_v1(date,bigint) to service_role;

alter function inventory_ledger_private.resolve_candidate(bigint,text,bigint,bigint,bigint,date,text,text,bigint) owner to postgres;
alter function inventory_ledger_private.sync_candidate(jsonb,bigint) owner to postgres;
alter function inventory_ledger_private.rebook_source(bigint,text,bigint,bigint,date,numeric,text,text,bigint,jsonb,text,bigint,date) owner to postgres;
alter function inventory_ledger_private.economics(jsonb) owner to postgres;

-- Keep v1 -> v2, the existing signature, role checks and result counters. Old callers
-- may send legacy fingerprints; neither their snapshots nor amounts are trusted writes.
create or replace function public.ledger_sync_inventory_candidates_v2(p_rows jsonb,p_actor_user_id bigint)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_row jsonb; v_result jsonb; v_id bigint; v_seen bigint[] := '{}';
  v_scanned integer := 0; v_created integer := 0; v_superseded integer := 0; v_unchanged integer := 0;
  v_immediate integer := 0; v_payable integer := 0; v_pending integer := 0; v_review integer := 0;
  v_failed integer := 0; v_metadata integer := 0; v_rebooked integer := 0; v_issues jsonb := '[]'::jsonb;
begin
  if not exists(select 1 from public.users where id = p_actor_user_id and is_active = true
    and app_login_enabled = true and lower(role::text) in ('owner','master')) then
    return jsonb_build_object('status','forbidden');
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception using errcode = '22023',message = 'INVALID_ROWS';
  end if;
  -- Validate every identifier before any write, preserving the legacy atomic input contract.
  for v_row in select value from jsonb_array_elements(p_rows) loop
    if coalesce(v_row->>'sourceKey','') !~ '^inventory-log:[0-9]+$'
      or coalesce(length(v_row->>'fingerprint'),0) <> 64
      or jsonb_typeof(v_row->'snapshot') is distinct from 'object'
      or v_row->>'businessDate' is null or v_row->>'amount' is null then
      raise exception using errcode = '22023',message = 'INVALID_ROWS';
    end if;
    begin
      v_id := substring(v_row->>'sourceKey' from 15)::bigint;
      if (v_row->>'amount')::numeric <= 0 or v_id <= 0 then raise exception 'invalid'; end if;
      perform (v_row->>'businessDate')::date;
    exception when others then raise exception using errcode = '22023',message = 'INVALID_ROWS';
    end;
    if not v_id = any(v_seen) then v_seen := array_append(v_seen,v_id); end if;
  end loop;
  perform inventory_ledger_private.lock_sources(array(select 'inventory-log:' || id from unnest(v_seen) id));
  for v_id in select unnest(v_seen) order by 1 loop
    v_result := public.ledger_project_inventory_purchase_log_v1(v_id,p_actor_user_id);
    v_scanned := v_scanned + 1;
    v_created := v_created + coalesce((v_result->>'createdCount')::integer,0);
    v_superseded := v_superseded + coalesce((v_result->>'supersededCount')::integer,0);
    v_unchanged := v_unchanged + coalesce((v_result->>'unchangedCount')::integer,0);
    v_immediate := v_immediate + coalesce((v_result->>'autoConfirmedImmediateCount')::integer,0);
    v_payable := v_payable + coalesce((v_result->>'autoConfirmedPayableCount')::integer,0);
    if v_result->>'status' = 'pending' then v_pending := v_pending + 1; end if;
    if v_result->>'status' = 'review_required' then v_review := v_review + 1; end if;
    if v_result->>'status' = 'failed' then v_failed := v_failed + 1; end if;
    if v_result->>'code' = 'METADATA_SYNCED' then v_metadata := v_metadata + 1; end if;
    if v_result->>'code' = 'REBOOKED' then v_rebooked := v_rebooked + 1; end if;
    if v_result->>'status' <> 'synced' then v_issues := v_issues || jsonb_build_array(v_result); end if;
  end loop;
  return jsonb_build_object('status','ok','scannedLogs',v_scanned,'createdCount',v_created,
    'supersededCount',v_superseded,'unchangedCount',v_unchanged,'autoConfirmedImmediateCount',v_immediate,
    'autoConfirmedPayableCount',v_payable,'pendingReviewCount',v_pending,'reviewRequiredCount',v_review,
    'failedCount',v_failed,'metadataDriftCount',v_metadata,'metadataDriftUnchangedCount',v_unchanged,
    'forwardedCount',v_scanned,'rebookedCount',v_rebooked,'issues',v_issues);
end;
$$;
alter function public.ledger_sync_inventory_candidates_v2(jsonb,bigint) owner to postgres;
revoke all on function public.ledger_sync_inventory_candidates_v2(jsonb,bigint) from public, anon, authenticated, service_role;
grant execute on function public.ledger_sync_inventory_candidates_v2(jsonb,bigint) to postgres, service_role;
alter function public.ledger_project_inventory_purchase_log_v1(bigint,bigint) owner to postgres;
revoke all on function public.ledger_project_inventory_purchase_log_v1(bigint,bigint) from public, anon, authenticated, service_role;
grant execute on function public.ledger_project_inventory_purchase_log_v1(bigint,bigint) to service_role;

-- Lock-only preambles preserve the deployed management bodies, identity and ACL.
-- Unexpected definitions abort the entire migration instead of being overwritten.
do $locking_contract$
declare v_oid regprocedure; v_definition text; v_anchor text; v_preamble text;
begin
  v_oid := 'public.ledger_rebook_inventory_transaction_v1(bigint,text,bigint,bigint,date,numeric,text,text,bigint)'::regprocedure;
  v_definition := pg_get_functiondef(v_oid);
  v_anchor := '  perform pg_advisory_xact_lock(hashtext(''ledger_inventory_rebook:'' || p_original_transaction_id::text));';
  v_preamble := $patch$  perform inventory_ledger_private.lock_sources(array(
    select source_key from public.ledger_candidates where source_type='inventory_purchase_log'
      and (resolved_transaction_id=p_original_transaction_id or source_key=(
        select 'inventory-log:' || (source_snapshot->>'inventory_log_id')
        from public.ledger_transactions where id=p_original_transaction_id))));
$patch$;
  if position(v_anchor in v_definition)=0 then raise exception 'INVENTORY_LOCK_CONTRACT_REBOOK_MISMATCH'; end if;
  execute replace(v_definition,v_anchor,v_preamble || v_anchor);

  v_oid := 'public.ledger_resolve_inventory_candidate_v1(bigint,text,bigint,bigint,bigint,date,text,text,bigint)'::regprocedure;
  v_definition := pg_get_functiondef(v_oid);
  v_anchor := ' select * into v_candidate from public.ledger_candidates where id=p_candidate_id for update;';
  v_preamble := $patch$ perform inventory_ledger_private.lock_sources(array(
    select source_key from public.ledger_candidates where id=p_candidate_id and source_type='inventory_purchase_log'));
$patch$;
  if position(v_anchor in v_definition)=0 then raise exception 'INVENTORY_LOCK_CONTRACT_RESOLVE_MISMATCH'; end if;
  execute replace(v_definition,v_anchor,v_preamble || v_anchor);

  v_oid := 'public.ledger_sync_inventory_candidates_core_v1(jsonb,bigint)'::regprocedure;
  v_definition := pg_get_functiondef(v_oid);
  v_anchor := '  for v_item in select value from jsonb_array_elements(p_rows) loop';
  v_preamble := $patch$  begin
    perform inventory_ledger_private.lock_sources(
      array(select value->>'sourceKey' from jsonb_array_elements(p_rows)),
      array(select (value->>'businessDate')::date from jsonb_array_elements(p_rows)));
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception using errcode='22023',message='INVALID_ROWS';
  end;
$patch$;
  if position(v_anchor in v_definition)=0 then raise exception 'INVENTORY_LOCK_CONTRACT_CORE_MISMATCH'; end if;
  execute replace(v_definition,v_anchor,v_preamble || v_anchor);
end;
$locking_contract$;

-- Display-only overlays in closed months must not produce economic drift candidates.
-- Inventory projection persists its own review status with the real requesting actor.
create or replace function public.ledger_confirmed_candidate_drift_v1() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_tx public.ledger_transactions%rowtype; v_amount numeric;
begin
  if new.source_type = 'inventory_purchase_log' then return new; end if;
  if new.status = 'confirmed' and new.resolved_transaction_id is not null
     and new.source_drift_fingerprint is distinct from old.source_drift_fingerprint
     and new.source_drift_fingerprint is not null then
    select * into v_tx from public.ledger_transactions where id = new.resolved_transaction_id;
    if v_tx.id is not null and public.ledger_month_is_closed_v1(coalesce(v_tx.recognition_month,date_trunc('month',v_tx.business_date)::date)) then
      v_amount := coalesce((new.source_drift_snapshot->>'purchase_amount')::numeric,
        (new.source_drift_snapshot->>'total_amount')::numeric,(new.source_drift_snapshot->>'actual_paid_amount')::numeric,v_tx.amount);
      perform public.ledger_record_source_drift_v1(v_tx.id,new.source_drift_fingerprint,v_amount,new.source_drift_snapshot,coalesce(new.resolved_by,v_tx.confirmed_by));
    end if;
  end if;
  return new;
end;
$$;
