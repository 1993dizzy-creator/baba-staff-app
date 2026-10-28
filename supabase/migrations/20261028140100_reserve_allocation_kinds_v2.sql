-- Reserve allocation kinds (v2).
--
-- Problem: ledger_generate_reserve_schedule_v1 / ledger_confirm_reserve_schedule_v1 treat
-- every unlinked 'allocate' of the month as "manual" and subtract it from the monthly
-- recurring amount. A top-up on top of the 60M rule, or putting back money released for
-- a loan, therefore silently shrinks that month's recurring allocation.
--
-- v2 tags new allocate entries:
--   regular -> confirmed recurring allocation (schedule confirm)
--   extra   -> additional top-up; never offsets the recurring amount
--   restore -> puts back (part of) one earlier 'release'; capped by what is left of it;
--              not a new reservation for the operating-residual KPI
-- and records attribution_month = the business month the entry was booked in (always the
-- current, open month: v2 never back-dates). Existing rows keep NULL in every new column
-- and keep their v1 meaning; no existing row is updated.
--
-- Untouched: v1 functions and grants, ledger_close_preflight_v1, month closures,
-- ledger_transactions/ledger_movements. The existing ledger_reserve_entries_month_guard
-- trigger still rejects writes dated in a closed month.

alter table public.ledger_reserve_entries
  add column allocation_kind text null,
  add column restores_entry_id bigint null references public.ledger_reserve_entries(id) on delete restrict,
  add column attribution_month date null,
  add column request_key uuid null;

alter table public.ledger_reserve_entries
  add constraint ledger_reserve_entries_allocation_kind_check
    check (allocation_kind is null or allocation_kind in ('regular', 'extra', 'restore')),
  add constraint ledger_reserve_entries_attribution_month_check
    check (attribution_month is null or attribution_month = date_trunc('month', attribution_month)::date),
  add constraint ledger_reserve_entries_kind_shape check (
    (allocation_kind is null and restores_entry_id is null and attribution_month is null)
    or (entry_type = 'allocate' and allocation_kind in ('regular', 'extra')
      and restores_entry_id is null and attribution_month is not null)
    or (entry_type = 'allocate' and allocation_kind = 'restore'
      and restores_entry_id is not null and attribution_month is not null)
  );

create unique index ledger_reserve_entries_request_key_unique
  on public.ledger_reserve_entries(request_key) where request_key is not null;
create index ledger_reserve_entries_restores_idx
  on public.ledger_reserve_entries(restores_entry_id) where restores_entry_id is not null;

comment on column public.ledger_reserve_entries.allocation_kind is
  'v2 allocate kind: regular (schedule confirm) | extra (top-up, never offsets the recurring amount) | restore (puts back a release). NULL = v1 row.';
comment on column public.ledger_reserve_entries.restores_entry_id is
  'For allocation_kind=restore: the release entry being put back. Sum of restores never exceeds that release.';
comment on column public.ledger_reserve_entries.attribution_month is
  'Business month the v2 entry was booked in (= confirmation month, never back-dated). NULL = v1 row: use occurred_at.';

-- Internal: books one reserve entry for an already locked active plan. Same fund and
-- balance checks as ledger_create_reserve_entry_v1. Not granted to any API role.
create function public.ledger_reserve_insert_entry_v2(
  p_plan_id bigint,
  p_entry_type text,
  p_allocation_kind text,
  p_amount numeric,
  p_restores_entry_id bigint,
  p_memo text,
  p_request_key uuid,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_plan public.ledger_reserve_plans%rowtype;
  v_month date := date_trunc('month', ((now() at time zone 'Asia/Ho_Chi_Minh') - interval '3 hours')::date)::date;
  v_delta numeric;
  v_current numeric;
  v_gross_balance numeric;
  v_reserved_total numeric;
  v_id bigint;
begin
  select * into v_plan from public.ledger_reserve_plans where id = p_plan_id;
  v_delta := case p_entry_type when 'allocate' then p_amount else -p_amount end;
  if v_plan.fund_account_id is not null then
    perform pg_advisory_xact_lock(hashtext('ledger_reserve_fund:' || v_plan.fund_account_id::text));
  end if;
  if v_plan.fund_account_id is not null and v_delta > 0 and not exists (
    select 1 from public.ledger_fund_accounts account
    where account.id = v_plan.fund_account_id and account.is_active = true and account.is_business_fund = true
      and account.type in ('cash', 'bank', 'personal_custody') and account.code <> 'card_clearing'
  ) then
    return jsonb_build_object('status', 'invalid_fund_account');
  end if;
  select coalesce(sum(case entry_type when 'allocate' then amount when 'release' then -amount
    when 'consume' then -amount else amount end), 0)
  into v_current from public.ledger_reserve_entries where reserve_plan_id = v_plan.id;
  if v_current + v_delta < 0 then
    return jsonb_build_object('status', 'insufficient_reserve', 'currentAmount', v_current);
  end if;
  if v_plan.fund_account_id is not null and v_delta > 0 then
    select coalesce(sum(movement.amount), 0) into v_gross_balance
    from public.ledger_movements movement
    join public.ledger_transactions ledger_transaction on ledger_transaction.id = movement.transaction_id
    where movement.fund_account_id = v_plan.fund_account_id
      and ledger_transaction.status = 'confirmed' and ledger_transaction.occurred_at <= now();
    select coalesce(sum(case entry.entry_type when 'allocate' then entry.amount when 'release' then -entry.amount
      when 'consume' then -entry.amount else entry.amount end), 0)
    into v_reserved_total
    from public.ledger_reserve_plans plan
    join public.ledger_reserve_entries entry on entry.reserve_plan_id = plan.id
    where plan.fund_account_id = v_plan.fund_account_id;
    if v_reserved_total + v_delta > v_gross_balance then
      return jsonb_build_object('status', 'insufficient_fund_balance', 'grossBalance', v_gross_balance,
        'reservedBalance', v_reserved_total, 'availableBalance', v_gross_balance - v_reserved_total);
    end if;
  end if;

  insert into public.ledger_reserve_entries(
    reserve_plan_id, entry_type, amount, occurred_at, memo, created_by,
    allocation_kind, restores_entry_id, attribution_month, request_key
  ) values (
    v_plan.id, p_entry_type, p_amount, now(), nullif(btrim(p_memo), ''), p_actor_user_id,
    p_allocation_kind, p_restores_entry_id, case when p_allocation_kind is null then null else v_month end, p_request_key
  ) returning id into v_id;
  insert into public.ledger_audit_logs(actor_user_id, action, entity_type, entity_id, before_snapshot, after_snapshot, reason)
  values (p_actor_user_id, 'reserve_entry_created', 'reserve_entry', v_id,
    jsonb_build_object('reserveAmount', v_current),
    jsonb_build_object('reservePlanId', v_plan.id, 'entryType', p_entry_type, 'allocationKind', p_allocation_kind,
      'restoresEntryId', p_restores_entry_id, 'attributionMonth', case when p_allocation_kind is null then null else v_month end,
      'amount', p_amount, 'reserveAmount', v_current + v_delta, 'rpc', 'v2'),
    nullif(btrim(p_memo), ''));
  return jsonb_build_object('status', 'created', 'reserveEntryId', v_id, 'currentAmount', v_current + v_delta,
    'attributionMonth', case when p_allocation_kind is null then null else v_month end);
end
$$;

-- Manual entry (v2). p_kind: extra | restore | release | consume. 'regular' is only
-- booked by ledger_confirm_reserve_schedule_v2. Always dated now() in the open current
-- business month; no back-dating. p_request_key makes a retried request return the
-- first result instead of booking twice.
create function public.ledger_create_reserve_entry_v2(
  p_reserve_plan_id bigint,
  p_kind text,
  p_amount numeric,
  p_restores_entry_id bigint,
  p_memo text,
  p_request_key uuid,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_plan public.ledger_reserve_plans%rowtype;
  v_existing public.ledger_reserve_entries%rowtype;
  v_target public.ledger_reserve_entries%rowtype;
  v_restored numeric;
  v_month date := date_trunc('month', ((now() at time zone 'Asia/Ho_Chi_Minh') - interval '3 hours')::date)::date;
  v_entry_type text;
  v_kind text;
begin
  select lower(role::text) into v_role from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_kind is null or p_kind not in ('extra', 'restore', 'release', 'consume')
    or p_amount is null or p_amount <= 0 or scale(p_amount) > 3 or p_request_key is null
    or (p_kind = 'restore') <> (p_restores_entry_id is not null) then
    return jsonb_build_object('status', 'invalid_entry');
  end if;
  v_entry_type := case when p_kind in ('extra', 'restore') then 'allocate' else p_kind end;
  v_kind := case when p_kind in ('extra', 'restore') then p_kind else null end;

  select * into v_plan from public.ledger_reserve_plans where id = p_reserve_plan_id and is_active = true for update;
  if v_plan.id is null then
    return jsonb_build_object('status', 'invalid_plan');
  end if;

  -- Idempotent retry: same key + same request returns the booked entry.
  select * into v_existing from public.ledger_reserve_entries where request_key = p_request_key;
  if v_existing.id is not null then
    if v_existing.reserve_plan_id = v_plan.id and v_existing.entry_type = v_entry_type
      and v_existing.allocation_kind is not distinct from v_kind and v_existing.amount = p_amount
      and v_existing.restores_entry_id is not distinct from p_restores_entry_id then
      return jsonb_build_object('status', 'duplicate', 'reserveEntryId', v_existing.id);
    end if;
    return jsonb_build_object('status', 'request_key_conflict');
  end if;

  if public.ledger_month_is_closed_v1(v_month) then
    return jsonb_build_object('status', 'current_month_closed');
  end if;

  if p_kind = 'restore' then
    select * into v_target from public.ledger_reserve_entries where id = p_restores_entry_id for update;
    if v_target.id is null or v_target.reserve_plan_id <> v_plan.id or v_target.entry_type <> 'release' then
      return jsonb_build_object('status', 'invalid_restore_target');
    end if;
    select coalesce(sum(amount), 0) into v_restored from public.ledger_reserve_entries
    where restores_entry_id = v_target.id and allocation_kind = 'restore';
    if v_restored + p_amount > v_target.amount then
      return jsonb_build_object('status', 'restore_exceeds_release',
        'releasedAmount', v_target.amount, 'restoredAmount', v_restored,
        'remainingAmount', v_target.amount - v_restored);
    end if;
  end if;

  return public.ledger_reserve_insert_entry_v2(v_plan.id, v_entry_type, v_kind, p_amount,
    p_restores_entry_id, p_memo, p_request_key, p_actor_user_id);
exception when unique_violation then
  -- A concurrent request with the same key committed first. It is a retry only when
  -- it booked exactly this request; any other payload under the key is a conflict.
  select * into v_existing from public.ledger_reserve_entries where request_key = p_request_key;
  if v_existing.id is not null and v_existing.reserve_plan_id = p_reserve_plan_id
    and v_existing.entry_type = v_entry_type and v_existing.allocation_kind is not distinct from v_kind
    and v_existing.amount = p_amount and v_existing.restores_entry_id is not distinct from p_restores_entry_id then
    return jsonb_build_object('status', 'duplicate', 'reserveEntryId', v_existing.id);
  end if;
  return jsonb_build_object('status', 'request_key_conflict');
end
$$;

-- Same as v1 except the "manual this month" offset counts only unlinked allocate rows
-- that are not v2 extra/restore (i.e. legacy v1 manual allocations).
create function public.ledger_generate_reserve_schedule_v2(p_month date, p_require_auto_generate boolean, p_actor_user_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_plan public.ledger_reserve_plans%rowtype;
  v_today date := ((now() at time zone 'Asia/Ho_Chi_Minh') - interval '3 hours')::date;
  v_current numeric;
  v_manual numeric;
  v_planned numeric;
  v_sched_date date;
  v_occ_id bigint;
  v_created int := 0;
  v_skipped_existing int := 0;
  v_skipped_target int := 0;
  v_skipped_fulfilled int := 0;
  v_skipped_notdue int := 0;
begin
  select lower(role::text) into v_role from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_month is null or p_month <> date_trunc('month', p_month)::date then
    return jsonb_build_object('status', 'invalid_month');
  end if;
  if public.ledger_month_is_closed_v1(p_month) then
    return jsonb_build_object('status', 'month_closed');
  end if;

  for v_plan in
    select * from public.ledger_reserve_plans
    where is_active = true
      and (coalesce(p_require_auto_generate, true) = false or recurring_auto_generate = true)
      and recurring_monthly_amount is not null and recurring_day is not null
      and recurring_start_month is not null and recurring_start_month <= p_month
      and (recurring_end_month is null or recurring_end_month >= p_month)
    order by id
  loop
    perform pg_advisory_xact_lock(hashtext('ledger_reserve_schedule:' || v_plan.id || ':' || to_char(p_month, 'YYYY-MM')));
    if coalesce(p_require_auto_generate, true) = true and p_month = date_trunc('month', v_today)::date
      and extract(day from v_today)::int < v_plan.recurring_day then
      v_skipped_notdue := v_skipped_notdue + 1;
      continue;
    end if;
    if exists (select 1 from public.ledger_reserve_scheduled_allocations
      where reserve_plan_id = v_plan.id and scheduled_month = p_month and status <> 'superseded') then
      v_skipped_existing := v_skipped_existing + 1;
      continue;
    end if;
    select coalesce(sum(case entry_type when 'allocate' then amount when 'release' then -amount
      when 'consume' then -amount else amount end), 0)
    into v_current from public.ledger_reserve_entries where reserve_plan_id = v_plan.id;
    if v_current >= v_plan.target_amount then
      v_skipped_target := v_skipped_target + 1;
      continue;
    end if;
    select coalesce(sum(entry.amount), 0) into v_manual
    from public.ledger_reserve_entries entry
    where entry.reserve_plan_id = v_plan.id and entry.entry_type = 'allocate'
      and entry.allocation_kind is null
      and date_trunc('month', ((entry.occurred_at at time zone 'Asia/Ho_Chi_Minh') - interval '3 hours')::date)::date = p_month
      and not exists (select 1 from public.ledger_reserve_scheduled_allocations sched where sched.reserve_entry_id = entry.id);
    v_planned := least(v_plan.recurring_monthly_amount - v_manual, v_plan.target_amount - v_current);
    if v_planned is null or v_planned <= 0 then
      v_skipped_fulfilled := v_skipped_fulfilled + 1;
      continue;
    end if;
    v_planned := round(v_planned, 3);
    v_sched_date := least((p_month + (v_plan.recurring_day - 1) * interval '1 day')::date,
      (p_month + interval '1 month' - interval '1 day')::date);
    insert into public.ledger_reserve_scheduled_allocations(reserve_plan_id, scheduled_month, scheduled_date, planned_amount, rule_snapshot)
    values (v_plan.id, p_month, v_sched_date, v_planned, jsonb_build_object(
      'monthlyAmount', v_plan.recurring_monthly_amount, 'recurringDay', v_plan.recurring_day,
      'startMonth', v_plan.recurring_start_month, 'endMonth', v_plan.recurring_end_month,
      'targetAmount', v_plan.target_amount, 'currentReserved', v_current, 'manualThisMonth', v_manual,
      'manualRule', 'v2_excludes_extra_restore'))
    returning id into v_occ_id;
    insert into public.ledger_audit_logs(actor_user_id, action, entity_type, entity_id, after_snapshot, reason)
    values (p_actor_user_id, 'reserve_schedule_generated', 'reserve_scheduled_allocation', v_occ_id,
      jsonb_build_object('reservePlanId', v_plan.id, 'scheduledMonth', p_month, 'scheduledDate', v_sched_date,
        'plannedAmount', v_planned, 'rpc', 'v2'), null);
    v_created := v_created + 1;
  end loop;

  return jsonb_build_object('status', 'ok',
    'mode', case when coalesce(p_require_auto_generate, true) then 'cron' else 'manual' end,
    'createdCount', v_created, 'skippedExisting', v_skipped_existing, 'skippedTarget', v_skipped_target,
    'skippedFulfilled', v_skipped_fulfilled, 'skippedNotDue', v_skipped_notdue);
end
$$;

-- Same as v1 except: the manual offset ignores extra/restore, the entry is booked as
-- allocation_kind='regular' with attribution_month = the confirmation month, and a
-- future month's schedule is refused (future_schedule). A schedule of an earlier (even
-- closed) month confirmed late therefore counts in the month it was actually confirmed;
-- no closed month's figures change.
create function public.ledger_confirm_reserve_schedule_v2(p_schedule_id bigint, p_actor_user_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_occ public.ledger_reserve_scheduled_allocations%rowtype;
  v_plan public.ledger_reserve_plans%rowtype;
  v_now_month date;
  v_current numeric;
  v_manual numeric;
  v_monthly numeric;
  v_target_room numeric;
  v_monthly_room numeric;
  v_amount numeric;
  v_entry jsonb;
begin
  select lower(role::text) into v_role from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  select * into v_occ from public.ledger_reserve_scheduled_allocations where id = p_schedule_id for update;
  if v_occ.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_occ.status <> 'pending' then
    return jsonb_build_object('status', 'not_pending', 'currentStatus', v_occ.status);
  end if;
  select * into v_plan from public.ledger_reserve_plans where id = v_occ.reserve_plan_id for update;
  if v_plan.id is null or v_plan.is_active = false then
    return jsonb_build_object('status', 'invalid_plan');
  end if;
  v_now_month := date_trunc('month', ((now() at time zone 'Asia/Ho_Chi_Minh') - interval '3 hours')::date)::date;
  if public.ledger_month_is_closed_v1(v_now_month) then
    return jsonb_build_object('status', 'current_month_closed');
  end if;
  -- A future month's schedule cannot be confirmed early (nothing is written). An earlier
  -- month's schedule confirmed late still books in the current open month (below).
  if v_occ.scheduled_month > v_now_month then
    return jsonb_build_object('status', 'future_schedule', 'scheduledMonth', v_occ.scheduled_month, 'currentMonth', v_now_month);
  end if;

  select coalesce(sum(case entry_type when 'allocate' then amount when 'release' then -amount
    when 'consume' then -amount else amount end), 0)
  into v_current from public.ledger_reserve_entries where reserve_plan_id = v_plan.id;
  v_target_room := v_plan.target_amount - v_current;
  if v_target_room <= 0 then
    update public.ledger_reserve_scheduled_allocations
    set status = 'skipped', resolved_by = p_actor_user_id, resolved_at = now(), skip_reason = '목표 금액 달성', updated_at = now()
    where id = p_schedule_id;
    insert into public.ledger_audit_logs(actor_user_id, action, entity_type, entity_id, before_snapshot, after_snapshot, reason)
    values (p_actor_user_id, 'reserve_schedule_skipped', 'reserve_scheduled_allocation', p_schedule_id,
      to_jsonb(v_occ), jsonb_build_object('status', 'skipped', 'autoReason', 'target_reached', 'rpc', 'v2'), '목표 금액 달성');
    return jsonb_build_object('status', 'target_reached');
  end if;

  v_monthly := coalesce(v_plan.recurring_monthly_amount, (v_occ.rule_snapshot->>'monthlyAmount')::numeric);
  select coalesce(sum(entry.amount), 0) into v_manual
  from public.ledger_reserve_entries entry
  where entry.reserve_plan_id = v_plan.id and entry.entry_type = 'allocate'
    and entry.allocation_kind is null
    and date_trunc('month', ((entry.occurred_at at time zone 'Asia/Ho_Chi_Minh') - interval '3 hours')::date)::date = v_occ.scheduled_month
    and not exists (select 1 from public.ledger_reserve_scheduled_allocations sched where sched.reserve_entry_id = entry.id);
  v_monthly_room := coalesce(v_monthly, v_occ.planned_amount) - v_manual;
  v_amount := least(v_occ.planned_amount, v_target_room, greatest(v_monthly_room, 0));
  if v_amount is null or v_amount <= 0 then
    update public.ledger_reserve_scheduled_allocations
    set status = 'skipped', resolved_by = p_actor_user_id, resolved_at = now(), skip_reason = '이번 달 수동 적립으로 충족', updated_at = now()
    where id = p_schedule_id;
    insert into public.ledger_audit_logs(actor_user_id, action, entity_type, entity_id, before_snapshot, after_snapshot, reason)
    values (p_actor_user_id, 'reserve_schedule_skipped', 'reserve_scheduled_allocation', p_schedule_id,
      to_jsonb(v_occ), jsonb_build_object('status', 'skipped', 'autoReason', 'already_fulfilled', 'manualThisMonth', v_manual, 'rpc', 'v2'),
      '이번 달 수동 적립으로 충족');
    return jsonb_build_object('status', 'already_fulfilled', 'manualThisMonth', v_manual);
  end if;
  v_amount := round(v_amount, 3);

  v_entry := public.ledger_reserve_insert_entry_v2(v_plan.id, 'allocate', 'regular', v_amount, null,
    '정기 준비금 적립 ' || to_char(v_occ.scheduled_month, 'YYYY-MM'), null, p_actor_user_id);
  if coalesce(v_entry->>'status', '') <> 'created' then
    return v_entry;
  end if;
  update public.ledger_reserve_scheduled_allocations
  set status = 'confirmed', reserve_entry_id = (v_entry->>'reserveEntryId')::bigint,
      resolved_by = p_actor_user_id, resolved_at = now(), updated_at = now()
  where id = p_schedule_id;
  insert into public.ledger_audit_logs(actor_user_id, action, entity_type, entity_id, before_snapshot, after_snapshot, reason)
  values (p_actor_user_id, 'reserve_schedule_confirmed', 'reserve_scheduled_allocation', p_schedule_id, to_jsonb(v_occ),
    jsonb_build_object('reservePlanId', v_plan.id, 'scheduledMonth', v_occ.scheduled_month, 'plannedAmount', v_occ.planned_amount,
      'confirmedAmount', v_amount, 'reserveEntryId', (v_entry->>'reserveEntryId')::bigint,
      'attributionMonth', v_entry->>'attributionMonth', 'rpc', 'v2'), null);
  return jsonb_build_object('status', 'confirmed', 'reserveEntryId', (v_entry->>'reserveEntryId')::bigint,
    'amount', v_amount, 'scheduledMonth', v_occ.scheduled_month, 'attributionMonth', v_entry->>'attributionMonth');
end
$$;

revoke all on function public.ledger_reserve_insert_entry_v2(bigint, text, text, numeric, bigint, text, uuid, bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.ledger_create_reserve_entry_v2(bigint, text, numeric, bigint, text, uuid, bigint)
  from public, anon, authenticated;
revoke all on function public.ledger_generate_reserve_schedule_v2(date, boolean, bigint)
  from public, anon, authenticated;
revoke all on function public.ledger_confirm_reserve_schedule_v2(bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.ledger_create_reserve_entry_v2(bigint, text, numeric, bigint, text, uuid, bigint) to service_role;
grant execute on function public.ledger_generate_reserve_schedule_v2(date, boolean, bigint) to service_role;
grant execute on function public.ledger_confirm_reserve_schedule_v2(bigint, bigint) to service_role;
