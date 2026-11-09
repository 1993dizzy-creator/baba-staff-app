-- pos_open_orders_v1 — CANCEL INSTALL BEFORE ANY DATA (separate approval required).
-- Use only if the migration was applied but the collector never wrote anything.
-- Refuses to run when any row exists; after data, use the stop procedure in
-- docs/pos-open-orders-v1-migration-review.md instead (data is never dropped here).
-- Drops only objects created by 20261109210000_pos_open_orders_v1.sql, explicitly
-- (no CASCADE). The migration history row is left as is; reinstalling later uses a
-- new migration version.
begin;
do $$
begin
  if to_regnamespace('pos_open_orders_private') is null then
    raise exception 'pos_open_orders_v1 is not installed';
  end if;
  if exists (select 1 from pos_open_orders_private.runs) or exists (select 1 from pos_open_orders_private.sync_state)
     or exists (select 1 from pos_open_orders_private.orders) or exists (select 1 from pos_open_orders_private.order_lines) then
    raise exception 'pos_open_orders_v1 already has data: do not drop; use the after-data stop procedure';
  end if;
end $$;
drop function public.pos_open_orders_claim(uuid, uuid, text, text, date, integer);
drop function public.pos_open_orders_commit(uuid, uuid, jsonb, jsonb);
drop function public.pos_open_orders_fail(uuid, uuid, text);
drop function public.pos_open_orders_read(text, date);
drop function pos_open_orders_private.claim_v1(uuid, uuid, text, text, date, integer);
drop function pos_open_orders_private.commit_v1(uuid, uuid, jsonb, jsonb);
drop function pos_open_orders_private.fail_v1(uuid, uuid, text);
drop function pos_open_orders_private.read_v1(text, date);
drop table pos_open_orders_private.order_lines;
drop table pos_open_orders_private.orders;
drop table pos_open_orders_private.sync_state;
drop table pos_open_orders_private.runs;
drop schema pos_open_orders_private;
commit;
