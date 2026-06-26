create unique index if not exists pos_sales_receipts_manual_ref_no_uidx
  on public.pos_sales_receipts (business_date, ref_no)
  where source = 'manual' and ref_no is not null;
