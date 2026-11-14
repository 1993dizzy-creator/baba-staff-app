-- Rollback for migrations/20261114120000_create_reservation_inbox_foundation.sql.
-- NOT a migration. Run manually, only with separate owner approval, and only after:
--   1. ZALO_BOT_WEBHOOK_MODE is unset (or "observe") in Vercel and that deployment is live,
--      so the webhook no longer calls public.reservation_inbox_ingest_v1;
--   2. any existing inbox/reservation rows have been exported (they are audit evidence).
-- The guard below refuses to run while rows exist. Removing the migration history row is a
-- separate, explicitly approved step and is not done here.

begin;

do $$
begin
  if exists (select 1 from reservation_private.inbox)
     or exists (select 1 from reservation_private.reservations)
     or exists (select 1 from reservation_private.reservation_events) then
    raise exception 'reservation data exists: export it and get owner approval before dropping';
  end if;
end $$;

drop function public.reservation_inbox_ingest_v1(jsonb);
drop function public.reservation_inbox_list_v1(bigint, text[], date, date, integer);
drop function public.reservation_inbox_get_v1(bigint, bigint);
drop function public.reservation_inbox_dismiss_v1(bigint, bigint, text);
drop function public.reservation_inbox_reprocess_v1(bigint, bigint, jsonb);
drop function public.reservation_create_v1(bigint, jsonb);
drop function public.reservation_update_v1(bigint, bigint, integer, jsonb);
drop function public.reservation_transition_v1(bigint, bigint, integer, text, text);
drop function public.reservation_link_table_v1(bigint, bigint, integer, text);
drop function public.reservation_release_table_v1(bigint, bigint, integer, bigint, text);
drop function public.reservation_list_v1(bigint, date, date, text[]);
drop function public.reservation_get_v1(bigint, bigint, boolean);
drop function public.reservation_purge_expired_pii_v1(bigint, timestamptz, boolean);

-- Tables, triggers and helper functions all live in this schema. btree_gist stays installed
-- (other migrations use it).
drop schema reservation_private cascade;

commit;
