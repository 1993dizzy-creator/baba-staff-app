-- Keg progress I/O P0: support the paid-line lookup used by lib/inventory/keg-progress.ts
--   .eq("payment_status", 3).or("item_id.in.(...),item_code.in.(...)")
-- item_code is already indexed (idx_pos_sales_receipt_lines_item_code); item_id was not,
-- so the OR could not use a bitmap index path. Partial on payment_status = 3 to keep it small.
-- Plain CREATE INDEX (migrations run in a transaction, CONCURRENTLY is not allowed).
-- Plain CREATE INDEX may temporarily block POS sync writes.
-- Lock acquisition wait is bounded to 5s;
-- index creation statement is bounded to 60s.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create index if not exists idx_pos_sales_receipt_lines_paid_item_id
  on public.pos_sales_receipt_lines using btree (item_id)
  where payment_status = 3;
