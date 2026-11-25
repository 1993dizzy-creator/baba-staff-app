-- NOT APPLIED. Owner approval is required. Apply right AFTER 20261125123044_pos_open_orders_merge_links
-- (same approval batch). Follow-up only: never edit/replay 20261115103656_tables_cleaning_v1,
-- 20261116095122_tables_auto_normal_v1 or 20261119123459_tables_quarantine_successor_evidence.
--
-- Replaces ONLY table_operations_private.evidence_v1 (same signature, owner, grants, SECURITY
-- INVOKER, STABLE) and adds one private STABLE helper. Manual confirm, automatic observation,
-- contexts, triggers, activation generations, invalidations and every POS/accounting table are
-- untouched, so the existing payment proof, cleaning permission and lock order stay in force.
--
-- BABA-TABLE-MERGE-02: a POS merge verified as a link BEFORE payment (contract 6) and closed by
-- its target's single paid receipt (e.g. #9081, TableName "BAR9, 2") is an ordinary payment of
-- every table that receipt names:
-- 1. A table also takes the latest paid receipt that closed a merge link and names it among its
--    TableName parts (all links to that target closed by that receipt). Otherwise unchanged:
--    only the exact TableName.
-- 2. Merge-link history (merge_target_order_id = closure_merged_into_order_id) no longer blocks
--    as "merge membership" and a member closed by that link is not an unconverted order. Proof-
--    only merges (#8885 shape, no link) still block exactly as before.
-- 3. For such a receipt, unresolved receipts and unconverted orders are also searched on every
--    TableName part (a new composite "BAR9, 2" order or a new order on 2 blocks), and the order
--    epoch adds the composite orders, the target and the members, so any change invalidates
--    both tables' manual/automatic keys. Each table keeps its own key (p_table is in the hash).
-- Tables without such a receipt keep byte-identical epochs and keys (existing cleaning events and
-- payment observations stay valid).
begin;
set local lock_timeout = '5s';
do $$ begin
 if to_regprocedure('table_operations_private.evidence_v1(text,date,uuid)') is null
  or to_regprocedure('pos_open_orders_private.merge_table_tokens_v1(text)') is null
  or not exists(select 1 from pg_proc where oid=to_regprocedure('table_operations_private.evidence_v1(text,date,uuid)')
   and prosrc like '%quarantined%')
  or not exists(select 1 from information_schema.columns where table_schema='pos_open_orders_private'
   and table_name='orders' and column_name='merge_target_order_id') then
  raise exception 'merge_link_evidence_dependency_missing';end if;
end $$;

-- True when receipt p_receipt closed a verified merge link (every link to its OrderId is closed
-- by it) and p_table is one of its TableName parts.
create function table_operations_private.merge_link_receipt_v1(p_scope text,p_day date,p_receipt bigint,p_table text)
returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from public.pos_sales_receipts x
  where x.id=p_receipt and nullif(btrim(x.raw_json->>'OrderId'),'') is not null
   and exists(select 1 from unnest(pos_open_orders_private.merge_table_tokens_v1(x.raw_json->>'TableName')) t where lower(t)=lower(p_table))
   and exists(select 1 from pos_open_orders_private.orders m where m.scope=p_scope and m.business_date=p_day
    and m.closure_receipt_id=x.id and m.merge_target_order_id is not null and m.closure_merged_into_order_id=m.merge_target_order_id
    and lower(m.merge_target_order_id)=lower(btrim(x.raw_json->>'OrderId')))
   and not exists(select 1 from pos_open_orders_private.orders m where m.scope=p_scope and m.business_date=p_day
    and lower(m.merge_target_order_id)=lower(btrim(x.raw_json->>'OrderId')) and m.closure_receipt_id is distinct from x.id))
$$;

create or replace function table_operations_private.evidence_v1(p_scope text,p_day date,p_table uuid) returns jsonb
language plpgsql stable set search_path='' as $$
declare c table_operations_private.catalog%rowtype; r public.pos_sales_receipts%rowtype; epoch jsonb; linked boolean;
begin
 select * into c from table_operations_private.catalog where table_id=p_table and branch_id=split_part(p_scope,':',2);
 if not found then return null;end if;
 select * into r from public.pos_sales_receipts p where source='cukcuk' and branch_id=c.branch_id and business_date=p_day
  and payment_status=3 and is_canceled=false
  and (lower(btrim(raw_json->>'TableName'))=lower(c.table_name)
   or table_operations_private.merge_link_receipt_v1(p_scope,p_day,p.id,c.table_name))
  order by ref_date desc nulls last,id desc limit 1;
 if not found or r.ref_date is null or r.ref_date>statement_timestamp() or r.final_amount is null or r.final_amount<0
  or public.store_business_date_for_timestamp_v1(r.ref_date)::date<>p_day
  or nullif(btrim(r.raw_json->>'OrderId'),'') is null then return null;end if;
 linked:=lower(btrim(r.raw_json->>'TableName')) is distinct from lower(c.table_name);
 -- Any proof-only merge membership blocks physical cleaning, including a surviving receipt whose
 -- TableName points at a different physical table (#8885 shape). Verified link history does not.
 if exists(select 1 from pos_open_orders_private.orders o where o.scope=p_scope and o.business_date=p_day
  and o.closure_merged_into_order_id is not null and (o.closure_receipt_id=r.id or lower(btrim(o.table_name))=lower(c.table_name))
  and o.merge_target_order_id is distinct from o.closure_merged_into_order_id) then return null;end if;
 if exists(select 1 from public.pos_sales_receipts x where x.source='cukcuk' and x.branch_id=c.branch_id
  and x.business_date between p_day and p_day+1 and x.is_canceled is not true and (x.payment_status is null or x.payment_status not in(4,5))
  and (lower(btrim(x.raw_json->>'TableName'))=lower(c.table_name) or lower(btrim(x.raw_json->>'OrderId'))=lower(btrim(r.raw_json->>'OrderId'))
   or (linked and exists(select 1 from unnest(pos_open_orders_private.merge_table_tokens_v1(x.raw_json->>'TableName')) t where lower(t)=lower(c.table_name))))
  and (x.payment_status is distinct from 3 or x.is_canceled is distinct from false or nullif(btrim(x.raw_json->>'OrderId'),'') is null
    or (select count(*) from public.pos_sales_receipts y where y.source='cukcuk' and y.branch_id=c.branch_id
       and y.business_date between p_day and p_day+1 and lower(btrim(y.raw_json->>'OrderId'))=lower(btrim(x.raw_json->>'OrderId'))
       and y.is_canceled is not true and (y.payment_status is null or y.payment_status not in(4,5)))<>1)) then return null;end if;
 -- An unconverted current order at this table blocks. A retained paid order is history, and so is
 -- an order merged into another by a verified link closed by a valid paid receipt.
 -- A quarantined order is superseded only by the receipt's own clearly newer order.
 if exists(select 1 from pos_open_orders_private.orders o where o.scope=p_scope and o.business_date=p_day
   and (lower(btrim(o.table_name))=lower(c.table_name)
    or (linked and exists(select 1 from unnest(pos_open_orders_private.merge_table_tokens_v1(o.table_name)) t where lower(t)=lower(c.table_name))))
   and o.status is distinct from 5
   and not exists(select 1 from public.pos_sales_receipts x where x.source='cukcuk' and x.branch_id=c.branch_id
    and x.business_date between p_day and p_day+1 and lower(btrim(x.raw_json->>'OrderId'))=lower(o.order_id)
    and x.payment_status=3 and x.is_canceled=false and x.ref_date>=o.order_date)
   and not (o.merge_target_order_id is not null and o.closure_merged_into_order_id=o.merge_target_order_id
    and exists(select 1 from public.pos_sales_receipts x where x.id=o.closure_receipt_id and x.source='cukcuk' and x.branch_id=c.branch_id
     and x.business_date between p_day and p_day+1 and lower(btrim(x.raw_json->>'OrderId'))=lower(o.merge_target_order_id)
     and x.payment_status=3 and x.is_canceled=false and x.ref_date>=o.order_date))
   and not (o.quarantined_at is not null and o.quarantine_reason='vanished_unconfirmed'
    and o.closure_receipt_id is null and o.closure_merged_into_order_id is null and o.observed_at<=o.quarantined_at
    and exists(select 1 from pos_open_orders_private.orders s where s.scope=p_scope and s.business_date=p_day
     and lower(s.order_id)=lower(btrim(r.raw_json->>'OrderId')) and lower(s.order_id)<>lower(o.order_id)
     and s.quarantined_at is null and s.closure_merged_into_order_id is null and s.status is distinct from 5
     and (s.table_name is null or lower(btrim(s.table_name))=lower(c.table_name))
     and s.order_date>o.quarantined_at and s.order_date<=r.ref_date))) then return null;end if;
 -- All retained table orders define a generation. A new order permanently invalidates
 -- an older event even after that order is canceled, until a new cleaning action.
 -- A linked merged payment also includes its composite-name orders, its target and its members.
 select coalesce(jsonb_agg(jsonb_build_array(o.order_id,o.order_date,o.status,o.table_name,o.closure_receipt_id,
  o.closure_merged_into_order_id) order by o.order_id),'[]'::jsonb)
  || coalesce((select jsonb_agg(jsonb_build_array('quarantined',q.order_id,q.quarantined_at,q.quarantine_reason,q.observed_at)
    order by q.order_id) from pos_open_orders_private.orders q where q.scope=p_scope and q.business_date=p_day
    and lower(btrim(q.table_name))=lower(c.table_name) and q.quarantined_at is not null),'[]'::jsonb) into epoch
 from pos_open_orders_private.orders o where o.scope=p_scope and o.business_date=p_day and (lower(btrim(o.table_name))=lower(c.table_name)
  or (linked and (lower(o.order_id)=lower(btrim(r.raw_json->>'OrderId')) or o.closure_receipt_id=r.id
   or exists(select 1 from unnest(pos_open_orders_private.merge_table_tokens_v1(o.table_name)) t where lower(t)=lower(c.table_name)))));
 return jsonb_build_object('receiptId',r.id,'orderEpoch',epoch,'evidenceKey',md5(jsonb_build_array(p_table,p_day,
   table_operations_private.receipt_version_v1(r.id),epoch,(select generation from table_operations_private.config where singleton),
   (select coalesce(max(i.id),0) from table_operations_private.invalidations i join table_operations_private.cleaning_events e on e.id=i.event_id
    where e.scope=p_scope and e.table_id=p_table and e.business_date=p_day))::text));
end $$;
revoke all on function table_operations_private.merge_link_receipt_v1(text,date,bigint,text) from public,anon,authenticated,service_role;
revoke all on function table_operations_private.evidence_v1(text,date,uuid) from public,anon,authenticated,service_role;
commit;
