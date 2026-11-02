-- Metadata only. Execute with --read-only; no sales, stock or audit rows read.
with f as (
 select p.oid,p.oid::regprocedure::text signature,r.rolname owner,p.prosecdef,
 (select array_agg(v) from unnest(p.proconfig) v where v like 'search_path=%' or v like 'TimeZone=%') safe_config,
 md5(p.prosrc) body_hash,
 p.prosrc ~* '(update|insert into|delete from)[[:space:]]+(public[.])?inventory([[:space:](]|$)' direct_writer,
 p.prosrc ~* 'inventory_(update_with_audit|apply_purchase|apply_keg|create_with_receipt)|replace_inventory_keg|apply_sales_inventory_deduction|reprocess_modified_sales|rollback_canceled_sales' writer_caller,
 has_function_privilege('anon',p.oid,'execute') anon_execute,
 has_function_privilege('authenticated',p.oid,'execute') authenticated_execute,
 has_function_privilege('service_role',p.oid,'execute') service_execute
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner
 where n.nspname in ('public','inventory_writer_private','pos_inventory_shadow','pos_ingest_private')
 and (p.proname ~ 'inventory|pos_shadow|pos_ingest|sales_inventory' or p.prosrc ~* '(update|insert into|delete from)[[:space:]]+(public[.])?inventory([[:space:](]|$)')
)
select jsonb_build_object(
 'readOnly',current_setting('transaction_read_only'),'serverVersion',current_setting('server_version'),
 'roles',(select jsonb_agg(jsonb_build_object('name',rolname,'login',rolcanlogin,'superuser',rolsuper,'bypassRls',rolbypassrls,'createRole',rolcreaterole) order by rolname)
 from pg_roles where rolname in ('anon','authenticated','service_role','postgres','authenticator','supabase_admin','dashboard_user')),
 'memberships',(select coalesce(jsonb_agg(jsonb_build_object('member',m.rolname,'role',r.rolname)),'[]') from pg_auth_members a join pg_roles m on m.oid=a.member join pg_roles r on r.oid=a.roleid
 where m.rolname in ('anon','authenticated','service_role','authenticator','postgres','dashboard_user')),
 'tableGrants',(select jsonb_agg(jsonb_build_object('role',r.rolname,'table',c.relname,'rls',c.relrowsecurity,
 'insert',has_table_privilege(r.oid,c.oid,'insert'),'update',has_table_privilege(r.oid,c.oid,'update'),
 'delete',has_table_privilege(r.oid,c.oid,'delete'),'truncate',has_table_privilege(r.oid,c.oid,'truncate')) order by r.rolname,c.relname)
 from pg_roles r cross join pg_class c join pg_namespace n on n.oid=c.relnamespace
 where r.rolname in ('anon','authenticated','service_role','postgres','authenticator') and n.nspname='public' and c.relname in ('inventory','inventory_logs','pos_sales_receipts','pos_inventory_deductions')),
 'functions',(select jsonb_agg(to_jsonb(f) order by signature) from f),
 'triggers',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid)) order by c.relname,t.tgname)
 from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
 where not t.tgisinternal and n.nspname='public' and c.relname in ('inventory','inventory_logs','inventory_keg_sessions','pos_sales_receipts')),
 'extensions',(select jsonb_agg(extname order by extname) from pg_extension),
 'connections',(select jsonb_agg(to_jsonb(a)) from (select usename,application_name,backend_type,count(*) from pg_stat_activity where datname=current_database() group by 1,2,3) a),
 'quantityTypes',(select jsonb_agg(jsonb_build_object('table',c.relname,'column',a.attname,'type',format_type(a.atttypid,a.atttypmod)))
 from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('inventory','inventory_logs') and a.attname in ('quantity','prev_quantity','new_quantity','change_quantity') and not a.attisdropped)
) evidence;
