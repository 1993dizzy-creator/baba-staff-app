alter table public.inventory
  add column if not exists low_stock_enabled boolean not null default false;
