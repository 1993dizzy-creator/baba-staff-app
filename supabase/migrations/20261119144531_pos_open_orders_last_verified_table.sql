-- NOT APPLIED. Owner approval is required. Follow-up only: never edit/replay
-- 20261109210000, 20261110170329, 20261114161500 or 20261119080000.
--
-- Payment-confirmation window (2026-11-19): once an order reaches Status 4 the POS drops
-- its TableName, and until the receipt collector links its paid receipt the order has no
-- location, so every non-occupied table was shown unknown. Commits replace the whole
-- snapshot, so the table the provider last listed for that order is lost after one run.
--
-- This keeps, per (scope, business_date, order_id), the last provider-listed table name and
-- the observation time of that listing, ONLY while the current row is Status 4 without a
-- table name. It is past observation evidence, never a current TableName: table_name stays
-- exactly what the provider sent. It is carried only from this date's previous row of the
-- same order id AND the same order_date (an id reused by a new order never inherits it). A
-- newly listed table (move) replaces it on the next Status 4 transition.
--
-- Unchanged: the lease/writer fence, replay, vanished/receipt/merge/quarantine rules
-- (renamed below to commit_quarantine_v1 without body changes), retention, roles, grants,
-- recoveryContractVersion 4 and every cleaning/auto-normal function and trigger (they
-- compare 6 fixed per-order facts that this update never changes). No receipt, ledger,
-- inventory or payroll DML.

-- DDL wait budget for this migration transaction only.
set local lock_timeout = '5s';

alter table pos_open_orders_private.orders
  add column last_table_name text,
  add column last_table_observed_at timestamptz;
alter table pos_open_orders_private.orders add constraint orders_last_table_check check (
  (last_table_name is null and last_table_observed_at is null)
  or (nullif(btrim(last_table_name), '') is not null and last_table_observed_at is not null
    and status = 4 and nullif(btrim(table_name), '') is null));
comment on column pos_open_orders_private.orders.last_table_name is
  'Status 4 rows without a TableName only: the table the provider last listed for this same order on this business date. Past observation, not a current location or a payment proof.';
comment on column pos_open_orders_private.orders.last_table_observed_at is
  'Observation time of the provider listing that named last_table_name.';

create or replace function pos_open_orders_private.read_v1(p_scope text, p_business_date date)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'recoveryContractVersion', 4,
    'sync', (select jsonb_build_object('businessDate', s.business_date, 'lastSuccessAt', s.last_success_at,
        'lastAttemptAt', s.last_attempt_at, 'lastErrorCode', s.last_error_code, 'consecutiveFailures', s.consecutive_failures)
      from pos_open_orders_private.sync_state s where s.scope = p_scope),
    'orders', coalesce((select jsonb_agg(jsonb_build_object(
        'orderId', o.order_id, 'orderNo', o.order_no, 'status', o.status, 'statusClass', o.status_class,
        'orderDate', o.order_date, 'businessDate', o.business_date, 'totalAmount', o.total_amount, 'tableName', o.table_name,
        'providerObservedAt', o.observed_at, 'closureReceiptId', o.closure_receipt_id, 'closureConfirmedAt', o.closure_confirmed_at,
        'closureMergedIntoOrderId', o.closure_merged_into_order_id,
        'quarantinedAt', o.quarantined_at, 'quarantineReason', o.quarantine_reason,
        'lastTableName', o.last_table_name, 'lastTableObservedAt', o.last_table_observed_at,
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

-- The 2026-11-19 quarantine commit is kept byte-for-byte as an internal step.
alter function pos_open_orders_private.commit_v1(uuid, uuid, jsonb, jsonb) rename to commit_quarantine_v1;
revoke all on function pos_open_orders_private.commit_quarantine_v1(uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;

create function pos_open_orders_private.commit_v1(p_run_id uuid, p_owner_token uuid, p_manifest jsonb, p_orders jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r pos_open_orders_private.runs%rowtype; v_previous jsonb; v_result jsonb;
begin
  select * into r from pos_open_orders_private.runs where id = p_run_id;
  -- Unknown run: the unchanged commit raises its own error.
  if not found then return pos_open_orders_private.commit_quarantine_v1(p_run_id, p_owner_token, p_manifest, p_orders); end if;
  -- Same writer lock the inner commit takes (re-entrant): the previous rows cannot change underneath.
  perform pg_advisory_xact_lock(hashtextextended('pos_open_orders:' || r.scope, 0));
  -- Last provider-listed table per order before the snapshot is replaced.
  select coalesce(jsonb_agg(jsonb_build_object('order_id', o.order_id, 'order_date', o.order_date,
      'table_name', coalesce(nullif(btrim(o.table_name), ''), o.last_table_name),
      'observed_at', case when nullif(btrim(o.table_name), '') is not null then o.observed_at else o.last_table_observed_at end)), '[]'::jsonb)
    into v_previous from pos_open_orders_private.orders o
    where o.scope = r.scope and o.business_date = r.business_date
      and (nullif(btrim(o.table_name), '') is not null and o.observed_at is not null or o.last_table_name is not null);
  v_result := pos_open_orders_private.commit_quarantine_v1(p_run_id, p_owner_token, p_manifest, p_orders);
  -- Idempotent: a replay or a no-op result re-derives the same values from the same rows.
  update pos_open_orders_private.orders o set last_table_name = p.table_name, last_table_observed_at = p.observed_at
    from jsonb_to_recordset(v_previous) as p(order_id text, order_date timestamptz, table_name text, observed_at timestamptz)
    where o.scope = r.scope and o.business_date = r.business_date and o.order_id = p.order_id and o.order_date = p.order_date
      and o.status = 4 and nullif(btrim(o.table_name), '') is null and o.last_table_name is null
      and p.observed_at is not null and nullif(btrim(p.table_name), '') is not null;
  return v_result;
end $$;

alter function pos_open_orders_private.commit_quarantine_v1(uuid, uuid, jsonb, jsonb) owner to postgres;
alter function pos_open_orders_private.commit_v1(uuid, uuid, jsonb, jsonb) owner to postgres;
alter function pos_open_orders_private.read_v1(text, date) owner to postgres;
revoke all on function pos_open_orders_private.commit_v1(uuid, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function pos_open_orders_private.commit_v1(uuid, uuid, jsonb, jsonb) to service_role;

-- Refresh SQL-wrapper resolution after renaming the previous implementation.
create or replace function public.pos_open_orders_commit(p_run_id uuid, p_owner_token uuid, p_manifest jsonb, p_orders jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
  select pos_open_orders_private.commit_v1(p_run_id, p_owner_token, p_manifest, p_orders)
$$;
revoke all on function public.pos_open_orders_commit(uuid, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.pos_open_orders_commit(uuid, uuid, jsonb, jsonb) to service_role;
