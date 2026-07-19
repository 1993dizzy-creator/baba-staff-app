-- Read-only snapshot to save immediately before applying 202607190002.
-- Keep the JSON result with the deployment record for before/after comparison.
select jsonb_build_object(
  'capturedAt', clock_timestamp(),
  'legacy', jsonb_build_object(
    'processedLineCount', (select count(*) from public.pos_processed_invoice_lines),
    'deductionCount', (select count(*) from public.pos_inventory_deductions where processed_line_id is not null),
    'deductionStatusCounts', (
      select coalesce(jsonb_object_agg(status, row_count), '{}'::jsonb)
      from (
        select status, count(*) row_count
        from public.pos_inventory_deductions
        where processed_line_id is not null
        group by status
      ) status_counts
    ),
    'appliedLogLinks', (
      select count(*)
      from public.pos_inventory_deductions deduction
      join public.inventory_logs inventory_log on inventory_log.id = deduction.inventory_log_id
      where deduction.processed_line_id is not null
        and deduction.status = 'applied'
        and inventory_log.item_id = deduction.inventory_item_id
        and inventory_log.change_quantity = -deduction.deduct_quantity
    )
  ),
  'receiptDeductions', jsonb_build_object(
    'count', (select count(*) from public.pos_inventory_deductions where processed_line_id is null),
    'idChecksum', (select coalesce(sum(id), 0) from public.pos_inventory_deductions where processed_line_id is null),
    'statusCounts', (
      select coalesce(jsonb_object_agg(status, row_count), '{}'::jsonb)
      from (
        select status, count(*) row_count
        from public.pos_inventory_deductions
        where processed_line_id is null
        group by status
      ) status_counts
    ),
    'appliedCount', (
      select count(*) from public.pos_inventory_deductions
      where processed_line_id is null
        and (status in ('applied', 'success') or applied_at is not null or inventory_log_id is not null)
    ),
    'inventoryLogLinks', (
      select count(*) from public.pos_inventory_deductions
      where processed_line_id is null and inventory_log_id is not null
    ),
    'orphans', jsonb_build_object(
      'receipt', (select count(*) from public.pos_inventory_deductions d left join public.pos_sales_receipts r on r.id = d.receipt_id where d.processed_line_id is null and r.id is null),
      'receiptLine', (select count(*) from public.pos_inventory_deductions d left join public.pos_sales_receipt_lines l on l.id = d.receipt_line_id where d.processed_line_id is null and d.receipt_line_id is not null and l.id is null),
      'inventory', (select count(*) from public.pos_inventory_deductions d left join public.inventory i on i.id = d.inventory_item_id where d.processed_line_id is null and i.id is null),
      'inventoryLog', (select count(*) from public.pos_inventory_deductions d left join public.inventory_logs l on l.id = d.inventory_log_id where d.processed_line_id is null and d.inventory_log_id is not null and l.id is null)
    )
  ),
  'inventory', jsonb_build_object(
    'count', (select count(*) from public.inventory),
    'quantitySum', (select coalesce(sum(quantity), 0) from public.inventory),
    'quantityChecksum', (select coalesce(sum(id::numeric * coalesce(quantity, 0)), 0) from public.inventory)
  ),
  'inventoryLogs', jsonb_build_object(
    'count', (select count(*) from public.inventory_logs),
    'maxId', (select max(id) from public.inventory_logs)
  ),
  'batches', jsonb_build_object(
    'batchCount', (select count(*) from public.pos_inventory_deduction_batches),
    'receiptCount', (select count(*) from public.pos_inventory_deduction_receipts)
  ),
  'mapping', jsonb_build_object(
    'mappingCount', (select count(*) from public.pos_item_mappings),
    'recipeCount', (select count(*) from public.pos_item_mapping_recipes)
  ),
  'eligibility', (
    select coalesce(jsonb_object_agg(coalesce(inventory_deduction_pending_status, '(null)'), row_count), '{}'::jsonb)
    from (
      select inventory_deduction_pending_status, count(*) row_count
      from public.pos_sales_receipts
      group by inventory_deduction_pending_status
    ) eligibility_counts
  ),
  'functionHashes', jsonb_build_object(
    'reprocess', (select md5(pg_get_functiondef(to_regprocedure('public.reprocess_modified_sales_inventory_deduction_receipt(bigint,text,timestamp with time zone,text,text)')::oid))),
    'rollback', (select md5(pg_get_functiondef(to_regprocedure('public.rollback_canceled_sales_inventory_deduction_receipt(bigint,text,timestamp with time zone,text)')::oid)))
  )
) as verification;
