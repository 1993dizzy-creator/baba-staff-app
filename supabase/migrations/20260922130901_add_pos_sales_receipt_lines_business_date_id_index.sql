create index pos_sales_receipt_lines_business_date_id_idx
  on public.pos_sales_receipt_lines using btree (business_date asc, id asc);
