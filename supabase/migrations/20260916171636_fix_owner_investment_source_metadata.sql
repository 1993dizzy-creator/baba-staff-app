-- Repository copy of the already applied Production owner investment metadata fix.
create or replace function public.ledger_create_owner_investment_v1(
  p_participant_id bigint, p_entry_type text, p_signed_amount numeric,
  p_occurred_at timestamptz, p_fund_account_id bigint, p_reason text,
  p_actor_user_id bigint)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_current numeric;
  v_recovery_allocated numeric;
  v_new_investment numeric;
  v_tx_id bigint;
  v_id bigint;
  v_date date;
  v_operation uuid := gen_random_uuid();
  v_owner_user bigint;
begin
  if not public.ledger_owner_role_v1(p_actor_user_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_entry_type not in ('opening', 'contribution', 'adjustment')
     or p_signed_amount = 0 or scale(p_signed_amount) > 3
     or p_occurred_at is null
     or (p_entry_type = 'adjustment' and nullif(btrim(p_reason), '') is null)
     or (p_entry_type in ('opening', 'contribution') and p_signed_amount < 0) then
    return jsonb_build_object('status', 'invalid_input');
  end if;
  select user_id into v_owner_user
  from public.ledger_owner_participants where id = p_participant_id;
  if v_owner_user is null then
    return jsonb_build_object('status', 'participant_not_found');
  end if;

  -- Serializes principal changes with recovery confirmations before either
  -- the investment basis or the confirmed recovery obligation is read.
  perform pg_advisory_xact_lock(hashtext('ledger_owner_capital_recovery'));
  perform 1 from public.ledger_owner_participants
  where user_id = v_owner_user order by id for update;
  select coalesce(sum(i.signed_amount), 0) into v_current
  from public.ledger_owner_investments i
  join public.ledger_owner_participants p on p.id = i.participant_id
  where p.user_id = v_owner_user;
  select coalesce(sum(a.recovery_amount), 0) into v_recovery_allocated
  from public.ledger_owner_settlement_allocations a
  join public.ledger_owner_settlements s on s.id = a.settlement_id
  join public.ledger_owner_participants p on p.id = a.participant_id
  where p.user_id = v_owner_user
    and s.status in ('confirmed', 'partially_paid', 'paid');

  v_new_investment := v_current + p_signed_amount;
  if v_new_investment < 0 then
    return jsonb_build_object('status', 'negative_cumulative_investment');
  end if;
  if v_new_investment < v_recovery_allocated then
    return jsonb_build_object('status', 'investment_below_recovery_obligation');
  end if;
  v_date := ((p_occurred_at at time zone 'Asia/Ho_Chi_Minh') - interval '3 hours')::date;
  if p_entry_type = 'contribution' then
    if not exists (select 1 from public.ledger_fund_accounts
      where id = p_fund_account_id and is_active and is_business_fund
        and type in ('cash', 'bank', 'personal_custody')) then
      return jsonb_build_object('status', 'invalid_fund_account');
    end if;
    perform public.ledger_assert_month_open_v1(date_trunc('month', v_date)::date);
    insert into public.ledger_transactions(
      operation_id, type, occurred_at, business_date, amount, status,
      source_type, source_snapshot, source_fingerprint, source_synced_at, memo, created_by, confirmed_by)
    values (v_operation, 'investment', p_occurred_at, v_date,
      p_signed_amount, 'confirmed', 'owner_investment',
      jsonb_build_object('participantId', p_participant_id, 'entryType', p_entry_type),
      md5(v_operation::text), now(),
      nullif(btrim(p_reason), ''), p_actor_user_id, p_actor_user_id)
    returning id into v_tx_id;
    insert into public.ledger_movements(transaction_id, fund_account_id, amount)
    values (v_tx_id, p_fund_account_id, p_signed_amount);
  end if;
  insert into public.ledger_owner_investments(
    participant_id, entry_type, signed_amount, occurred_at, transaction_id,
    reason, source_snapshot, created_by)
  values (p_participant_id, p_entry_type, p_signed_amount, p_occurred_at,
    v_tx_id, nullif(btrim(p_reason), ''),
    jsonb_build_object('cumulativeBefore', v_current,
      'cumulativeAfter', v_new_investment, 'fundAccountId', p_fund_account_id),
    p_actor_user_id)
  returning id into v_id;
  insert into public.ledger_audit_logs(
    actor_user_id, action, entity_type, entity_id,
    before_snapshot, after_snapshot, reason)
  values (p_actor_user_id, 'owner_investment_created', 'owner_investment',
    v_id, jsonb_build_object('cumulativeInvestment', v_current,
      'recoveryAllocated', v_recovery_allocated),
    jsonb_build_object('entryType', p_entry_type, 'amount', p_signed_amount,
      'cumulativeInvestment', v_new_investment, 'transactionId', v_tx_id),
    nullif(btrim(p_reason), ''));
  return jsonb_build_object('status', 'created',
    'investmentId', v_id, 'transactionId', v_tx_id);
end$$;
