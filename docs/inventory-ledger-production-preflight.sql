-- READ ONLY: run before any separately approved deployment; save all result sets.
-- Run again after application as postflight and compare. Do not invoke mutation RPCs.
SELECT version(), current_database(), current_user;
SELECT version, name FROM supabase_migrations.schema_migrations
WHERE version IN ('202608250002','202608250003','20260903154302','20260903155046','20260906114438')
ORDER BY version;

-- Signatures, owners, execution context, ACL and function bodies, including old RPCs.
SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS arguments,
 pg_get_function_result(p.oid) AS result, pg_get_userbyid(p.proowner) AS owner,
 p.prosecdef AS security_definer, p.proconfig, p.proacl,
 md5(pg_get_functiondef(p.oid)) AS definition_md5, pg_get_functiondef(p.oid) AS definition
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='inventory_ledger_private' OR (n.nspname='public' AND p.proname IN (
 'ledger_project_inventory_purchase_log_v1','ledger_reconcile_inventory_month_v1',
 'ledger_sync_inventory_candidates_v1','ledger_sync_inventory_candidates_v2',
 'ledger_sync_inventory_candidates_core_v1','ledger_resolve_inventory_candidate_v1',
 'ledger_rebook_inventory_transaction_v1','ledger_confirmed_candidate_drift_v1'))
ORDER BY 1,2,3;

SELECT n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,
 r.rolname,has_schema_privilege(r.oid,n.oid,'USAGE') AS schema_usage,
 has_function_privilege(r.oid,p.oid,'EXECUTE') AS can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
CROSS JOIN pg_roles r
WHERE r.rolname IN ('postgres','anon','authenticated','service_role')
AND (n.nspname='inventory_ledger_private' OR (n.nspname='public' AND p.proname IN (
 'ledger_project_inventory_purchase_log_v1','ledger_reconcile_inventory_month_v1',
 'ledger_sync_inventory_candidates_v1','ledger_sync_inventory_candidates_v2',
 'ledger_sync_inventory_candidates_core_v1','ledger_resolve_inventory_candidate_v1',
 'ledger_rebook_inventory_transaction_v1')))
ORDER BY 1,2,3,4;

-- Includes PUBLIC defaults (grantee=0), which role-only checks do not describe.
SELECT n.nspname,p.proname,a.grantee,a.privilege_type,a.is_grantable
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
WHERE n.nspname='inventory_ledger_private' OR p.proname IN
 ('ledger_project_inventory_purchase_log_v1','ledger_reconcile_inventory_month_v1');

SELECT column_name,data_type,is_nullable FROM information_schema.columns
WHERE table_schema='public' AND table_name='inventory_logs'
ORDER BY ordinal_position;
SELECT n.nspname,c.relname,c.relkind,c.relrowsecurity,c.relacl,pg_get_userbyid(c.relowner) AS owner
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE c.relname IN ('ledger_inventory_projection_status','ledger_candidates_inventory_source_idx',
 'inventory_logs_purchase_supplier_partner_idx','inventory_logs_source_actor_idx',
 'ledger_inventory_projection_actor_idx');
SELECT nspname,nspacl,pg_get_userbyid(nspowner) AS owner FROM pg_namespace
WHERE nspname='inventory_ledger_private';
SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public'
AND tablename IN ('inventory_logs','ledger_candidates','ledger_inventory_projection_status');
SELECT conrelid::regclass AS relation,conname,pg_get_constraintdef(oid)
FROM pg_constraint WHERE conrelid IN (to_regclass('public.inventory_logs'),
 to_regclass('public.ledger_inventory_projection_status'));

-- Dependencies of functions being replaced, and installed candidate triggers.
SELECT pg_describe_object(d.classid,d.objid,d.objsubid) AS dependent,d.deptype,
 pg_describe_object(d.refclassid,d.refobjid,d.refobjsubid) AS referenced
FROM pg_depend d WHERE d.refclassid='pg_proc'::regclass AND d.refobjid IN
 (SELECT oid FROM pg_proc WHERE proname IN
 ('ledger_sync_inventory_candidates_v2','ledger_confirmed_candidate_drift_v1'));
SELECT tgname,pg_get_triggerdef(oid) FROM pg_trigger
WHERE tgrelid='public.ledger_candidates'::regclass AND NOT tgisinternal;

-- Migration itself must not alter these counts (compare during a quiet window;
-- otherwise concurrent application writes can legitimately change them).
SELECT 'inventory_logs' AS relation,count(*) FROM public.inventory_logs
UNION ALL SELECT 'ledger_candidates',count(*) FROM public.ledger_candidates
UNION ALL SELECT 'ledger_transactions',count(*) FROM public.ledger_transactions
UNION ALL SELECT 'ledger_movements',count(*) FROM public.ledger_movements
UNION ALL SELECT 'ledger_payables',count(*) FROM public.ledger_payables
UNION ALL SELECT 'ledger_audit_logs',count(*) FROM public.ledger_audit_logs;

-- POSTFLIGHT ONLY: run these after the new objects exist.
SELECT status,code,count(*) FROM public.ledger_inventory_projection_status GROUP BY 1,2;
SELECT r.rolname,has_table_privilege(r.oid,'public.ledger_inventory_projection_status','SELECT') AS can_select,
 has_table_privilege(r.oid,'public.ledger_inventory_projection_status','INSERT,UPDATE,DELETE') AS can_mutate
FROM pg_roles r WHERE rolname IN ('anon','authenticated','service_role');
SELECT * FROM pg_policies WHERE schemaname='public' AND tablename='ledger_inventory_projection_status';
SELECT source_key,count(*) FROM public.ledger_candidates
WHERE source_type='inventory_purchase_log' AND status='confirmed'
GROUP BY source_key HAVING count(*)>1;
SELECT c.id,c.source_key,c.resolved_transaction_id FROM public.ledger_candidates c
LEFT JOIN public.ledger_transactions t ON t.id=c.resolved_transaction_id
WHERE c.source_type='inventory_purchase_log' AND c.status='confirmed' AND t.id IS NULL;
SELECT action,count(*) FROM public.ledger_audit_logs
WHERE action IN ('inventory_source_projected','inventory_source_rebooked') GROUP BY action;
