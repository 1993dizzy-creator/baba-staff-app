-- Expected:
-- calculate_inventory_keg_sales: anon/authenticated false, service_role/postgres true.
-- both replace_inventory_keg overloads: anon/authenticated false,
-- service_role/postgres true.
select
  role_name,
  function_signature,
  has_function_privilege(role_name, function_signature, 'EXECUTE') as has_execute
from unnest(array['anon', 'authenticated', 'service_role', 'postgres'])
  as roles(role_name)
cross join unnest(array[
  'public.calculate_inventory_keg_sales(bigint,timestamp with time zone,timestamp with time zone)',
  'public.replace_inventory_keg(bigint,text,date,numeric)',
  'public.replace_inventory_keg(bigint,text,date,numeric,timestamp with time zone)'
])
  as functions(function_signature)
order by function_signature, role_name;

-- Expected: the calculate function is STABLE and not SECURITY DEFINER.
select
  procedure.proname,
  pg_get_function_identity_arguments(procedure.oid) as arguments,
  procedure.provolatile,
  procedure.prosecdef
from pg_proc procedure
join pg_namespace namespace
  on namespace.oid = procedure.pronamespace
where namespace.nspname = 'public'
  and procedure.proname = 'calculate_inventory_keg_sales';

-- Expected: the 5-argument implementation uses the shared calculation.
-- The 4-argument compatibility overload delegates to the 5-argument overload.
select
  pg_get_function_identity_arguments(procedure.oid) as arguments,
  position(
    'calculate_inventory_keg_sales'
    in pg_get_functiondef(procedure.oid)
  ) > 0 as uses_shared_calculation,
  position(
    'select public.replace_inventory_keg'
    in pg_get_functiondef(procedure.oid)
  ) > 0 as delegates_to_timed_overload
from pg_proc procedure
join pg_namespace namespace
  on namespace.oid = procedure.pronamespace
where namespace.nspname = 'public'
  and procedure.proname = 'replace_inventory_keg'
order by arguments;

-- Optional read-only production comparison. Review IDs/timestamps first.
-- select public.calculate_inventory_keg_sales(
--   28,
--   '2026-07-07 21:14:00+07'::timestamp with time zone,
--   '2026-07-22 22:31:00+07'::timestamp with time zone
-- );
