-- OWNER APPROVAL REQUIRED. Reinstall hooks while OFF; this does NOT activate cleaning.
-- Fix/verify the cause first. Preserve events, invalidations, sequence and history.
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';
update table_operations_private.config set enabled=false where singleton;
alter table pos_open_orders_private.orders enable trigger tables_cleaning_order_invalidation;
alter table public.pos_sales_receipts enable trigger tables_cleaning_receipt_invalidation;
alter table public.pos_sales_receipt_lines enable trigger tables_cleaning_line_invalidation;
select singleton,enabled,generation from table_operations_private.config;
commit;
-- Then run postflight while OFF. Separate Owner approval is required to set DB
-- enabled=true (generation advances again), then BABA_TABLE_CLEANING_ENABLED=true.
