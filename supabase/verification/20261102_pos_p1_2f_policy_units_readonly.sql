-- Read-only configuration aggregates; no item identities or stock quantities.
select jsonb_build_object(
 'readOnly',current_setting('transaction_read_only'),
 'policies',(select jsonb_agg(jsonb_build_object('table',tablename,'policy',policyname,'roles',roles,'command',cmd))
  from pg_policies where schemaname='public' and tablename in ('inventory','inventory_logs')),
 'rls',(select jsonb_agg(jsonb_build_object('table',relname,'enabled',relrowsecurity,'forced',relforcerowsecurity))
  from pg_class where oid in ('public.inventory'::regclass,'public.inventory_logs'::regclass)),
 'unitGroups',(select jsonb_agg(to_jsonb(u)) from (select unit,package_content_quantity,package_content_unit,count(*) item_count
  from public.inventory group by 1,2,3 order by 1,2,3) u),
 'missingCapacity',(select count(*) from public.inventory where package_content_quantity is null),
 'cronJobsCatalogVisible',to_regclass('cron.job') is not null
) evidence;
