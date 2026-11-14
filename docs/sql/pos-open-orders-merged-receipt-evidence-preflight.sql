-- Read-only preflight for 20261114161500_pos_open_orders_merged_receipt_evidence.sql.
-- Every row must be pass = true before applying; detail shows what was actually found.
-- No DDL/DML. Function bodies are pinned by md5(pg_proc.prosrc) of the exact signature
-- (production baseline read 2026-11-14, identical to the committed 20261109210000 +
-- 20261110170329 migrations applied on isolated PostgreSQL 17).
with fn(sig, src_md5, secdef, api_execute) as (values
    ('pos_open_orders_private.commit_v1(uuid,uuid,jsonb,jsonb)', 'd4b4af9cf2759c8b422dfdeba058684f', true, true),
    ('pos_open_orders_private.read_v1(text,date)', 'ac855dec68eec963eb139ac2132131bc', true, true),
    ('pos_open_orders_private.commit_snapshot_v1(uuid,uuid,jsonb,jsonb)', 'bf813f2992eb7e64e4428b13b05be057', true, false),
    ('public.pos_open_orders_claim(uuid,uuid,text,text,date,integer)', 'ffb29f3976c818af0ff71b2bb6acd016', false, true),
    ('public.pos_open_orders_commit(uuid,uuid,jsonb,jsonb)', 'c343fa1175a398909b94b0acaeeb5f9d', false, true),
    ('public.pos_open_orders_fail(uuid,uuid,text)', 'eb9fa126ef56d664d2b45d88ca02c788', false, true),
    ('public.pos_open_orders_read(text,date)', '0ca4a98a15e2a524897504145ae1d547', false, true)),
found as (
  select fn.*, p.oid, md5(p.prosrc) actual_md5, p.prosecdef actual_secdef, p.proconfig, pg_get_userbyid(p.proowner) owner,
    case when p.oid is null then null else has_function_privilege('service_role', p.oid, 'execute') end svc,
    case when p.oid is null then null else has_function_privilege('anon', p.oid, 'execute') end anon,
    case when p.oid is null then null else has_function_privilege('authenticated', p.oid, 'execute') end auth
  from fn left join pg_proc p on p.oid = to_regprocedure(fn.sig)),
receipt_columns(name, type, nullable) as (values ('id', 'bigint', 'NO'), ('source', 'text', 'NO'), ('branch_id', 'text', 'YES'),
    ('business_date', 'date', 'NO'), ('payment_status', 'integer', 'YES'), ('is_canceled', 'boolean', 'NO'),
    ('total_amount', 'numeric', 'NO'), ('discount_amount', 'numeric', 'NO'), ('raw_json', 'jsonb', 'NO')),
order_constraints(name, def) as (values
    ('orders_canceled_status_check', 'CHECK (((status_class <> ''canceled''::text) OR (NOT (status IS DISTINCT FROM 5))))'),
    ('orders_pkey', 'PRIMARY KEY (scope, business_date, order_id)'),
    ('orders_status_class_check', 'CHECK ((status_class = ANY (ARRAY[''open''::text, ''paid_candidate''::text, ''canceled''::text, ''unknown''::text])))'),
    ('orders_total_amount_check', 'CHECK ((total_amount >= (0)::numeric))'))
select 'A1 history: 20261110170329 receipt-evidence migration applied' check_name,
  exists (select 1 from supabase_migrations.schema_migrations where version = '20261110170329') pass,
  coalesce((select string_agg(version || ' ' || coalesce(name, ''), ', ') from supabase_migrations.schema_migrations
    where version in ('20261109210000', '20261110170329')), 'missing') detail
union all
select 'A2 history: 20261114161500 not applied and its name not reused',
  not exists (select 1 from supabase_migrations.schema_migrations
    where version = '20261114161500' or name = 'pos_open_orders_merged_receipt_evidence'),
  coalesce((select string_agg(version || ' ' || coalesce(name, ''), ', ') from supabase_migrations.schema_migrations
    where version = '20261114161500' or name = 'pos_open_orders_merged_receipt_evidence'), 'none')
union all
select 'A3 history: no applied version newer than 20261114161500 (no out-of-order apply)',
  not exists (select 1 from supabase_migrations.schema_migrations where version > '20261114161500'),
  coalesce((select max(version) from supabase_migrations.schema_migrations), 'empty')
union all
select 'A4 no partial apply: merge columns absent',
  not exists (select 1 from information_schema.columns where table_schema = 'pos_open_orders_private' and table_name = 'orders'
    and column_name in ('closure_merged_into_order_id', 'closure_evidence_hash')),
  coalesce((select string_agg(column_name, ', ') from information_schema.columns where table_schema = 'pos_open_orders_private'
    and table_name = 'orders' and column_name in ('closure_merged_into_order_id', 'closure_evidence_hash')), 'none')
union all
select 'A5 no partial apply: merge constraint absent',
  not exists (select 1 from pg_constraint where conname = 'orders_merged_closure_check'),
  coalesce((select string_agg(conrelid::regclass::text, ', ') from pg_constraint where conname = 'orders_merged_closure_check'), 'none')
union all
select 'A6 no partial apply: merge helper functions absent',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'pos_open_orders_private' and p.proname in ('merge_zero_v1', 'merge_order_menu_v1', 'merge_receipt_menu_v1')),
  coalesce((select string_agg(p.oid::regprocedure::text, ', ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'pos_open_orders_private' and p.proname like 'merge\_%'), 'none')
union all
select 'B ' || sig || ' body/security/owner/privileges match baseline',
  oid is not null and actual_md5 = src_md5 and actual_secdef = secdef and proconfig = array['search_path=""'] and owner = 'postgres'
    and svc = api_execute and anon = false and auth = false,
  case when oid is null then 'signature not found' else concat_ws(' ', 'md5=' || actual_md5, 'secdef=' || actual_secdef,
    'config=' || array_to_string(proconfig, ','), 'owner=' || owner, 'service_role=' || svc, 'anon=' || anon, 'authenticated=' || auth) end
from found
union all
select 'B read contract is version 2 (read_v1 source; no execution needed)',
  coalesce(position('''recoveryContractVersion'', 2,' in (select prosrc from pg_proc where oid = to_regprocedure('pos_open_orders_private.read_v1(text,date)'))) > 0, false),
  coalesce(substring((select prosrc from pg_proc where oid = to_regprocedure('pos_open_orders_private.read_v1(text,date)')) from '''recoveryContractVersion'', [0-9]+'), 'missing')
union all
select 'C receipt column ' || rc.name || ' ' || rc.type || ' nullable=' || rc.nullable,
  c.data_type = rc.type and c.is_nullable = rc.nullable,
  coalesce(c.data_type || ' nullable=' || c.is_nullable, 'missing')
from receipt_columns rc left join information_schema.columns c
  on c.table_schema = 'public' and c.table_name = 'pos_sales_receipts' and c.column_name = rc.name
union all
select 'C orders constraints are exactly the 4 known ones',
  (select count(*) from pg_constraint where conrelid = 'pos_open_orders_private.orders'::regclass) = 4
    and not exists (select 1 from order_constraints oc where not exists (select 1 from pg_constraint c
      where c.conrelid = 'pos_open_orders_private.orders'::regclass and c.conname = oc.name and pg_get_constraintdef(c.oid) = oc.def)),
  (select string_agg(conname, ', ' order by conname) from pg_constraint where conrelid = 'pos_open_orders_private.orders'::regclass)
union all
select 'C no collecting run holds a live lease (apply between Cron runs)',
  not exists (select 1 from pos_open_orders_private.runs where status = 'collecting' and lease_until > clock_timestamp()),
  coalesce((select string_agg(status || ' until ' || lease_until::text, ', ') from pos_open_orders_private.runs
    where status = 'collecting' and lease_until > clock_timestamp()), 'none');
