-- pos_open_orders_v1 — RESUME after pos_open_orders_v1_suspend.sql (separate approval required).
-- Restores exactly the wrapper privileges of the migration; run the postflight afterwards.
begin;
grant execute on function public.pos_open_orders_claim(uuid, uuid, text, text, date, integer),
  public.pos_open_orders_commit(uuid, uuid, jsonb, jsonb), public.pos_open_orders_fail(uuid, uuid, text),
  public.pos_open_orders_read(text, date) to service_role;
commit;
