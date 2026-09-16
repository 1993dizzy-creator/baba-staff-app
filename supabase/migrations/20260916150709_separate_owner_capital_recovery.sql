-- Separate principal recovery from closed-profit distribution.
-- This migration is repository-only until explicitly applied.

alter table public.ledger_owner_settlements
  add column settlement_type text not null default 'profit_distribution',
  add constraint ledger_owner_settlements_type_check
    check (settlement_type in ('capital_recovery', 'profit_distribution'));

alter table public.ledger_owner_settlements
  alter column policy_id drop not null,
  add constraint ledger_owner_settlements_policy_type_check
    check ((settlement_type = 'capital_recovery' and policy_id is null)
        or (settlement_type = 'profit_distribution' and policy_id is not null));

alter table public.ledger_owner_settlements
  drop constraint ledger_owner_settlements_through_month_key;

create unique index ledger_owner_profit_distribution_month_idx
  on public.ledger_owner_settlements (through_month)
  where settlement_type = 'profit_distribution';

create or replace function public.ledger_owner_recovery_capacity_v1()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_liquid numeric := 0;
  v_reserve numeric := 0;
  v_payable numeric := 0;
  v_owner_unpaid numeric := 0;
  v_safe numeric := 0;
  v_invested numeric := 0;
  v_allocated numeric := 0;
  v_paid numeric := 0;
  v_unallocated numeric := 0;
  v_cash_unrecovered numeric := 0;
begin
  select coalesce(sum(m.amount), 0) into v_liquid
  from public.ledger_movements m
  join public.ledger_transactions t on t.id = m.transaction_id
  join public.ledger_fund_accounts f on f.id = m.fund_account_id
  where t.status = 'confirmed' and t.occurred_at <= now()
    and f.is_active and f.is_business_fund
    and f.type in ('cash', 'bank', 'personal_custody');

  select coalesce(sum(case entry_type when 'allocate' then amount
    when 'release' then -amount when 'consume' then -amount else amount end), 0)
  into v_reserve from public.ledger_reserve_entries where occurred_at <= now();

  select coalesce(sum(greatest(0, p.original_amount -
    coalesce((select sum(a.allocated_amount) from public.ledger_payable_allocations a
              where a.payable_id = p.id), 0))), 0)
  into v_payable from public.ledger_payables p where p.status <> 'cancelled';

  select coalesce(sum(a.assigned_amount - a.paid_amount), 0) into v_owner_unpaid
  from public.ledger_owner_settlement_allocations a
  join public.ledger_owner_settlements s on s.id = a.settlement_id
  where s.status in ('confirmed', 'partially_paid');

  with investment as (
    select p.user_id, sum(i.signed_amount) invested
    from public.ledger_owner_investments i
    join public.ledger_owner_participants p on p.id = i.participant_id
    where i.occurred_at <= now()
    group by p.user_id
  ), recovery as (
    select p.user_id, sum(a.recovery_amount) allocated,
      sum(a.recovery_paid_amount) paid
    from public.ledger_owner_settlement_allocations a
    join public.ledger_owner_settlements s on s.id = a.settlement_id
    join public.ledger_owner_participants p on p.id = a.participant_id
    where s.status in ('confirmed', 'partially_paid', 'paid')
    group by p.user_id
  )
  select coalesce(sum(i.invested), 0), coalesce(sum(coalesce(r.allocated, 0)), 0),
    coalesce(sum(coalesce(r.paid, 0)), 0),
    coalesce(sum(greatest(0, i.invested - coalesce(r.allocated, 0))), 0),
    coalesce(sum(greatest(0, i.invested - coalesce(r.paid, 0))), 0)
  into v_invested, v_allocated, v_paid, v_unallocated, v_cash_unrecovered
  from investment i left join recovery r on r.user_id = i.user_id;

  v_safe := greatest(0, v_liquid - v_reserve - v_payable - v_owner_unpaid);
  return jsonb_build_object(
    'status', 'ok', 'liquidFunds', v_liquid, 'activeReserve', v_reserve,
    'vendorPayables', v_payable, 'confirmedUnpaidOwnerSettlements', v_owner_unpaid,
    'safeCashCapacity', v_safe, 'totalInvested', v_invested,
    'totalRecoveryAllocated', v_allocated, 'totalRecoveryPaid', v_paid,
    'totalUnallocatedUnrecoveredInvestment', v_unallocated,
    'totalCashUnrecoveredInvestment', v_cash_unrecovered,
    'recommendedMaxRecovery', greatest(0, least(v_safe, v_unallocated)));
end$$;

create or replace function public.ledger_confirm_owner_recovery_v1(
  p_requested_pool numeric, p_actor_user_id bigint)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_capacity jsonb;
  v_total numeric;
  v_settlement bigint;
  v_month date;
  v_line record;
  v_assigned numeric;
  v_used numeric := 0;
  v_snapshot jsonb := '[]'::jsonb;
begin
  if not public.ledger_owner_role_v1(p_actor_user_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_requested_pool is null or p_requested_pool <= 0
     or scale(p_requested_pool) > 3 then
    return jsonb_build_object('status', 'invalid_pool');
  end if;
  perform pg_advisory_xact_lock(hashtext('ledger_owner_capital_recovery'));
  v_capacity := public.ledger_owner_recovery_capacity_v1();
  v_total := (v_capacity->>'totalUnallocatedUnrecoveredInvestment')::numeric;
  if v_total <= 0 then return jsonb_build_object('status', 'no_unrecovered_investment'); end if;
  if p_requested_pool > (v_capacity->>'recommendedMaxRecovery')::numeric then
    return jsonb_build_object('status', 'requested_above_recommended_max',
      'recommendedMaxRecovery', v_capacity->'recommendedMaxRecovery');
  end if;

  v_month := date_trunc('month',
    ((now() at time zone 'Asia/Ho_Chi_Minh') - interval '3 hours')::date)::date;
  insert into public.ledger_owner_settlements(
    through_month, settlement_type, status, requested_pool, confirmed_pool,
    policy_id, policy_snapshot, undistributed_profit_snapshot,
    liquid_funds_snapshot, reserve_snapshot, payable_snapshot,
    unpaid_owner_settlement_snapshot, safe_cash_capacity_snapshot,
    recommended_max_snapshot, confirmed_by, confirmed_at, created_by)
  values (v_month, 'capital_recovery', 'confirmed', p_requested_pool,
    p_requested_pool, null, '{}'::jsonb, 0,
    (v_capacity->>'liquidFunds')::numeric,
    (v_capacity->>'activeReserve')::numeric,
    (v_capacity->>'vendorPayables')::numeric,
    (v_capacity->>'confirmedUnpaidOwnerSettlements')::numeric,
    (v_capacity->>'safeCashCapacity')::numeric,
    (v_capacity->>'recommendedMaxRecovery')::numeric,
    p_actor_user_id, now(), p_actor_user_id)
  returning id into v_settlement;

  for v_line in
    with investment as (
      select p.user_id, sum(i.signed_amount) invested
      from public.ledger_owner_investments i
      join public.ledger_owner_participants p on p.id = i.participant_id
      where i.occurred_at <= now()
      group by p.user_id
    ), recovery as (
      select p.user_id, sum(a.recovery_amount) allocated
      from public.ledger_owner_settlement_allocations a
      join public.ledger_owner_settlements s on s.id = a.settlement_id
      join public.ledger_owner_participants p on p.id = a.participant_id
      where s.status in ('confirmed', 'partially_paid', 'paid')
        and s.id <> v_settlement
      group by p.user_id
    ), eligible as (
      select i.user_id, i.invested, coalesce(r.allocated, 0) prior_allocated,
        greatest(0, i.invested - coalesce(r.allocated, 0)) remaining
      from investment i left join recovery r on r.user_id = i.user_id
    ), shares as (
      select e.*, p.id participant_id,
        coalesce(u.name, u.full_name, u.username) owner_name,
        p_requested_pool * e.remaining / v_total exact_share,
        trunc(p_requested_pool * e.remaining / v_total, 3) base_share
      from eligible e
      join lateral (
        select id from public.ledger_owner_participants
        where user_id = e.user_id order by effective_from desc, id desc limit 1
      ) p on true
      join public.users u on u.id = e.user_id
      where e.remaining > 0
    ), ranked as (
      select shares.*,
        row_number() over (order by exact_share - base_share desc, user_id) remainder_rank,
        ((p_requested_pool - sum(base_share) over ()) * 1000)::integer remainder_units
      from shares
    )
    select ranked.*,
      base_share + case when remainder_rank <= remainder_units then 0.001 else 0 end assigned
    from ranked order by user_id
  loop
    v_assigned := v_line.assigned;
    if v_assigned > v_line.remaining then
      raise exception using errcode = 'P0001',
        message = 'OWNER_RECOVERY_ALLOCATION_EXCEEDS_PRINCIPAL';
    end if;
    v_used := v_used + v_assigned;
    if v_assigned > 0 then
      insert into public.ledger_owner_settlement_allocations(
        settlement_id, participant_id, rate_snapshot, assigned_amount,
        recovery_amount, pure_profit_amount, paid_amount,
        recovery_paid_amount, pure_profit_paid_amount)
      values (v_settlement, v_line.participant_id,
        greatest(0.000001, round(v_line.remaining / v_total, 6)),
        v_assigned, v_assigned, 0, 0, 0, 0);
    end if;
    v_snapshot := v_snapshot || jsonb_build_array(jsonb_build_object(
      'userId', v_line.user_id, 'participantId', v_line.participant_id,
      'name', v_line.owner_name, 'cumulativeInvestment', v_line.invested,
      'priorRecoveryAllocated', v_line.prior_allocated,
      'unallocatedUnrecovered', v_line.remaining,
      'allocationRatio', v_line.remaining / v_total,
      'assignedRecovery', v_assigned));
  end loop;
  if v_used <> p_requested_pool then
    raise exception using errcode = 'P0001', message = 'OWNER_RECOVERY_ALLOCATION_MISMATCH';
  end if;
  update public.ledger_owner_settlements
  set policy_snapshot = jsonb_build_object(
    'settlementType', 'capital_recovery',
    'allocationBasis', 'unrecovered_investment_ratio',
    'capacity', v_capacity, 'lines', v_snapshot)
  where id = v_settlement;
  insert into public.ledger_audit_logs(
    actor_user_id, action, entity_type, entity_id, after_snapshot, reason)
  values (p_actor_user_id, 'owner_recovery_confirmed', 'owner_settlement',
    v_settlement, jsonb_build_object('capacity', v_capacity,
      'allocations', v_snapshot), 'Capital recovery obligation; no fund movement');
  return jsonb_build_object('status', 'confirmed', 'settlementId', v_settlement,
    'confirmedPool', p_requested_pool, 'allocations', v_snapshot,
    'capacity', v_capacity);
end$$;

create or replace function public.ledger_owner_financial_capacity_v1(p_through_month date)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_start date; v_opening numeric; v_profit numeric; v_settled numeric;
  v_liquid numeric; v_reserve numeric; v_payable numeric; v_owner_unpaid numeric;
  v_safe numeric; v_undistributed numeric;
begin
  select profit_tracking_start_month, opening_undistributed_profit
  into v_start, v_opening from public.ledger_owner_profit_settings where singleton;
  if v_start is null then
    return jsonb_build_object('status', 'profit_tracking_not_configured');
  end if;
  select coalesce(sum((summary_snapshot#>>'{operatingResult,operatingProfit}')::numeric), 0)
  into v_profit from public.ledger_month_closures
  where month between v_start and p_through_month;
  select coalesce(sum(confirmed_pool), 0) into v_settled
  from public.ledger_owner_settlements
  where status in ('confirmed', 'partially_paid', 'paid')
    and settlement_type = 'profit_distribution'
    and through_month between v_start and p_through_month;
  v_undistributed := v_opening + v_profit - v_settled;
  select coalesce(sum(m.amount), 0) into v_liquid
  from public.ledger_movements m
  join public.ledger_transactions t on t.id = m.transaction_id
  join public.ledger_fund_accounts f on f.id = m.fund_account_id
  where t.status = 'confirmed' and t.occurred_at <= now()
    and f.is_active and f.is_business_fund
    and f.type in ('cash', 'bank', 'personal_custody');
  select coalesce(sum(case entry_type when 'allocate' then amount
    when 'release' then -amount when 'consume' then -amount else amount end), 0)
  into v_reserve from public.ledger_reserve_entries where occurred_at <= now();
  select coalesce(sum(greatest(0, p.original_amount -
    coalesce((select sum(a.allocated_amount) from public.ledger_payable_allocations a
              where a.payable_id = p.id), 0))), 0)
  into v_payable from public.ledger_payables p where p.status <> 'cancelled';
  select coalesce(sum(a.assigned_amount - a.paid_amount), 0)
  into v_owner_unpaid from public.ledger_owner_settlement_allocations a
  join public.ledger_owner_settlements s on s.id = a.settlement_id
  where s.status in ('confirmed', 'partially_paid');
  v_safe := greatest(0, v_liquid - v_reserve - v_payable - v_owner_unpaid);
  return jsonb_build_object(
    'status', 'ok', 'throughMonth', p_through_month,
    'openingUndistributedProfit', v_opening, 'closedOperatingProfit', v_profit,
    'confirmedSettlementPool', v_settled, 'undistributedProfit', v_undistributed,
    'liquidFunds', v_liquid, 'activeReserve', v_reserve,
    'vendorPayables', v_payable, 'confirmedUnpaidOwnerSettlements', v_owner_unpaid,
    'safeCashCapacity', v_safe,
    'recommendedMax', greatest(0, least(v_undistributed, v_safe)));
end$$;

create or replace function public.ledger_confirm_owner_settlement_v1(
  p_through_month date, p_requested_pool numeric, p_actor_user_id bigint)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_capacity jsonb; v_recovery_capacity jsonb; v_policy bigint; v_count int; v_rate_sum numeric;
  v_settlement bigint; v_line record; v_assigned numeric;
  v_allocated numeric := 0; v_index int := 0; v_snapshot jsonb := '[]'::jsonb;
begin
  if not public.ledger_owner_role_v1(p_actor_user_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if not public.ledger_month_is_closed_v1(p_through_month) then
    return jsonb_build_object('status', 'through_month_not_closed');
  end if;
  if p_requested_pool is null or p_requested_pool <= 0
     or scale(p_requested_pool) > 3 then
    return jsonb_build_object('status', 'invalid_pool');
  end if;
  perform pg_advisory_xact_lock(hashtext('ledger_owner_settlement:' || p_through_month));
  v_recovery_capacity := public.ledger_owner_recovery_capacity_v1();
  if (v_recovery_capacity->>'totalInvested')::numeric <= 0 then
    return jsonb_build_object('status', 'investment_not_configured');
  end if;
  if (v_recovery_capacity->>'totalCashUnrecoveredInvestment')::numeric > 0 then
    return jsonb_build_object('status', 'capital_recovery_not_completed');
  end if;
  if exists (select 1 from public.ledger_owner_settlements
             where through_month = p_through_month
               and settlement_type = 'profit_distribution') then
    return jsonb_build_object('status', 'duplicate_through_month');
  end if;
  v_capacity := public.ledger_owner_financial_capacity_v1(p_through_month);
  if v_capacity->>'status' <> 'ok' then
    return jsonb_build_object('status', 'OWNER_PROFIT_TRACKING_NOT_CONFIGURED');
  end if;
  if p_requested_pool > (v_capacity->>'recommendedMax')::numeric then
    return jsonb_build_object('status', 'requested_above_recommended_max',
      'recommendedMax', v_capacity->'recommendedMax');
  end if;
  v_policy := public.ledger_owner_policy_at_v1(p_through_month);
  if v_policy is null then return jsonb_build_object('status', 'policy_not_configured'); end if;
  select count(*), sum(settlement_rate) into v_count, v_rate_sum
  from public.ledger_owner_settlement_policy_lines where policy_id = v_policy;
  if v_count <> 3 or v_rate_sum <> 1.000000 then
    return jsonb_build_object('status', 'invalid_policy');
  end if;
  insert into public.ledger_owner_settlements(
    through_month, settlement_type, status, requested_pool, confirmed_pool,
    policy_id, policy_snapshot, undistributed_profit_snapshot,
    liquid_funds_snapshot, reserve_snapshot, payable_snapshot,
    unpaid_owner_settlement_snapshot, safe_cash_capacity_snapshot,
    recommended_max_snapshot, confirmed_by, confirmed_at, created_by)
  values (p_through_month, 'profit_distribution', 'confirmed',
    p_requested_pool, p_requested_pool, v_policy, '{}'::jsonb,
    (v_capacity->>'undistributedProfit')::numeric,
    (v_capacity->>'liquidFunds')::numeric,
    (v_capacity->>'activeReserve')::numeric,
    (v_capacity->>'vendorPayables')::numeric,
    (v_capacity->>'confirmedUnpaidOwnerSettlements')::numeric,
    (v_capacity->>'safeCashCapacity')::numeric,
    (v_capacity->>'recommendedMax')::numeric,
    p_actor_user_id, now(), p_actor_user_id)
  returning id into v_settlement;
  for v_line in
    select l.*, p.sort_order, u.id user_id,
      coalesce(u.name, u.full_name, u.username) participant_name
    from public.ledger_owner_settlement_policy_lines l
    join public.ledger_owner_participants p on p.id = l.participant_id
    join public.users u on u.id = p.user_id
    where l.policy_id = v_policy order by p.sort_order, p.id
  loop
    v_index := v_index + 1;
    v_assigned := case when v_index = v_count then p_requested_pool - v_allocated
      else trunc(p_requested_pool * v_line.settlement_rate, 3) end;
    v_allocated := v_allocated + v_assigned;
    insert into public.ledger_owner_settlement_allocations(
      settlement_id, participant_id, rate_snapshot, assigned_amount,
      recovery_amount, pure_profit_amount)
    values (v_settlement, v_line.participant_id, v_line.settlement_rate,
      v_assigned, 0, v_assigned);
    v_snapshot := v_snapshot || jsonb_build_array(jsonb_build_object(
      'participantId', v_line.participant_id, 'userId', v_line.user_id,
      'name', v_line.participant_name, 'sortOrder', v_line.sort_order,
      'rate', v_line.settlement_rate, 'assignedAmount', v_assigned,
      'recoveryAmount', 0, 'pureProfitAmount', v_assigned));
  end loop;
  update public.ledger_owner_settlements
  set policy_snapshot = jsonb_build_object('settlementType', 'profit_distribution',
    'policyId', v_policy, 'lines', v_snapshot)
  where id = v_settlement;
  insert into public.ledger_audit_logs(
    actor_user_id, action, entity_type, entity_id, after_snapshot, reason)
  values (p_actor_user_id, 'owner_settlement_confirmed', 'owner_settlement',
    v_settlement, jsonb_build_object('capacity', v_capacity,
      'policyId', v_policy, 'allocations', v_snapshot),
    'Closed-profit owner distribution confirmed; no fund movement');
  return jsonb_build_object('status', 'confirmed', 'settlementId', v_settlement,
    'confirmedPool', p_requested_pool, 'allocations', v_snapshot,
    'capacity', v_capacity);
end$$;

create or replace function public.ledger_pay_owner_allocation_v1(
  p_allocation_id bigint, p_amount numeric, p_fund_account_id bigint,
  p_paid_at timestamptz, p_memo text, p_actor_user_id bigint)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_allocation public.ledger_owner_settlement_allocations%rowtype;
  v_settlement public.ledger_owner_settlements%rowtype;
  v_balance numeric; v_remaining_recovery numeric; v_recovery_paid numeric;
  v_profit_paid numeric; v_tx bigint; v_date date; v_total_paid numeric;
begin
  if not public.ledger_owner_role_v1(p_actor_user_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_amount is null or p_amount <= 0 or scale(p_amount) > 3
     or p_paid_at is null then return jsonb_build_object('status', 'invalid_amount'); end if;
  if p_paid_at > now() then
    return jsonb_build_object('status', 'future_payment_not_allowed');
  end if;
  select * into v_allocation from public.ledger_owner_settlement_allocations
  where id = p_allocation_id for update;
  if v_allocation.id is null then return jsonb_build_object('status', 'allocation_not_found'); end if;
  select * into v_settlement from public.ledger_owner_settlements
  where id = v_allocation.settlement_id for update;
  if v_settlement.status not in ('confirmed', 'partially_paid')
     or v_allocation.paid_amount + p_amount > v_allocation.assigned_amount then
    return jsonb_build_object('status', 'overpayment');
  end if;
  if not exists (select 1 from public.ledger_fund_accounts
    where id = p_fund_account_id and is_active and is_business_fund
      and type in ('cash', 'bank', 'personal_custody')) then
    return jsonb_build_object('status', 'invalid_fund_account');
  end if;
  select coalesce(sum(m.amount), 0) into v_balance
  from public.ledger_movements m join public.ledger_transactions t
    on t.id = m.transaction_id
  where m.fund_account_id = p_fund_account_id
    and t.status = 'confirmed' and t.occurred_at <= now();
  if v_balance < p_amount then
    return jsonb_build_object('status', 'insufficient_fund', 'balance', v_balance);
  end if;
  v_date := ((p_paid_at at time zone 'Asia/Ho_Chi_Minh') - interval '3 hours')::date;
  perform public.ledger_assert_month_open_v1(date_trunc('month', v_date)::date);
  v_remaining_recovery := v_allocation.recovery_amount - v_allocation.recovery_paid_amount;
  v_recovery_paid := least(p_amount, v_remaining_recovery);
  v_profit_paid := p_amount - v_recovery_paid;
  if v_settlement.settlement_type = 'capital_recovery' and v_profit_paid <> 0 then
    return jsonb_build_object('status', 'invalid_recovery_allocation');
  end if;
  insert into public.ledger_transactions(
    operation_id, type, occurred_at, business_date, amount, party_id,
    status, source_type, source_snapshot, memo, created_by, confirmed_by)
  values (gen_random_uuid(), 'owner_settlement_payment', p_paid_at, v_date,
    p_amount, null, 'confirmed', 'owner_settlement_payment',
    jsonb_build_object('settlementId', v_settlement.id,
      'settlementType', v_settlement.settlement_type,
      'allocationId', v_allocation.id, 'participantId', v_allocation.participant_id,
      'assignedAmount', v_allocation.assigned_amount,
      'paymentBefore', v_allocation.paid_amount,
      'paymentAfter', v_allocation.paid_amount + p_amount,
      'recoveryPaid', v_recovery_paid, 'pureProfitPaid', v_profit_paid),
    nullif(btrim(p_memo), ''), p_actor_user_id, p_actor_user_id)
  returning id into v_tx;
  insert into public.ledger_movements(transaction_id, fund_account_id, amount)
  values (v_tx, p_fund_account_id, -p_amount);
  update public.ledger_owner_settlement_allocations
  set paid_amount = paid_amount + p_amount,
    recovery_paid_amount = recovery_paid_amount + v_recovery_paid,
    pure_profit_paid_amount = pure_profit_paid_amount + v_profit_paid,
    updated_at = now() where id = v_allocation.id;
  select sum(paid_amount) into v_total_paid
  from public.ledger_owner_settlement_allocations where settlement_id = v_settlement.id;
  update public.ledger_owner_settlements
  set status = case when v_total_paid = confirmed_pool then 'paid'
    else 'partially_paid' end, updated_at = now()
  where id = v_settlement.id;
  insert into public.ledger_audit_logs(
    actor_user_id, action, entity_type, entity_id,
    before_snapshot, after_snapshot, reason)
  values (p_actor_user_id, 'owner_settlement_payment_created',
    'owner_settlement_allocation', v_allocation.id, to_jsonb(v_allocation),
    jsonb_build_object('transactionId', v_tx, 'amount', p_amount,
      'fundAccountId', p_fund_account_id, 'settlementType', v_settlement.settlement_type,
      'recoveryPaid', v_recovery_paid, 'pureProfitPaid', v_profit_paid,
      'settlementTotalPaid', v_total_paid), nullif(btrim(p_memo), ''));
  return jsonb_build_object('status', 'paid', 'transactionId', v_tx,
    'recoveryPaid', v_recovery_paid, 'pureProfitPaid', v_profit_paid,
    'settlementStatus', case when v_total_paid = v_settlement.confirmed_pool
      then 'paid' else 'partially_paid' end);
end$$;

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
      source_type, source_snapshot, memo, created_by, confirmed_by)
    values (v_operation, 'investment', p_occurred_at, v_date,
      p_signed_amount, 'confirmed', 'owner_investment',
      jsonb_build_object('participantId', p_participant_id, 'entryType', p_entry_type),
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

alter function public.ledger_owner_recovery_capacity_v1() owner to postgres;
alter function public.ledger_confirm_owner_recovery_v1(numeric,bigint) owner to postgres;
alter function public.ledger_owner_financial_capacity_v1(date) owner to postgres;
alter function public.ledger_confirm_owner_settlement_v1(date,numeric,bigint) owner to postgres;
alter function public.ledger_pay_owner_allocation_v1(bigint,numeric,bigint,timestamptz,text,bigint) owner to postgres;
alter function public.ledger_create_owner_investment_v1(bigint,text,numeric,timestamptz,bigint,text,bigint) owner to postgres;

revoke all on function public.ledger_owner_recovery_capacity_v1(),
  public.ledger_confirm_owner_recovery_v1(numeric,bigint),
  public.ledger_owner_financial_capacity_v1(date),
  public.ledger_confirm_owner_settlement_v1(date,numeric,bigint),
  public.ledger_pay_owner_allocation_v1(bigint,numeric,bigint,timestamptz,text,bigint),
  public.ledger_create_owner_investment_v1(bigint,text,numeric,timestamptz,bigint,text,bigint)
  from public, anon, authenticated;
grant execute on function public.ledger_owner_recovery_capacity_v1(),
  public.ledger_confirm_owner_recovery_v1(numeric,bigint),
  public.ledger_owner_financial_capacity_v1(date),
  public.ledger_confirm_owner_settlement_v1(date,numeric,bigint),
  public.ledger_pay_owner_allocation_v1(bigint,numeric,bigint,timestamptz,text,bigint),
  public.ledger_create_owner_investment_v1(bigint,text,numeric,timestamptz,bigint,text,bigint)
  to service_role, postgres;
