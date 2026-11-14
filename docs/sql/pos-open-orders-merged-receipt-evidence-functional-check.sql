-- Read-only functional check after the migration AND the app deploy (data-dependent; run
-- after at least two scheduled collections). Separate from the structural postflight, which
-- must keep passing whether or not merge proofs exist. No DDL/DML.
with current_day as (
  select s.scope, s.business_date from pos_open_orders_private.sync_state s),
recent as (
  select r.scope, r.status, r.failure_code, row_number() over (partition by r.scope order by r.started_at desc) n
  from pos_open_orders_private.runs r join current_day d on d.scope = r.scope and d.business_date = r.business_date),
merged as (
  select o.* from pos_open_orders_private.orders o join current_day d on d.scope = o.scope and d.business_date = o.business_date
  where o.closure_merged_into_order_id is not null),
active as (
  select r.id, lower(btrim(r.raw_json->>'OrderId')) order_id, r.payment_status, r.business_date
  from public.pos_sales_receipts r
  where r.source = 'cukcuk' and r.is_canceled is not true and (r.payment_status is null or r.payment_status not in (4, 5))
    and r.business_date in (select business_date from current_day union select business_date + 1 from current_day)),
audit as (
  select x.value a, r.scope from pos_open_orders_private.runs r join current_day d on d.scope = r.scope and d.business_date = r.business_date,
    jsonb_array_elements(coalesce(r.manifest->'receiptClosures', '[]'::jsonb)) x
  where r.id = (select s.last_success_run_id from pos_open_orders_private.sync_state s where s.scope = r.scope)
    and x.value->>'kind' = 'merged_receipt')
select 'F1 latest two collections of the business date committed' check_name,
  (select count(*) = 2 from recent where n <= 2 and status = 'committed') pass,
  coalesce((select string_agg(status || coalesce(':' || failure_code, ''), ', ' order by n) from recent where n <= 3), 'no runs') detail
union all
select 'F2 every merged order points to a surviving order in the same snapshot',
  not exists (select 1 from merged m where not exists (select 1 from pos_open_orders_private.orders t
    where t.scope = m.scope and t.business_date = m.business_date and t.order_id = m.closure_merged_into_order_id
      and t.closure_merged_into_order_id is null)),
  (select count(*) || ' merged order(s)' from merged)
union all
select 'F3 each merge receipt is the single active paid receipt of its surviving order',
  not exists (select 1 from merged m where (select count(*) from active a where a.order_id = m.closure_merged_into_order_id) <> 1
    or not exists (select 1 from active a where a.id = m.closure_receipt_id and a.order_id = m.closure_merged_into_order_id and a.payment_status = 3)),
  coalesce((select string_agg(distinct m.closure_receipt_id::text, ', ') from merged m), 'none')
union all
select 'F4 merged orders have no active receipt of their own (no second sale)',
  not exists (select 1 from merged m join active a on a.order_id = m.order_id),
  (select count(*) || ' conflicting receipt(s)' from merged m join active a on a.order_id = m.order_id)
union all
select 'F5 one receipt proves one group only (single target, never also a single-order proof)',
  not exists (select 1 from pos_open_orders_private.orders o join current_day d on d.scope = o.scope and d.business_date = o.business_date
    where o.closure_receipt_id is not null group by o.scope, o.closure_receipt_id
    having count(distinct coalesce(o.closure_merged_into_order_id, '<single>')) > 1),
  'receipts=' || coalesce((select count(distinct closure_receipt_id)::text from merged), '0')
union all
select 'F6 merged orders keep their last provider facts (status, amount, table, observed time)',
  not exists (select 1 from merged m left join audit x on x.scope = m.scope and x.a->>'orderId' = m.order_id
    where x.a is null or (x.a->'previousOrder'->>'status')::int is distinct from m.status
      or (x.a->'previousOrder'->>'totalAmount')::numeric is distinct from m.total_amount
      or x.a->'previousOrder'->>'tableName' is distinct from m.table_name
      or (x.a->'previousOrder'->>'providerObservedAt')::timestamptz is distinct from m.observed_at
      or m.status = 4),
  coalesce((select string_agg(left(m.order_id, 8) || ' status=' || m.status, ', ') from merged m), 'none')
union all
select 'F7 evidence hash and receipt recorded for every merged order',
  not exists (select 1 from merged where closure_evidence_hash !~ '^[0-9a-f]{32}$' or closure_receipt_id is null or closure_confirmed_at is null),
  (select count(*) || ' merged order(s)' from merged);
-- Not covered here (check in the app): /tables shows merged tables as idle/history (not occupied or unknown),
-- and the daily sales screen's paid total equals the receipts total for the day (merged orders add nothing).
