-- pos_open_orders_v1 — PREFLIGHT (read-only). Run before applying
-- supabase/migrations/20261109210000_pos_open_orders_v1.sql. Every row must have pass = true.
-- No DDL/DML: a single SELECT over the catalogs.
with
roles as (select rolname from pg_roles),
-- The history table may not exist (local copies). It is read through query_to_xml so the
-- statement still parses there; the inner queries are read-only SELECTs.
has_history as (select to_regclass('supabase_migrations.schema_migrations') is not null as ok),
mig as (
  select
    case when (select ok from has_history) then (xpath('/row/n/text()', query_to_xml(
      'select count(*) as n from supabase_migrations.schema_migrations where version = ''20261109210000''', false, true, '')))[1]::text::int
    end as n,
    case when (select ok from has_history) then (xpath('/row/v/text()', query_to_xml(
      'select max(version) as v from supabase_migrations.schema_migrations', false, true, '')))[1]::text
    end as latest
)
select * from (
  select 1 as ord, 'schema pos_open_orders_private does not exist' as check_name,
    not exists (select 1 from pg_namespace where nspname = 'pos_open_orders_private') as pass,
    null::text as detail
  union all
  select 2, 'no public function named pos_open_orders_*',
    not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'pos\_open\_orders\_%'),
    (select string_agg(p.oid::regprocedure::text, ', ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'pos\_open\_orders\_%')
  union all
  select 3, 'no other relation/type named like pos_open_orders in public',
    not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname like 'pos\_open\_orders%'),
    null
  union all
  select 4, 'roles postgres, service_role, anon, authenticated exist',
    (select count(*) from roles where rolname in ('postgres', 'service_role', 'anon', 'authenticated')) = 4,
    (select string_agg(rolname, ', ' order by rolname) from roles where rolname in ('postgres', 'service_role', 'anon', 'authenticated'))
  union all
  select 5, 'current user can own objects as postgres (member of postgres)',
    pg_has_role(current_user, 'postgres', 'member'),
    current_user::text
  union all
  select 6, 'migration version 20261109210000 not yet recorded',
    coalesce((select n from mig) = 0, true),
    case when (select n from mig) is null then 'supabase_migrations.schema_migrations not present (local check)' end
  union all
  select 7, 'latest recorded migration is 20261108170000 (expected predecessor)',
    case when (select ok from has_history) then (select latest from mig) = '20261108170000' else true end,
    coalesce((select latest from mig), 'local check')
  union all
  -- Data API exposed schemas are configured in the Supabase dashboard (not always visible in SQL).
  -- If the authenticator role carries pgrst.db_schemas, it must not list the private schema.
  select 8, 'private schema not in authenticator pgrst.db_schemas (if set in DB)',
    not exists (select 1 from pg_roles r, unnest(coalesce(r.rolconfig, '{}')) cfg
      where r.rolname = 'authenticator' and cfg like 'pgrst.db\_schemas=%' and cfg like '%pos_open_orders_private%'),
    (select string_agg(cfg, '; ') from pg_roles r, unnest(coalesce(r.rolconfig, '{}')) cfg
      where r.rolname = 'authenticator' and cfg like 'pgrst.db\_schemas=%')
) checks
order by ord;
