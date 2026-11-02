-- Targeted item evidence; no actor/customer/payment details and no writes.
select jsonb_build_object('readOnly',current_setting('transaction_read_only'),'observedAt',clock_timestamp(),
 'item47',(select jsonb_build_object('id',id,'name',item_name,'nameVi',item_name_vi,'unit',unit,'capacity',package_content_quantity,'capacityUnit',package_content_unit) from public.inventory where id=47),
 'boundaryEvents',(select jsonb_agg(jsonb_build_object('id',id,'source',source,'reason',reason,'businessDate',business_date,
  'recordedAt',created_at,'unit',unit,'quantityChange',change_quantity,'countQuantity',case when reason='stock_check' then new_quantity else null end,
  'receiptId',related_receipt_id,'deductionId',related_deduction_id,'hasNote',nullif(new_note,'') is not null) order by created_at,id)
  from public.inventory_logs where item_id=47 and created_at>='2026-10-09T00:00:00+07:00' and created_at<'2026-10-13T00:00:00+07:00'),
 'canceledReceiptCount',(select count(*) from public.pos_sales_receipts where is_canceled),
 'canceledExecutedReversals',(select count(*) from public.pos_inventory_deductions d join public.pos_sales_receipts r on r.id=d.receipt_id
  where r.is_canceled and d.operation_type='revert' and (d.status in ('applied','success','reverted') or d.applied_at is not null or d.inventory_log_id is not null)),
 'snapshotColumns',(select jsonb_agg(column_name order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='inventory_snapshot_items')
) evidence;
