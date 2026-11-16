-- Separate approval; keep automatic feature OFF. Restores ONLY these three hooks.
begin;
set local lock_timeout='5s';
update table_operations_private.auto_config set enabled=false where singleton;
alter table pos_open_orders_private.orders enable trigger tables_auto_order_invalidation;
alter table public.pos_sales_receipts enable trigger tables_auto_receipt_invalidation;
alter table public.pos_sales_receipt_lines enable trigger tables_auto_line_invalidation;
commit;
