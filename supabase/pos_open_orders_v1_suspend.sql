-- pos_open_orders_v1 — DB-LEVEL STOP AFTER DATA (separate approval required).
-- First step of any stop is app-side: POS_OPEN_ORDERS_SYNC_ENABLED / POS_OPEN_ORDERS_READ_ENABLED
-- off and the cron entry removed. This script is the extra DB kill switch: the app can no
-- longer call the four public wrappers (it then shows "unavailable"; paid KPIs are untouched).
-- No table or row is changed; resume with pos_open_orders_v1_resume.sql.
begin;
revoke execute on function public.pos_open_orders_claim(uuid, uuid, text, text, date, integer),
  public.pos_open_orders_commit(uuid, uuid, jsonb, jsonb), public.pos_open_orders_fail(uuid, uuid, text),
  public.pos_open_orders_read(text, date) from service_role;
commit;
