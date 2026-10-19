-- OPTIONAL, MANUAL, DATA-CHANGING. Run only with explicit approval, AFTER the migration
-- 20261020093000_sync_inventory_display_category_to_ledger.sql is applied and verified.
--
-- Target rows: exactly 2 pending candidates, ledger_candidates #1900 (inventory-log:13561,
-- 270000) and #1901 (inventory-log:13563, 65000). Their logs were already display-synced,
-- so the daily sync list no longer shows them and they stay on category #66.
-- Effect: proposed_category_id 66 -> 31 (and snapshot refreshed if it drifted) through the
-- same audited RPC the daily sync uses. No transaction, payable, movement, partner, payment
-- mode, amount or quantity is written. Partner #33 remains payment_mode=unspecified, so both
-- candidates stay pending (RESOLUTION_REQUIRED) for an owner decision.
--
-- Usage: set v_actor to an active owner/master users.id, run inside the transaction below,
-- inspect the result SELECTs, then COMMIT (or ROLLBACK). Rollback-after-commit is at the end.
begin;
do $backfill$
declare
  v_actor bigint := null; -- REQUIRED: active owner/master users.id executing this backfill
  v_result jsonb;
  v_log bigint;
begin
  if v_actor is null then raise exception 'BACKFILL_ACTOR_REQUIRED'; end if;
  if to_regprocedure('public.ledger_project_inventory_display_sync_v1(bigint,bigint)') is null then
    raise exception 'BACKFILL_MIGRATION_NOT_APPLIED';
  end if;
  -- Exact expected state; anything else aborts with no change.
  if (select count(*) from public.ledger_candidates
      where (id, source_key) in ((1900,'inventory-log:13561'),(1901,'inventory-log:13563'))
        and source_type = 'inventory_purchase_log' and status = 'pending' and proposed_category_id = 66) <> 2
     or exists (select 1 from public.ledger_candidates where source_type = 'inventory_purchase_log'
        and source_key in ('inventory-log:13561','inventory-log:13563') and id > 1901)
     or (select count(*) from public.inventory_logs where id in (13561,13563)
        and lower(btrim(category)) = lower(btrim('가공식품')) and coalesce(new_part, part) = 'kitchen') <> 2
     or not exists (select 1 from public.ledger_inventory_category_mappings m
        join public.ledger_categories c on c.id = m.ledger_category_id and c.kind = 'expense' and c.is_active
        where m.is_active and lower(btrim(m.inventory_category)) = lower(btrim('가공식품')) and m.ledger_category_id = 31) then
    raise exception 'BACKFILL_STATE_MISMATCH';
  end if;
  foreach v_log in array array[13561,13563] loop
    v_result := public.ledger_project_inventory_display_sync_v1(v_log, v_actor);
    if v_result->>'status' is distinct from 'pending' or coalesce((v_result->>'createdCount')::int, 0) <> 0
       or coalesce((v_result->>'supersededCount')::int, 0) <> 0 then
      raise exception 'BACKFILL_RESULT_MISMATCH: % %', v_log, v_result;
    end if;
  end loop;
  if (select count(*) from public.ledger_candidates where id in (1900,1901) and status = 'pending' and proposed_category_id = 31) <> 2 then
    raise exception 'BACKFILL_CATEGORY_NOT_UPDATED';
  end if;
end;
$backfill$;
-- Inspect before deciding (expect 2 rows on #31, 2 audit rows, no new candidates).
select id, status, proposed_category_id, proposed_amount, proposed_party_id from public.ledger_candidates
 where source_key in ('inventory-log:13561','inventory-log:13563') order by id;
select id, entity_id, action, before_snapshot->>'proposed_category_id' before_category, after_snapshot->>'proposed_category_id' after_category
 from public.ledger_audit_logs where action = 'inventory_candidate_display_synced' and entity_id in (1900,1901) order by id;
-- COMMIT;   -- after review
-- ROLLBACK; -- to discard

-- Rollback after COMMIT (only if needed; restores the exact pre-backfill candidate values
-- from the audit rows above and records the reversal):
-- begin;
-- with a as (
--   select distinct on (entity_id) entity_id, before_snapshot from public.ledger_audit_logs
--   where action = 'inventory_candidate_display_synced' and entity_id in (1900,1901) order by entity_id, id
-- ), u as (
--   update public.ledger_candidates c set proposed_category_id = (a.before_snapshot->>'proposed_category_id')::bigint,
--     proposed_party_id = (a.before_snapshot->>'proposed_party_id')::bigint, source_snapshot = a.before_snapshot->'source_snapshot',
--     source_fingerprint = a.before_snapshot->>'source_fingerprint', updated_at = now()
--   from a where c.id = a.entity_id and c.status = 'pending' returning c.id, to_jsonb(c) after_row, a.before_snapshot
-- ) insert into public.ledger_audit_logs(actor_user_id, action, entity_type, entity_id, before_snapshot, after_snapshot, reason)
--   select <owner/master users.id>, 'inventory_candidate_display_sync_reverted', 'candidate', id, before_snapshot, after_row, 'Revert 2026-10-20 display category backfill' from u;
-- -- expect 2 rows updated, then COMMIT;
