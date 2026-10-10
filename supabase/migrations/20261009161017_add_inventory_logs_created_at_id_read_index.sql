-- The inventory log card loader and recent loader order by these exact keys.
-- DESC defaults to NULLS FIRST, so NULLS LAST must be explicit.
-- Narrow ordering index only: no INCLUDE payload, data rewrite, or policy change.
-- Apply only after checking production pg_indexes for equivalent indexes and
-- reserving a brief write-lock window; this is intentionally non-CONCURRENT
-- so the normal transactional migration runner can execute it safely.
create index inventory_logs_created_at_id_read_idx
  on public.inventory_logs using btree (created_at desc nulls last, id desc);
