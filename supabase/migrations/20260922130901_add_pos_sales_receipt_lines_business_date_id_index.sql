create index idx_pos_sales_receipt_lines_business_date_id
  on public.pos_sales_receipt_lines using btree (business_date asc, id asc);
