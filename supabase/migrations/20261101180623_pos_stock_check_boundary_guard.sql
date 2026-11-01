-- P0: a physical count supersedes earlier sales, including delayed deductions
-- and reversals. No backfill or historical inventory/log rewrite is performed.
-- The existing engines retain their OIDs, arguments, owner and grants.
begin;

create or replace function public.guard_pos_inventory_stock_check_boundary()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $guard$
declare
  v_sale_at timestamptz;
begin
  if new.reason = 'stock_check' then
    -- Serialize count publication with every POS movement on the same item.
    perform id from public.inventory where id = new.item_id for update;
    return new;
  end if;
  if new.source is distinct from 'pos_sales' then return new; end if;

  perform id from public.inventory where id = new.item_id for update;
  select ref_date into v_sale_at from public.pos_sales_receipts
  where id = new.related_receipt_id;

  -- Stronger snapshot isolation can hide a newly committed count. Fail closed.
  if current_setting('transaction_isolation') not in ('read committed', 'read uncommitted')
    or v_sale_at is null
    or exists (
      select 1 from public.inventory_logs counted
      where counted.item_id = new.item_id and counted.reason = 'stock_check'
        and (counted.created_at is null or counted.created_at >= v_sale_at)
    ) then
    raise exception using errcode = 'P0S01',
      message = 'POS_STOCK_CHECK_REVIEW_REQUIRED',
      detail = jsonb_build_object('receiptId', new.related_receipt_id,
        'itemId', new.item_id, 'saleAt', v_sale_at)::text;
  end if;
  return new;
end;
$guard$;

revoke all on function public.guard_pos_inventory_stock_check_boundary()
  from public, anon, authenticated;

create trigger inventory_logs_pos_stock_check_boundary
before insert on public.inventory_logs
for each row execute function public.guard_pos_inventory_stock_check_boundary();

-- Catch only this guard's error at the OUTERMOST block: PostgreSQL rolls back
-- every stock change, reversal and log made by that RPC before recording review.
-- Patch the installed definitions, rather than overwrite later operating fixes.
do $install$
declare
  v_signature text;
  v_definition text;
  v_body text;
  v_patched text;
  v_handler text;
begin
  foreach v_signature in array array[
    'public.apply_sales_inventory_deduction_batch(bigint,text,jsonb)',
    'public.reprocess_modified_sales_inventory_deduction_receipt(bigint,text,timestamptz,text,text)',
    'public.rollback_canceled_sales_inventory_deduction_receipt(bigint,text,timestamptz,text)'
  ] loop
    select pg_get_functiondef(p.oid), p.prosrc into strict v_definition, v_body
    from pg_proc p where p.oid = v_signature::regprocedure;
    if v_body !~* 'end;[[:space:]]*$'
      or v_body ~* 'exception[[:space:]]+when'
      or position('POS_STOCK_CHECK_P0_GUARD' in v_body) > 0 then
      raise exception 'Unsupported stock engine definition: %', v_signature;
    end if;

    if v_signature like 'public.apply_sales_inventory_deduction_batch(%' then
      v_handler := $handler$
exception when sqlstate 'P0S01' then -- POS_STOCK_CHECK_P0_GUARD
  update public.pos_sales_receipts r set
    inventory_deduction_processing_error = 'stock_check_boundary_requires_review',
    inventory_deduction_pending_status = 'needs_check',
    inventory_deduction_last_checked_at = clock_timestamp()
  where r.id in (select receipt_id from public.pos_inventory_deduction_receipts
    where batch_id = p_batch_id and selected_for_apply);
  update public.pos_inventory_deduction_receipts set status = 'failed', selected_for_apply = false,
    error_message = 'stock_check_boundary_requires_review',
    review_reason = 'stock_check_boundary_requires_review',
    review_required_at = clock_timestamp(), updated_at = clock_timestamp()
  where batch_id = p_batch_id and selected_for_apply;
  update public.pos_inventory_deduction_batches set status = 'failed',
    error_message = 'stock_check_boundary_requires_review', updated_at = clock_timestamp()
  where id = p_batch_id;
  return jsonb_build_object('ok', false, 'result', 'needs_check',
    'batchId', p_batch_id, 'requiresReview', true,
    'failureReason', 'stock_check_boundary_requires_review',
    'summary', jsonb_build_object('appliedReceiptCount', 0, 'appliedDeductionCount', 0));
$handler$;
    elsif v_signature like 'public.reprocess_modified_sales_inventory_deduction_receipt(%' then
      v_handler := $handler$
exception when sqlstate 'P0S01' then -- POS_STOCK_CHECK_P0_GUARD
  update public.pos_sales_receipts set
    inventory_deduction_processing_error = 'stock_check_boundary_requires_review',
    inventory_deduction_pending_status = 'needs_check',
    inventory_deduction_last_checked_at = clock_timestamp()
  where id = v_receipt.id;
  update public.pos_inventory_deduction_receipts set status = 'failed', selected_for_apply = false,
    error_message = 'stock_check_boundary_requires_review',
    review_reason = 'stock_check_boundary_requires_review',
    review_required_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = p_batch_receipt_id;
  update public.pos_inventory_deduction_batches set status = 'failed',
    error_message = 'stock_check_boundary_requires_review', updated_at = clock_timestamp()
  where id = v_batch.id;
  return jsonb_build_object('result', 'needs_check', 'receiptId', v_receipt.id,
    'batchId', v_batch.id, 'deductionReceiptId', p_batch_receipt_id,
    'appliedDeductionCount', 0, 'reversedDeductionCount', 0,
    'requiresReview', true, 'failureReason', 'stock_check_boundary_requires_review');
$handler$;
    else
      v_handler := $handler$
exception when sqlstate 'P0S01' then -- POS_STOCK_CHECK_P0_GUARD
  update public.pos_sales_receipts set
    inventory_deduction_processing_error = 'stock_check_boundary_requires_review',
    inventory_deduction_pending_status = 'needs_check',
    inventory_deduction_last_checked_at = clock_timestamp()
  where id = p_receipt_id;
  return jsonb_build_object('result', 'needs_check', 'receiptId', p_receipt_id,
    'appliedDeductionCount', 0, 'reversedDeductionCount', 0,
    'rollbackOnly', true, 'requiresReview', true,
    'failureReason', 'stock_check_boundary_requires_review');
$handler$;
    end if;
    v_patched := regexp_replace(v_body, 'end;[[:space:]]*$', v_handler || E'\nend;\n', 'i');
    if v_patched = v_body then raise exception 'Guard installation failed: %', v_signature; end if;
    execute replace(v_definition, v_body, v_patched);
  end loop;
end;
$install$;
commit;
