-- LOCAL REVIEW ONLY. Hosted application requires separate explicit approval.
-- CUKCUK order merge: orders merged into another order vanish from the POS list and
-- never get a receipt of their own. They may end only when one paid receipt of a
-- surviving order from the same previous snapshot is exactly their combined menu.
-- The single-order paid-receipt proof, lease/writer fence, idempotent replay and the
-- original vanished guard (commit_snapshot_v1) are unchanged. No receipt/ledger/
-- inventory DML. Receipts are only read under the existing share lock.

-- DDL wait budget for this migration transaction only.
set local lock_timeout = '5s';

alter table pos_open_orders_private.orders
  add column closure_merged_into_order_id text,
  add column closure_evidence_hash text;
alter table pos_open_orders_private.orders add constraint orders_merged_closure_check check (
  (closure_merged_into_order_id is null and closure_evidence_hash is null)
  or (closure_merged_into_order_id is not null and closure_receipt_id is not null
    and closure_merged_into_order_id <> order_id and closure_evidence_hash ~ '^[0-9a-f]{32}$'));
comment on column pos_open_orders_private.orders.closure_merged_into_order_id is
  'Surviving order whose single paid receipt (closure_receipt_id) exactly contains this vanished merged order. Status/lines remain last provider facts.';
comment on column pos_open_orders_private.orders.closure_evidence_hash is
  'md5 of the verified receipt menu, target and merged group; later runs keep the closure only while the receipt is unchanged.';

-- True only for a JSON number 0, or an absent/null field.
create function pos_open_orders_private.merge_zero_v1(p_value jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select p_value is null or jsonb_typeof(p_value) = 'null'
    or (jsonb_typeof(p_value) = 'number' and (p_value #>> '{}')::numeric = 0)
$$;

-- Menu of preserved snapshot orders (read_v1 shape), aggregated by item and unit price.
-- Null when any order lacks lines, a header differs from its lines, or a non-canceled
-- line is an option/addition/child or malformed: such merges stay unconfirmed.
create function pos_open_orders_private.merge_order_menu_v1(p_orders jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(p_orders) is distinct from 'array' or jsonb_array_length(p_orders) = 0 then null
    when exists (select 1 from jsonb_array_elements(p_orders) o
      where jsonb_typeof(o->'lines') is distinct from 'array' or jsonb_typeof(o->'totalAmount') is distinct from 'number') then null
    when exists (select 1 from jsonb_array_elements(p_orders) o, jsonb_array_elements(o->'lines') l
      where l->'isCanceled' is distinct from 'true'::jsonb and case
        when l->'isOption' = 'true'::jsonb or l->'isOrphanOption' = 'true'::jsonb then true
        when nullif(btrim(coalesce(l->>'additionId', '')), '') is not null then true
        when nullif(btrim(coalesce(l->>'parentDetailId', '')), '') is not null then true
        when nullif(btrim(coalesce(l->>'itemId', '')), '') is null then true
        when jsonb_typeof(l->'quantity') is distinct from 'number' or jsonb_typeof(l->'price') is distinct from 'number'
          or jsonb_typeof(l->'amount') is distinct from 'number' then true
        when (l->>'quantity')::numeric <= 0 or (l->>'price')::numeric < 0 then true
        else (l->>'amount')::numeric <> (l->>'quantity')::numeric * (l->>'price')::numeric end) then null
    when exists (select 1 from jsonb_array_elements(p_orders) o
      where (o->>'totalAmount')::numeric <> (select coalesce(sum((l->>'amount')::numeric), 0)
        from jsonb_array_elements(o->'lines') l where l->'isCanceled' is distinct from 'true'::jsonb)) then null
    else (select coalesce(jsonb_agg(jsonb_build_object('item', item, 'price', price, 'quantity', quantity, 'amount', amount)
        order by item, price), '[]'::jsonb)
      from (select lower(btrim(l->>'itemId')) item, trim_scale((l->>'price')::numeric) price,
          trim_scale(sum((l->>'quantity')::numeric)) quantity, trim_scale(sum((l->>'amount')::numeric)) amount
        from jsonb_array_elements(p_orders) o, jsonb_array_elements(o->'lines') l
        where l->'isCanceled' is distinct from 'true'::jsonb
        group by 1, 2) m)
  end
$$;

-- Menu of one CUKCUK receipt (SAInvoiceDetails), same aggregation. Null unless every
-- line is a plain item line (RefDetailType 1, no parent/addition, no line promotion
-- or discount) whose amount is quantity x unit price.
create function pos_open_orders_private.merge_receipt_menu_v1(p_raw jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(p_raw->'SAInvoiceDetails') is distinct from 'array' or jsonb_array_length(p_raw->'SAInvoiceDetails') = 0 then null
    when exists (select 1 from jsonb_array_elements(p_raw->'SAInvoiceDetails') d where case
        when jsonb_typeof(d) is distinct from 'object' then true
        when d->'RefDetailType' is distinct from '1'::jsonb then true
        when nullif(btrim(coalesce(d->>'ParentID', '')), '') is not null then true
        when nullif(btrim(coalesce(d->>'InventoryItemAdditionID', '')), '') is not null then true
        when nullif(btrim(coalesce(d->>'ItemID', '')), '') is null then true
        when not (pos_open_orders_private.merge_zero_v1(d->'PromotionAmount') and pos_open_orders_private.merge_zero_v1(d->'PromotionRate')
          and pos_open_orders_private.merge_zero_v1(d->'DiscountRate') and pos_open_orders_private.merge_zero_v1(d->'SAInvoicePromotionAmount')) then true
        when jsonb_typeof(d->'Quantity') is distinct from 'number' or jsonb_typeof(d->'UnitPrice') is distinct from 'number'
          or jsonb_typeof(d->'Amount') is distinct from 'number' then true
        when (d->>'Quantity')::numeric <= 0 or (d->>'UnitPrice')::numeric < 0 then true
        else (d->>'Amount')::numeric <> (d->>'Quantity')::numeric * (d->>'UnitPrice')::numeric end) then null
    else (select jsonb_agg(jsonb_build_object('item', item, 'price', price, 'quantity', quantity, 'amount', amount) order by item, price)
      from (select lower(btrim(d->>'ItemID')) item, trim_scale((d->>'UnitPrice')::numeric) price,
          trim_scale(sum((d->>'Quantity')::numeric)) quantity, trim_scale(sum((d->>'Amount')::numeric)) amount
        from jsonb_array_elements(p_raw->'SAInvoiceDetails') d group by 1, 2) m)
  end
$$;

create or replace function pos_open_orders_private.read_v1(p_scope text, p_business_date date)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'recoveryContractVersion', 3,
    'sync', (select jsonb_build_object('businessDate', s.business_date, 'lastSuccessAt', s.last_success_at,
        'lastAttemptAt', s.last_attempt_at, 'lastErrorCode', s.last_error_code, 'consecutiveFailures', s.consecutive_failures)
      from pos_open_orders_private.sync_state s where s.scope = p_scope),
    'orders', coalesce((select jsonb_agg(jsonb_build_object(
        'orderId', o.order_id, 'orderNo', o.order_no, 'status', o.status, 'statusClass', o.status_class,
        'orderDate', o.order_date, 'businessDate', o.business_date, 'totalAmount', o.total_amount, 'tableName', o.table_name,
        'providerObservedAt', o.observed_at, 'closureReceiptId', o.closure_receipt_id, 'closureConfirmedAt', o.closure_confirmed_at,
        'closureMergedIntoOrderId', o.closure_merged_into_order_id,
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

create or replace function pos_open_orders_private.commit_v1(p_run_id uuid, p_owner_token uuid, p_manifest jsonb, p_orders jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r pos_open_orders_private.runs%rowtype;
  v_previous jsonb; v_payload jsonb := '[]'::jsonb; v_order jsonb; v_old jsonb;
  v_restore jsonb := '[]'::jsonb; v_entry jsonb; v_receipt_id bigint;
  v_active_count integer; v_paid_id bigint; v_result jsonb; v_now timestamptz;
  v_lock_timeout text := current_setting('lock_timeout');
  v_receipt_audit jsonb := '[]'::jsonb; v_cancel_audit jsonb := '[]'::jsonb;
  v_locked boolean := false; v_group record; v_merges jsonb := '{}'::jsonb; v_target_old jsonb;
  v_receipt public.pos_sales_receipts%rowtype; v_receipt_menu jsonb; v_hash text; v_carried boolean; v_group_orders jsonb;
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
  if exists (select 1 from jsonb_array_elements(p_orders) x
      where (x ? 'closureMergedIntoOrderId' and jsonb_typeof(x->'closureMergedIntoOrderId') not in ('string', 'null'))
        or (jsonb_typeof(x->'closureMergedIntoOrderId') = 'string' and x->>'closureReceiptId' is null)) then
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

  -- Merged-order groups. One receipt proves at most one group with one surviving target;
  -- it can never also be single-order proof. Verified once per commit, independent of
  -- any caller-supplied header/status/lines.
  for v_group in
    select x->>'closureReceiptId' receipt_text,
      count(*) filter (where jsonb_typeof(x->'closureMergedIntoOrderId') = 'string') merged_count, count(*) total_count,
      count(distinct x->>'closureMergedIntoOrderId') target_count, min(lower(btrim(x->>'closureMergedIntoOrderId'))) target,
      jsonb_agg(x->>'orderId' order by x->>'orderId') members
    from jsonb_array_elements(p_orders) x where x->>'closureReceiptId' is not null group by 1
  loop
    continue when v_group.merged_count = 0;
    if v_group.merged_count <> v_group.total_count or v_group.target_count <> 1 then
      raise exception 'open_orders_vanished' using errcode = '55000', detail = 'merged_receipt_reused';
    end if;
    if coalesce(v_group.receipt_text, '') !~ '^[1-9][0-9]{0,17}$' then raise exception 'open_orders_payload_invalid' using errcode = '22023'; end if;
    v_receipt_id := v_group.receipt_text::bigint;
    if current_setting('transaction_isolation') <> 'read committed' then
      raise exception 'open_orders_vanished' using errcode = '55000', detail = 'receipt_evidence_requires_read_committed';
    end if;
    -- The surviving order: previous snapshot of this date, present in this payload, not merged away itself.
    select value into v_target_old from jsonb_array_elements(v_previous) where value->>'orderId' = v_group.target;
    if v_target_old is null or v_group.members ? v_group.target
      or not exists (select 1 from jsonb_array_elements(p_orders) x
        where x->>'orderId' = v_group.target and jsonb_typeof(x->'closureMergedIntoOrderId') is distinct from 'string') then
      raise exception 'open_orders_vanished' using errcode = '55000', detail = 'merged_target_invalid';
    end if;
    -- Every merged order was unfinished in the previous snapshot.
    if exists (select 1 from jsonb_array_elements_text(v_group.members) m where not exists (
        select 1 from jsonb_array_elements(v_previous) o where o->>'orderId' = m and o->>'statusClass' in ('open', 'unknown'))) then
      raise exception 'open_orders_vanished' using errcode = '55000', detail = 'merged_member_invalid';
    end if;
    if not v_locked then
      perform set_config('lock_timeout', '10s', true);
      begin
        lock table public.pos_sales_receipts in share mode;
      exception when lock_not_available then
        raise exception 'open_orders_vanished' using errcode = '55000';
      end;
      perform set_config('lock_timeout', v_lock_timeout, true);
      v_locked := true;
    end if;
    -- Exactly one active receipt on the surviving order, and it is this paid receipt.
    select count(*)::integer, min(case when payment_status = 3 then id end) into v_active_count, v_paid_id
      from public.pos_sales_receipts
      where source = 'cukcuk' and business_date in (r.business_date, r.business_date + 1)
        and lower(btrim(raw_json->>'OrderId')) = v_group.target
        and is_canceled is not true and (payment_status is null or payment_status not in (4, 5));
    if v_active_count <> 1 or v_paid_id is distinct from v_receipt_id then
      raise exception 'open_orders_vanished' using errcode = '55000', detail = 'merged_receipt_not_single_paid';
    end if;
    -- A merged order with any active receipt of its own is not a merge: its own proof decides.
    if exists (select 1 from public.pos_sales_receipts
        where source = 'cukcuk' and business_date in (r.business_date, r.business_date + 1)
          and lower(btrim(raw_json->>'OrderId')) in (select jsonb_array_elements_text(v_group.members))
          and is_canceled is not true and (payment_status is null or payment_status not in (4, 5))) then
      raise exception 'open_orders_vanished' using errcode = '55000', detail = 'merged_member_has_receipt';
    end if;
    select * into v_receipt from public.pos_sales_receipts where id = v_receipt_id;
    v_receipt_menu := pos_open_orders_private.merge_receipt_menu_v1(v_receipt.raw_json);
    if v_receipt.branch_id is distinct from r.branch_id or v_receipt_menu is null
      or coalesce(v_receipt.discount_amount, 0) <> 0
      or not (pos_open_orders_private.merge_zero_v1(v_receipt.raw_json->'DiscountAmount')
        and pos_open_orders_private.merge_zero_v1(v_receipt.raw_json->'PromotionAmount')
        and pos_open_orders_private.merge_zero_v1(v_receipt.raw_json->'PromotionItemsAmount'))
      or v_receipt.total_amount is distinct from (select sum((m->>'amount')::numeric) from jsonb_array_elements(v_receipt_menu) m) then
      raise exception 'open_orders_vanished' using errcode = '55000', detail = 'merged_receipt_not_plain';
    end if;
    v_hash := md5(concat_ws('|', v_receipt_id::text, v_group.target, r.branch_id, v_receipt.business_date::text,
      trim_scale(v_receipt.total_amount)::text, v_receipt_menu::text, v_group.members::text));
    -- Later runs: the surviving order is already Status 4 without lines, so the proof is
    -- carried only when every member holds this exact proof and nobody else does.
    select count(*) filter (where o.order_id in (select jsonb_array_elements_text(v_group.members))
          and o.closure_merged_into_order_id = v_group.target and o.closure_evidence_hash = v_hash) = jsonb_array_length(v_group.members)
        and count(*) filter (where o.closure_receipt_id = v_receipt_id and o.closure_merged_into_order_id is not null) = jsonb_array_length(v_group.members)
      into v_carried
      from pos_open_orders_private.orders o where o.scope = r.scope and o.business_date = r.business_date;
    if not v_carried then
      select jsonb_agg(value) into v_group_orders from jsonb_array_elements(v_previous)
        where value->>'orderId' = v_group.target or v_group.members ? (value->>'orderId');
      if pos_open_orders_private.merge_order_menu_v1(v_group_orders) is distinct from v_receipt_menu
        or (select sum((value->>'totalAmount')::numeric) from jsonb_array_elements(v_group_orders)) is distinct from v_receipt.total_amount then
        raise exception 'open_orders_vanished' using errcode = '55000', detail = 'merged_menu_mismatch';
      end if;
    end if;
    v_merges := v_merges || jsonb_build_object(v_receipt_id::text,
      jsonb_build_object('target', v_group.target, 'hash', v_hash, 'carried', v_carried));
  end loop;

  for v_order in select value from jsonb_array_elements(p_orders) loop
    if jsonb_typeof(v_order->'closureMergedIntoOrderId') = 'string' then
      v_receipt_id := (v_order->>'closureReceiptId')::bigint;
      select value into v_old from jsonb_array_elements(v_previous) where value->>'orderId' = v_order->>'orderId';
      if not found then raise exception 'open_orders_payload_invalid' using errcode = '22023'; end if;
      v_now := clock_timestamp();
      v_entry := v_merges->(v_receipt_id::text);
      v_receipt_audit := v_receipt_audit || jsonb_build_array(jsonb_build_object('kind', 'merged_receipt',
        'orderId', v_old->>'orderId', 'receiptId', v_receipt_id, 'mergedIntoOrderId', v_entry->>'target',
        'carried', (v_entry->>'carried')::boolean, 'confirmedAt', v_now, 'previousOrder', v_old));
      v_restore := v_restore || jsonb_build_array(jsonb_build_object('orderId', v_old->>'orderId',
        'observedAt', v_old->>'providerObservedAt', 'receiptId', v_receipt_id, 'confirmedAt', v_now,
        'mergedInto', v_entry->>'target', 'hash', v_entry->>'hash'));
      -- Preserved provider facts only; never a synthesized Status 4.
      v_order := v_old || jsonb_build_object('closureReceiptId', v_receipt_id, 'closureMergedIntoOrderId', v_entry->>'target');
    elsif v_order->>'closureReceiptId' is not null then
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
      if not v_locked then
        perform set_config('lock_timeout', '10s', true);
        begin
          lock table public.pos_sales_receipts in share mode;
        exception when lock_not_available then
          raise exception 'open_orders_vanished' using errcode = '55000';
        end;
        perform set_config('lock_timeout', v_lock_timeout, true);
        v_locked := true;
      end if;
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
      closure_confirmed_at = (v_entry->>'confirmedAt')::timestamptz,
      closure_merged_into_order_id = v_entry->>'mergedInto',
      closure_evidence_hash = v_entry->>'hash'
      where scope = r.scope and business_date = r.business_date and order_id = v_entry->>'orderId';
  end loop;
  if r.lease_until <= clock_timestamp() then raise exception 'open_orders_lease_lost' using errcode = '55000'; end if;
  return v_result;
end $$;

alter function pos_open_orders_private.merge_zero_v1(jsonb) owner to postgres;
alter function pos_open_orders_private.merge_order_menu_v1(jsonb) owner to postgres;
alter function pos_open_orders_private.merge_receipt_menu_v1(jsonb) owner to postgres;
alter function pos_open_orders_private.commit_v1(uuid, uuid, jsonb, jsonb) owner to postgres;
alter function pos_open_orders_private.read_v1(text, date) owner to postgres;
revoke all on function pos_open_orders_private.merge_zero_v1(jsonb) from public, anon, authenticated, service_role;
revoke all on function pos_open_orders_private.merge_order_menu_v1(jsonb) from public, anon, authenticated, service_role;
revoke all on function pos_open_orders_private.merge_receipt_menu_v1(jsonb) from public, anon, authenticated, service_role;
revoke all on function pos_open_orders_private.commit_v1(uuid, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function pos_open_orders_private.commit_v1(uuid, uuid, jsonb, jsonb) to service_role;
