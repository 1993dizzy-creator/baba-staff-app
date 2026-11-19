-- NOT APPLIED. Owner approval is required. Follow-up only: never edit/replay
-- 20261115103656_tables_cleaning_v1, 20261116095122_tables_auto_normal_v1 or
-- 20261119080000_pos_open_orders_vanished_quarantine.
--
-- Replaces ONLY table_operations_private.evidence_v1 (same signature, owner, grants,
-- SECURITY INVOKER, STABLE). Manual confirm, automatic observation, contexts, triggers,
-- activation generations, invalidations and every POS/accounting table are untouched.
--
-- 1. A quarantined order (vanished_unconfirmed, no closure) at this table no longer blocks
--    forever. It is superseded ONLY when the table's latest paid receipt belongs to a
--    different, retained, non-quarantined, non-merged order whose order_date is strictly
--    after the quarantine commit time (so it cannot be the merge target A vanished into)
--    and not after the receipt. A itself is never treated as paid or closed.
-- 2. Quarantine facts join the order epoch as separate ["quarantined", ...] tuples, so the
--    manual evidenceKey and the automatic autoKey change whenever quarantine changes. They
--    are appended only when present: tables without quarantined orders keep byte-identical
--    epochs and keys (existing cleaning events/observations stay valid). Existing triggers
--    compare 6-field per-order facts and are unaffected by the extra tuples.
begin;
set local lock_timeout = '5s';
do $$ begin
 if to_regprocedure('table_operations_private.evidence_v1(text,date,uuid)') is null
  or to_regprocedure('table_operations_private.auto_evidence_v1(text,date,uuid)') is null
  or not exists(select 1 from information_schema.columns where table_schema='pos_open_orders_private'
   and table_name='orders' and column_name='quarantined_at')
  or not exists(select 1 from information_schema.columns where table_schema='pos_open_orders_private'
   and table_name='orders' and column_name='quarantine_reason') then
  raise exception 'quarantine_successor_dependency_missing';end if;
end $$;

create or replace function table_operations_private.evidence_v1(p_scope text,p_day date,p_table uuid) returns jsonb
language plpgsql stable set search_path='' as $$
declare c table_operations_private.catalog%rowtype; r public.pos_sales_receipts%rowtype; epoch jsonb;
begin
 select * into c from table_operations_private.catalog where table_id=p_table and branch_id=split_part(p_scope,':',2);
 if not found then return null;end if;
 select * into r from public.pos_sales_receipts where source='cukcuk' and branch_id=c.branch_id and business_date=p_day
  and lower(btrim(raw_json->>'TableName'))=lower(c.table_name) and payment_status=3 and is_canceled=false
  order by ref_date desc nulls last,id desc limit 1;
 if not found or r.ref_date is null or r.ref_date>statement_timestamp() or r.final_amount is null or r.final_amount<0
  or public.store_business_date_for_timestamp_v1(r.ref_date)::date<>p_day
  or nullif(btrim(r.raw_json->>'OrderId'),'') is null then return null;end if;
 -- Any merge membership blocks physical cleaning, including a surviving receipt whose
 -- TableName points at a different physical table (#8885 shape).
 if exists(select 1 from pos_open_orders_private.orders o where o.scope=p_scope and o.business_date=p_day
  and o.closure_merged_into_order_id is not null and (o.closure_receipt_id=r.id or lower(btrim(o.table_name))=lower(c.table_name))) then return null;end if;
 if exists(select 1 from public.pos_sales_receipts x where x.source='cukcuk' and x.branch_id=c.branch_id
  and x.business_date between p_day and p_day+1 and x.is_canceled is not true and (x.payment_status is null or x.payment_status not in(4,5))
  and (lower(btrim(x.raw_json->>'TableName'))=lower(c.table_name) or lower(btrim(x.raw_json->>'OrderId'))=lower(btrim(r.raw_json->>'OrderId')))
  and (x.payment_status is distinct from 3 or x.is_canceled is distinct from false or nullif(btrim(x.raw_json->>'OrderId'),'') is null
    or (select count(*) from public.pos_sales_receipts y where y.source='cukcuk' and y.branch_id=c.branch_id
       and y.business_date between p_day and p_day+1 and lower(btrim(y.raw_json->>'OrderId'))=lower(btrim(x.raw_json->>'OrderId'))
       and y.is_canceled is not true and (y.payment_status is null or y.payment_status not in(4,5)))<>1)) then return null;end if;
 -- An unconverted current order at this table blocks. A retained paid order is history.
 -- A quarantined order is superseded only by the receipt's own clearly newer order.
 if exists(select 1 from pos_open_orders_private.orders o where o.scope=p_scope and o.business_date=p_day
   and lower(btrim(o.table_name))=lower(c.table_name) and o.status is distinct from 5
   and not exists(select 1 from public.pos_sales_receipts x where x.source='cukcuk' and x.branch_id=c.branch_id
    and x.business_date between p_day and p_day+1 and lower(btrim(x.raw_json->>'OrderId'))=lower(o.order_id)
    and x.payment_status=3 and x.is_canceled=false and x.ref_date>=o.order_date)
   and not (o.quarantined_at is not null and o.quarantine_reason='vanished_unconfirmed'
    and o.closure_receipt_id is null and o.closure_merged_into_order_id is null and o.observed_at<=o.quarantined_at
    and exists(select 1 from pos_open_orders_private.orders s where s.scope=p_scope and s.business_date=p_day
     and lower(s.order_id)=lower(btrim(r.raw_json->>'OrderId')) and lower(s.order_id)<>lower(o.order_id)
     and s.quarantined_at is null and s.closure_merged_into_order_id is null and s.status is distinct from 5
     and (s.table_name is null or lower(btrim(s.table_name))=lower(c.table_name))
     and s.order_date>o.quarantined_at and s.order_date<=r.ref_date))) then return null;end if;
 -- All retained table orders define a generation. A new order permanently invalidates
 -- an older event even after that order is canceled, until a new cleaning action.
 select coalesce(jsonb_agg(jsonb_build_array(o.order_id,o.order_date,o.status,o.table_name,o.closure_receipt_id,
  o.closure_merged_into_order_id) order by o.order_id),'[]'::jsonb)
  || coalesce((select jsonb_agg(jsonb_build_array('quarantined',q.order_id,q.quarantined_at,q.quarantine_reason,q.observed_at)
    order by q.order_id) from pos_open_orders_private.orders q where q.scope=p_scope and q.business_date=p_day
    and lower(btrim(q.table_name))=lower(c.table_name) and q.quarantined_at is not null),'[]'::jsonb) into epoch
 from pos_open_orders_private.orders o where o.scope=p_scope and o.business_date=p_day and lower(btrim(o.table_name))=lower(c.table_name);
 return jsonb_build_object('receiptId',r.id,'orderEpoch',epoch,'evidenceKey',md5(jsonb_build_array(p_table,p_day,
   table_operations_private.receipt_version_v1(r.id),epoch,(select generation from table_operations_private.config where singleton),
   (select coalesce(max(i.id),0) from table_operations_private.invalidations i join table_operations_private.cleaning_events e on e.id=i.event_id
    where e.scope=p_scope and e.table_id=p_table and e.business_date=p_day))::text));
end $$;
revoke all on function table_operations_private.evidence_v1(text,date,uuid) from public,anon,authenticated,service_role;
commit;
