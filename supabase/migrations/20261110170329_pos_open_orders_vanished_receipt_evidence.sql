-- LOCAL REVIEW ONLY. Hosted application requires separate explicit approval.
-- Preserve provider identity/status; a paid-receipt closure is separate evidence.
-- No receipt/ledger/inventory DML. Existing lease and vanished guards remain in the
-- original snapshot function, now callable only by the migration owner.

-- DDL wait budget for this migration transaction only (receipt proof uses 10s at runtime).
set local lock_timeout = '5s';

alter table pos_open_orders_private.orders drop constraint orders_status_class_check;
alter table pos_open_orders_private.orders add constraint orders_status_class_check
  check (status_class in ('open', 'paid_candidate', 'canceled', 'unknown'));
alter table pos_open_orders_private.orders add constraint orders_canceled_status_check
  check (status_class <> 'canceled' or status is not distinct from 5);
alter table pos_open_orders_private.orders
  add column closure_receipt_id bigint,
  add column closure_confirmed_at timestamptz;

create or replace function pos_open_orders_private.read_v1(p_scope text, p_business_date date)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'recoveryContractVersion', 2,
    'sync', (select jsonb_build_object('businessDate', s.business_date, 'lastSuccessAt', s.last_success_at,
        'lastAttemptAt', s.last_attempt_at, 'lastErrorCode', s.last_error_code, 'consecutiveFailures', s.consecutive_failures)
      from pos_open_orders_private.sync_state s where s.scope = p_scope),
    'orders', coalesce((select jsonb_agg(jsonb_build_object(
        'orderId', o.order_id, 'orderNo', o.order_no, 'status', o.status, 'statusClass', o.status_class,
        'orderDate', o.order_date, 'businessDate', o.business_date, 'totalAmount', o.total_amount, 'tableName', o.table_name,
        'providerObservedAt', o.observed_at, 'closureReceiptId', o.closure_receipt_id, 'closureConfirmedAt', o.closure_confirmed_at,
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

alter function pos_open_orders_private.commit_v1(uuid, uuid, jsonb, jsonb) rename to commit_snapshot_v1;
revoke all on function pos_open_orders_private.commit_snapshot_v1(uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;

create function pos_open_orders_private.commit_v1(p_run_id uuid, p_owner_token uuid, p_manifest jsonb, p_orders jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r pos_open_orders_private.runs%rowtype;
  v_previous jsonb; v_payload jsonb := '[]'::jsonb; v_order jsonb; v_old jsonb;
  v_restore jsonb := '[]'::jsonb; v_entry jsonb; v_receipt_id bigint;
  v_active_count integer; v_paid_id bigint; v_result jsonb; v_now timestamptz;
  v_lock_timeout text := current_setting('lock_timeout');
  v_receipt_audit jsonb := '[]'::jsonb; v_cancel_audit jsonb := '[]'::jsonb;
begin
  if p_run_id is null or p_owner_token is null then raise exception 'open_orders_run_conflict' using errcode = '22023'; end if;
  if p_orders is null or p_manifest is null then raise exception 'open_orders_payload_invalid' using errcode = '22023'; end if;
  select * into r from pos_open_orders_private.runs where id = p_run_id;
  if not found or r.owner_token is distinct from p_owner_token then raise exception 'open_orders_run_conflict' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('pos_open_orders:' || r.scope, 0));
  select * into r from pos_open_orders_private.runs where id = p_run_id for update;
  if r.status = 'committed' then
    return pos_open_orders_private.commit_snapshot_v1(p_run_id, p_owner_token, p_manifest, p_orders);
  end if;
  v_now := clock_timestamp();
  if r.status <> 'collecting' or r.lease_until <= v_now then raise exception 'open_orders_lease_lost' using errcode = '55000'; end if;
  if jsonb_typeof(p_orders) is distinct from 'array' or jsonb_typeof(p_manifest) is distinct from 'object'
    or exists (select 1 from jsonb_array_elements(p_orders) x where x->>'businessDate' is distinct from r.business_date::text)
    or (select count(distinct x->>'orderId') from jsonb_array_elements(p_orders) x) <> jsonb_array_length(p_orders) then
    raise exception 'open_orders_payload_invalid' using errcode = '22023';
  end if;
  v_previous := pos_open_orders_private.read_v1(r.scope, r.business_date)->'orders';

  -- Retain already observed Status 5, including old rows still classified unknown.
  -- Do not make the unchanged old vanished guard ignore an unverified order.
  for v_old in select value from jsonb_array_elements(v_previous) loop
    if v_old->>'status' = '5' and not exists (
      select 1 from jsonb_array_elements(p_orders) x where x->>'orderId' = v_old->>'orderId') then
      v_payload := v_payload || jsonb_build_array(v_old || jsonb_build_object('statusClass', 'canceled', 'closureReceiptId', null));
      v_restore := v_restore || jsonb_build_array(jsonb_build_object('orderId', v_old->>'orderId', 'observedAt', v_old->>'providerObservedAt'));
      v_cancel_audit := v_cancel_audit || jsonb_build_array(jsonb_build_object('orderId', v_old->>'orderId',
        'providerStatus', 5, 'providerObservedAt', v_old->>'providerObservedAt'));
    end if;
  end loop;

  for v_order in select value from jsonb_array_elements(p_orders) loop
    if v_order->>'closureReceiptId' is not null then
      -- A repeatable/serializable snapshot can predate the writer we wait for below.
      if current_setting('transaction_isolation') <> 'read committed' then
        raise exception 'open_orders_vanished' using errcode = '55000', detail = 'receipt_evidence_requires_read_committed';
      end if;
      if coalesce(v_order->>'closureReceiptId', '') !~ '^[1-9][0-9]{0,17}$' then
        raise exception 'open_orders_payload_invalid' using errcode = '22023';
      end if;
      v_receipt_id := (v_order->>'closureReceiptId')::bigint;
      select value into v_old from jsonb_array_elements(v_previous) where value->>'orderId' = v_order->>'orderId';
      if not found then raise exception 'open_orders_payload_invalid' using errcode = '22023'; end if;

      -- Only on receipt fallback: prevent a concurrent cancel/reissue/duplicate insert
      -- from changing the proof between validation and snapshot commit. No receipt DML.
      perform set_config('lock_timeout', '10s', true);
      begin
        lock table public.pos_sales_receipts in share mode;
      exception when lock_not_available then
        raise exception 'open_orders_vanished' using errcode = '55000';
      end;
      perform set_config('lock_timeout', v_lock_timeout, true);
      select count(*)::integer, min(case when payment_status = 3 then id end)
        into v_active_count, v_paid_id
        from public.pos_sales_receipts
        where source = 'cukcuk' and business_date in (r.business_date, r.business_date + 1)
          and lower(btrim(raw_json->>'OrderId')) = v_old->>'orderId'
          and is_canceled is not true and (payment_status is null or payment_status not in (4, 5));
      if v_active_count <> 1 or v_paid_id is distinct from v_receipt_id then
        raise exception 'open_orders_vanished' using errcode = '55000';
      end if;
      v_now := clock_timestamp();
      v_receipt_audit := v_receipt_audit || jsonb_build_array(jsonb_build_object('kind', 'paid_receipt',
        'orderId', v_old->>'orderId', 'receiptId', v_receipt_id, 'confirmedAt', v_now, 'previousOrder', v_old));
      v_restore := v_restore || jsonb_build_array(jsonb_build_object('orderId', v_old->>'orderId',
        'observedAt', v_old->>'providerObservedAt', 'receiptId', v_receipt_id, 'confirmedAt', v_now));
      -- Do not trust caller-supplied header/status/lines or synthesize a provider Id.
      v_order := v_old || jsonb_build_object('closureReceiptId', v_receipt_id);
    end if;
    v_payload := v_payload || jsonb_build_array(v_order);
  end loop;

  v_result := pos_open_orders_private.commit_snapshot_v1(p_run_id, p_owner_token,
    p_manifest || jsonb_build_object('receiptClosures', v_receipt_audit, 'retainedCancellations', v_cancel_audit), v_payload);
  for v_entry in select value from jsonb_array_elements(v_restore) loop
    update pos_open_orders_private.orders set observed_at = (v_entry->>'observedAt')::timestamptz,
      closure_receipt_id = (v_entry->>'receiptId')::bigint,
      closure_confirmed_at = (v_entry->>'confirmedAt')::timestamptz
      where scope = r.scope and business_date = r.business_date and order_id = v_entry->>'orderId';
  end loop;
  if r.lease_until <= clock_timestamp() then raise exception 'open_orders_lease_lost' using errcode = '55000'; end if;
  return v_result;
end $$;

alter function pos_open_orders_private.commit_v1(uuid, uuid, jsonb, jsonb) owner to postgres;
alter function pos_open_orders_private.read_v1(text, date) owner to postgres;
revoke all on function pos_open_orders_private.commit_v1(uuid, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function pos_open_orders_private.commit_v1(uuid, uuid, jsonb, jsonb) to service_role;
comment on column pos_open_orders_private.orders.closure_receipt_id is
  'Independent paid receipt evidence; status/order_id/observed_at remain last provider facts. Revalidated on each fallback commit.';

-- Refresh SQL-wrapper resolution after renaming the old implementation.
create or replace function public.pos_open_orders_commit(p_run_id uuid, p_owner_token uuid, p_manifest jsonb, p_orders jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
  select pos_open_orders_private.commit_v1(p_run_id, p_owner_token, p_manifest, p_orders)
$$;
revoke all on function public.pos_open_orders_commit(uuid, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.pos_open_orders_commit(uuid, uuid, jsonb, jsonb) to service_role;
