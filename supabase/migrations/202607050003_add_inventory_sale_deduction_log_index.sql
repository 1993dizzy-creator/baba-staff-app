create index if not exists inventory_logs_sale_deduction_item_business_date_idx
  on public.inventory_logs (item_id, business_date desc, created_at desc)
  where reason = 'sale_deduction';
