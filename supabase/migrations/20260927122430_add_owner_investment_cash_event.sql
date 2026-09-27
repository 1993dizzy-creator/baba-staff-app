-- Atomic owner-capital cash events for the manual ledger entry sheet.
-- Existing historical adjustments remain valid even when they have no linked transaction.
alter table public.ledger_owner_investments
  drop constraint ledger_owner_investments_check;

alter table public.ledger_owner_investments
  add constraint ledger_owner_investments_entry_transaction_check check (
    (entry_type = 'contribution' and signed_amount > 0 and transaction_id is not null)
    or (entry_type = 'opening' and transaction_id is null)
    or entry_type = 'adjustment'
  );

create or replace function public.ledger_create_owner_investment_cash_event_v1(
  p_participant_id bigint,
  p_action text,
  p_amount numeric,
  p_occurred_at timestamptz,
  p_fund_account_id bigint,
  p_reason text,
  p_memo text,
  p_actor_user_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_user bigint;
  v_effective_from date;
  v_effective_to date;
  v_is_eligible boolean;
  v_current numeric;
  v_recovery_allocated numeric;
  v_new_investment numeric;
  v_account_balance numeric;
  v_signed_amount numeric;
  v_entry_type text;
  v_transaction_type text;
  v_source_type text;
  v_date date;
  v_transaction_id bigint;
  v_investment_id bigint;
  v_operation uuid := pg_catalog.gen_random_uuid();
begin
  if not public.ledger_owner_role_v1(p_actor_user_id) then
    return pg_catalog.jsonb_build_object('status', 'forbidden');
  end if;
  if p_action not in ('contribution', 'recovery')
     or p_amount is null or p_amount <= 0 or pg_catalog.scale(p_amount) > 3
     or p_occurred_at is null or p_fund_account_id is null
     or nullif(pg_catalog.btrim(p_reason), '') is null then
    return pg_catalog.jsonb_build_object('status', 'invalid_input');
  end if;

  v_date := ((p_occurred_at at time zone 'Asia/Ho_Chi_Minh') - interval '3 hours')::date;
  select p.user_id, p.effective_from, p.effective_to, p.is_eligible
    into v_owner_user, v_effective_from, v_effective_to, v_is_eligible
  from public.ledger_owner_participants p
  where p.id = p_participant_id;
  if v_owner_user is null then
    return pg_catalog.jsonb_build_object('status', 'participant_not_found');
  end if;
  if not v_is_eligible
     or v_effective_from > pg_catalog.date_trunc('month', v_date)::date
     or (v_effective_to is not null and v_effective_to < v_date) then
    return pg_catalog.jsonb_build_object('status', 'participant_not_effective');
  end if;
  if public.ledger_month_is_closed_v1(pg_catalog.date_trunc('month', v_date)::date) then
    return pg_catalog.jsonb_build_object('status', 'closed_month');
  end if;
  if not exists (
    select 1 from public.ledger_fund_accounts a
    where a.id = p_fund_account_id and a.is_active and a.is_business_fund
      and a.type in ('cash', 'bank', 'personal_custody')
  ) then
    return pg_catalog.jsonb_build_object('status', 'invalid_fund_account');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('ledger_owner_capital_recovery'));
  perform 1 from public.ledger_owner_participants p
  where p.user_id = v_owner_user order by p.id for update;
  perform 1 from public.ledger_fund_accounts a where a.id = p_fund_account_id for update;

  select coalesce(pg_catalog.sum(i.signed_amount), 0) into v_current
  from public.ledger_owner_investments i
  join public.ledger_owner_participants p on p.id = i.participant_id
  where p.user_id = v_owner_user;
  select coalesce(pg_catalog.sum(a.recovery_amount), 0) into v_recovery_allocated
  from public.ledger_owner_settlement_allocations a
  join public.ledger_owner_settlements s on s.id = a.settlement_id
  join public.ledger_owner_participants p on p.id = a.participant_id
  where p.user_id = v_owner_user
    and s.status in ('confirmed', 'partially_paid', 'paid');

  v_signed_amount := case when p_action = 'contribution' then p_amount else -p_amount end;
  v_new_investment := v_current + v_signed_amount;
  if v_new_investment < 0 then
    return pg_catalog.jsonb_build_object('status', 'negative_cumulative_investment');
  end if;
  if v_new_investment < v_recovery_allocated then
    return pg_catalog.jsonb_build_object('status', 'investment_below_recovery_obligation');
  end if;

  if p_action = 'recovery' then
    select coalesce(pg_catalog.sum(m.amount), 0) into v_account_balance
    from public.ledger_movements m
    join public.ledger_transactions t on t.id = m.transaction_id
    where m.fund_account_id = p_fund_account_id
      and t.status = 'confirmed'
      and t.occurred_at <= p_occurred_at;
    if v_account_balance < p_amount then
      return pg_catalog.jsonb_build_object(
        'status', 'insufficient_fund', 'balance', v_account_balance
      );
    end if;
  end if;

  perform public.ledger_assert_month_open_v1(pg_catalog.date_trunc('month', v_date)::date);
  v_entry_type := case when p_action = 'contribution' then 'contribution' else 'adjustment' end;
  v_transaction_type := case when p_action = 'contribution' then 'investment' else 'owner_settlement_payment' end;
  v_source_type := case when p_action = 'contribution' then 'owner_investment' else 'owner_investment_recovery' end;

  insert into public.ledger_transactions(
    operation_id, type, occurred_at, business_date, amount, status,
    source_type, source_snapshot, source_fingerprint, source_synced_at,
    memo, created_by, confirmed_by
  ) values (
    v_operation, v_transaction_type, p_occurred_at, v_date, p_amount, 'confirmed',
    v_source_type,
    pg_catalog.jsonb_build_object(
      'participantId', p_participant_id, 'entryType', v_entry_type,
      'action', p_action, 'fundAccountId', p_fund_account_id
    ),
    pg_catalog.md5(v_operation::text), pg_catalog.now(),
    coalesce(nullif(pg_catalog.btrim(p_memo), ''), pg_catalog.btrim(p_reason)),
    p_actor_user_id, p_actor_user_id
  ) returning id into v_transaction_id;

  insert into public.ledger_movements(transaction_id, fund_account_id, amount)
  values (
    v_transaction_id, p_fund_account_id,
    case when p_action = 'contribution' then p_amount else -p_amount end
  );

  insert into public.ledger_owner_investments(
    participant_id, entry_type, signed_amount, occurred_at, transaction_id,
    reason, source_snapshot, created_by
  ) values (
    p_participant_id, v_entry_type, v_signed_amount, p_occurred_at, v_transaction_id,
    pg_catalog.btrim(p_reason),
    pg_catalog.jsonb_build_object(
      'cumulativeBefore', v_current, 'cumulativeAfter', v_new_investment,
      'recoveryAllocated', v_recovery_allocated, 'fundAccountId', p_fund_account_id,
      'action', p_action
    ),
    p_actor_user_id
  ) returning id into v_investment_id;

  update public.ledger_transactions
  set source_snapshot = source_snapshot || pg_catalog.jsonb_build_object('investmentId', v_investment_id)
  where id = v_transaction_id;

  insert into public.ledger_audit_logs(
    actor_user_id, action, entity_type, entity_id,
    before_snapshot, after_snapshot, reason
  ) values (
    p_actor_user_id, 'owner_investment_cash_event_created', 'owner_investment', v_investment_id,
    pg_catalog.jsonb_build_object(
      'cumulativeInvestment', v_current, 'recoveryAllocated', v_recovery_allocated
    ),
    pg_catalog.jsonb_build_object(
      'action', p_action, 'entryType', v_entry_type, 'amount', v_signed_amount,
      'cumulativeInvestment', v_new_investment, 'transactionId', v_transaction_id,
      'fundAccountId', p_fund_account_id
    ),
    pg_catalog.btrim(p_reason)
  );

  return pg_catalog.jsonb_build_object(
    'status', 'created', 'action', p_action,
    'investmentId', v_investment_id, 'transactionId', v_transaction_id
  );
end
$$;

alter function public.ledger_create_owner_investment_cash_event_v1(
  bigint, text, numeric, timestamptz, bigint, text, text, bigint
) owner to postgres;

revoke all on function public.ledger_create_owner_investment_cash_event_v1(
  bigint, text, numeric, timestamptz, bigint, text, text, bigint
) from public, anon, authenticated;

grant execute on function public.ledger_create_owner_investment_cash_event_v1(
  bigint, text, numeric, timestamptz, bigint, text, text, bigint
) to service_role, postgres;

comment on function public.ledger_create_owner_investment_cash_event_v1(
  bigint, text, numeric, timestamptz, bigint, text, text, bigint
) is 'Atomically records an owner contribution or recovery together with its non-P&L fund movement.';
