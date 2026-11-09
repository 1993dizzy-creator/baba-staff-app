-- pos_open_orders_v1 — POSTFLIGHT (read-only). Run right after applying
-- supabase/migrations/20261109210000_pos_open_orders_v1.sql. Every row must have pass = true.
-- No DDL/DML: a single SELECT over the catalogs and four row counts.
with
fn(schema_name, fname, args, secdef, volatility, owner_required) as (values
  ('pos_open_orders_private', 'claim_v1', 'uuid, uuid, text, text, date, integer', true, 'v', true),
  ('pos_open_orders_private', 'commit_v1', 'uuid, uuid, jsonb, jsonb', true, 'v', true),
  ('pos_open_orders_private', 'fail_v1', 'uuid, uuid, text', true, 'v', true),
  ('pos_open_orders_private', 'read_v1', 'text, date', true, 's', true),
  ('public', 'pos_open_orders_claim', 'uuid, uuid, text, text, date, integer', false, 'v', false),
  ('public', 'pos_open_orders_commit', 'uuid, uuid, jsonb, jsonb', false, 'v', false),
  ('public', 'pos_open_orders_fail', 'uuid, uuid, text', false, 'v', false),
  ('public', 'pos_open_orders_read', 'text, date', false, 's', false)
),
fx as (
  select f.*, to_regprocedure(format('%I.%I(%s)', f.schema_name, f.fname, f.args)) as oid from fn f
),
tbl(tname) as (values ('runs'), ('sync_state'), ('orders'), ('order_lines')),
api_roles(rname) as (values ('anon'), ('authenticated'), ('service_role')),
modes(m) as (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger'))
select * from (
  select 1 as ord, 'schema exists' as check_name,
    exists (select 1 from pg_namespace where nspname = 'pos_open_orders_private') as pass, null::text as detail
  union all
  select 2, 'tables exist with RLS enabled (4)',
    (select count(*) from tbl t join pg_class c on c.oid = to_regclass('pos_open_orders_private.' || t.tname) where c.relrowsecurity) = 4,
    (select string_agg(t.tname || ':' || coalesce(c.relrowsecurity::text, 'missing'), ', ')
       from tbl t left join pg_class c on c.oid = to_regclass('pos_open_orders_private.' || t.tname))
  union all
  select 3, 'indexes: active-scope partial unique + recent runs',
    exists (select 1 from pg_index i where i.indexrelid = to_regclass('pos_open_orders_private.pos_open_orders_active_scope')
      and i.indisunique and i.indpred is not null)
    and to_regclass('pos_open_orders_private.pos_open_orders_runs_recent') is not null,
    null
  union all
  select 4, 'all 8 functions exist with exact signatures',
    (select count(*) from fx where oid is not null) = 8,
    (select string_agg(schema_name || '.' || fname, ', ') from fx where oid is null)
  union all
  select 5, 'internal = SECURITY DEFINER, wrappers = SECURITY INVOKER',
    not exists (select 1 from fx join pg_proc p on p.oid = fx.oid where p.prosecdef <> fx.secdef),
    (select string_agg(fx.fname || '=' || p.prosecdef, ', ') from fx join pg_proc p on p.oid = fx.oid where p.prosecdef <> fx.secdef)
  union all
  select 6, 'all 8 functions pin search_path to empty',
    not exists (select 1 from fx join pg_proc p on p.oid = fx.oid where coalesce(p.proconfig, '{}') <> array['search_path=""']),
    (select string_agg(fx.fname || '=' || coalesce(array_to_string(p.proconfig, ';'), 'none'), ', ')
       from fx join pg_proc p on p.oid = fx.oid where coalesce(p.proconfig, '{}') <> array['search_path=""'])
  union all
  select 7, 'internal functions owned by postgres',
    not exists (select 1 from fx join pg_proc p on p.oid = fx.oid where fx.owner_required and pg_get_userbyid(p.proowner) <> 'postgres'),
    (select string_agg(fx.fname || '=' || pg_get_userbyid(p.proowner), ', ') from fx join pg_proc p on p.oid = fx.oid where fx.owner_required)
  union all
  select 8, 'volatility: read = stable, others volatile',
    not exists (select 1 from fx join pg_proc p on p.oid = fx.oid where p.provolatile::text <> fx.volatility),
    null
  union all
  select 9, 'EXECUTE: only service_role on all 8 functions',
    not exists (select 1 from fx, api_roles r
      where fx.oid is not null and has_function_privilege(r.rname, fx.oid, 'execute') <> (r.rname = 'service_role')),
    (select string_agg(r.rname || ':' || fx.fname, ', ') from fx, api_roles r
      where fx.oid is not null and has_function_privilege(r.rname, fx.oid, 'execute') <> (r.rname = 'service_role'))
  union all
  select 10, 'PUBLIC has no privilege on the 8 functions',
    not exists (select 1 from fx join pg_proc p on p.oid = fx.oid, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where a.grantee = 0),
    null
  union all
  select 11, 'schema USAGE only for service_role; CREATE for none of the API roles',
    not exists (select 1 from api_roles r
      where has_schema_privilege(r.rname, 'pos_open_orders_private', 'usage') <> (r.rname = 'service_role')
         or has_schema_privilege(r.rname, 'pos_open_orders_private', 'create')),
    null
  union all
  select 12, 'no table privilege for anon/authenticated/service_role (7 modes x 4 tables)',
    not exists (select 1 from tbl t, api_roles r, modes m
      where has_table_privilege(r.rname, 'pos_open_orders_private.' || t.tname, m.m)),
    (select string_agg(r.rname || ':' || m.m || ':' || t.tname, ', ') from tbl t, api_roles r, modes m
      where has_table_privilege(r.rname, 'pos_open_orders_private.' || t.tname, m.m))
  union all
  select 13, 'PUBLIC has no privilege on schema or tables',
    not exists (select 1 from pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
      where n.nspname = 'pos_open_orders_private' and a.grantee = 0)
    and not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace,
      aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where n.nspname = 'pos_open_orders_private' and a.grantee = 0),
    null
  union all
  select 14, 'no data yet (all 4 tables empty)',
    (select count(*) from pos_open_orders_private.runs) + (select count(*) from pos_open_orders_private.sync_state)
      + (select count(*) from pos_open_orders_private.orders) + (select count(*) from pos_open_orders_private.order_lines) = 0,
    null
  union all
  select 15, 'only the expected objects in the private schema (4 tables, 4 functions)',
    (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'pos_open_orders_private' and c.relkind in ('r', 'p', 'v', 'm', 'f')) = 4
    and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'pos_open_orders_private') = 4,
    null
  union all
  select 16, 'private schema not in authenticator pgrst.db_schemas (if set in DB)',
    not exists (select 1 from pg_roles r, unnest(coalesce(r.rolconfig, '{}')) cfg
      where r.rolname = 'authenticator' and cfg like 'pgrst.db\_schemas=%' and cfg like '%pos_open_orders_private%'),
    'also confirm Dashboard > API > Exposed schemas'
) checks
order by ord;
