-- ONLY for an automatic hook failure, with separate approval. App auto OFF first.
begin;
set local lock_timeout='5s';
update table_operations_private.auto_config set enabled=false where singleton;
alter table pos_open_orders_private.orders disable trigger tables_auto_order_invalidation;
alter table public.pos_sales_receipts disable trigger tables_auto_receipt_invalidation;
alter table public.pos_sales_receipt_lines disable trigger tables_auto_line_invalidation;
commit;
