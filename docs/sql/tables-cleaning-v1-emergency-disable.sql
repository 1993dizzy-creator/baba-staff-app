-- OWNER APPROVAL REQUIRED: optional emergency DDL if the OFF fast path itself fails.
-- Stop app requests first, then run the normal stop SQL. Bounded DDL may fail under
-- active POS traffic; a timeout means NOT stopped, never hide/retry as success.
-- Disable only cleaning hooks, NEVER all triggers, v3, ledger or inventory triggers.
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';
update table_operations_private.config set enabled=false where singleton;
alter table pos_open_orders_private.orders disable trigger tables_cleaning_order_invalidation;
alter table public.pos_sales_receipts disable trigger tables_cleaning_receipt_invalidation;
alter table public.pos_sales_receipt_lines disable trigger tables_cleaning_line_invalidation;
commit;
