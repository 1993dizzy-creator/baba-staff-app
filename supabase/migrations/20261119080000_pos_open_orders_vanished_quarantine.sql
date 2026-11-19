-- LOCAL REVIEW ONLY. Hosted application requires separate explicit approval.
-- Partial collection (2026-11-18 incident): after a POS table move/merge, a previously
-- unfinished order can vanish with an identity-less detail while no receipt proves its
-- ending (no receipt yet, or one with options/custom items/changed menu). Instead of
-- failing every run for the rest of the business day, such an order may be committed as
-- QUARANTINED: its last provider facts (status, amount, lines, observed_at) are preserved
-- unchanged, it is flagged, and every other order is refreshed normally.
--
-- Unchanged: the lease/writer fence, idempotent replay, the original vanished guard
-- (commit_snapshot_v1), the single-order and merged-receipt proofs (renamed below to
-- commit_merge_v1 without body changes), retention, roles and grants.
-- No receipt/ledger/inventory/payroll DML. Receipts are not read by this layer.
-- A quarantined row is never an ending: readers exclude it from open estimates and paid
-- sales, and the cleaning/auto-normal evidence keeps blocking its table (status 1/3 row
-- without its own paid receipt).

-- DDL wait budget for this migration transaction only.
set local lock_timeout = '5s';

alter table pos_open_orders_private.orders
  add column quarantined_at timestamptz,
  add column quarantine_reason text;
alter table pos_open_orders_private.orders add constraint orders_quarantine_check check (
  (quarantined_at is null and quarantine_reason is null)
  or (quarantined_at is not null and quarantine_reason = 'vanished_unconfirmed'
    and closure_receipt_id is null and closure_merged_into_order_id is null and status_class in ('open', 'unknown')));
comment on column pos_open_orders_private.orders.quarantined_at is
  'First time this previously unfinished order vanished without a provable ending. Its status/lines/amount/observed_at are the last provider facts, never a fresh observation.';
comment on column pos_open_orders_private.orders.quarantine_reason is
  'vanished_unconfirmed only. Re-evaluated every run: a later listing, detail or exact receipt proof replaces it.';

-- Contract 4: the collector may send quarantined orders only to this read version.
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

-- The 2026-11-14 commit (receipt and merge proofs) is kept byte-for-byte as an internal step.
alter function pos_open_orders_private.commit_v1(uuid, uuid, jsonb, jsonb) rename to commit_merge_v1;
revoke all on function pos_open_orders_private.commit_merge_v1(uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;

create function pos_open_orders_private.commit_v1(p_run_id uuid, p_owner_token uuid, p_manifest jsonb, p_orders jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r pos_open_orders_private.runs%rowtype;
  v_previous jsonb; v_payload jsonb := '[]'::jsonb; v_order jsonb; v_old jsonb; v_entry jsonb;
  v_restore jsonb := '[]'::jsonb; v_audit jsonb := '[]'::jsonb; v_ids jsonb := '[]'::jsonb;
  v_count integer; v_result jsonb; v_now timestamptz;
begin
  if p_run_id is null or p_owner_token is null then raise exception 'open_orders_run_conflict' using errcode = '22023'; end if;
  if p_orders is null or p_manifest is null then raise exception 'open_orders_payload_invalid' using errcode = '22023'; end if;
  select * into r from pos_open_orders_private.runs where id = p_run_id;
  if not found or r.owner_token is distinct from p_owner_token then raise exception 'open_orders_run_conflict' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('pos_open_orders:' || r.scope, 0));
  select * into r from pos_open_orders_private.runs where id = p_run_id for update;
  if jsonb_typeof(p_orders) is distinct from 'array' or jsonb_typeof(p_manifest) is distinct from 'object' then
    raise exception 'open_orders_payload_invalid' using errcode = '22023';
  end if;
  select count(*)::integer into v_count from jsonb_array_elements(p_orders) x where x ? 'quarantineReason';
  -- The manifest must state exactly what the payload quarantines (absent means none).
  if coalesce(p_manifest->'quarantinedCount', '0'::jsonb) is distinct from to_jsonb(v_count) then
    raise exception 'open_orders_payload_invalid' using errcode = '22023';
  end if;
  -- Replay, lease loss and ordinary full snapshots: the unchanged commit decides.
  if v_count = 0 or r.status <> 'collecting' or r.lease_until <= clock_timestamp() then
    return pos_open_orders_private.commit_merge_v1(p_run_id, p_owner_token, p_manifest, p_orders);
  end if;
  -- Same bound as the collector's vanished re-read limit.
  if v_count > 20 then raise exception 'open_orders_vanished' using errcode = '55000', detail = 'quarantine_limit'; end if;
  v_previous := pos_open_orders_private.read_v1(r.scope, r.business_date)->'orders';

  for v_order in select value from jsonb_array_elements(p_orders) loop
    if v_order ? 'quarantineReason' then
      if jsonb_typeof(v_order->'quarantineReason') is distinct from 'string' or v_order->>'quarantineReason' <> 'vanished_unconfirmed'
        or jsonb_typeof(v_order->'orderId') is distinct from 'string'
        or coalesce(jsonb_typeof(v_order->'closureReceiptId'), 'null') <> 'null'
        or coalesce(jsonb_typeof(v_order->'closureMergedIntoOrderId'), 'null') <> 'null' then
        raise exception 'open_orders_payload_invalid' using errcode = '22023';
      end if;
      v_old := null;
      select value into v_old from jsonb_array_elements(v_previous) where value->>'orderId' = v_order->>'orderId';
      -- Only an order this date's current snapshot holds as unfinished and not already
      -- closed by receipt/merge evidence may be quarantined.
      if v_old is null or v_old->>'statusClass' not in ('open', 'unknown') or v_old->>'status' = '5'
        or v_old->>'closureReceiptId' is not null or v_old->>'closureMergedIntoOrderId' is not null then
        raise exception 'open_orders_vanished' using errcode = '55000', detail = 'quarantine_member_invalid';
      end if;
      v_now := clock_timestamp();
      v_ids := v_ids || to_jsonb(v_old->>'orderId');
      v_restore := v_restore || jsonb_build_array(jsonb_build_object('orderId', v_old->>'orderId',
        'observedAt', v_old->>'providerObservedAt', 'quarantinedAt', coalesce(v_old->>'quarantinedAt', v_now::text)));
      v_audit := v_audit || jsonb_build_array(jsonb_build_object('orderId', v_old->>'orderId', 'reason', 'vanished_unconfirmed',
        'quarantinedAt', coalesce(v_old->>'quarantinedAt', v_now::text), 'carried', v_old->>'quarantinedAt' is not null,
        'confirmedAt', v_now, 'previousOrder', v_old));
      -- Preserved provider facts only: caller-supplied header/status/lines are never stored.
      v_order := v_old - 'quarantinedAt' - 'quarantineReason';
    end if;
    v_payload := v_payload || jsonb_build_array(v_order);
  end loop;
  -- A quarantined order is not a surviving merge target (that needs a current listing).
  if exists (select 1 from jsonb_array_elements(p_orders) x
      where jsonb_typeof(x->'closureMergedIntoOrderId') = 'string' and v_ids ? lower(btrim(x->>'closureMergedIntoOrderId'))) then
    raise exception 'open_orders_vanished' using errcode = '55000', detail = 'quarantine_merge_target';
  end if;

  v_result := pos_open_orders_private.commit_merge_v1(p_run_id, p_owner_token, p_manifest, v_payload);
  for v_entry in select value from jsonb_array_elements(v_restore) loop
    update pos_open_orders_private.orders set observed_at = (v_entry->>'observedAt')::timestamptz,
      quarantined_at = (v_entry->>'quarantinedAt')::timestamptz, quarantine_reason = 'vanished_unconfirmed'
      where scope = r.scope and business_date = r.business_date and order_id = v_entry->>'orderId';
    if not found then raise exception 'open_orders_payload_invalid' using errcode = '22023'; end if;
  end loop;
  update pos_open_orders_private.runs set manifest = manifest || jsonb_build_object('quarantinedOrders', v_audit) where id = r.id;
  if r.lease_until <= clock_timestamp() then raise exception 'open_orders_lease_lost' using errcode = '55000'; end if;
  return v_result || jsonb_build_object('quarantined', v_count);
end $$;

alter function pos_open_orders_private.commit_merge_v1(uuid, uuid, jsonb, jsonb) owner to postgres;
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
