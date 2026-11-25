-- NOT APPLIED. Owner approval is required. Follow-up only: never edit/replay
-- 20261109210000, 20261110170329, 20261114161500, 20261119080000 or 20261119144531.
--
-- Merged-order proof, contract 5 (production 2026-11-24, receipt #9081): table 2's order was
-- merged in POS into BAR9 (TableName "BAR9, 2") at 22:12 and quarantined; BAR9 was paid at
-- 22:36 with one receipt that held both menus exactly. Two gaps kept it quarantined until 03:00:
--   1. Manual menu lines (order lines without ItemId; receipt RefDetailType 3 without ItemID)
--      were rejected outright by merge_order_menu_v1 / merge_receipt_menu_v1.
--   2. CUKCUK copies the merged order's lines into the surviving order with NEW detail IDs, so
--      a run between the merge and the payment stores the surviving order already holding them.
--      "surviving + merged = receipt" then counts the merged order twice and never matches.
--
-- This adds, inside the merged-receipt commit only:
--   * merge_order_menu_v2 / merge_receipt_menu_v2: v1 plus an exact manual line keyed by its
--     trimmed name ('name:' || name, case and inner spaces unchanged). For item-only menus
--     their output is identical to v1, so already stored evidence hashes stay valid.
--   * merge_table_tokens_v1: sorted distinct table names of a POS TableName, or null.
--   * The "absorbed" proof, tried only when surviving + merged does not match:
--       - the surviving order's previous menu and header equal the receipt exactly;
--       - its previous TableName and the receipt TableName name the same >= 2 distinct tables;
--       - every merged member was already quarantined, has exactly one table name and that
--         table is one of them; no other quarantined order of this date names one of them;
--       - the members' combined menu is contained item by item in the surviving menu, and
--         their total is less than the surviving total.
--   Ambiguity, options, discounts, other lines types, any amount/menu difference -> unchanged
--   merged_menu_mismatch (the collector keeps such orders quarantined instead).
--
-- Unchanged: the lease/writer fence, replay, receipt-single-paid/member-has-receipt/target
-- checks, the SHARE lock, the carried-proof rule, quarantine and last-table layers (they call
-- commit_merge_v1 by name), retention, roles and grants. read_v1 only reports contract 5; its
-- body is otherwise identical to 20261119144531. No receipt, ledger, inventory or payroll DML.

-- DDL wait budget for this migration transaction only.
set local lock_timeout = '5s';

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

-- Same as 20261119144531 except 'recoveryContractVersion' 5: the collector sends manual-line
-- and absorbed merge proofs only to a DB that verifies them.
create or replace function pos_open_orders_private.read_v1(p_scope text, p_business_date date)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'recoveryContractVersion', 5,
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

-- 20261114161500 commit (renamed commit_merge_v1 by 20261119080000). Only the merged-group
-- menu verification changes: v2 menus, then the absorbed proof. Everything else is the same.
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
  v_member_orders jsonb; v_target_menu jsonb; v_member_menu jsonb; v_tables text[]; v_absorbed boolean;
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
    -- Contract 5: identical to v1 for item-only receipts; also exact manual lines.
    v_receipt_menu := pos_open_orders_private.merge_receipt_menu_v2(v_receipt.raw_json);
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
      -- Surviving + merged = receipt (the 20261114161500 proof, now with manual lines).
      if pos_open_orders_private.merge_order_menu_v2(v_group_orders) is distinct from v_receipt_menu
        or (select sum((value->>'totalAmount')::numeric) from jsonb_array_elements(v_group_orders)) is distinct from v_receipt.total_amount then
        -- Absorbed: the surviving order's previous snapshot already holds the merged menu.
        select jsonb_agg(value) into v_member_orders from jsonb_array_elements(v_previous)
          where v_group.members ? (value->>'orderId');
        v_target_menu := pos_open_orders_private.merge_order_menu_v2(jsonb_build_array(v_target_old));
        v_member_menu := pos_open_orders_private.merge_order_menu_v2(v_member_orders);
        v_tables := pos_open_orders_private.merge_table_tokens_v1(v_target_old->>'tableName');
        v_absorbed := coalesce(
          v_target_menu is not null and v_member_menu is not null
          and v_target_menu = v_receipt_menu
          and (v_target_old->>'totalAmount')::numeric = v_receipt.total_amount
          and cardinality(v_tables) >= 2
          and v_tables = pos_open_orders_private.merge_table_tokens_v1(v_receipt.raw_json->>'TableName')
          -- Every member was already quarantined on exactly one of those tables.
          and not exists (select 1 from jsonb_array_elements(v_member_orders) m
            where m->>'quarantinedAt' is null
              or coalesce(cardinality(pos_open_orders_private.merge_table_tokens_v1(m->>'tableName')), 0) <> 1
              or not ((pos_open_orders_private.merge_table_tokens_v1(m->>'tableName'))[1] = any(v_tables)))
          -- No other quarantined order of this date names one of those tables.
          and not exists (select 1 from jsonb_array_elements(v_previous) o
            where o->>'quarantinedAt' is not null and o->>'orderId' <> v_group.target and not (v_group.members ? (o->>'orderId'))
              and coalesce(pos_open_orders_private.merge_table_tokens_v1(o->>'tableName'), '{}'::text[]) && v_tables)
          -- The members' menu is inside the surviving menu, item by item, and smaller than it.
          and not exists (select 1 from jsonb_array_elements(v_member_menu) m where not exists (
            select 1 from jsonb_array_elements(v_target_menu) t
            where t->>'item' = m->>'item' and (t->>'price')::numeric = (m->>'price')::numeric
              and (t->>'quantity')::numeric >= (m->>'quantity')::numeric and (t->>'amount')::numeric >= (m->>'amount')::numeric))
          and (select sum((m->>'totalAmount')::numeric) from jsonb_array_elements(v_member_orders) m) < (v_target_old->>'totalAmount')::numeric,
          false);
        if not v_absorbed then
          raise exception 'open_orders_vanished' using errcode = '55000', detail = 'merged_menu_mismatch';
        end if;
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

alter function pos_open_orders_private.merge_table_tokens_v1(text) owner to postgres;
alter function pos_open_orders_private.merge_order_menu_v2(jsonb) owner to postgres;
alter function pos_open_orders_private.merge_receipt_menu_v2(jsonb) owner to postgres;
alter function pos_open_orders_private.commit_merge_v1(uuid, uuid, jsonb, jsonb) owner to postgres;
alter function pos_open_orders_private.read_v1(text, date) owner to postgres;
revoke all on function pos_open_orders_private.merge_table_tokens_v1(text) from public, anon, authenticated, service_role;
revoke all on function pos_open_orders_private.merge_order_menu_v2(jsonb) from public, anon, authenticated, service_role;
revoke all on function pos_open_orders_private.merge_receipt_menu_v2(jsonb) from public, anon, authenticated, service_role;
revoke all on function pos_open_orders_private.commit_merge_v1(uuid, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
