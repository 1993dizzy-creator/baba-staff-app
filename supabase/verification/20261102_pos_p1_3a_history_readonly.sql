-- Read-only business/audit evidence. No repair, interpretation registration or RPC.
with executed as materialized (
 select d.*,coalesce(d.operation_type,'deduction')='revert' is_revert
 from public.pos_inventory_deductions d
 where d.status in ('applied','success','reverted') or d.applied_at is not null or d.inventory_log_id is not null
), reversals as (
 select reversal_of_deduction_id,count(*) n from executed where is_revert group by reversal_of_deduction_id
), active as (
 select d.* from executed d where not d.is_revert and not exists(select 1 from executed rev where rev.is_revert and rev.reversal_of_deduction_id=d.id)
)
select jsonb_build_object(
 'readOnly',current_setting('transaction_read_only'),'observedAt',clock_timestamp(),
 'migrationHistory',(select jsonb_build_object('latestVersion',max(version),'novemberVersions',jsonb_agg(version order by version) filter(where version>='20261101000000')) from supabase_migrations.schema_migrations),
 'inventoryUnits',(select jsonb_agg(to_jsonb(u)) from (select unit,package_content_quantity,package_content_unit,count(*) items from public.inventory group by 1,2,3 order by 1,2,3) u),
 'glenUnits',(select jsonb_agg(jsonb_build_object('id',id,'name',item_name,'unit',unit,'capacity',package_content_quantity,'capacityUnit',package_content_unit,'active',is_active)) from public.inventory where item_name ilike '%glenfiddich%'),
 'movementEvidence',(select jsonb_agg(to_jsonb(x)) from (select source,reason,count(*) events,min(created_at) first_recorded,max(created_at) last_recorded,
  count(*) filter(where business_date is null) missing_business_day,
  count(*) filter(where business_date<>(created_at at time zone 'Asia/Bangkok')::date) day_differs_from_recorded,
  count(*) filter(where coalesce(new_note,'')<>'') note_present
  from public.inventory_logs group by source,reason order by source,reason) x),
 'posTimeEvidence',(select jsonb_build_object('receipts',count(*),'missingRefDate',count(*) filter(where ref_date is null),
  'rawRefDateNoOffset',count(*) filter(where raw_json->>'RefDate' is not null and raw_json->>'RefDate' !~ '(Z|[+-][0-9]{2}:[0-9]{2})$'),
  'rawModifiedDatePresent',count(*) filter(where raw_json ? 'ModifiedDate')) from public.pos_sales_receipts),
 'executedGroups',(select jsonb_agg(to_jsonb(x)) from (select d.operation_type,d.status,br.workflow_type,count(*) rows,count(distinct d.receipt_id) receipts from executed d left join public.pos_inventory_deduction_receipts br on br.id=d.batch_receipt_id group by 1,2,3 order by 1,2,3) x),
 'reversalRisks',jsonb_build_object('executedRows',(select count(*) from executed),'reversalRows',(select count(*) from executed where is_revert),
  'receiptsWithReversals',(select count(distinct receipt_id) from executed where is_revert),
  'duplicateExecutedReversalTargets',(select count(*) from reversals where reversal_of_deduction_id is not null and n>1),
  'unlinkedExecutedReversals',(select count(*) from executed where is_revert and reversal_of_deduction_id is null),
  'missingOriginalReversals',(select count(*) from executed d where is_revert and reversal_of_deduction_id is not null and not exists(select 1 from public.pos_inventory_deductions original where original.id=d.reversal_of_deduction_id)),
  'missingAuditLogs',(select count(*) from executed d where not exists(select 1 from public.inventory_logs l where l.id=d.inventory_log_id)),
  'canceledReceiptsWithActiveDeductions',(select count(distinct d.receipt_id) from active d join public.pos_sales_receipts r on r.id=d.receipt_id where r.is_canceled),
  'receiptsWithPhysicalReturnReference',(select count(distinct related_receipt_id) from public.inventory_logs where source<>'pos_sales' and related_receipt_id is not null and change_quantity>0)),
 'precisionEvidence',(select jsonb_agg(to_jsonb(x)) from (select i.unit,d.operation_type,count(*) posted,
  count(*) filter(where abs(l.change_quantity)<>abs(d.deduct_quantity_total)) log_vs_target_rounding_rows
  from executed d join public.inventory_logs l on l.id=d.inventory_log_id join public.inventory i on i.id=d.inventory_item_id group by 1,2 order by 1,2) x),
 'receipt8111',(select jsonb_build_object('id',id,'businessDate',business_date,'refDate',ref_date,'canceled',is_canceled,'updatedAt',updated_at,'reprocessRequired',inventory_deduction_reprocess_required) from public.pos_sales_receipts where id=8111),
 'receipt8111Deductions',(select jsonb_agg(jsonb_build_object('id',id,'itemId',inventory_item_id,'operation',operation_type,'status',status,'target',deduct_quantity_total,'createdAt',created_at,'appliedAt',applied_at,'reversalOf',reversal_of_deduction_id,'logId',inventory_log_id) order by id) from public.pos_inventory_deductions where receipt_id=8111 and (operation_type<>'preview' or applied_at is not null)),
 'receipt8111Logs',(select jsonb_agg(jsonb_build_object('id',id,'itemId',item_id,'source',source,'reason',reason,'recordedAt',created_at,'businessDate',business_date,'delta',change_quantity,'deductionId',related_deduction_id) order by id) from public.inventory_logs where related_receipt_id=8111)
) evidence;
