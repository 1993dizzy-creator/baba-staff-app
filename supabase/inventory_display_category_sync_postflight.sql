-- READ-ONLY postflight after applying 20261020093000_sync_inventory_display_category_to_ledger.sql.
-- Remember: a migration run from the SQL Editor is NOT recorded in migration history.

-- 1) Migration history.
select version, name from supabase_migrations.schema_migrations where version >= '20261018000000' order by version;

-- 2) Function definitions and arguments (expect patched=true for both bodies, 3 new functions).
select p.oid::regprocedure signature, p.prosecdef security_definer, p.proowner::regrole owner,
       position('baba.inventory_display_sync' in pg_get_functiondef(p.oid)) > 0 patched
from pg_proc p
where p.oid in ('public.ledger_project_inventory_display_sync_v1(bigint,bigint)'::regprocedure,
  'public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'::regprocedure,
  'inventory_ledger_private.sync_candidate(jsonb,bigint)'::regprocedure,
  'inventory_ledger_private.display_sync_category_v1(text,bigint,jsonb)'::regprocedure,
  'inventory_ledger_private.sync_confirmed_display_category_v1(bigint,jsonb,text,bigint)'::regprocedure)
order by 1;

-- 3) PUBLIC/anon/authenticated/service_role privileges
--    (expect service_role=true only on the two public ledger_* RPCs; everything else false).
select p.oid::regprocedure signature, r.rolname, has_function_privilege(r.rolname, p.oid, 'execute') can_execute
from pg_proc p cross join (values ('anon'),('authenticated'),('service_role')) r(rolname)
where p.oid in ('public.ledger_project_inventory_display_sync_v1(bigint,bigint)'::regprocedure,
  'public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'::regprocedure,
  'inventory_ledger_private.sync_candidate(jsonb,bigint)'::regprocedure,
  'inventory_ledger_private.display_sync_category_v1(text,bigint,jsonb)'::regprocedure,
  'inventory_ledger_private.sync_confirmed_display_category_v1(bigint,jsonb,text,bigint)'::regprocedure)
order by 1, 2;
select p.oid::regprocedure signature, a.grantee::regrole
from pg_proc p, aclexplode(p.proacl) a
where p.proname = 'ledger_project_inventory_display_sync_v1' and a.grantee = 0; -- expect no PUBLIC row

-- 4) Row counts / unexpected changes (the migration itself writes no rows; compare with preflight).
select status, count(*) from public.ledger_candidates where source_type = 'inventory_purchase_log' group by 1 order by 1;
select c.id, c.status, c.proposed_category_id, c.proposed_amount from public.ledger_candidates c
where c.source_key in ('inventory-log:13561','inventory-log:13563') order by c.id;

-- 5) Audit rows created by display syncs / category rebooks since the migration.
select action, count(*), max(created_at) from public.ledger_audit_logs
where action in ('inventory_candidate_display_synced','inventory_source_rebooked','inventory_source_projected')
  and created_at >= now() - interval '1 day' group by 1 order by 1;
select inventory_log_id, status, code from public.ledger_inventory_projection_status
where code like 'CATEGORY_%' order by updated_at desc limit 50;

-- 6) Then review Supabase Security and Performance Advisors in the dashboard.
