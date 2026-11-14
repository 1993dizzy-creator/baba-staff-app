-- Read-only postflight for 20261114161500_pos_open_orders_merged_receipt_evidence.sql.
-- Every row must be pass = true after applying. No DDL/DML.
select 'merge columns and constraint exist' check_name,
  (select count(*) = 2 from information_schema.columns where table_schema = 'pos_open_orders_private'
    and table_name = 'orders' and column_name in ('closure_merged_into_order_id', 'closure_evidence_hash'))
  and exists (select 1 from pg_constraint where conname = 'orders_merged_closure_check') pass
union all
select 'read contract is version 3',
  (pos_open_orders_private.read_v1('postflight-no-scope', current_date)->>'recoveryContractVersion') = '3'
union all
select 'commit_v1 is SECURITY DEFINER, empty search_path, executable by service_role only',
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'pos_open_orders_private' and p.proname = 'commit_v1' and p.prosecdef
      and p.proconfig @> array['search_path=""'])
  and has_function_privilege('service_role', 'pos_open_orders_private.commit_v1(uuid, uuid, jsonb, jsonb)', 'execute')
  and not has_function_privilege('anon', 'pos_open_orders_private.commit_v1(uuid, uuid, jsonb, jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'pos_open_orders_private.commit_v1(uuid, uuid, jsonb, jsonb)', 'execute')
union all
select 'merge helpers exist and are not executable by API roles',
  (select count(*) = 3 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'pos_open_orders_private' and p.proname in ('merge_zero_v1', 'merge_order_menu_v1', 'merge_receipt_menu_v1')
      and p.proconfig @> array['search_path=""']
      and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')
      and not has_function_privilege('service_role', p.oid, 'execute'))
union all
select 'public wrappers unchanged (SECURITY INVOKER)',
  (select count(*) = 4 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('pos_open_orders_claim', 'pos_open_orders_commit', 'pos_open_orders_fail', 'pos_open_orders_read')
      and not p.prosecdef)
union all
select 'existing snapshot rows carry no merge proof yet',
  not exists (select 1 from pos_open_orders_private.orders where closure_merged_into_order_id is not null);
