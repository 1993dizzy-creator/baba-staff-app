-- 2026-10 payroll special settlement (accountant-corrected amounts, already paid out).
--
-- Adds, without modifying any existing row:
--   1. payroll_employee_payment_allocations: one employee payment split across
--      several (payment_date, fund_account) groups. Only split payments get rows;
--      every other payment keeps the single payment_date/fund_account_id path.
--   2. payroll_payment_group_residuals: batch-level rounding residual that belongs
--      to a cash group but to no individual employee (never assigned to anyone).
--   3. payroll_special_settlement_requests: idempotency/audit record per request.
--   4. ledger_project_payroll_payment_group_v1 (same signature): allocation and
--      residual aware. Groups without allocations/residuals project byte-identically
--      (same employees JSON, total, count and fingerprint) to the previous body.
--   5. payroll_cancel_employee_payment_v3 (same signature): also cancels active
--      allocations and re-projects every group the payment touched.
--   6. payroll_refresh_payment_tax_totals_v1 (same signature): company cost also
--      includes the batch's residuals (zero for every batch without residuals).
--   7. payroll_settle_2026_10_v1: payroll managers (owner/master via
--      payroll_assert_actor_v2), payroll month 2026-10 only, exactly 17 employees
--      in ONE atomic call through the existing payroll_pay_employee_v2 path. Any
--      result other than completed 17/17 with exact cash groups rolls back.
--      Completed batches stay non-cancellable (existing payroll_cancel_* rule).
-- Personal payroll amounts are NOT in this file; they arrive as RPC arguments.
begin;

create table public.payroll_employee_payment_allocations(
  id bigint generated always as identity primary key,
  payroll_batch_id bigint not null references public.payroll_payment_batches(id) on delete restrict,
  employee_payment_id bigint not null references public.payroll_employee_payments(id) on delete restrict,
  user_id bigint not null references public.users(id) on delete restrict,
  payment_date date not null,
  fund_account_id bigint not null references public.ledger_fund_accounts(id) on delete restrict,
  amount bigint not null check(amount>0),
  allocation_kind text not null check(allocation_kind in('salary','penalty_refund')),
  note text,
  status text not null default 'active' check(status in('active','cancelled')),
  request_key text not null,
  created_by bigint not null references public.users(id),
  created_at timestamptz not null default now(),
  cancelled_by bigint references public.users(id),
  cancelled_at timestamptz,
  cancellation_reason text,
  constraint payroll_employee_payment_allocations_cancel_state check(
    (status='active' and cancelled_by is null and cancelled_at is null and cancellation_reason is null)
    or (status='cancelled' and cancelled_by is not null and cancelled_at is not null and nullif(btrim(cancellation_reason),'') is not null))
);
create unique index payroll_employee_payment_allocations_active_key
  on public.payroll_employee_payment_allocations(employee_payment_id,payment_date,fund_account_id) where status='active';
create index payroll_employee_payment_allocations_group_idx
  on public.payroll_employee_payment_allocations(payroll_batch_id,payment_date,fund_account_id) where status='active';

create table public.payroll_payment_group_residuals(
  id bigint generated always as identity primary key,
  payroll_batch_id bigint not null references public.payroll_payment_batches(id) on delete restrict,
  payment_date date not null,
  fund_account_id bigint not null references public.ledger_fund_accounts(id) on delete restrict,
  amount bigint not null check(amount<>0 and amount between -1000 and 1000),
  reason text not null check(nullif(btrim(reason),'') is not null),
  request_key text not null,
  created_by bigint not null references public.users(id),
  created_at timestamptz not null default now(),
  constraint payroll_payment_group_residuals_group_key unique(payroll_batch_id,payment_date,fund_account_id)
);

create table public.payroll_special_settlement_requests(
  id bigint generated always as identity primary key,
  payroll_month date not null,
  request_key text not null unique check(request_key ~ '^[A-Za-z0-9:_-]{16,128}$'),
  request_hash text not null check(request_hash ~ '^[0-9a-f]{64}$'),
  plan_hash text not null check(plan_hash ~ '^[0-9a-f]{64}$'),
  user_ids bigint[] not null,
  result jsonb not null,
  created_by bigint not null references public.users(id),
  created_at timestamptz not null default now()
);

alter table public.payroll_employee_payment_allocations enable row level security;
alter table public.payroll_payment_group_residuals enable row level security;
alter table public.payroll_special_settlement_requests enable row level security;
revoke all on table public.payroll_employee_payment_allocations,public.payroll_payment_group_residuals,public.payroll_special_settlement_requests from public,anon,authenticated,service_role;
grant select on table public.payroll_employee_payment_allocations,public.payroll_payment_group_residuals,public.payroll_special_settlement_requests to service_role;

alter table public.payroll_payment_audit_logs drop constraint payroll_payment_audit_logs_action_check;
alter table public.payroll_payment_audit_logs add constraint payroll_payment_audit_logs_action_check
  check(action = any(array['batch_started','employee_paid','employee_payment_cancelled','batch_completed','special_settlement_applied']));

-- Company cost = paid + insurance + PIT + advance + director insurance + residuals.
create or replace function public.payroll_refresh_payment_tax_totals_v1(p_run_id bigint) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  update public.payroll_payment_batches b set employee_pit_total=x.employee_pit,company_pit_total=x.company_pit,advance_total=x.advance,actual_company_cost_total=x.actual+x.employee_insurance+x.employee_pit+x.advance+x.employer_insurance+x.company_pit+b.director_insurance_amount
    +coalesce((select sum(r.amount) from public.payroll_payment_group_residuals r where r.payroll_batch_id=b.id),0),updated_at=now()
  from (select coalesce(sum(actual_paid_amount),0)::bigint actual,coalesce(sum(employee_insurance_amount),0)::bigint employee_insurance,coalesce(sum(employer_insurance_amount),0)::bigint employer_insurance,coalesce(sum((calculation_snapshot #>> '{employee,tax,employeePitDeductionAmount}')::bigint),0)::bigint employee_pit,coalesce(sum((calculation_snapshot #>> '{employee,tax,companyPitAmount}')::bigint),0)::bigint company_pit,coalesce(sum((calculation_snapshot #>> '{employee,amounts,advanceAmount}')::bigint),0)::bigint advance from public.payroll_employee_payments where payroll_batch_id=p_run_id and payment_status='paid') x where b.id=p_run_id;
end $$;

create or replace function public.ledger_project_payroll_payment_group_v1(
  p_payroll_month date,
  p_payment_date date,
  p_fund_account_id bigint,
  p_actor_user_id bigint
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_role text;
  v_account public.ledger_fund_accounts%rowtype;
  v_batch public.payroll_payment_batches%rowtype;
  v_existing public.ledger_transactions%rowtype;
  v_existing_id bigint;
  v_reversal_id bigint;
  v_new_id bigint;
  v_total numeric := 0;
  v_count integer := 0;
  v_employees jsonb := '[]'::jsonb;
  v_fingerprint text;
  v_group_key text;
  v_version integer := 0;
  v_names text;
  v_memo text;
  v_operation uuid := gen_random_uuid();
  v_before jsonb;
  v_after jsonb;
begin
  select lower(role::text) into v_role
  from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;

  if p_payroll_month is null
     or p_payroll_month <> date_trunc('month', p_payroll_month)::date
     or p_payment_date is null
     or p_fund_account_id is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  select * into v_account
  from public.ledger_fund_accounts
  where id = p_fund_account_id and is_active = true;
  if v_account.id is null then
    return jsonb_build_object('status', 'fund_account_not_found');
  end if;

  select * into v_batch
  from public.payroll_payment_batches
  where payroll_month = p_payroll_month;
  if v_batch.id is null then
    return jsonb_build_object('status', 'batch_not_found');
  end if;

  perform pg_advisory_xact_lock(
    hashtext('ledger_month_close:' || to_char(date_trunc('month', p_payment_date)::date, 'YYYY-MM'))
  );
  if public.ledger_month_is_closed_v1(date_trunc('month', p_payment_date)::date) then
    return jsonb_build_object('status', 'month_closed');
  end if;

  v_group_key := 'payroll-payment-group:' || to_char(p_payroll_month, 'YYYY-MM') || ':' || p_payment_date::text || ':' || p_fund_account_id;
  perform pg_advisory_xact_lock(hashtext(v_group_key));

  -- Lines: (a) unsplit paid payments in this group (unchanged JSON shape/order),
  -- (b) active allocations of split payments in this group, (c) batch residuals.
  with lines as (
    select p.id as sort_payment, 0::bigint as sort_line, p.id as payment_id,
      p.actual_paid_amount::numeric as amount,
      jsonb_build_object(
        'paymentId', p.id,
        'userId', p.user_id,
        'employeeName', p.employee_name,
        'amount', p.actual_paid_amount,
        'calculatedNetAmount', p.calculated_net_amount,
        'differenceAmount', p.difference_amount,
        'differenceReason', p.difference_reason,
        'paidAt', p.paid_at
      ) as line
    from public.payroll_employee_payments p
    where p.payroll_batch_id = v_batch.id
      and p.payment_status = 'paid'
      and p.payment_date = p_payment_date
      and p.fund_account_id = p_fund_account_id
      and coalesce(p.actual_paid_amount, 0) > 0
      and not exists (
        select 1 from public.payroll_employee_payment_allocations a
        where a.employee_payment_id = p.id and a.status = 'active'
      )
    union all
    select p.id, a.id, p.id, a.amount::numeric,
      jsonb_build_object(
        'paymentId', p.id,
        'userId', p.user_id,
        'employeeName', p.employee_name,
        'amount', a.amount,
        'calculatedNetAmount', p.calculated_net_amount,
        'differenceAmount', p.difference_amount,
        'differenceReason', p.difference_reason,
        'paidAt', p.paid_at,
        'allocationId', a.id,
        'allocationKind', a.allocation_kind,
        'allocationNote', a.note,
        'paymentTotalAmount', p.actual_paid_amount
      )
    from public.payroll_employee_payment_allocations a
    join public.payroll_employee_payments p on p.id = a.employee_payment_id
    where a.payroll_batch_id = v_batch.id
      and a.status = 'active'
      and a.payment_date = p_payment_date
      and a.fund_account_id = p_fund_account_id
      and p.payment_status = 'paid'
    union all
    select 9223372036854775807::bigint, r.id, null::bigint, r.amount::numeric,
      jsonb_build_object(
        'residualId', r.id,
        'kind', 'rounding_residual',
        'amount', r.amount,
        'reason', r.reason
      )
    from public.payroll_payment_group_residuals r
    where r.payroll_batch_id = v_batch.id
      and r.payment_date = p_payment_date
      and r.fund_account_id = p_fund_account_id
  )
  select
    coalesce(sum(l.amount), 0),
    count(distinct l.payment_id)::integer,
    coalesce(jsonb_agg(l.line order by l.sort_payment, l.sort_line), '[]'::jsonb)
  into v_total, v_count, v_employees
  from lines l;

  -- A residual never stands alone: without a paid employee the group is empty.
  if v_count = 0 then
    v_total := 0;
    v_employees := '[]'::jsonb;
  end if;

  v_fingerprint := md5(v_employees::text || '|' || v_total::text || '|' || v_count::text);

  select t.id into v_existing_id
  from public.ledger_transactions t
  where t.source_type = 'payroll_payment_group'
    and t.source_snapshot->>'groupKey' = v_group_key
    and t.status = 'confirmed'
    and not exists (
      select 1
      from public.ledger_transactions r
      where r.correction_of_id = t.id
        and r.source_type = 'payroll_payment_group_reversal'
    )
  order by t.id desc
  limit 1;

  if v_existing_id is not null then
    select * into v_existing
    from public.ledger_transactions
    where id = v_existing_id
    for update;
  end if;

  if v_existing.id is not null
     and v_existing.source_fingerprint = v_fingerprint
     and v_existing.amount = v_total then
    update public.ledger_transactions
    set source_synced_at = now(), updated_at = now()
    where id = v_existing.id;
    return jsonb_build_object(
      'status', 'unchanged',
      'transactionId', v_existing.id,
      'amount', v_total,
      'employeeCount', v_count,
      'groupKey', v_group_key
    );
  end if;

  if v_existing.id is not null then
    if (select count(*) from public.ledger_movements where transaction_id = v_existing.id) <> 1
       or coalesce((select sum(amount) from public.ledger_movements where transaction_id = v_existing.id and fund_account_id = p_fund_account_id), 0) <> -v_existing.amount then
      return jsonb_build_object('status', 'invalid_state');
    end if;

    v_before := jsonb_build_object(
      'transaction', to_jsonb(v_existing),
      'movements', coalesce((select jsonb_agg(to_jsonb(m) order by m.id) from public.ledger_movements m where m.transaction_id = v_existing.id), '[]'::jsonb)
    );

    insert into public.ledger_transactions(
      operation_id, type, occurred_at, business_date, recognition_month, amount,
      category_id, party_id, status, source_type, source_key, source_snapshot,
      source_fingerprint, source_synced_at, correction_of_id, memo,
      created_by, confirmed_by, economic_effect_sign
    ) values (
      v_operation, 'payroll_payment', v_existing.occurred_at, v_existing.business_date, null,
      v_existing.amount, null, null, 'confirmed', 'payroll_payment_group_reversal',
      v_existing.source_key || ':reversal',
      jsonb_build_object(
        'groupKey', v_group_key,
        'originalTransactionId', v_existing.id,
        'reason', 'Payroll payment group recalculated'
      ),
      md5(v_existing.source_key || ':reversal'), now(), v_existing.id,
      '급여 지급 묶음 재계산 역분개', p_actor_user_id, p_actor_user_id, -1
    ) returning id into v_reversal_id;

    insert into public.ledger_movements(transaction_id, fund_account_id, amount)
    values(v_reversal_id, p_fund_account_id, v_existing.amount);
  end if;

  select coalesce(max((t.source_snapshot->>'version')::integer), 0)
  into v_version
  from public.ledger_transactions t
  where t.source_type = 'payroll_payment_group'
    and t.source_snapshot->>'groupKey' = v_group_key;
  v_version := v_version + 1;

  if v_total > 0 and v_count > 0 then
    select string_agg(x.employee_name, ', ' order by x.id)
    into v_names
    from (
      select p.id, p.employee_name
      from public.payroll_employee_payments p
      where p.payroll_batch_id = v_batch.id
        and p.payment_status = 'paid'
        and (
          (p.payment_date = p_payment_date
            and p.fund_account_id = p_fund_account_id
            and coalesce(p.actual_paid_amount, 0) > 0
            and not exists (select 1 from public.payroll_employee_payment_allocations a
              where a.employee_payment_id = p.id and a.status = 'active'))
          or exists (select 1 from public.payroll_employee_payment_allocations a
              where a.employee_payment_id = p.id and a.status = 'active'
                and a.payment_date = p_payment_date and a.fund_account_id = p_fund_account_id)
        )
      order by p.id
      limit 8
    ) x;

    v_memo := extract(month from p_payroll_month)::integer || '월 급여 · ' || coalesce(v_names, '직원');
    if v_count > 8 then
      v_memo := v_memo || ' 외 ' || (v_count - 8) || '명';
    end if;

    insert into public.ledger_transactions(
      operation_id, type, occurred_at, business_date, recognition_month, amount,
      category_id, party_id, status, source_type, source_key, source_snapshot,
      source_fingerprint, source_synced_at, memo,
      created_by, confirmed_by, economic_effect_sign
    ) values (
      v_operation, 'payroll_payment', (p_payment_date::timestamp at time zone 'Asia/Ho_Chi_Minh'),
      p_payment_date, null, v_total, null, null, 'confirmed', 'payroll_payment_group',
      v_group_key || ':v' || v_version,
      jsonb_build_object(
        'groupKey', v_group_key,
        'version', v_version,
        'batchId', v_batch.id,
        'payrollMonth', p_payroll_month,
        'paymentDate', p_payment_date,
        'fundAccountId', p_fund_account_id,
        'fundAccountCode', v_account.code,
        'fundAccountName', v_account.display_name,
        'employeeCount', v_count,
        'employees', v_employees,
        'totalAmount', v_total
      ),
      v_fingerprint, now(), v_memo, p_actor_user_id, p_actor_user_id, 1
    ) returning id into v_new_id;

    insert into public.ledger_movements(transaction_id, fund_account_id, amount)
    values(v_new_id, p_fund_account_id, -v_total);
  end if;

  v_after := jsonb_build_object(
    'groupKey', v_group_key,
    'newTransactionId', v_new_id,
    'reversalTransactionId', v_reversal_id,
    'amount', v_total,
    'employeeCount', v_count,
    'employees', v_employees
  );

  insert into public.ledger_audit_logs(
    actor_user_id, action, entity_type, entity_id, before_snapshot, after_snapshot, reason
  ) values (
    p_actor_user_id,
    case when v_new_id is null then 'payroll_payment_group_cleared' else 'payroll_payment_group_projected' end,
    'payroll_payment_group',
    coalesce(v_new_id, v_existing.id),
    v_before,
    v_after,
    'Payroll payment group recalculated'
  );

  return jsonb_build_object(
    'status', case when v_new_id is null then 'cleared' when v_existing.id is null then 'created' else 'rebooked' end,
    'transactionId', v_new_id,
    'reversalTransactionId', v_reversal_id,
    'amount', v_total,
    'employeeCount', v_count,
    'groupKey', v_group_key
  );
end;
$$;

create or replace function public.payroll_cancel_employee_payment_v3(
  p_run_id bigint,
  p_user_id bigint,
  p_reason text,
  p_actor_user_id bigint
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_month date;
  v_payment_date date;
  v_fund_account_id bigint;
  v_payment_id bigint;
  v_result jsonb;
  v_group jsonb;
  v_primary_group jsonb;
  v_groups jsonb := '[]'::jsonb;
  v_status text;
  v_lock_dates date[];
  v_lock_months date[];
  v_group_list jsonb;
  g record;
begin
  perform public.payroll_assert_actor_v2(p_actor_user_id);
  select b.payroll_month, p.id into v_month, v_payment_id
    from public.payroll_employee_payments p join public.payroll_payment_batches b on b.id=p.payroll_batch_id
    where p.payroll_batch_id=p_run_id and p.user_id=p_user_id and p.payment_status='paid';
  select array_agg(d) into v_lock_dates from (
    select p.payment_date d from public.payroll_employee_payments p where p.id=v_payment_id
    union select a.payment_date from public.payroll_employee_payment_allocations a
      where a.employee_payment_id=v_payment_id and a.status='active') x;
  perform public.payroll_lock_months_v1(array[v_month] || coalesce(v_lock_dates, '{}'::date[]));
  select array_agg(distinct date_trunc('month', d)::date) into v_lock_months from unnest(coalesce(v_lock_dates, '{}'::date[])) d;

  select b.payroll_month, p.payment_date, p.fund_account_id, p.id
  into v_month, v_payment_date, v_fund_account_id, v_payment_id
  from public.payroll_employee_payments p
  join public.payroll_payment_batches b on b.id = p.payroll_batch_id
  where p.payroll_batch_id = p_run_id
    and p.user_id = p_user_id
    and p.payment_status = 'paid'
  for update of p, b;

  if v_month is null then
    raise exception 'PAYROLL_EMPLOYEE_NOT_IN_BATCH' using errcode = '22023';
  end if;

  perform 1 from public.payroll_employee_payment_allocations a
    where a.employee_payment_id = v_payment_id and a.status = 'active' for update;
  if exists (
    select 1 from (
      select v_payment_date d
      union all
      select a.payment_date from public.payroll_employee_payment_allocations a
        where a.employee_payment_id = v_payment_id and a.status = 'active'
    ) x
    where not (date_trunc('month', x.d)::date = any(coalesce(v_lock_months, '{}'::date[])))
  ) then
    raise exception 'PAYROLL_PAYMENT_STATE_STALE' using errcode='55000';
  end if;

  -- Every group this payment touched, captured before the allocations are cancelled.
  select coalesce(jsonb_agg(jsonb_build_object('d', y.d, 'f', y.f, 'p', y.p) order by y.d, y.f), '[]'::jsonb)
  into v_group_list
  from (
    select x.d, x.f, bool_or(x.p) p
    from (
      select v_payment_date d, v_fund_account_id f, true p
      where v_payment_date is not null and v_fund_account_id is not null
      union all
      select a.payment_date, a.fund_account_id, false
      from public.payroll_employee_payment_allocations a
      where a.employee_payment_id = v_payment_id and a.status = 'active'
    ) x
    group by x.d, x.f
  ) y;

  v_result := public.payroll_cancel_employee_payment_v2(
    p_run_id, p_user_id, p_reason, p_actor_user_id
  );

  update public.payroll_employee_payments
  set fund_account_id = null, updated_at = now()
  where payroll_batch_id = p_run_id and user_id = p_user_id and payment_status = 'unpaid';

  update public.payroll_employee_payment_allocations
  set status = 'cancelled', cancelled_by = p_actor_user_id, cancelled_at = now(), cancellation_reason = btrim(p_reason)
  where employee_payment_id = v_payment_id and status = 'active';

  for g in
    select (e->>'d')::date payment_date, (e->>'f')::bigint fund_account_id, (e->>'p')::boolean is_primary
    from jsonb_array_elements(v_group_list) e
  loop
    v_group := public.ledger_project_payroll_payment_group_v1(
      v_month, g.payment_date, g.fund_account_id, p_actor_user_id
    );
    v_status := coalesce(v_group->>'status', '');
    if v_status not in ('created', 'rebooked', 'unchanged', 'cleared') then
      raise exception 'PAYROLL_LEDGER_PROJECTION_FAILED:%', v_status using errcode = '55000';
    end if;
    if g.is_primary then v_primary_group := v_group; end if;
    v_groups := v_groups || jsonb_build_array(v_group);
  end loop;

  return v_result || jsonb_build_object('ledgerPaymentGroup', v_primary_group, 'ledgerPaymentGroups', v_groups);
end;
$$;

-- Read-only proof of the completed 2026-10 settlement. Returns null when the
-- batch, 17/17 payments, cash groups, movements and company cost all agree;
-- otherwise the first mismatch name. Used on first execution and on replay.
create or replace function public.payroll_settle_2026_10_final_state_v1(
  p_month date,
  p_expected_groups jsonb,
  p_run_id bigint,
  p_paid_total bigint,
  p_cost_total bigint
) returns text
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare
  c_employee_count constant integer := 17;
  v_run public.payroll_payment_batches%rowtype;
  v_prefix text := 'payroll-payment-group:' || to_char(p_month, 'YYYY-MM') || ':';
  v_active jsonb;
  v_active_count integer;
  v_expected jsonb;
  v_expected_total numeric;
  v_residual numeric;
begin
  select * into v_run from public.payroll_payment_batches where payroll_month = p_month;
  if v_run.id is null or v_run.id is distinct from p_run_id then return 'batch'; end if;
  if v_run.status <> 'completed' or v_run.paid_employee_count <> c_employee_count or v_run.target_employee_count <> c_employee_count
     or (select count(*) from public.payroll_employee_payments where payroll_batch_id = v_run.id and payment_status = 'paid') <> c_employee_count then
    return 'completion';
  end if;
  if p_paid_total is null or v_run.actual_paid_total <> p_paid_total then return 'paid_total'; end if;
  if p_cost_total is null or v_run.actual_company_cost_total <> p_cost_total then return 'company_cost_total'; end if;

  select coalesce(jsonb_object_agg(t.source_snapshot->>'groupKey', t.amount), '{}'::jsonb), count(*)::integer
  into v_active, v_active_count
  from public.ledger_transactions t
  where t.source_type = 'payroll_payment_group' and t.status = 'confirmed'
    and t.source_snapshot->>'groupKey' like v_prefix || '%'
    and not exists (select 1 from public.ledger_transactions r
      where r.correction_of_id = t.id and r.source_type = 'payroll_payment_group_reversal');
  select coalesce(jsonb_object_agg(v_prefix || (e->>'paymentDate') || ':' || (e->>'fundAccountId'), (e->>'amount')::numeric), '{}'::jsonb),
    coalesce(sum((e->>'amount')::numeric), 0)
  into v_expected, v_expected_total
  from jsonb_array_elements(p_expected_groups) e;
  if v_active_count <> jsonb_array_length(p_expected_groups) or v_active <> v_expected then return 'cash_groups'; end if;
  if exists (
    select 1 from public.ledger_transactions t
    where t.source_type = 'payroll_payment_group' and t.status = 'confirmed'
      and t.source_snapshot->>'groupKey' like v_prefix || '%'
      and not exists (select 1 from public.ledger_transactions r
        where r.correction_of_id = t.id and r.source_type = 'payroll_payment_group_reversal')
      and ((select count(*) from public.ledger_movements m where m.transaction_id = t.id) <> 1
        or not exists (select 1 from public.ledger_movements m where m.transaction_id = t.id
          and m.fund_account_id = (t.source_snapshot->>'fundAccountId')::bigint and m.amount = -t.amount))
  ) then return 'movements'; end if;
  select coalesce(sum(amount), 0) into v_residual from public.payroll_payment_group_residuals where payroll_batch_id = v_run.id;
  if v_expected_total <> p_paid_total + v_residual then return 'cash_total'; end if;
  if (select count(*) from public.ledger_transactions t
      where t.source_type = 'payroll_completed_batch' and t.status = 'confirmed'
        and t.source_key = 'payroll-batch:' || v_run.id || ':company-cost'
        and t.amount = v_run.actual_company_cost_total and t.recognition_month = p_month) <> 1 then
    return 'company_cost_transaction';
  end if;
  return null;
end;
$$;

create or replace function public.payroll_settle_2026_10_v1(
  p_month date,
  p_targets jsonb,
  p_payments jsonb,
  p_residuals jsonb,
  p_expected_groups jsonb,
  p_request_key text,
  p_request_hash text,
  p_plan_hash text,
  p_actor_user_id bigint,
  p_engine_version text,
  p_common_settings_snapshot jsonb,
  p_director_insurance_amount bigint
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_existing public.payroll_special_settlement_requests%rowtype;
  v_payment jsonb;
  v_alloc jsonb;
  v_item jsonb;
  v_dates date[] := '{}'::date[];
  v_user_ids bigint[] := '{}'::bigint[];
  v_sum bigint;
  v_salary_count integer;
  v_primary jsonb;
  v_paid jsonb;
  v_payment_id bigint;
  v_run_id bigint;
  v_run public.payroll_payment_batches%rowtype;
  v_paid_results jsonb := '[]'::jsonb;
  v_group jsonb;
  v_groups jsonb := '[]'::jsonb;
  v_status text;
  v_company_cost jsonb;
  v_result jsonb;
  v_group_key text;
  v_group_amount numeric;
  c_employee_count constant integer := 17;
  v_mismatch text;
  v_residual_ids bigint[] := '{}'::bigint[];
  v_new_id bigint;
  g record;
begin
  -- Same payroll-manager policy as every payroll RPC (active owner or master).
  perform public.payroll_assert_actor_v2(p_actor_user_id);
  if p_month is distinct from date '2026-10-01' then
    raise exception 'PAYROLL_SPECIAL_SETTLEMENT_MONTH_NOT_ALLOWED' using errcode = '22023';
  end if;
  if coalesce(p_request_key, '') !~ '^[A-Za-z0-9:_-]{16,128}$'
     or coalesce(p_request_hash, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_plan_hash, '') !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_payments) is distinct from 'array' or jsonb_array_length(p_payments) = 0
     or jsonb_typeof(p_residuals) is distinct from 'array'
     or jsonb_typeof(p_expected_groups) is distinct from 'array' or jsonb_array_length(p_expected_groups) = 0 then
    raise exception 'PAYROLL_INVALID_PAYMENT_REQUEST' using errcode = '22023';
  end if;

  -- Shape validation (no writes yet).
  for v_payment in select value from jsonb_array_elements(p_payments) loop
    if jsonb_typeof(v_payment) is distinct from 'object'
       or coalesce(v_payment->>'userId', '') !~ '^[1-9][0-9]{0,15}$'
       or jsonb_typeof(v_payment->'calculationSnapshot') is distinct from 'object'
       or nullif(btrim(coalesce(v_payment->>'calculationHash', '')), '') is null
       or coalesce(v_payment->>'calculatedNetAmount', '') !~ '^[0-9]{1,15}$'
       or coalesce(v_payment->>'actualPaidAmount', '') !~ '^[1-9][0-9]{0,14}$'
       or jsonb_typeof(v_payment->'allocations') is distinct from 'array'
       or jsonb_array_length(v_payment->'allocations') = 0 then
      raise exception 'PAYROLL_INVALID_PAYMENT_REQUEST' using errcode = '22023';
    end if;
    if (v_payment->>'userId')::bigint = any(v_user_ids) then
      raise exception 'PAYROLL_INVALID_PAYMENT_REQUEST' using errcode = '22023';
    end if;
    v_user_ids := v_user_ids || (v_payment->>'userId')::bigint;
    v_sum := 0; v_salary_count := 0;
    for v_alloc in select value from jsonb_array_elements(v_payment->'allocations') loop
      if jsonb_typeof(v_alloc) is distinct from 'object'
         or coalesce(v_alloc->>'paymentDate', '') !~ '^\d{4}-\d{2}-\d{2}$'
         or coalesce(v_alloc->>'fundAccountId', '') !~ '^[1-9][0-9]{0,15}$'
         or coalesce(v_alloc->>'amount', '') !~ '^[1-9][0-9]{0,14}$'
         or coalesce(v_alloc->>'kind', '') not in ('salary', 'penalty_refund') then
        raise exception 'PAYROLL_INVALID_PAYMENT_REQUEST' using errcode = '22023';
      end if;
      if (v_alloc->>'paymentDate')::date < (p_month + interval '1 month')::date then
        raise exception 'PAYROLL_INVALID_PAYMENT_REQUEST' using errcode = '22023';
      end if;
      perform 1 from public.ledger_fund_accounts
        where id = (v_alloc->>'fundAccountId')::bigint and is_active = true and code <> 'card_clearing';
      if not found then
        raise exception 'PAYROLL_FUND_ACCOUNT_INVALID' using errcode = '22023';
      end if;
      v_sum := v_sum + (v_alloc->>'amount')::bigint;
      if v_alloc->>'kind' = 'salary' then v_salary_count := v_salary_count + 1; end if;
      v_dates := v_dates || (v_alloc->>'paymentDate')::date;
    end loop;
    if v_salary_count <> 1 or v_sum <> (v_payment->>'actualPaidAmount')::bigint
       or (select count(distinct (a->>'paymentDate') || ':' || (a->>'fundAccountId')) from jsonb_array_elements(v_payment->'allocations') a)
          <> jsonb_array_length(v_payment->'allocations') then
      raise exception 'PAYROLL_SPECIAL_SETTLEMENT_ALLOCATION_MISMATCH' using errcode = '22023';
    end if;
  end loop;
  for v_item in select value from jsonb_array_elements(p_residuals) loop
    if jsonb_typeof(v_item) is distinct from 'object'
       or coalesce(v_item->>'paymentDate', '') !~ '^\d{4}-\d{2}-\d{2}$'
       or coalesce(v_item->>'fundAccountId', '') !~ '^[1-9][0-9]{0,15}$'
       or coalesce(v_item->>'amount', '') !~ '^-?[1-9][0-9]{0,3}$'
       or nullif(btrim(coalesce(v_item->>'reason', '')), '') is null then
      raise exception 'PAYROLL_INVALID_PAYMENT_REQUEST' using errcode = '22023';
    end if;
    v_dates := v_dates || (v_item->>'paymentDate')::date;
  end loop;
  for v_item in select value from jsonb_array_elements(p_expected_groups) loop
    if jsonb_typeof(v_item) is distinct from 'object'
       or coalesce(v_item->>'paymentDate', '') !~ '^\d{4}-\d{2}-\d{2}$'
       or coalesce(v_item->>'fundAccountId', '') !~ '^[1-9][0-9]{0,15}$'
       or coalesce(v_item->>'amount', '') !~ '^[1-9][0-9]{0,14}$' then
      raise exception 'PAYROLL_INVALID_PAYMENT_REQUEST' using errcode = '22023';
    end if;
  end loop;
  if (select count(distinct (e->>'paymentDate') || ':' || (e->>'fundAccountId')) from jsonb_array_elements(p_expected_groups) e)
     <> jsonb_array_length(p_expected_groups) then
    raise exception 'PAYROLL_INVALID_PAYMENT_REQUEST' using errcode = '22023';
  end if;
  -- Every touched group must be declared with its expected final total.
  if exists (
    select 1 from (
      select a->>'paymentDate' d, a->>'fundAccountId' f
      from jsonb_array_elements(p_payments) p, jsonb_array_elements(p->'allocations') a
      union select r->>'paymentDate', r->>'fundAccountId' from jsonb_array_elements(p_residuals) r
    ) t
    where not exists (select 1 from jsonb_array_elements(p_expected_groups) e
      where e->>'paymentDate' = t.d and e->>'fundAccountId' = t.f)
  ) then
    raise exception 'PAYROLL_SPECIAL_SETTLEMENT_GROUP_UNDECLARED' using errcode = '22023';
  end if;
  -- Exactly the 17-person roster, every one payable, every one paid in this single call.
  if jsonb_typeof(p_targets) is distinct from 'array'
     or jsonb_array_length(p_targets) <> c_employee_count
     or jsonb_array_length(p_payments) <> c_employee_count
     or exists (select 1 from jsonb_array_elements(p_targets) t
       where jsonb_typeof(t) is distinct from 'object'
         or coalesce(t->>'userId', '') !~ '^[1-9][0-9]{0,15}$'
         or (t->>'isPayable') is distinct from 'true'
         or jsonb_typeof(t->'failureCodes') is distinct from 'array'
         or jsonb_array_length(t->'failureCodes') > 0)
     or (select array_agg(x order by x) from (select (t->>'userId')::bigint x from jsonb_array_elements(p_targets) t
         where coalesce(t->>'userId', '') ~ '^[1-9][0-9]{0,15}$') q)
        is distinct from (select array_agg(x order by x) from unnest(v_user_ids) x) then
    raise exception 'PAYROLL_SPECIAL_SETTLEMENT_SCOPE_MISMATCH' using errcode = '22023';
  end if;

  perform public.payroll_lock_months_v1(array[p_month] || v_dates);

  -- Idempotent replay: same key + same request/plan hash, and the recorded
  -- final state must still hold. Nothing is written on replay.
  select * into v_existing from public.payroll_special_settlement_requests where request_key = p_request_key;
  if found then
    if v_existing.request_hash <> p_request_hash or v_existing.plan_hash <> p_plan_hash or v_existing.payroll_month <> p_month then
      raise exception 'PAYROLL_SPECIAL_SETTLEMENT_REQUEST_CONFLICT' using errcode = '23505';
    end if;
    v_mismatch := public.payroll_settle_2026_10_final_state_v1(p_month, p_expected_groups,
      (v_existing.result->>'runId')::bigint, (v_existing.result->>'actualPaidTotal')::bigint, (v_existing.result->>'actualCompanyCostTotal')::bigint);
    if v_mismatch is not null then
      raise exception 'PAYROLL_SPECIAL_SETTLEMENT_REPLAY_STATE_MISMATCH:%', v_mismatch using errcode = '55000';
    end if;
    return v_existing.result || jsonb_build_object('replayed', true);
  end if;
  -- One atomic execution only: an existing batch means the month is already settled.
  if exists (select 1 from public.payroll_payment_batches where payroll_month = p_month) then
    raise exception 'PAYROLL_SPECIAL_SETTLEMENT_BATCH_EXISTS' using errcode = '23505';
  end if;

  -- Each employee goes through the existing approval path (hash, roster,
  -- preflight, already-paid, first-month guard, audit, totals, completion).
  for v_payment in select value from jsonb_array_elements(p_payments) order by (value->>'userId')::bigint loop
    select a into v_primary from jsonb_array_elements(v_payment->'allocations') a where a->>'kind' = 'salary';
    v_paid := public.payroll_pay_employee_v2(
      p_month, p_targets, (v_payment->>'userId')::bigint, v_payment->'calculationSnapshot',
      v_payment->>'calculationHash', (v_payment->>'calculatedNetAmount')::bigint,
      (v_payment->>'actualPaidAmount')::bigint, nullif(btrim(coalesce(v_payment->>'differenceReason', '')), ''),
      (v_primary->>'paymentDate')::date, p_actor_user_id, p_engine_version,
      p_common_settings_snapshot, p_director_insurance_amount
    );
    v_payment_id := (v_paid #>> '{employee,id}')::bigint;
    v_run_id := (v_paid->>'runId')::bigint;
    update public.payroll_employee_payments
    set fund_account_id = (v_primary->>'fundAccountId')::bigint, updated_at = now()
    where id = v_payment_id;
    if jsonb_array_length(v_payment->'allocations') > 1 then
      insert into public.payroll_employee_payment_allocations(
        payroll_batch_id, employee_payment_id, user_id, payment_date, fund_account_id,
        amount, allocation_kind, note, request_key, created_by)
      select v_run_id, v_payment_id, (v_payment->>'userId')::bigint, (a->>'paymentDate')::date,
        (a->>'fundAccountId')::bigint, (a->>'amount')::bigint, a->>'kind',
        nullif(btrim(coalesce(a->>'note', '')), ''), p_request_key, p_actor_user_id
      from jsonb_array_elements(v_payment->'allocations') a;
    end if;
    v_paid_results := v_paid_results || jsonb_build_array(jsonb_build_object(
      'userId', (v_payment->>'userId')::bigint, 'paymentId', v_payment_id,
      'actualPaidAmount', (v_payment->>'actualPaidAmount')::bigint,
      'allocationCount', jsonb_array_length(v_payment->'allocations')));
  end loop;

  -- Batch residuals (the batch was created in this call; duplicates violate the unique key).
  for v_item in select value from jsonb_array_elements(p_residuals) loop
    insert into public.payroll_payment_group_residuals(payroll_batch_id, payment_date, fund_account_id, amount, reason, request_key, created_by)
    values (v_run_id, (v_item->>'paymentDate')::date, (v_item->>'fundAccountId')::bigint,
      (v_item->>'amount')::bigint, btrim(v_item->>'reason'), p_request_key, p_actor_user_id)
    returning id into v_new_id;
    v_residual_ids := v_residual_ids || v_new_id;
  end loop;
  perform public.payroll_refresh_payment_tax_totals_v1(v_run_id);

  for g in
    select distinct d::date payment_date, f::bigint fund_account_id from (
      select a->>'paymentDate' d, a->>'fundAccountId' f
      from jsonb_array_elements(p_payments) p, jsonb_array_elements(p->'allocations') a
      union select r->>'paymentDate', r->>'fundAccountId' from jsonb_array_elements(p_residuals) r
    ) t order by 1, 2
  loop
    v_group := public.ledger_project_payroll_payment_group_v1(p_month, g.payment_date, g.fund_account_id, p_actor_user_id);
    v_status := coalesce(v_group->>'status', '');
    if v_status not in ('created', 'rebooked', 'unchanged') then
      raise exception 'PAYROLL_LEDGER_PROJECTION_FAILED:%', v_status using errcode = '55000';
    end if;
    v_groups := v_groups || jsonb_build_array(v_group);
  end loop;

  select * into v_run from public.payroll_payment_batches where id = v_run_id;
  if v_run.status is distinct from 'completed' or v_run.paid_employee_count <> c_employee_count
     or v_run.target_employee_count <> c_employee_count then
    raise exception 'PAYROLL_SPECIAL_SETTLEMENT_NOT_COMPLETE:%:%/%', v_run.status, v_run.paid_employee_count, v_run.target_employee_count using errcode = '55000';
  end if;

  -- Every stored payment must equal what this request recorded.
  for v_payment in select value from jsonb_array_elements(p_payments) loop
    select a into v_primary from jsonb_array_elements(v_payment->'allocations') a where a->>'kind' = 'salary';
    if not exists (
      select 1 from public.payroll_employee_payments p
      where p.payroll_batch_id = v_run_id and p.user_id = (v_payment->>'userId')::bigint and p.payment_status = 'paid'
        and p.actual_paid_amount = (v_payment->>'actualPaidAmount')::bigint
        and p.calculated_net_amount = (v_payment->>'calculatedNetAmount')::bigint
        and p.calculation_hash = v_payment->>'calculationHash'
        and p.payment_date = (v_primary->>'paymentDate')::date
        and p.fund_account_id = (v_primary->>'fundAccountId')::bigint
        and (jsonb_array_length(v_payment->'allocations') = 1
          and not exists (select 1 from public.payroll_employee_payment_allocations a where a.employee_payment_id = p.id)
          or jsonb_array_length(v_payment->'allocations') > 1
          and (select count(*) from public.payroll_employee_payment_allocations a where a.employee_payment_id = p.id and a.status = 'active') = jsonb_array_length(v_payment->'allocations')
          and (select sum(a.amount) from public.payroll_employee_payment_allocations a where a.employee_payment_id = p.id and a.status = 'active') = p.actual_paid_amount)
    ) then
      raise exception 'PAYROLL_SPECIAL_SETTLEMENT_PAYMENT_MISMATCH:%', v_payment->>'userId' using errcode = '55000';
    end if;
  end loop;

  v_company_cost := public.ledger_sync_payroll_batch_company_cost_v1(v_run_id, p_actor_user_id);
  v_status := coalesce(v_company_cost->>'status', '');
  if v_status <> 'created' then
    raise exception 'PAYROLL_COMPANY_COST_SYNC_FAILED:%', v_status using errcode = '55000';
  end if;
  select * into v_run from public.payroll_payment_batches where id = v_run_id;

  v_mismatch := public.payroll_settle_2026_10_final_state_v1(p_month, p_expected_groups, v_run_id,
    (select sum((p->>'actualPaidAmount')::bigint) from jsonb_array_elements(p_payments) p)::bigint, v_run.actual_company_cost_total);
  if v_mismatch is not null then
    raise exception 'PAYROLL_SPECIAL_SETTLEMENT_GROUP_MISMATCH:%', v_mismatch using errcode = '55000';
  end if;

  v_result := jsonb_build_object(
    'runId', v_run_id,
    'status', v_run.status,
    'paidEmployeeCount', v_run.paid_employee_count,
    'targetEmployeeCount', v_run.target_employee_count,
    'actualPaidTotal', v_run.actual_paid_total,
    'actualCompanyCostTotal', v_run.actual_company_cost_total,
    'payments', v_paid_results,
    'residualIds', to_jsonb(v_residual_ids),
    'ledgerPaymentGroups', v_groups,
    'ledgerCompanyCost', v_company_cost,
    'requestKey', p_request_key,
    'planHash', p_plan_hash
  );

  insert into public.payroll_special_settlement_requests(payroll_month, request_key, request_hash, plan_hash, user_ids, result, created_by)
  values (p_month, p_request_key, p_request_hash, p_plan_hash, v_user_ids, v_result, p_actor_user_id);
  insert into public.payroll_payment_audit_logs(payroll_batch_id, action, actor_user_id, reason, after_snapshot)
  values (v_run_id, 'special_settlement_applied', p_actor_user_id,
    '2026-10 special settlement (accountant-corrected amounts, recorded after actual payment)', v_result);

  return v_result;
end;
$$;

revoke all on function public.payroll_refresh_payment_tax_totals_v1(bigint) from public, anon, authenticated;
revoke all on function public.ledger_project_payroll_payment_group_v1(date,date,bigint,bigint) from public, anon, authenticated;
revoke all on function public.payroll_cancel_employee_payment_v3(bigint,bigint,text,bigint) from public, anon, authenticated;
revoke all on function public.payroll_settle_2026_10_v1(date,jsonb,jsonb,jsonb,jsonb,text,text,text,bigint,text,jsonb,bigint) from public, anon, authenticated;
revoke all on function public.payroll_settle_2026_10_final_state_v1(date,jsonb,bigint,bigint,bigint) from public, anon, authenticated, service_role;
grant execute on function public.ledger_project_payroll_payment_group_v1(date,date,bigint,bigint) to service_role;
grant execute on function public.payroll_cancel_employee_payment_v3(bigint,bigint,text,bigint) to service_role;
grant execute on function public.payroll_settle_2026_10_v1(date,jsonb,jsonb,jsonb,jsonb,text,text,text,bigint,text,jsonb,bigint) to service_role;

commit;
