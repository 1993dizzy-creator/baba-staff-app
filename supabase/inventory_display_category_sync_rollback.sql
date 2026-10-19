-- MANUAL ROLLBACK for 20261020093000_sync_inventory_display_category_to_ledger.sql.
-- Run only with explicit approval (as a follow-up migration if history must record it).
-- Removes exactly the inserted blocks, restoring the previous function bodies byte-for-byte
-- (verified in tests/inventory-display-category-sync-db.test.mjs), then drops the new
-- functions. Rows already changed by display syncs (in-place pending candidates, category
-- rebooks with their reversal) are audited ledger history and are not touched here.
begin;
do $rollback$
declare
  definition text; eol text; start_at integer; end_at integer; block text;
begin
  -- sync_candidate: block between its marker and the original pending-fingerprint branch.
  definition := pg_get_functiondef('inventory_ledger_private.sync_candidate(jsonb,bigint)'::regprocedure);
  eol := case when position(chr(13)||chr(10) in definition) > 0 then chr(13)||chr(10) else chr(10) end;
  start_at := position('    -- Explicit display-only daily sync: keep the pending candidate identity and its party.' in definition);
  end_at := position('    if v_pending.id is not null and v_pending.source_fingerprint = v_fingerprint then' in definition);
  if start_at = 0 or end_at <= start_at then raise exception 'INVENTORY_DISPLAY_SYNC_ROLLBACK_MISMATCH: sync_candidate'; end if;
  execute overlay(definition placing '' from start_at for end_at - start_at);

  -- projection: the confirmed-category block ends right before the original economic branch.
  definition := pg_get_functiondef('public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'::regprocedure);
  eol := case when position(chr(13)||chr(10) in definition) > 0 then chr(13)||chr(10) else chr(10) end;
  start_at := position('          -- Explicit display-only daily sync: follow the category on an unpaid open-month expense.' in definition);
  end_at := position('        else' || eol || '          -- Economic drift always requires explicit owner confirmation' in definition);
  block := '  v_display_sync jsonb;' || eol;
  if start_at = 0 or end_at <= start_at or position(block in definition) = 0 then
    raise exception 'INVENTORY_DISPLAY_SYNC_ROLLBACK_MISMATCH: projection';
  end if;
  definition := overlay(definition placing '' from start_at for end_at - start_at);
  execute replace(definition, block, '');
end;
$rollback$;
drop function public.ledger_project_inventory_display_sync_v1(bigint,bigint);
drop function inventory_ledger_private.sync_confirmed_display_category_v1(bigint,jsonb,text,bigint);
drop function inventory_ledger_private.display_sync_category_v1(text,bigint,jsonb);
alter function inventory_ledger_private.sync_candidate(jsonb,bigint) owner to postgres;
revoke all on function inventory_ledger_private.sync_candidate(jsonb,bigint) from public,anon,authenticated,service_role;
alter function public.ledger_project_inventory_purchase_log_v1(bigint,bigint) owner to postgres;
revoke all on function public.ledger_project_inventory_purchase_log_v1(bigint,bigint) from public,anon,authenticated,service_role;
grant execute on function public.ledger_project_inventory_purchase_log_v1(bigint,bigint) to service_role;
commit;
