-- P1-3A. Metadata only; run with CLI --remote --read-only. Never run RPCs.
select jsonb_build_object(
 'readOnly',current_setting('transaction_read_only'),'observedAt',clock_timestamp(),
 'schemas',(select jsonb_agg(nspname order by nspname) from pg_namespace where nspname in ('pos_inventory_shadow','pos_ingest_private','inventory_writer_private','pos_signed_private','supabase_migrations','cron','net')),
 'catalogs',(select jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname)) from pg_class c join pg_namespace n on n.oid=c.relnamespace where (n.nspname in ('cron','supabase_migrations') or c.relname in ('inventory','inventory_logs','pos_inventory_deductions','pos_sales_receipts')) and c.relkind in ('r','v')),
 'columns',(select jsonb_agg(jsonb_build_object('table',table_name,'column',column_name,'type',data_type) order by table_name,ordinal_position) from information_schema.columns where table_schema='public' and table_name in ('inventory','inventory_logs','pos_inventory_deductions','pos_sales_receipts','inventory_keg_sessions')),
 'functions',(select jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'owner',r.rolname,'definer',p.prosecdef,
  'bodyLFMD5',md5(replace(replace(p.prosrc,E'\r\n',E'\n'),E'\r',E'\n')),
  'quantityDml',p.prosrc ~* '(update[[:space:]]+(public[.])?"?inventory"?[[:space:]]+set|insert[[:space:]]+into[[:space:]]+(public[.])?"?inventory"?[[:space:](])',
  'mentionsInventory',p.prosrc ilike '%inventory%',
  'anon',has_function_privilege('anon',p.oid,'execute'),'auth',has_function_privilege('authenticated',p.oid,'execute'),'service',has_function_privilege('service_role',p.oid,'execute')) order by p.oid::regprocedure::text)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner where n.nspname='public' and (p.prosrc ilike '%inventory%' or p.proname ~ '^pos_(shadow|ingest|signed)')),
 'memberships',(select jsonb_agg(jsonb_build_object('role',r.rolname,'member',m.rolname,'admin',a.admin_option)) from pg_auth_members a join pg_roles r on r.oid=a.roleid join pg_roles m on m.oid=a.member where m.rolname in ('service_role','anon','authenticated','authenticator','postgres','dashboard_user')),
 'extensions',(select jsonb_agg(extname order by extname) from pg_extension),
 'cronDatabase',current_setting('cron.database_name',true),
 'databases',(select jsonb_agg(datname order by datname) from pg_database where datallowconn)
) evidence;
