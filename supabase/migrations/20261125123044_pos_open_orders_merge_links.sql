-- NOT APPLIED. Owner approval is required. Follow-up only: never edit/replay 20261109210000,
-- 20261110170329, 20261114161500, 20261119080000 or 20261119144531. Supersedes the never-applied
-- 20261125115152 (removed before application: its quarantine-based "absorbed" proof could close
-- an unrelated quarantined order with a look-alike menu).
--
-- Merge links, contract 6 (production 2026-11-24, receipt #9081): table 2's order was merged in
-- POS into BAR9 at 22:12 (TableName "BAR9, 2", new detail IDs) and stayed quarantined until 03:00.
-- A POS merge is a RELATION observed before payment, never a payment:
--   * The collector links a vanished order M to a listed order T only from the same run's
--     evidence; this commit re-verifies every new link independently:
--       B (existing T): same id/start time in the previous snapshot, still plain open; T keeps
--         its previous tables and newly adds M's single table; one fresh vanished order per added
--         table; T's menu (item ID or exact manual name, price, quantity, amount) and header =
--         previous T + new members exactly.
--       C (new T): >= 2 new members whose tables are exactly T's tables; T = their sum exactly;
--         T started no earlier than any member.
--     M keeps its last provider facts (status, lines, amount, observed_at) plus
--     merge_target_order_id / merge_linked_at / merge_target_table.
--   * A stored link is carried only while T is listed and still open with M's table in its
--     TableName and M's menu inside its menu, or T is Status 4 (POS dropped its lines).
--     Otherwise the collector releases it and M follows the unchanged quarantine rules.
--   * Payment: T's single active paid receipt (same/next day, same branch) that names M's table
--     and is at least M's amount closes M as merged into T (existing closure columns; link kept
--     as history). The menu was proven when the link was made, so T's lines are not needed
--     (receipt saved after T reached Status 4).
--   * Exact manual lines also count for the existing "surviving + merged = receipt" proof.
--
-- Unchanged: the lease/writer fence, replay, single-order receipt proof, the SHARE lock, the
-- carried-proof rule, quarantine and last-table layers (renamed below without body changes),
-- retention, roles and grants, every cleaning/auto-normal function (merge membership still
-- blocks cleaning). No receipt, ledger, inventory or payroll DML.

-- DDL wait budget for this migration transaction only.
set local lock_timeout = '5s';

alter table pos_open_orders_private.orders
  add column merge_target_order_id text,
  add column merge_linked_at timestamptz,
  add column merge_target_table text;
alter table pos_open_orders_private.orders add constraint orders_merge_link_check check (
  (merge_target_order_id is null and merge_linked_at is null and merge_target_table is null)
  or (merge_target_order_id is not null and merge_linked_at is not null and nullif(btrim(merge_target_table), '') is not null
    and merge_target_order_id <> order_id and quarantined_at is null
    and ((closure_receipt_id is null and closure_merged_into_order_id is null)
      or closure_merged_into_order_id = merge_target_order_id)));
comment on column pos_open_orders_private.orders.merge_target_order_id is
  'Merged in POS into this order (verified relation, not a payment). With a closure it is history of that same merge.';
comment on column pos_open_orders_private.orders.merge_linked_at is 'First commit that verified the merge link.';
comment on column pos_open_orders_private.orders.merge_target_table is 'Target TableName when the link was verified (e.g. "BAR9, 2").';

-- Sorted distinct table names of a POS TableName ("BAR9, 2" -> {2,BAR9}); null when absent or
-- when any part is empty or repeated.
create function pos_open_orders_private.merge_table_tokens_v1(p_name text)
returns text[] language sql immutable set search_path = '' as $$
  select case
    when p_name is null then null
    when exists (select 1 from unnest(string_to_array(p_name, ',')) t where btrim(t, E' \t\r\n') = '') then null
    when (select count(*) <> count(distinct btrim(t, E' \t\r\n')) from unnest(string_to_array(p_name, ',')) t) then null
    else (select array_agg(btrim(t, E' \t\r\n') order by btrim(t, E' \t\r\n')) from unnest(string_to_array(p_name, ',')) t)
  end
$$;

-- merge_order_menu_v1 plus manual lines: a line without itemId is keyed by its exact name.
create function pos_open_orders_private.merge_order_menu_v2(p_orders jsonb)
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
        when nullif(btrim(coalesce(l->>'itemId', '')), '') is null
          and coalesce(btrim(l->>'itemName', E' \t\r\n'), '') = '' then true
        when jsonb_typeof(l->'quantity') is distinct from 'number' or jsonb_typeof(l->'price') is distinct from 'number'
          or jsonb_typeof(l->'amount') is distinct from 'number' then true
        when (l->>'quantity')::numeric <= 0 or (l->>'price')::numeric < 0 then true
        else (l->>'amount')::numeric <> (l->>'quantity')::numeric * (l->>'price')::numeric end) then null
    when exists (select 1 from jsonb_array_elements(p_orders) o
      where (o->>'totalAmount')::numeric <> (select coalesce(sum((l->>'amount')::numeric), 0)
        from jsonb_array_elements(o->'lines') l where l->'isCanceled' is distinct from 'true'::jsonb)) then null
    else (select coalesce(jsonb_agg(jsonb_build_object('item', item, 'price', price, 'quantity', quantity, 'amount', amount)
        order by item, price), '[]'::jsonb)
      from (select coalesce(lower(nullif(btrim(coalesce(l->>'itemId', '')), '')), 'name:' || btrim(l->>'itemName', E' \t\r\n')) item,
          trim_scale((l->>'price')::numeric) price,
          trim_scale(sum((l->>'quantity')::numeric)) quantity, trim_scale(sum((l->>'amount')::numeric)) amount
        from jsonb_array_elements(p_orders) o, jsonb_array_elements(o->'lines') l
        where l->'isCanceled' is distinct from 'true'::jsonb
        group by 1, 2) m)
  end
$$;

-- merge_receipt_menu_v1 plus manual lines: RefDetailType 3 without ItemID, keyed by exact name.
-- Every other line type (options 2, unknown), parents, additions and line promotions stay null.
create function pos_open_orders_private.merge_receipt_menu_v2(p_raw jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(p_raw->'SAInvoiceDetails') is distinct from 'array' or jsonb_array_length(p_raw->'SAInvoiceDetails') = 0 then null
    when exists (select 1 from jsonb_array_elements(p_raw->'SAInvoiceDetails') d where case
        when jsonb_typeof(d) is distinct from 'object' then true
        when d->'RefDetailType' = '1'::jsonb then jsonb_typeof(d->'ItemID') is distinct from 'string' or btrim(d->>'ItemID') = ''
        when d->'RefDetailType' = '3'::jsonb then nullif(btrim(coalesce(d->>'ItemID', '')), '') is not null
          or jsonb_typeof(d->'ItemName') is distinct from 'string' or btrim(d->>'ItemName', E' \t\r\n') = ''
        else true end
      or case
        when nullif(btrim(coalesce(d->>'ParentID', '')), '') is not null then true
        when nullif(btrim(coalesce(d->>'InventoryItemAdditionID', '')), '') is not null then true
        when not (pos_open_orders_private.merge_zero_v1(d->'PromotionAmount') and pos_open_orders_private.merge_zero_v1(d->'PromotionRate')
          and pos_open_orders_private.merge_zero_v1(d->'DiscountRate') and pos_open_orders_private.merge_zero_v1(d->'SAInvoicePromotionAmount')) then true
        when jsonb_typeof(d->'Quantity') is distinct from 'number' or jsonb_typeof(d->'UnitPrice') is distinct from 'number'
          or jsonb_typeof(d->'Amount') is distinct from 'number' then true
        when (d->>'Quantity')::numeric <= 0 or (d->>'UnitPrice')::numeric < 0 then true
        else (d->>'Amount')::numeric <> (d->>'Quantity')::numeric * (d->>'UnitPrice')::numeric end) then null
    else (select jsonb_agg(jsonb_build_object('item', item, 'price', price, 'quantity', quantity, 'amount', amount) order by item, price)
      from (select case when d->'RefDetailType' = '1'::jsonb then lower(btrim(d->>'ItemID'))
            else 'name:' || btrim(d->>'ItemName', E' \t\r\n') end item,
          trim_scale((d->>'UnitPrice')::numeric) price,
          trim_scale(sum((d->>'Quantity')::numeric)) quantity, trim_scale(sum((d->>'Amount')::numeric)) amount
        from jsonb_array_elements(p_raw->'SAInvoiceDetails') d group by 1, 2) m)
  end
$$;


-- True when every item/price of p_part is in p_whole with at least its quantity and amount.
create function pos_open_orders_private.merge_menu_within_v1(p_part jsonb, p_whole jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select p_part is not null and p_whole is not null and not exists (select 1 from jsonb_array_elements(p_part) m where not exists (
    select 1 from jsonb_array_elements(p_whole) w where w->>'item' = m->>'item' and (w->>'price')::numeric = (m->>'price')::numeric
      and (w->>'quantity')::numeric >= (m->>'quantity')::numeric and (w->>'amount')::numeric >= (m->>'amount')::numeric))
$$;

-- Same as 20261119144531 plus the three merge-link fields; 'recoveryContractVersion' 6.
create or replace function pos_open_orders_private.read_v1(p_scope text, p_business_date date)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'recoveryContractVersion', 6,
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
        'mergeTargetOrderId', o.merge_target_order_id, 'mergeLinkedAt', o.merge_linked_at, 'mergeTargetTable', o.merge_target_table,
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

-- 20261114161500 commit (renamed commit_merge_v1 by 20261119080000). Only the merged-group
-- verification changes: v2 menus, and a group whose members are all linked to its target is
-- verified by the link + receipt (no menu re-match). Everything else is the same.
create or replace function pos_open_orders_private.commit_merge_v1(p_run_id uuid, p_owner_token uuid, p_manifest jsonb, p_orders jsonb)
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
  v_member_orders jsonb; v_tables text[]; v_link boolean;
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
    v_target_old := null;
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
    -- Contract 6: identical to v1 for item-only receipts; also exact manual lines.
    v_receipt_menu := pos_open_orders_private.merge_receipt_menu_v2(v_receipt.raw_json);
    -- A merge link verified before payment (every member linked to this very target).
    select jsonb_agg(value) into v_member_orders from jsonb_array_elements(v_previous) where v_group.members ? (value->>'orderId');
    v_link := coalesce(jsonb_array_length(v_member_orders), 0) = jsonb_array_length(v_group.members)
      and not exists (select 1 from jsonb_array_elements(v_member_orders) m
        where lower(btrim(coalesce(m->>'mergeTargetOrderId', ''))) is distinct from v_group.target);
    if v_link then
      v_tables := pos_open_orders_private.merge_table_tokens_v1(v_receipt.raw_json->>'TableName');
      if v_receipt.branch_id is distinct from r.branch_id or v_tables is null or v_receipt.total_amount is null
        or exists (select 1 from jsonb_array_elements(v_member_orders) m
          where coalesce(cardinality(pos_open_orders_private.merge_table_tokens_v1(m->>'tableName')), 0) <> 1
            or not ((pos_open_orders_private.merge_table_tokens_v1(m->>'tableName'))[1] = any(v_tables)))
        or v_receipt.total_amount < (select sum((m->>'totalAmount')::numeric) from jsonb_array_elements(v_member_orders) m) then
        raise exception 'open_orders_vanished' using errcode = '55000', detail = 'merged_link_receipt_invalid';
      end if;
      v_hash := md5(concat_ws('|', 'link', v_receipt_id::text, v_group.target, r.branch_id, v_receipt.business_date::text,
        trim_scale(v_receipt.total_amount)::text, coalesce(v_receipt_menu::text, ''), v_group.members::text));
    else
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
    end if;
    -- Later runs: the surviving order is already Status 4 without lines, so the proof is
    -- carried only when every member holds this exact proof and nobody else does.
    select count(*) filter (where o.order_id in (select jsonb_array_elements_text(v_group.members))
          and o.closure_merged_into_order_id = v_group.target and o.closure_evidence_hash = v_hash) = jsonb_array_length(v_group.members)
        and count(*) filter (where o.closure_receipt_id = v_receipt_id and o.closure_merged_into_order_id is not null) = jsonb_array_length(v_group.members)
      into v_carried
      from pos_open_orders_private.orders o where o.scope = r.scope and o.business_date = r.business_date;
    if not v_carried and not v_link then
      select jsonb_agg(value) into v_group_orders from jsonb_array_elements(v_previous)
        where value->>'orderId' = v_group.target or v_group.members ? (value->>'orderId');
      -- Surviving + merged = receipt (the 20261114161500 proof, now with exact manual lines).
      if pos_open_orders_private.merge_order_menu_v2(v_group_orders) is distinct from v_receipt_menu
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

-- The 2026-11-19 last-table commit is kept byte-for-byte as an internal step.
alter function pos_open_orders_private.commit_v1(uuid, uuid, jsonb, jsonb) rename to commit_last_table_v1;
revoke all on function pos_open_orders_private.commit_last_table_v1(uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;

-- Merge-link layer. Payload rows with "mergeTargetOrderId" are verified here and replaced by
-- their preserved previous row before the unchanged inner commit; the link is stored after it.
create function pos_open_orders_private.commit_v1(p_run_id uuid, p_owner_token uuid, p_manifest jsonb, p_orders jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r pos_open_orders_private.runs%rowtype;
  v_previous jsonb; v_payload jsonb := '[]'::jsonb; v_order jsonb; v_old jsonb; v_target jsonb; v_target_old jsonb;
  v_links jsonb := '[]'::jsonb; v_history jsonb; v_group record; v_new jsonb; v_carried jsonb; v_m jsonb;
  v_tables text[]; v_old_tables text[]; v_new_tables text[]; v_result jsonb; v_now timestamptz; v_entry jsonb;
begin
  select * into r from pos_open_orders_private.runs where id = p_run_id;
  -- Unknown run, malformed payload, nothing linked now or before: the unchanged commit decides.
  if not found or p_orders is null or jsonb_typeof(p_orders) is distinct from 'array' then
    return pos_open_orders_private.commit_last_table_v1(p_run_id, p_owner_token, p_manifest, p_orders);
  end if;
  if not exists (select 1 from jsonb_array_elements(p_orders) x where x ? 'mergeTargetOrderId')
    and not exists (select 1 from pos_open_orders_private.orders o
      where o.scope = r.scope and o.business_date = r.business_date and o.merge_target_order_id is not null) then
    return pos_open_orders_private.commit_last_table_v1(p_run_id, p_owner_token, p_manifest, p_orders);
  end if;
  -- Same writer lock the inner commits take (re-entrant).
  perform pg_advisory_xact_lock(hashtextextended('pos_open_orders:' || r.scope, 0));
  select * into r from pos_open_orders_private.runs where id = p_run_id for update;
  -- Replay, owner conflict and lease loss: the unchanged commit decides (and raises).
  if r.owner_token is distinct from p_owner_token or r.status <> 'collecting' or r.lease_until <= clock_timestamp()
    or p_manifest is null or jsonb_typeof(p_manifest) is distinct from 'object' then
    return pos_open_orders_private.commit_last_table_v1(p_run_id, p_owner_token, p_manifest, p_orders);
  end if;
  v_previous := pos_open_orders_private.read_v1(r.scope, r.business_date)->'orders';
  select coalesce(jsonb_agg(value), '[]'::jsonb) into v_history from jsonb_array_elements(v_previous) where value->>'mergeTargetOrderId' is not null;

  if exists (select 1 from jsonb_array_elements(p_orders) x where x ? 'mergeTargetOrderId' and (
      jsonb_typeof(x->'mergeTargetOrderId') is distinct from 'string' or jsonb_typeof(x->'orderId') is distinct from 'string'
      or x ? 'quarantineReason' or coalesce(jsonb_typeof(x->'closureReceiptId'), 'null') <> 'null'
      or coalesce(jsonb_typeof(x->'closureMergedIntoOrderId'), 'null') <> 'null'
      or lower(btrim(x->>'mergeTargetOrderId')) = x->>'orderId')) then
    raise exception 'open_orders_payload_invalid' using errcode = '22023';
  end if;
  if (select count(distinct x->>'orderId') from jsonb_array_elements(p_orders) x) <> jsonb_array_length(p_orders) then
    raise exception 'open_orders_payload_invalid' using errcode = '22023';
  end if;

  for v_group in
    select lower(btrim(x->>'mergeTargetOrderId')) target, jsonb_agg(x->>'orderId' order by x->>'orderId') members
    from jsonb_array_elements(p_orders) x where x ? 'mergeTargetOrderId' group by 1
  loop
    -- The target: a plain row of this payload (not linked, merged away or quarantined itself).
    v_target := null;
    select value into v_target from jsonb_array_elements(p_orders) where value->>'orderId' = v_group.target;
    if v_target is null or v_target ? 'mergeTargetOrderId' or v_target ? 'quarantineReason'
      or jsonb_typeof(v_target->'closureMergedIntoOrderId') = 'string' then
      raise exception 'open_orders_vanished' using errcode = '55000', detail = 'merge_target_invalid';
    end if;
    -- Members: unfinished rows of this date's snapshot, never quarantined/closed, one single table.
    if exists (select 1 from jsonb_array_elements_text(v_group.members) id where not exists (
        select 1 from jsonb_array_elements(v_previous) o where o->>'orderId' = id
          and o->>'statusClass' in ('open', 'unknown') and o->>'status' is distinct from '5'
          and o->>'closureReceiptId' is null and o->>'quarantinedAt' is null and jsonb_typeof(o->'lines') = 'array'
          and cardinality(pos_open_orders_private.merge_table_tokens_v1(o->>'tableName')) = 1
          and (o->>'mergeTargetOrderId' is null or lower(btrim(o->>'mergeTargetOrderId')) = v_group.target))) then
      raise exception 'open_orders_vanished' using errcode = '55000', detail = 'merge_member_invalid';
    end if;
    select coalesce(jsonb_agg(o) filter (where o->>'mergeTargetOrderId' is null), '[]'::jsonb),
        coalesce(jsonb_agg(o) filter (where o->>'mergeTargetOrderId' is not null), '[]'::jsonb)
      into v_new, v_carried
      from jsonb_array_elements(v_previous) o where v_group.members ? (o->>'orderId');
    -- Carried links: target still open with the member's table and menu, or a payment candidate.
    for v_m in select value from jsonb_array_elements(v_carried) loop
      if not coalesce(case when jsonb_typeof(v_target->'lines') = 'array' then
          v_target->>'statusClass' in ('open', 'unknown') and v_target->>'status' is distinct from '5'
          and (pos_open_orders_private.merge_table_tokens_v1(v_m->>'tableName'))[1]
            = any(coalesce(pos_open_orders_private.merge_table_tokens_v1(v_target->>'tableName'), '{}'::text[]))
          and pos_open_orders_private.merge_menu_within_v1(pos_open_orders_private.merge_order_menu_v2(jsonb_build_array(v_m)),
            pos_open_orders_private.merge_order_menu_v2(jsonb_build_array(v_target)))
        else v_target->>'status' = '4' end, false) then
        raise exception 'open_orders_vanished' using errcode = '55000', detail = 'merge_link_invalid';
      end if;
    end loop;
    -- New links: re-verified from the previous snapshot and this payload only.
    if jsonb_array_length(v_new) > 0 then
      v_tables := pos_open_orders_private.merge_table_tokens_v1(v_target->>'tableName');
      select pos_open_orders_private.merge_table_tokens_v1(string_agg((pos_open_orders_private.merge_table_tokens_v1(m->>'tableName'))[1], ','))
        into v_new_tables from jsonb_array_elements(v_new) m;
      v_target_old := null;
      select value into v_target_old from jsonb_array_elements(v_previous) where value->>'orderId' = v_group.target;
      if jsonb_typeof(v_target->'lines') is distinct from 'array' or coalesce(v_target->>'statusClass' not in ('open', 'unknown'), true)
        or v_target->>'status' = '5' or coalesce(cardinality(v_tables), 0) < 2
        or v_new_tables is null or cardinality(v_new_tables) <> jsonb_array_length(v_new) or not (v_new_tables <@ v_tables) then
        raise exception 'open_orders_vanished' using errcode = '55000', detail = 'merge_link_tables';
      end if;
      if v_target_old is not null then
        -- B: an existing order newly adds the members' tables and exactly their menus.
        v_old_tables := pos_open_orders_private.merge_table_tokens_v1(v_target_old->>'tableName');
        if coalesce((v_target_old->>'orderDate')::timestamptz is distinct from (v_target->>'orderDate')::timestamptz
          or v_target_old->>'statusClass' not in ('open', 'unknown') or v_target_old->>'status' = '5'
          or jsonb_typeof(v_target_old->'lines') is distinct from 'array'
          or v_target_old->>'closureReceiptId' is not null or v_target_old->>'quarantinedAt' is not null
          or v_target_old->>'mergeTargetOrderId' is not null
          or v_old_tables is null or not (v_old_tables <@ v_tables) or v_new_tables && v_old_tables
          or pos_open_orders_private.merge_order_menu_v2(jsonb_build_array(v_target_old) || v_new)
            is distinct from pos_open_orders_private.merge_order_menu_v2(jsonb_build_array(v_target))
          or pos_open_orders_private.merge_order_menu_v2(jsonb_build_array(v_target)) is null
          or (v_target_old->>'totalAmount')::numeric + (select sum((m->>'totalAmount')::numeric) from jsonb_array_elements(v_new) m)
            is distinct from (v_target->>'totalAmount')::numeric, true) then
          raise exception 'open_orders_vanished' using errcode = '55000', detail = 'merge_link_mismatch';
        end if;
      else
        -- C: a new order is exactly >= 2 vanished orders, one per table, started after them.
        if coalesce(jsonb_array_length(v_carried) > 0 or jsonb_array_length(v_new) < 2 or v_new_tables is distinct from v_tables
          or pos_open_orders_private.merge_order_menu_v2(v_new) is distinct from pos_open_orders_private.merge_order_menu_v2(jsonb_build_array(v_target))
          or pos_open_orders_private.merge_order_menu_v2(v_new) is null
          or (select sum((m->>'totalAmount')::numeric) from jsonb_array_elements(v_new) m) is distinct from (v_target->>'totalAmount')::numeric
          or exists (select 1 from jsonb_array_elements(v_new) m where (m->>'orderDate')::timestamptz > (v_target->>'orderDate')::timestamptz), true) then
          raise exception 'open_orders_vanished' using errcode = '55000', detail = 'merge_link_mismatch';
        end if;
      end if;
      -- No other order that vanished in this run (quarantined, receipt-closed or linked elsewhere)
      -- sat on a newly merged table: which one merged would be ambiguous.
      if exists (select 1 from jsonb_array_elements(p_orders) x join jsonb_array_elements(v_previous) o on o->>'orderId' = x->>'orderId'
          where not (v_group.members ? (x->>'orderId'))
            and (x ? 'quarantineReason' or x->>'closureReceiptId' is not null or x ? 'mergeTargetOrderId')
            and o->>'quarantinedAt' is null and o->>'mergeTargetOrderId' is null and o->>'closureReceiptId' is null
            and o->>'closureMergedIntoOrderId' is null
            and coalesce(pos_open_orders_private.merge_table_tokens_v1(o->>'tableName'), '{}'::text[]) && v_new_tables) then
        raise exception 'open_orders_vanished' using errcode = '55000', detail = 'merge_link_ambiguous';
      end if;
    end if;
    v_now := clock_timestamp();
    for v_m in select value from jsonb_array_elements(v_new || v_carried) loop
      v_links := v_links || jsonb_build_array(jsonb_build_object('orderId', v_m->>'orderId', 'target', v_group.target,
        'linkedAt', coalesce(v_m->>'mergeLinkedAt', v_now::text), 'table', coalesce(v_m->>'mergeTargetTable', v_target->>'tableName'),
        'observedAt', v_m->>'providerObservedAt', 'carried', v_m->>'mergeTargetOrderId' is not null));
    end loop;
  end loop;

  for v_order in select value from jsonb_array_elements(p_orders) loop
    if v_order ? 'mergeTargetOrderId' then
      select value into v_old from jsonb_array_elements(v_previous) where value->>'orderId' = v_order->>'orderId';
      -- Preserved provider facts only: caller-supplied header/status/lines are never stored.
      v_order := v_old - 'mergeTargetOrderId' - 'mergeLinkedAt' - 'mergeTargetTable' - 'quarantinedAt' - 'quarantineReason';
    end if;
    v_payload := v_payload || jsonb_build_array(v_order);
  end loop;

  v_result := pos_open_orders_private.commit_last_table_v1(p_run_id, p_owner_token,
    case when jsonb_array_length(v_links) > 0 then p_manifest || jsonb_build_object('mergeLinks', v_links) else p_manifest end, v_payload);
  for v_entry in select value from jsonb_array_elements(v_links) loop
    update pos_open_orders_private.orders set observed_at = (v_entry->>'observedAt')::timestamptz,
      merge_target_order_id = v_entry->>'target', merge_linked_at = (v_entry->>'linkedAt')::timestamptz,
      merge_target_table = v_entry->>'table'
      where scope = r.scope and business_date = r.business_date and order_id = v_entry->>'orderId'
        and closure_receipt_id is null and quarantined_at is null;
    if not found then raise exception 'open_orders_payload_invalid' using errcode = '22023'; end if;
  end loop;
  -- A link closed by its target's receipt keeps the link as history of the same merge.
  update pos_open_orders_private.orders o set merge_target_order_id = h.value->>'mergeTargetOrderId',
      merge_linked_at = (h.value->>'mergeLinkedAt')::timestamptz, merge_target_table = h.value->>'mergeTargetTable'
    from jsonb_array_elements(v_history) h
    where o.scope = r.scope and o.business_date = r.business_date and o.order_id = h.value->>'orderId'
      and o.merge_target_order_id is null and o.closure_merged_into_order_id = h.value->>'mergeTargetOrderId';
  if r.lease_until <= clock_timestamp() then raise exception 'open_orders_lease_lost' using errcode = '55000'; end if;
  return v_result;
end $$;

alter function pos_open_orders_private.merge_table_tokens_v1(text) owner to postgres;
alter function pos_open_orders_private.merge_order_menu_v2(jsonb) owner to postgres;
alter function pos_open_orders_private.merge_receipt_menu_v2(jsonb) owner to postgres;
alter function pos_open_orders_private.merge_menu_within_v1(jsonb, jsonb) owner to postgres;
alter function pos_open_orders_private.commit_merge_v1(uuid, uuid, jsonb, jsonb) owner to postgres;
alter function pos_open_orders_private.commit_last_table_v1(uuid, uuid, jsonb, jsonb) owner to postgres;
alter function pos_open_orders_private.commit_v1(uuid, uuid, jsonb, jsonb) owner to postgres;
alter function pos_open_orders_private.read_v1(text, date) owner to postgres;
revoke all on function pos_open_orders_private.merge_table_tokens_v1(text) from public, anon, authenticated, service_role;
revoke all on function pos_open_orders_private.merge_order_menu_v2(jsonb) from public, anon, authenticated, service_role;
revoke all on function pos_open_orders_private.merge_receipt_menu_v2(jsonb) from public, anon, authenticated, service_role;
revoke all on function pos_open_orders_private.merge_menu_within_v1(jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function pos_open_orders_private.commit_merge_v1(uuid, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function pos_open_orders_private.commit_v1(uuid, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function pos_open_orders_private.commit_v1(uuid, uuid, jsonb, jsonb) to service_role;

-- Refresh SQL-wrapper resolution after renaming the previous implementation.
create or replace function public.pos_open_orders_commit(p_run_id uuid, p_owner_token uuid, p_manifest jsonb, p_orders jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
  select pos_open_orders_private.commit_v1(p_run_id, p_owner_token, p_manifest, p_orders)
$$;
revoke all on function public.pos_open_orders_commit(uuid, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.pos_open_orders_commit(uuid, uuid, jsonb, jsonb) to service_role;
