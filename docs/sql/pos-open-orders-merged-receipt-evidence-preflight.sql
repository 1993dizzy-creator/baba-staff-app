-- Read-only preflight for 20261114161500_pos_open_orders_merged_receipt_evidence.sql.
-- Every row must be pass = true before applying. No DDL/DML.
select 'previous receipt-evidence migration is installed' check_name,
  exists (select 1 from information_schema.columns where table_schema = 'pos_open_orders_private'
    and table_name = 'orders' and column_name = 'closure_receipt_id') pass
union all
select 'merge columns are not present yet',
  not exists (select 1 from information_schema.columns where table_schema = 'pos_open_orders_private'
    and table_name = 'orders' and column_name in ('closure_merged_into_order_id', 'closure_evidence_hash'))
union all
select 'merge helpers are not present yet',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'pos_open_orders_private' and p.proname like 'merge\_%')
union all
select 'commit_v1 and commit_snapshot_v1 are SECURITY DEFINER with empty search_path',
  (select count(*) = 2 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'pos_open_orders_private' and p.proname in ('commit_v1', 'commit_snapshot_v1')
      and p.prosecdef and p.proconfig @> array['search_path=""'])
union all
select 'receipt table has the columns the proof reads',
  (select count(*) = 8 from information_schema.columns where table_schema = 'public' and table_name = 'pos_sales_receipts'
    and column_name in ('id', 'source', 'branch_id', 'business_date', 'payment_status', 'is_canceled', 'total_amount', 'discount_amount'))
union all
select 'no collecting run holds the lease (apply between Cron runs)',
  not exists (select 1 from pos_open_orders_private.runs where status = 'collecting' and lease_until > clock_timestamp());
