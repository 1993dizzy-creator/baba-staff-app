-- Read-only DDL/permission snapshot to save before applying 202607190002.
select jsonb_build_object(
  'capturedAt', clock_timestamp(),
  'columns', (
    select jsonb_agg(to_jsonb(column_row) order by table_name, ordinal_position)
    from (
      select table_name, ordinal_position, column_name, data_type, udt_name,
             is_nullable, column_default
      from information_schema.columns
      where table_schema = 'public'
        and table_name in ('pos_processed_invoice_lines', 'pos_inventory_deductions')
    ) column_row
  ),
  'constraints', (
    select jsonb_agg(jsonb_build_object(
      'table', relation.relname,
      'name', constraint_row.conname,
      'definition', pg_get_constraintdef(constraint_row.oid)
    ) order by relation.relname, constraint_row.conname)
    from pg_constraint constraint_row
    join pg_class relation on relation.oid = constraint_row.conrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname in ('pos_processed_invoice_lines', 'pos_inventory_deductions')
  ),
  'indexes', (
    select jsonb_agg(to_jsonb(index_row) order by tablename, indexname)
    from (
      select tablename, indexname, indexdef
      from pg_indexes
      where schemaname = 'public'
        and tablename in ('pos_processed_invoice_lines', 'pos_inventory_deductions')
    ) index_row
  ),
  'triggers', (
    select coalesce(jsonb_agg(to_jsonb(trigger_row) order by event_object_table, trigger_name), '[]'::jsonb)
    from (
      select event_object_table, trigger_name, event_manipulation, action_statement
      from information_schema.triggers
      where event_object_schema = 'public'
        and event_object_table in ('pos_processed_invoice_lines', 'pos_inventory_deductions')
    ) trigger_row
  ),
  'tableGrants', (
    select coalesce(jsonb_agg(to_jsonb(grant_row) order by table_name, grantee, privilege_type), '[]'::jsonb)
    from (
      select table_name, grantee, privilege_type
      from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name in ('pos_processed_invoice_lines', 'pos_inventory_deductions')
    ) grant_row
  ),
  'functions', (
    select jsonb_object_agg(procedure.proname, pg_get_functiondef(procedure.oid))
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname in (
        'apply_pos_direct_inventory_deductions',
        'reprocess_modified_sales_inventory_deduction_receipt',
        'rollback_canceled_sales_inventory_deduction_receipt'
      )
  )
) as schema_snapshot;
