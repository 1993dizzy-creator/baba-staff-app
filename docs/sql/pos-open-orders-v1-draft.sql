-- DRAFT — NOT APPLIED. Do not run against production without separate explicit approval.
-- CUKCUK in-progress (open) order snapshot, central sync only.
-- To adopt: copy into supabase/migrations/<timestamp>_pos_open_orders_v1.sql after review.
--
-- Separation from paid sales: nothing here reads or writes pos_sales_receipts or any
-- ledger/inventory table. Order Status (CUKCUK orders API) is stored as-is and never
-- compared with receipt payment_status inside SQL; the app links receipts by OrderId.
--
-- Access: private schema, RLS on, all privileges revoked; only service_role may execute
-- the four RPCs. Admin reads go through a server route that checks the app role.

create schema pos_open_orders_private;
revoke all on schema pos_open_orders_private from public, anon, authenticated, service_role;

create table pos_open_orders_private.runs (
  id uuid primary key,
  scope text not null,
  branch_id text not null,
  business_date date not null,
  owner_token uuid not null,
  status text not null check (status in ('collecting','committed','failed','expired')),
  started_at timestamptz not null default clock_timestamp(),
  lease_until timestamptz not null,
  finished_at timestamptz,
  failure_code text,
  manifest jsonb
);
-- Single-run lock: at most one collecting run per scope (company+branch).
create unique index pos_open_orders_active_scope on pos_open_orders_private.runs(scope) where status = 'collecting';
create index pos_open_orders_runs_recent on pos_open_orders_private.runs(scope, started_at desc);

create table pos_open_orders_private.sync_state (
  scope text primary key,
  branch_id text not null,
  business_date date,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_success_run_id uuid,
  last_error_code text,
  last_error_at timestamptz,
  consecutive_failures integer not null default 0
);

create table pos_open_orders_private.orders (
  scope text not null,
  business_date date not null,
  order_id text not null,
  order_no text,
  status integer,
  status_class text not null check (status_class in ('open','paid_candidate','unknown')),
  order_date timestamptz not null,
  total_amount numeric(18,2) not null check (total_amount >= 0),
  table_name text,
  has_lines boolean not null,
  run_id uuid not null,
  observed_at timestamptz not null,
  primary key (scope, business_date, order_id)
);

create table pos_open_orders_private.order_lines (
  scope text not null,
  business_date date not null,
  order_id text not null,
  detail_id text not null,
  parent_detail_id text,
  addition_id text,
  item_id text,
  item_name text not null,
  unit_name text,
  quantity numeric(18,4) not null,
  price numeric(18,2) not null,
  amount numeric(18,2) not null,
  line_status integer,
  is_option boolean not null,
  is_orphan_option boolean not null,
  is_canceled boolean not null,
  primary key (scope, business_date, order_id, detail_id),
  foreign key (scope, business_date, order_id)
    references pos_open_orders_private.orders(scope, business_date, order_id) on delete cascade
);

alter table pos_open_orders_private.runs enable row level security;
alter table pos_open_orders_private.sync_state enable row level security;
alter table pos_open_orders_private.orders enable row level security;
alter table pos_open_orders_private.order_lines enable row level security;
revoke all on all tables in schema pos_open_orders_private from public, anon, authenticated, service_role;

-- Claim the single run lease. Returns:
--   collecting: caller may call CUKCUK now
--   busy:       another run holds a live lease (overlapping trigger, no CUKCUK call)
--   fresh:      a success for this date is newer than p_min_interval_seconds (throttle)
--   <status>:   idempotent replay of an existing run id
create function public.pos_open_orders_claim(p_run_id uuid, p_owner_token uuid, p_scope text, p_branch_id text,
  p_business_date date, p_min_interval_seconds integer default 60)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare r pos_open_orders_private.runs%rowtype; s pos_open_orders_private.sync_state%rowtype;
begin
  if p_run_id is null or p_owner_token is null or p_business_date is null or nullif(p_branch_id, '') is null
    or p_scope is null or p_scope !~ '^[a-f0-9]{64}:[a-zA-Z0-9-]+$' or split_part(p_scope, ':', 2) <> p_branch_id
    or p_min_interval_seconds is null or p_min_interval_seconds < 0 or p_min_interval_seconds > 3600 then
    raise exception 'open_orders_scope_invalid' using errcode = '22023';
  end if;
  -- Only the live business date (Vietnam date -1..+1 for the 03:00 cutoff and clock skew).
  -- A wrong far date could otherwise make commit's retention delete current snapshots.
  if p_business_date not between (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date - 1
    and (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date + 1 then
    raise exception 'open_orders_business_date_out_of_range' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('pos_open_orders:' || p_scope, 0));
  select * into r from pos_open_orders_private.runs where id = p_run_id;
  if found then
    if r.owner_token <> p_owner_token or r.scope <> p_scope or r.business_date <> p_business_date then
      raise exception 'open_orders_run_conflict' using errcode = '22023';
    end if;
    return jsonb_build_object('status', r.status, 'runId', r.id);
  end if;
  -- Recovery: a crashed run's lease expires; it never blocks the next run forever.
  update pos_open_orders_private.runs set status = 'expired', finished_at = clock_timestamp(), failure_code = 'lease_expired'
    where scope = p_scope and status = 'collecting' and lease_until <= clock_timestamp();
  if exists (select 1 from pos_open_orders_private.runs where scope = p_scope and status = 'collecting') then
    return jsonb_build_object('status', 'busy');
  end if;
  select * into s from pos_open_orders_private.sync_state where scope = p_scope;
  if found and s.business_date = p_business_date and s.last_success_at is not null
    and s.last_success_at > clock_timestamp() - make_interval(secs => p_min_interval_seconds) then
    return jsonb_build_object('status', 'fresh', 'lastSuccessAt', s.last_success_at);
  end if;
  insert into pos_open_orders_private.runs(id, scope, branch_id, business_date, owner_token, status, lease_until)
    values (p_run_id, p_scope, p_branch_id, p_business_date, p_owner_token, 'collecting', clock_timestamp() + interval '3 minutes');
  insert into pos_open_orders_private.sync_state(scope, branch_id, last_attempt_at)
    values (p_scope, p_branch_id, clock_timestamp())
    on conflict (scope) do update set last_attempt_at = excluded.last_attempt_at;
  return jsonb_build_object('status', 'collecting', 'runId', p_run_id);
end $$;

-- Replace the snapshot of the run's business date in one transaction.
create function public.pos_open_orders_commit(p_run_id uuid, p_owner_token uuid, p_manifest jsonb, p_orders jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare r pos_open_orders_private.runs%rowtype; v_now timestamptz := clock_timestamp(); v_order jsonb; v_line jsonb;
  v_orders integer := 0; v_lines integer := 0;
begin
  select * into r from pos_open_orders_private.runs where id = p_run_id;
  if not found or r.owner_token <> p_owner_token then raise exception 'open_orders_run_conflict' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('pos_open_orders:' || r.scope, 0));
  select * into r from pos_open_orders_private.runs where id = p_run_id for update;
  if r.status = 'committed' then return jsonb_build_object('status', 'committed', 'runId', r.id, 'replay', true); end if;
  if r.status <> 'collecting' or r.lease_until <= v_now then raise exception 'open_orders_lease_lost' using errcode = '55000'; end if;
  if jsonb_typeof(p_orders) <> 'array' or jsonb_typeof(p_manifest) <> 'object'
    or (select count(*) from jsonb_array_elements(p_orders) o where o->>'businessDate' is distinct from r.business_date::text) > 0
    or (select count(distinct o->>'orderId') from jsonb_array_elements(p_orders) o) <> jsonb_array_length(p_orders) then
    raise exception 'open_orders_payload_invalid' using errcode = '22023';
  end if;

  delete from pos_open_orders_private.orders where scope = r.scope and business_date = r.business_date;
  for v_order in select * from jsonb_array_elements(p_orders) loop
    insert into pos_open_orders_private.orders(scope, business_date, order_id, order_no, status, status_class, order_date,
      total_amount, table_name, has_lines, run_id, observed_at)
    values (r.scope, r.business_date, v_order->>'orderId', v_order->>'orderNo', (v_order->>'status')::integer,
      v_order->>'statusClass', (v_order->>'orderDate')::timestamptz, (v_order->>'totalAmount')::numeric,
      v_order->>'tableName', jsonb_typeof(v_order->'lines') = 'array', r.id, v_now);
    v_orders := v_orders + 1;
    if jsonb_typeof(v_order->'lines') = 'array' then
      for v_line in select * from jsonb_array_elements(v_order->'lines') loop
        insert into pos_open_orders_private.order_lines(scope, business_date, order_id, detail_id, parent_detail_id, addition_id,
          item_id, item_name, unit_name, quantity, price, amount, line_status, is_option, is_orphan_option, is_canceled)
        values (r.scope, r.business_date, v_order->>'orderId', v_line->>'detailId', v_line->>'parentDetailId', v_line->>'additionId',
          v_line->>'itemId', coalesce(v_line->>'itemName', ''), v_line->>'unitName', (v_line->>'quantity')::numeric,
          (v_line->>'price')::numeric, (v_line->>'amount')::numeric, (v_line->>'lineStatus')::integer,
          (v_line->>'isOption')::boolean, (v_line->>'isOrphanOption')::boolean, (v_line->>'isCanceled')::boolean);
        v_lines := v_lines + 1;
      end loop;
    end if;
  end loop;

  update pos_open_orders_private.runs set status = 'committed', finished_at = v_now,
    manifest = p_manifest || jsonb_build_object('storedOrders', v_orders, 'storedLines', v_lines) where id = r.id;
  update pos_open_orders_private.sync_state set business_date = r.business_date, last_success_at = v_now,
    last_success_run_id = r.id, last_error_code = null, last_error_at = null, consecutive_failures = 0
    where scope = r.scope;
  -- Old data: snapshots older than 7 business days and runs older than 30 days are dropped.
  delete from pos_open_orders_private.orders where scope = r.scope and business_date < r.business_date - 7;
  delete from pos_open_orders_private.runs where scope = r.scope and status <> 'collecting' and started_at < v_now - interval '30 days';
  return jsonb_build_object('status', 'committed', 'runId', r.id, 'orders', v_orders, 'lines', v_lines);
end $$;

-- Record a failed run. The previous snapshot is kept but keeps its old success time,
-- so readers see it as stale instead of current.
create function public.pos_open_orders_fail(p_run_id uuid, p_owner_token uuid, p_code text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare r pos_open_orders_private.runs%rowtype; v_code text := case when p_code ~ '^[a-z0-9_]{1,64}$' then p_code else 'collection_failed' end;
begin
  select * into r from pos_open_orders_private.runs where id = p_run_id;
  if not found or r.owner_token <> p_owner_token then raise exception 'open_orders_run_conflict' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('pos_open_orders:' || r.scope, 0));
  update pos_open_orders_private.runs set status = 'failed', finished_at = clock_timestamp(), failure_code = v_code
    where id = p_run_id and status = 'collecting';
  if not found then return jsonb_build_object('status', 'ignored'); end if;
  update pos_open_orders_private.sync_state set last_error_code = v_code, last_error_at = clock_timestamp(),
    consecutive_failures = consecutive_failures + 1 where scope = r.scope;
  return jsonb_build_object('status', 'failed', 'code', v_code);
end $$;

-- Read model for the server route (role checked in the app before calling).
create function public.pos_open_orders_read(p_scope text, p_business_date date)
returns jsonb language sql stable security definer set search_path = pg_catalog, public as $$
  select jsonb_build_object(
    'sync', (select jsonb_build_object('businessDate', s.business_date, 'lastSuccessAt', s.last_success_at,
        'lastAttemptAt', s.last_attempt_at, 'lastErrorCode', s.last_error_code, 'consecutiveFailures', s.consecutive_failures)
      from pos_open_orders_private.sync_state s where s.scope = p_scope),
    'orders', coalesce((select jsonb_agg(jsonb_build_object(
        'orderId', o.order_id, 'orderNo', o.order_no, 'status', o.status, 'statusClass', o.status_class,
        'orderDate', o.order_date, 'businessDate', o.business_date, 'totalAmount', o.total_amount, 'tableName', o.table_name,
        'lines', case when o.has_lines then coalesce((select jsonb_agg(jsonb_build_object(
            'detailId', l.detail_id, 'parentDetailId', l.parent_detail_id, 'additionId', l.addition_id, 'itemId', l.item_id,
            'itemName', l.item_name, 'unitName', l.unit_name, 'quantity', l.quantity, 'price', l.price, 'amount', l.amount,
            'lineStatus', l.line_status, 'isOption', l.is_option, 'isOrphanOption', l.is_orphan_option, 'isCanceled', l.is_canceled)
            order by l.detail_id)
          from pos_open_orders_private.order_lines l
          where l.scope = o.scope and l.business_date = o.business_date and l.order_id = o.order_id), '[]'::jsonb) else null end)
        order by o.order_date, o.order_id)
      from pos_open_orders_private.orders o where o.scope = p_scope and o.business_date = p_business_date), '[]'::jsonb))
$$;

revoke all on function public.pos_open_orders_claim(uuid, uuid, text, text, date, integer),
  public.pos_open_orders_commit(uuid, uuid, jsonb, jsonb), public.pos_open_orders_fail(uuid, uuid, text),
  public.pos_open_orders_read(text, date) from public, anon, authenticated, service_role;
grant execute on function public.pos_open_orders_claim(uuid, uuid, text, text, date, integer),
  public.pos_open_orders_commit(uuid, uuid, jsonb, jsonb), public.pos_open_orders_fail(uuid, uuid, text),
  public.pos_open_orders_read(text, date) to service_role;
