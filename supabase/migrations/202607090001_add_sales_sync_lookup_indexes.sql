create index if not exists pos_sales_sync_runs_recent_success_idx
  on public.pos_sales_sync_runs (
    source,
    business_date,
    branch_id,
    status,
    finished_at desc
  );

create index if not exists pos_inventory_deductions_receipt_id_idx
  on public.pos_inventory_deductions (receipt_id);
