-- Run this snapshot query before and after applying the migration.
-- The total and every status count must be identical.
select
  count(*) as total_count,
  status,
  count(*) as status_count
from public.pos_inventory_deduction_receipts
group by rollup (status)
order by status nulls first;

-- Expected after migration: relrowsecurity = true.
select
  namespace.nspname as schema_name,
  relation.relname as table_name,
  relation.relrowsecurity
from pg_class relation
join pg_namespace namespace
  on namespace.oid = relation.relnamespace
where namespace.nspname = 'public'
  and relation.relname = 'pos_inventory_deduction_receipts';

-- Expected after migration:
-- anon/authenticated = false for all table privileges;
-- service_role/postgres = true for all table privileges.
select
  role_name,
  privilege_type,
  has_table_privilege(
    role_name,
    'public.pos_inventory_deduction_receipts',
    privilege_type
  ) as has_privilege
from unnest(array['anon', 'authenticated', 'service_role', 'postgres'])
  as roles(role_name)
cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
  as privileges(privilege_type)
order by role_name, privilege_type;

-- Expected after migration:
-- anon/authenticated = false for every signature;
-- service_role/postgres = true for every signature.
select
  role_name,
  function_signature,
  has_function_privilege(
    role_name,
    function_signature,
    'EXECUTE'
  ) as has_execute
from unnest(array['anon', 'authenticated', 'service_role', 'postgres'])
  as roles(role_name)
cross join unnest(array[
  'public.apply_sales_inventory_deduction_batch(bigint,text,jsonb)',
  'public.replace_inventory_keg(bigint,text,date,numeric)',
  'public.replace_inventory_keg(bigint,text,date,numeric,timestamp with time zone)'
])
  as functions(function_signature)
order by role_name, function_signature;
