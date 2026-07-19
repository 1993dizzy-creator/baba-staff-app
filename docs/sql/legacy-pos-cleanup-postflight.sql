-- Read-only verification after applying 202607190002.
-- Compare operational checksums and counts with legacy-pos-cleanup-preflight.sql.
select jsonb_build_object(
  'verifiedAt', clock_timestamp(),
  'archive', jsonb_build_object(
    'processedLineCount', (select count(*) from public.legacy_pos_processed_line_archive),
    'deductionCount', (select count(*) from public.legacy_pos_inventory_deduction_archive),
    'appliedCount', (select count(*) from public.legacy_pos_inventory_deduction_archive where deduction_status = 'applied'),
    'failedCount', (select count(*) from public.legacy_pos_inventory_deduction_archive where deduction_status = 'failed'),
    'appliedLogLinks', (
      select count(*)
      from public.legacy_pos_inventory_deduction_archive deduction
      join public.inventory_logs inventory_log on inventory_log.id = deduction.inventory_log_id
      where deduction.deduction_status = 'applied'
        and inventory_log.item_id = deduction.inventory_item_id
        and inventory_log.change_quantity = -deduction.deduct_quantity
    ),
    'rlsEnabled', (
      select bool_and(relrowsecurity)
      from pg_class
      where oid in (
        'public.legacy_pos_processed_line_archive'::regclass,
        'public.legacy_pos_inventory_deduction_archive'::regclass
      )
    ),
    'unsafeAppGrants', (
      select count(*) from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name in ('legacy_pos_processed_line_archive', 'legacy_pos_inventory_deduction_archive')
        and grantee in ('PUBLIC', 'anon', 'authenticated')
    )
  ),
  'removed', jsonb_build_object(
    'processedLineTable', to_regclass('public.pos_processed_invoice_lines') is null,
    'legacyRpc', to_regprocedure('public.apply_pos_direct_inventory_deductions(date,integer,text,text)') is null,
    'processedLineColumn', not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'pos_inventory_deductions' and column_name = 'processed_line_id'
    ),
    'processedLineIndexes', not exists (
      select 1 from pg_indexes
      where schemaname = 'public' and tablename = 'pos_inventory_deductions'
        and indexdef ilike '%processed_line_id%'
    )
  ),
  'functions', jsonb_build_object(
    'reprocessExists', to_regprocedure('public.reprocess_modified_sales_inventory_deduction_receipt(bigint,text,timestamp with time zone,text,text)') is not null,
    'rollbackExists', to_regprocedure('public.rollback_canceled_sales_inventory_deduction_receipt(bigint,text,timestamp with time zone,text)') is not null,
    'legacyReferences', (
      select count(*) from pg_proc
      where oid in (
        to_regprocedure('public.reprocess_modified_sales_inventory_deduction_receipt(bigint,text,timestamp with time zone,text,text)'),
        to_regprocedure('public.rollback_canceled_sales_inventory_deduction_receipt(bigint,text,timestamp with time zone,text)')
      ) and pg_get_functiondef(oid) ilike '%processed_line_id%'
    ),
    'unsafeExecuteGrants', (
      select count(*) from information_schema.routine_privileges
      where specific_schema = 'public'
        and routine_name in ('reprocess_modified_sales_inventory_deduction_receipt', 'rollback_canceled_sales_inventory_deduction_receipt')
        and grantee in ('PUBLIC', 'anon', 'authenticated')
        and privilege_type = 'EXECUTE'
    )
  ),
  'receiptDeductions', jsonb_build_object(
    'count', (select count(*) from public.pos_inventory_deductions),
    'idChecksum', (select coalesce(sum(id), 0) from public.pos_inventory_deductions),
    'statusCounts', (
      select coalesce(jsonb_object_agg(status, row_count), '{}'::jsonb)
      from (select status, count(*) row_count from public.pos_inventory_deductions group by status) status_counts
    ),
    'appliedCount', (select count(*) from public.pos_inventory_deductions where status in ('applied', 'success') or applied_at is not null or inventory_log_id is not null),
    'inventoryLogLinks', (select count(*) from public.pos_inventory_deductions where inventory_log_id is not null),
    'orphans', jsonb_build_object(
      'receipt', (select count(*) from public.pos_inventory_deductions d left join public.pos_sales_receipts r on r.id = d.receipt_id where r.id is null),
      'receiptLine', (select count(*) from public.pos_inventory_deductions d left join public.pos_sales_receipt_lines l on l.id = d.receipt_line_id where d.receipt_line_id is not null and l.id is null),
      'inventory', (select count(*) from public.pos_inventory_deductions d left join public.inventory i on i.id = d.inventory_item_id where i.id is null),
      'inventoryLog', (select count(*) from public.pos_inventory_deductions d left join public.inventory_logs l on l.id = d.inventory_log_id where d.inventory_log_id is not null and l.id is null)
    )
  ),
  'inventory', jsonb_build_object(
    'count', (select count(*) from public.inventory),
    'quantitySum', (select coalesce(sum(quantity), 0) from public.inventory),
    'quantityChecksum', (select coalesce(sum(id::numeric * coalesce(quantity, 0)), 0) from public.inventory)
  ),
  'inventoryLogs', jsonb_build_object('count', (select count(*) from public.inventory_logs), 'maxId', (select max(id) from public.inventory_logs)),
  'batches', jsonb_build_object('batchCount', (select count(*) from public.pos_inventory_deduction_batches), 'receiptCount', (select count(*) from public.pos_inventory_deduction_receipts)),
  'mapping', jsonb_build_object('mappingCount', (select count(*) from public.pos_item_mappings), 'recipeCount', (select count(*) from public.pos_item_mapping_recipes)),
  'eligibility', (
    select coalesce(jsonb_object_agg(coalesce(inventory_deduction_pending_status, '(null)'), row_count), '{}'::jsonb)
    from (select inventory_deduction_pending_status, count(*) row_count from public.pos_sales_receipts group by inventory_deduction_pending_status) eligibility_counts
  )
) as verification;
