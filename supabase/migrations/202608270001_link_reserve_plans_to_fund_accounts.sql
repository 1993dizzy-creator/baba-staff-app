do $$
begin
  if exists (
    select 1
    from public.ledger_reserve_plans plan
    left join public.ledger_reserve_entries entry on entry.reserve_plan_id = plan.id
    where plan.is_active = false
    group by plan.id
    having coalesce(sum(case entry.entry_type
      when 'allocate' then entry.amount
      when 'release' then -entry.amount
      when 'consume' then -entry.amount
      else entry.amount
    end), 0) <> 0
  ) then
    raise exception using
      errcode = '23514',
      message = 'inactive reserve plan has a non-zero balance';
  end if;
end
$$;

alter table public.ledger_reserve_plans
  add column fund_account_id bigint null;

alter table public.ledger_reserve_plans
  add constraint ledger_reserve_plans_fund_account_id_fkey
  foreign key (fund_account_id)
  references public.ledger_fund_accounts(id)
  on delete restrict;

create index ledger_reserve_plans_fund_account_idx
  on public.ledger_reserve_plans(fund_account_id)
  where fund_account_id is not null;

create function public.ledger_validate_reserve_fund_account_v1()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_current numeric := 0;
begin
  if new.fund_account_id is not null and not exists (
    select 1
    from public.ledger_fund_accounts account
    where account.id = new.fund_account_id
      and account.is_active = true
      and account.is_business_fund = true
      and account.type in ('cash', 'bank', 'personal_custody')
      and account.code <> 'card_clearing'
  ) then
    raise exception using
      errcode = '23514',
      message = 'reserve fund account must be an active liquid business account';
  end if;
  if tg_op = 'UPDATE' then
    select coalesce(sum(case entry_type
      when 'allocate' then amount
      when 'release' then -amount
      when 'consume' then -amount
      else amount
    end), 0) into v_current
    from public.ledger_reserve_entries
    where reserve_plan_id = old.id;
    if new.fund_account_id is distinct from old.fund_account_id and v_current <> 0 then
      raise exception using
        errcode = '23514',
        message = 'non-empty reserve plan cannot change fund account';
    end if;
    if old.is_active = true and new.is_active = false and v_current <> 0 then
      raise exception using
        errcode = '23514',
        message = 'non-empty reserve plan cannot be deactivated';
    end if;
  end if;
  return new;
end
$$;

create trigger ledger_reserve_plans_fund_account_guard
before insert or update of fund_account_id, is_active on public.ledger_reserve_plans
for each row execute function public.ledger_validate_reserve_fund_account_v1();

create function public.ledger_create_reserve_plan_v2(
  p_name text,
  p_target_amount numeric,
  p_target_date date,
  p_linked_plan_id bigint,
  p_fund_account_id bigint,
  p_memo text,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_id bigint;
begin
  select lower(role::text) into v_role
  from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if nullif(btrim(p_name), '') is null
    or p_target_amount is null
    or p_target_amount <= 0
    or scale(p_target_amount) > 3 then
    return jsonb_build_object('status', 'invalid_input');
  end if;
  if p_fund_account_id is not null and not exists (
    select 1 from public.ledger_fund_accounts
    where id = p_fund_account_id
      and is_active = true
      and is_business_fund = true
      and type in ('cash', 'bank', 'personal_custody')
      and code <> 'card_clearing'
  ) then
    return jsonb_build_object('status', 'invalid_fund_account');
  end if;
  insert into public.ledger_reserve_plans(
    name, target_amount, target_date, linked_recurring_plan_id,
    fund_account_id, memo, created_by
  ) values (
    btrim(p_name), p_target_amount, p_target_date, p_linked_plan_id,
    p_fund_account_id, nullif(btrim(p_memo), ''), p_actor_user_id
  ) returning id into v_id;
  insert into public.ledger_audit_logs(
    actor_user_id, action, entity_type, entity_id, after_snapshot, reason
  ) values (
    p_actor_user_id, 'reserve_plan_created', 'reserve_plan', v_id,
    (select to_jsonb(plan) from public.ledger_reserve_plans plan where id = v_id),
    nullif(btrim(p_memo), '')
  );
  return jsonb_build_object('status', 'created', 'reservePlanId', v_id);
end
$$;

create function public.ledger_update_reserve_plan_v2(
  p_reserve_plan_id bigint,
  p_target_amount numeric,
  p_target_date date,
  p_fund_account_id bigint,
  p_memo text,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_before public.ledger_reserve_plans%rowtype;
  v_current numeric := 0;
begin
  select lower(role::text) into v_role
  from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  select * into v_before
  from public.ledger_reserve_plans
  where id = p_reserve_plan_id and is_active = true
  for update;
  if v_before.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if p_target_amount is null
    or p_target_amount <= 0
    or scale(p_target_amount) > 3 then
    return jsonb_build_object('status', 'invalid_input');
  end if;
  if p_fund_account_id is not null and not exists (
    select 1 from public.ledger_fund_accounts
    where id = p_fund_account_id
      and is_active = true
      and is_business_fund = true
      and type in ('cash', 'bank', 'personal_custody')
      and code <> 'card_clearing'
  ) then
    return jsonb_build_object('status', 'invalid_fund_account');
  end if;
  select coalesce(sum(case entry_type
    when 'allocate' then amount
    when 'release' then -amount
    when 'consume' then -amount
    else amount
  end), 0) into v_current
  from public.ledger_reserve_entries
  where reserve_plan_id = p_reserve_plan_id;
  if p_fund_account_id is distinct from v_before.fund_account_id and v_current <> 0 then
    return jsonb_build_object('status', 'reserve_not_empty', 'currentAmount', v_current);
  end if;
  update public.ledger_reserve_plans
  set target_amount = p_target_amount,
      target_date = p_target_date,
      fund_account_id = p_fund_account_id,
      memo = nullif(btrim(p_memo), ''),
      updated_at = now()
  where id = p_reserve_plan_id;
  insert into public.ledger_audit_logs(
    actor_user_id, action, entity_type, entity_id,
    before_snapshot, after_snapshot, reason
  ) values (
    p_actor_user_id, 'reserve_plan_updated', 'reserve_plan', p_reserve_plan_id,
    to_jsonb(v_before),
    (select to_jsonb(plan) from public.ledger_reserve_plans plan where id = p_reserve_plan_id),
    nullif(btrim(p_memo), '')
  );
  return jsonb_build_object('status', 'updated', 'reservePlanId', p_reserve_plan_id);
end
$$;

create or replace function public.ledger_create_reserve_entry_v1(
  p_reserve_plan_id bigint,
  p_entry_type text,
  p_amount numeric,
  p_occurred_at timestamptz,
  p_memo text,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_id bigint;
  v_plan public.ledger_reserve_plans%rowtype;
  v_current numeric;
  v_delta numeric;
  v_gross_balance numeric;
  v_reserved_total numeric;
begin
  select lower(role::text) into v_role
  from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  select * into v_plan
  from public.ledger_reserve_plans
  where id = p_reserve_plan_id and is_active = true
  for update;
  if v_plan.id is null then
    return jsonb_build_object('status', 'invalid_plan');
  end if;
  if p_entry_type not in ('allocate', 'release', 'consume', 'adjustment')
    or p_amount is null
    or p_amount = 0
    or (p_entry_type <> 'adjustment' and p_amount < 0)
    or scale(p_amount) > 3
    or p_occurred_at is null then
    return jsonb_build_object('status', 'invalid_entry');
  end if;
  v_delta := case p_entry_type
    when 'allocate' then p_amount
    when 'release' then -p_amount
    when 'consume' then -p_amount
    else p_amount
  end;
  if v_plan.fund_account_id is not null then
    perform pg_advisory_xact_lock(hashtext('ledger_reserve_fund:' || v_plan.fund_account_id::text));
  end if;
  if v_plan.fund_account_id is not null and v_delta > 0 and not exists (
    select 1
    from public.ledger_fund_accounts account
    where account.id = v_plan.fund_account_id
      and account.is_active = true
      and account.is_business_fund = true
      and account.type in ('cash', 'bank', 'personal_custody')
      and account.code <> 'card_clearing'
  ) then
    return jsonb_build_object('status', 'invalid_fund_account');
  end if;
  select coalesce(sum(case entry_type
    when 'allocate' then amount
    when 'release' then -amount
    when 'consume' then -amount
    else amount
  end), 0) into v_current
  from public.ledger_reserve_entries
  where reserve_plan_id = p_reserve_plan_id;
  if v_current + v_delta < 0 then
    return jsonb_build_object('status', 'insufficient_reserve', 'currentAmount', v_current);
  end if;
  if v_plan.fund_account_id is not null and v_delta > 0 then
    select coalesce(sum(movement.amount), 0) into v_gross_balance
    from public.ledger_movements movement
    join public.ledger_transactions ledger_transaction on ledger_transaction.id = movement.transaction_id
    where movement.fund_account_id = v_plan.fund_account_id
      and ledger_transaction.status = 'confirmed'
      and ledger_transaction.occurred_at <= now();
    select coalesce(sum(case entry.entry_type
      when 'allocate' then entry.amount
      when 'release' then -entry.amount
      when 'consume' then -entry.amount
      else entry.amount
    end), 0) into v_reserved_total
    from public.ledger_reserve_plans plan
    join public.ledger_reserve_entries entry on entry.reserve_plan_id = plan.id
    where plan.fund_account_id = v_plan.fund_account_id;
    if v_reserved_total + v_delta > v_gross_balance then
      return jsonb_build_object(
        'status', 'insufficient_fund_balance',
        'grossBalance', v_gross_balance,
        'reservedBalance', v_reserved_total,
        'availableBalance', v_gross_balance - v_reserved_total
      );
    end if;
  end if;
  insert into public.ledger_reserve_entries(
    reserve_plan_id, entry_type, amount, occurred_at, memo, created_by
  ) values (
    p_reserve_plan_id, p_entry_type, p_amount, p_occurred_at,
    nullif(btrim(p_memo), ''), p_actor_user_id
  ) returning id into v_id;
  insert into public.ledger_audit_logs(
    actor_user_id, action, entity_type, entity_id,
    before_snapshot, after_snapshot, reason
  ) values (
    p_actor_user_id, 'reserve_entry_created', 'reserve_entry', v_id,
    jsonb_build_object('reserveAmount', v_current),
    jsonb_build_object(
      'reservePlanId', p_reserve_plan_id,
      'entryType', p_entry_type,
      'amount', p_amount,
      'reserveAmount', v_current + v_delta
    ),
    nullif(btrim(p_memo), '')
  );
  return jsonb_build_object(
    'status', 'created',
    'reserveEntryId', v_id,
    'currentAmount', v_current + v_delta
  );
end
$$;

revoke all on function public.ledger_validate_reserve_fund_account_v1()
  from public, anon, authenticated, service_role;
revoke all on function public.ledger_create_reserve_plan_v2(text, numeric, date, bigint, bigint, text, bigint)
  from public, anon, authenticated;
revoke all on function public.ledger_update_reserve_plan_v2(bigint, numeric, date, bigint, text, bigint)
  from public, anon, authenticated;
revoke all on function public.ledger_create_reserve_entry_v1(bigint, text, numeric, timestamptz, text, bigint)
  from public, anon, authenticated;
grant execute on function public.ledger_create_reserve_plan_v2(text, numeric, date, bigint, bigint, text, bigint)
  to service_role;
grant execute on function public.ledger_update_reserve_plan_v2(bigint, numeric, date, bigint, text, bigint)
  to service_role;
grant execute on function public.ledger_create_reserve_entry_v1(bigint, text, numeric, timestamptz, text, bigint)
  to service_role;

comment on column public.ledger_reserve_plans.fund_account_id is
  'Optional liquid business fund whose balance is earmarked by this plan. Reserve entries never create ledger movements.';
