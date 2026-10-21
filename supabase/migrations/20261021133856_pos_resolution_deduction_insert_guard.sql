-- LOCAL ONLY. After 20261021070640 and 20261021081604. No historical DML.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $preflight$
begin
 if to_regclass('pos_resolution_private.work_capabilities') is null
  or to_regprocedure('public.sales_confirm_admin_resolution_inventory_v2(bigint,bigint,jsonb)') is null then
  raise exception 'POS_DEDUCTION_GUARD_PHASE2_REQUIRED';
 end if;
end $preflight$;

-- Include every independent provenance key. Never let a harmless receipt_id
-- mask a protected invoice/batch/line/reversal reference. UNION terminates
-- even malformed legacy reversal cycles. RefNo alone is not an identity.
create function pos_resolution_private.deduction_links(p_row jsonb) returns setof jsonb
language sql stable set search_path=pg_catalog,public as $$
 with recursive links(s) as (
  select p_row
  union
  select to_jsonb(d) from links l join public.pos_inventory_deductions d
   on d.id=nullif(l.s->>'reversal_of_deduction_id','')::bigint
 ) select s from links
$$;
create function pos_resolution_private.deduction_receipt_ids(p_row jsonb) returns bigint[]
language sql stable set search_path=pg_catalog,public as $$
 with links as materialized(select * from pos_resolution_private.deduction_links(p_row)),
 precise as (
  select r.id from links l join public.pos_sales_receipts r on r.id=nullif(l.deduction_links->>'receipt_id','')::bigint
  union select r.id from links l join public.pos_sales_receipts r on nullif(btrim(l.deduction_links->>'invoice_ref_id'),'') is not null
   and lower(btrim(r.ref_id::text))=lower(btrim(l.deduction_links->>'invoice_ref_id'))
  union select b.receipt_id from links l join public.pos_inventory_deduction_receipts b on b.id=nullif(l.deduction_links->>'batch_receipt_id','')::bigint
  union select d.receipt_id from links l join public.pos_sales_receipt_lines d on d.id=nullif(l.deduction_links->>'receipt_line_id','')::bigint
  union select r.id from links l join public.pos_sales_receipts r
   on r.ref_no::text=nullif(l.deduction_links->>'receipt_ref_no','') and r.business_date=nullif(l.deduction_links->>'business_date','')::date
   where nullif(l.deduction_links->>'receipt_id','') is null and nullif(l.deduction_links->>'invoice_ref_id','') is null
    and nullif(l.deduction_links->>'batch_receipt_id','') is null and nullif(l.deduction_links->>'receipt_line_id','') is null
 ), resolved as (
  select id from precise
  union select b.receipt_id from links l join public.pos_inventory_deduction_receipts b
   on b.batch_id=nullif(l.deduction_links->>'batch_id','')::bigint where not exists(
    select 1 from public.pos_inventory_deduction_receipts linked
    where linked.id=nullif(l.deduction_links->>'batch_receipt_id','')::bigint
     and linked.batch_id=nullif(l.deduction_links->>'batch_id','')::bigint)
 ) select coalesce(array_agg(distinct r.id order by r.id),'{}'::bigint[])
 from resolved x join public.pos_sales_receipts r on r.id=x.id
$$;

create function pos_resolution_private.deduction_write_guard() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_new jsonb;v_old jsonb;v_ids bigint[];v_after bigint[];v_id bigint;
begin
 if tg_op in('UPDATE','DELETE') then v_old:=to_jsonb(old);end if;
 v_new:=case when tg_op='DELETE' then v_old else to_jsonb(new) end;
 if cardinality(pos_resolution_private.deduction_receipt_ids(v_new))=0 then
  raise exception 'POS_DEDUCTION_RECEIPT_LINK_REQUIRED' using errcode='23514';
 end if;
 -- Stabilize indirect provenance as well. All extra row locks are NOWAIT:
 -- legacy inventory engines may already hold stock/batch locks. Never wait
 -- in reverse order against an approval holding receipt -> stock locks.
 -- Prelock the known FK parents too: an AFTER INSERT FK check must not wait
 -- for a legacy batch/stock writer after we have taken a receipt KEY SHARE.
 perform 1 from public.pos_inventory_deduction_batches b where b.id in(
  select nullif(l->>'batch_id','')::bigint from pos_resolution_private.deduction_links(v_new) l
  union select nullif(l->>'batch_id','')::bigint from pos_resolution_private.deduction_links(v_old) l
 ) order by b.id for key share nowait;
 perform 1 from public.inventory i where i.id in(
  select nullif(l->>'inventory_item_id','')::bigint from pos_resolution_private.deduction_links(v_new) l
  union select nullif(l->>'inventory_item_id','')::bigint from pos_resolution_private.deduction_links(v_old) l
 ) order by i.id for key share nowait;
 perform 1 from public.pos_sales_receipt_lines d where d.id in(
  select nullif(l->>'receipt_line_id','')::bigint from pos_resolution_private.deduction_links(v_new) l
  union select nullif(l->>'receipt_line_id','')::bigint from pos_resolution_private.deduction_links(v_old) l
 ) order by d.id for key share nowait;
 perform 1 from public.pos_item_mappings m where m.id in(
  select nullif(l->>'mapping_id','')::bigint from pos_resolution_private.deduction_links(v_new) l
  union select nullif(l->>'mapping_id','')::bigint from pos_resolution_private.deduction_links(v_old) l
 ) order by m.id for key share nowait;
 perform 1 from public.inventory_logs i where i.id in(
  select nullif(l->>'inventory_log_id','')::bigint from pos_resolution_private.deduction_links(v_new) l
  union select nullif(l->>'inventory_log_id','')::bigint from pos_resolution_private.deduction_links(v_old) l
 ) order by i.id for key share nowait;
 perform 1 from public.pos_inventory_deduction_receipts b where b.id in(
  select nullif(l->>'batch_receipt_id','')::bigint from pos_resolution_private.deduction_links(v_new) l
  union select nullif(l->>'batch_receipt_id','')::bigint from pos_resolution_private.deduction_links(v_old) l
 ) or exists(select 1 from pos_resolution_private.deduction_links(v_new) l
  where b.batch_id=nullif(l->>'batch_id','')::bigint and not exists(
   select 1 from public.pos_inventory_deduction_receipts linked where linked.id=nullif(l->>'batch_receipt_id','')::bigint and linked.batch_id=b.batch_id))
 or exists(select 1 from pos_resolution_private.deduction_links(v_old) l
  where b.batch_id=nullif(l->>'batch_id','')::bigint and not exists(
   select 1 from public.pos_inventory_deduction_receipts linked where linked.id=nullif(l->>'batch_receipt_id','')::bigint and linked.batch_id=b.batch_id))
 order by b.id for share nowait;
 perform 1 from public.pos_inventory_deductions d where d.id in(
  select nullif(l->>'reversal_of_deduction_id','')::bigint from pos_resolution_private.deduction_links(v_new) l
  union select nullif(l->>'reversal_of_deduction_id','')::bigint from pos_resolution_private.deduction_links(v_old) l
 ) order by d.id for share nowait;
 select coalesce(array_agg(distinct id order by id),'{}'::bigint[]) into v_ids from(
  select unnest(pos_resolution_private.deduction_receipt_ids(v_new)) id
  union select unnest(pos_resolution_private.deduction_receipt_ids(v_old)) id
 ) ids;
 if cardinality(v_ids)=0 then raise exception 'POS_DEDUCTION_RECEIPT_LINK_REQUIRED' using errcode='23514';end if;
 foreach v_id in array v_ids loop
  perform 1 from public.pos_sales_receipts where id=v_id for key share nowait;
  if not found then raise exception 'POS_DEDUCTION_LINK_CHANGED' using errcode='40001';end if;
 end loop;
 select coalesce(array_agg(distinct id order by id),'{}'::bigint[]) into v_after from(
  select unnest(pos_resolution_private.deduction_receipt_ids(v_new)) id
  union select unnest(pos_resolution_private.deduction_receipt_ids(v_old)) id
 ) ids;
 if v_after is distinct from v_ids then raise exception 'POS_DEDUCTION_LINK_CHANGED' using errcode='40001';end if;
 if exists(select 1 from public.pos_sales_receipt_admin_resolutions a where a.receipt_id=any(v_ids)
  and (tg_op='DELETE' or not exists(select 1 from pos_resolution_private.work_capabilities c
   where c.transaction_id=txid_current() and c.receipt_id=a.receipt_id and c.purpose='inventory'))) then
  raise exception 'POS_ADMIN_RESOLUTION_DEDUCTION_PROTECTED' using errcode='42501';
 end if;
 if tg_op='DELETE' then return old;end if;
 return new;
exception when lock_not_available then
 raise exception 'POS_DEDUCTION_RECEIPT_BUSY' using errcode='55P03';
end $$;

-- Protected status/quantity/FK changes require the existing engine capability.
-- Original history is never DELETEd, even by an approved inventory engine.
create trigger pos_admin_resolution_deduction_write_guard
 before insert or update or delete
 on public.pos_inventory_deductions for each row
 execute function pos_resolution_private.deduction_write_guard();

revoke all on function pos_resolution_private.deduction_links(jsonb),
 pos_resolution_private.deduction_receipt_ids(jsonb),pos_resolution_private.deduction_write_guard()
 from public,anon,authenticated,service_role;
commit;
