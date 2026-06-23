create unique index if not exists pos_sales_sync_runs_running_lock_uidx
  on public.pos_sales_sync_runs (source, business_date, branch_id)
  where status = 'running';

create index if not exists pos_sales_sync_runs_running_started_idx
  on public.pos_sales_sync_runs (source, business_date, branch_id, started_at)
  where status = 'running';
