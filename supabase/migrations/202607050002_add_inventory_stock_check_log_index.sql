create index if not exists inventory_logs_stock_check_item_business_date_idx
  on public.inventory_logs (item_id, business_date desc, created_at desc)
  where reason = 'stock_check';
