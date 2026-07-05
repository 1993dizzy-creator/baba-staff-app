alter table public.inventory
  add column if not exists is_active boolean not null default true;

create index if not exists inventory_is_active_updated_idx
  on public.inventory (is_active, updated_at desc);
