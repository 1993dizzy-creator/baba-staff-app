-- Read-only STRUCTURAL postflight for 20261114161500_pos_open_orders_merged_receipt_evidence.sql.
-- Run right after applying (works before any collection) and any time later: it never
-- depends on whether merge proofs exist. Data checks after the app deploy live in
-- pos-open-orders-merged-receipt-evidence-functional-check.sql. No DDL/DML.
with fn(sig, src_md5, secdef, service_execute) as (values
    -- Replaced by the migration (new bodies).
    ('pos_open_orders_private.commit_v1(uuid,uuid,jsonb,jsonb)', '9a56ebf8ba0ef3f60d5e646fbf8aab97', true, true),
    ('pos_open_orders_private.read_v1(text,date)', 'a1c3dcbf7e0644675d0d29b11afce52f', true, true),
    -- Added private helpers: SECURITY INVOKER, not executable by any API role.
    ('pos_open_orders_private.merge_zero_v1(jsonb)', '9fb8e4da75000694355e4f8f84888ba9', false, false),
    ('pos_open_orders_private.merge_order_menu_v1(jsonb)', '89fe0b9031ce56dea1fe20176cb3adb1', false, false),
    ('pos_open_orders_private.merge_receipt_menu_v1(jsonb)', '490cf4e52b606df3958f4e943649914a', false, false),
    -- Must be unchanged (production baseline).
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
new_columns(name) as (values ('closure_merged_into_order_id'), ('closure_evidence_hash'))
select 'S1 history: 20261114161500 recorded' check_name,
  exists (select 1 from supabase_migrations.schema_migrations where version = '20261114161500') pass,
  coalesce((select version || ' ' || coalesce(name, '') from supabase_migrations.schema_migrations where version = '20261114161500'), 'missing') detail
union all
select 'S2 column pos_open_orders_private.orders.' || nc.name || ' text nullable',
  a.attnum is not null and format_type(a.atttypid, a.atttypmod) = 'text' and not a.attnotnull,
  coalesce(format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else ' nullable' end, 'missing')
from new_columns nc left join pg_attribute a
  on a.attrelid = 'pos_open_orders_private.orders'::regclass and a.attname = nc.name and not a.attisdropped
union all
select 'S3 constraint orders_merged_closure_check on pos_open_orders_private.orders',
  exists (select 1 from pg_constraint where conname = 'orders_merged_closure_check' and conrelid = 'pos_open_orders_private.orders'::regclass
    and contype = 'c' and convalidated and pg_get_constraintdef(oid) = 'CHECK ((((closure_merged_into_order_id IS NULL) AND (closure_evidence_hash IS NULL)) OR ((closure_merged_into_order_id IS NOT NULL) AND (closure_receipt_id IS NOT NULL) AND (closure_merged_into_order_id <> order_id) AND (closure_evidence_hash ~ ''^[0-9a-f]{32}$''::text))))'),
  coalesce((select conrelid::regclass::text || ' ' || pg_get_constraintdef(oid) from pg_constraint where conname = 'orders_merged_closure_check'), 'missing')
union all
select 'S4 the 4 original orders constraints are unchanged',
  (select count(*) from pg_constraint where conrelid = 'pos_open_orders_private.orders'::regclass) = 5
    and (select count(*) from pg_constraint c where c.conrelid = 'pos_open_orders_private.orders'::regclass and (c.conname, pg_get_constraintdef(c.oid)) in (
      ('orders_canceled_status_check', 'CHECK (((status_class <> ''canceled''::text) OR (NOT (status IS DISTINCT FROM 5))))'),
      ('orders_pkey', 'PRIMARY KEY (scope, business_date, order_id)'),
      ('orders_status_class_check', 'CHECK ((status_class = ANY (ARRAY[''open''::text, ''paid_candidate''::text, ''canceled''::text, ''unknown''::text])))'),
      ('orders_total_amount_check', 'CHECK ((total_amount >= (0)::numeric))'))) = 4,
  (select string_agg(conname, ', ' order by conname) from pg_constraint where conrelid = 'pos_open_orders_private.orders'::regclass)
union all
select 'S5 ' || sig || ' body/security/owner/privileges',
  oid is not null and actual_md5 = src_md5 and actual_secdef = secdef and proconfig = array['search_path=""'] and owner = 'postgres'
    and svc = service_execute and anon = false and auth = false,
  case when oid is null then 'signature not found' else concat_ws(' ', 'md5=' || actual_md5, 'secdef=' || actual_secdef,
    'config=' || array_to_string(proconfig, ','), 'owner=' || owner, 'service_role=' || svc, 'anon=' || anon, 'authenticated=' || auth) end
from found
union all
select 'S6 read contract is version 3 (read_v1 source; no execution needed)',
  coalesce(position('''recoveryContractVersion'', 3,' in (select prosrc from pg_proc where oid = to_regprocedure('pos_open_orders_private.read_v1(text,date)'))) > 0, false),
  coalesce(substring((select prosrc from pg_proc where oid = to_regprocedure('pos_open_orders_private.read_v1(text,date)')) from '''recoveryContractVersion'', [0-9]+'), 'missing');
