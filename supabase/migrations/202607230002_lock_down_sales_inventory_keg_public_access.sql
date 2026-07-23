alter table public.pos_inventory_deduction_receipts
enable row level security;

revoke all privileges
on table public.pos_inventory_deduction_receipts
from public, anon, authenticated;

grant select, insert, update, delete
on table public.pos_inventory_deduction_receipts
to service_role;

revoke execute
on function public.apply_sales_inventory_deduction_batch(
  bigint,
  text,
  jsonb
)
from public, anon, authenticated;

grant execute
on function public.apply_sales_inventory_deduction_batch(
  bigint,
  text,
  jsonb
)
to service_role;

revoke execute
on function public.replace_inventory_keg(
  bigint,
  text,
  date,
  numeric
)
from public, anon, authenticated;

grant execute
on function public.replace_inventory_keg(
  bigint,
  text,
  date,
  numeric
)
to service_role;

revoke execute
on function public.replace_inventory_keg(
  bigint,
  text,
  date,
  numeric,
  timestamp with time zone
)
from public, anon, authenticated;

grant execute
on function public.replace_inventory_keg(
  bigint,
  text,
  date,
  numeric,
  timestamp with time zone
)
to service_role;
