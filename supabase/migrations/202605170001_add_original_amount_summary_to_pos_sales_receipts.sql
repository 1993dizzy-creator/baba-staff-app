alter table public.pos_sales_receipts
  add column if not exists original_amount_summary jsonb null;
