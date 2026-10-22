-- POS pending-payment (CUKCUK payment_status = 1) minimum handling.
--
-- 1. sales_close_business_day_v1: every close path (manual, manual after sync and the
--    03:05 sales_finalize_business_day_v1) ends here. While the day still has an active
--    pending receipt the function now returns {"status":"pending_payment"} without any
--    projection/closure/audit write. The check runs after the existing share lock on
--    pos_sales_receipts/payments, so a concurrent sync or admin resolution cannot change
--    a receipt between the check and the closure insert. Only the exact inserted text is
--    added to the LIVE definition; CREATE OR REPLACE keeps OID, owner, ACL, SECURITY
--    DEFINER and SET options, verified before COMMIT. A 03:05 hold is recorded by the
--    existing finalize function as a 'source_invalid' check with
--    detail_snapshot.failureCode = 'pending_payment' (existing columns only).
-- 2. admin_resolve_pending_sales_receipt_v1: pending -> paid / pending -> canceled for a
--    CUKCUK receipt pending for 30+ minutes. Revision + request id idempotency, row lock,
--    audit row in pos_sales_receipt_modifications, inventory re-evaluation through the
--    existing deduction cron. No close/reclose and no ledger write. On an already closed
--    business day only "canceled" is allowed (it does not change the closed paid source).
-- Rollback: supabase/pos_pending_payment_close_hold_rollback.sql (byte-identical restore).
--
-- * No existing receipt/line/payment/stock/ledger/close row is changed by this file.
-- * New objects: one function. No table, column, trigger, cron or flag.
-- Apply the whole file once in the SQL Editor. Avoid the 03:00-03:10 final window.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if to_regprocedure('public.sales_close_business_day_v1(date,text,jsonb,jsonb,bigint,text,boolean,bigint)') is null
    or to_regprocedure('public.ledger_month_is_closed_v1(date)') is null
    or to_regclass('public.pos_sales_receipt_modifications') is null then
    raise exception 'POS_PENDING_HOLD_STATE_MISMATCH: required object missing';
  end if;
  if (select format_type(atttypid, atttypmod) from pg_attribute
      where attrelid = 'public.pos_sales_receipts'::regclass and attname = 'status_changed_at' and not attisdropped)
      is distinct from 'timestamp with time zone' then
    raise exception 'POS_PENDING_HOLD_STATE_MISMATCH: pos_sales_receipts.status_changed_at';
  end if;
  if to_regprocedure('public.admin_resolve_pending_sales_receipt_v1(bigint,bigint,uuid,text,text,text,numeric,text)') is not null then
    raise exception 'POS_PENDING_HOLD_ALREADY_APPLIED';
  end if;
end $preflight$;

create temporary table pos_pending_hold_function_meta on commit drop as
select p.oid, p.proowner, p.proacl::text as acl, p.prosecdef, p.proconfig::text as config,
  p.provolatile, p.prorettype
from pg_proc p
where p.oid = 'public.sales_close_business_day_v1(date,text,jsonb,jsonb,bigint,text,boolean,bigint)'::regprocedure;

do $close_hold$
declare
  v_definition text;
  v_eol text;
  -- The live body has one blank line between the lock and validate_source; it is kept as-is.
  v_anchor text := E'\n  lock table public.pos_sales_receipts, public.pos_sales_receipt_payments in share mode;\n'
    || E'\n'
    || E'  perform pos_sales_close_private.validate_source(p_business_date, p_source_fingerprint, p_source_snapshot, p_rows);\n';
  v_inserted text := E'\n  lock table public.pos_sales_receipts, public.pos_sales_receipt_payments in share mode;\n'
    || E'  -- Pending POS payments hold every close path (manual, after-sync, 03:05 final).\n'
    || E'  if exists (select 1 from public.pos_sales_receipts where business_date = p_business_date\n'
    || E'      and source = ''cukcuk'' and payment_status = 1 and is_canceled is not true) then\n'
    || E'    return jsonb_build_object(''status'', ''pending_payment'', ''pendingCount'', (select count(*) from public.pos_sales_receipts\n'
    || E'      where business_date = p_business_date and source = ''cukcuk'' and payment_status = 1 and is_canceled is not true));\n'
    || E'  end if;\n'
    || E'\n'
    || E'  perform pos_sales_close_private.validate_source(p_business_date, p_source_fingerprint, p_source_snapshot, p_rows);\n';
begin
  -- Keep the live body's own line endings so the rollback can restore it byte-for-byte.
  v_definition := pg_get_functiondef(
    'public.sales_close_business_day_v1(date,text,jsonb,jsonb,bigint,text,boolean,bigint)'::regprocedure);
  v_eol := case when position(chr(13) || chr(10) in v_definition) > 0 then chr(13) || chr(10) else chr(10) end;
  v_anchor := replace(v_anchor, chr(10), v_eol);
  v_inserted := replace(v_inserted, chr(10), v_eol);
  if position('pending_payment' in v_definition) > 0 then
    raise exception 'POS_PENDING_HOLD_ALREADY_APPLIED';
  end if;
  if (length(v_definition) - length(replace(v_definition, v_anchor, ''))) <> length(v_anchor) then
    raise exception 'POS_PENDING_HOLD_CLOSE_CONTRACT_MISMATCH';
  end if;
  execute replace(v_definition, v_anchor, v_inserted);
end $close_hold$;

do $verify_close$
declare v_definition text;
begin
  v_definition := replace(replace(pg_get_functiondef(
    'public.sales_close_business_day_v1(date,text,jsonb,jsonb,bigint,text,boolean,bigint)'::regprocedure),
    E'\r\n', E'\n'), E'\r', E'\n');
  if (length(v_definition) - length(replace(v_definition, '''pending_payment''', ''))) <> length('''pending_payment''') then
    raise exception 'POS_PENDING_HOLD_VERIFY_FAILED: definition';
  end if;
  if exists (select 1 from pos_pending_hold_function_meta m
      left join pg_proc p on p.oid = m.oid
      where p.oid is null or p.proowner <> m.proowner or p.proacl::text is distinct from m.acl
        or p.prosecdef <> m.prosecdef or p.proconfig::text is distinct from m.config
        or p.provolatile <> m.provolatile or p.prorettype <> m.prorettype) then
    raise exception 'POS_PENDING_HOLD_VERIFY_FAILED: function identity';
  end if;
end $verify_close$;

create function public.admin_resolve_pending_sales_receipt_v1(
  p_receipt_id bigint,
  p_expected_revision bigint,
  p_request_id uuid,
  p_actor_username text,
  p_resolution text,
  p_payment_method text,
  p_cash_received_amount numeric,
  p_evidence_note text
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_receipt public.pos_sales_receipts%rowtype;
  v_existing_result jsonb;
  v_now timestamptz := clock_timestamp();
  v_note text := nullif(btrim(coalesce(p_evidence_note, '')), '');
  v_pending_since timestamptz;
  v_receive numeric;
  v_return numeric;
  v_next_revision bigint;
  v_before jsonb;
  v_after jsonb;
  v_result jsonb;
begin
  if p_request_id is null then raise exception 'receipt_request_id_required'; end if;
  if p_actor_username is null or btrim(p_actor_username) = '' then raise exception 'receipt_actor_required'; end if;
  if p_resolution is null or p_resolution not in ('paid', 'canceled') then raise exception 'receipt_invalid_resolution'; end if;
  if v_note is null or char_length(v_note) < 5 or char_length(v_note) > 500 then
    raise exception 'receipt_evidence_required';
  end if;
  if p_resolution = 'paid' and (p_payment_method is null or p_payment_method not in ('cash', 'transfer', 'card', 'other')) then
    raise exception 'receipt_invalid_payment_method';
  end if;
  if p_resolution = 'canceled' and (p_payment_method is not null or p_cash_received_amount is not null) then
    raise exception 'receipt_invalid_payment_method';
  end if;

  select modification.result into v_existing_result
  from public.pos_sales_receipt_modifications modification
  where modification.receipt_id = p_receipt_id and modification.request_id = p_request_id;
  if v_existing_result is not null then return v_existing_result; end if;

  select * into v_receipt from public.pos_sales_receipts receipt where receipt.id = p_receipt_id for update;
  if not found then raise exception 'receipt_not_found'; end if;
  select modification.result into v_existing_result
  from public.pos_sales_receipt_modifications modification
  where modification.receipt_id = p_receipt_id and modification.request_id = p_request_id;
  if v_existing_result is not null then return v_existing_result; end if;

  if v_receipt.source is distinct from 'cukcuk' then raise exception 'receipt_source_not_pending_resolvable'; end if;
  if v_receipt.payment_status is distinct from 1 or v_receipt.is_canceled is true then
    raise exception 'receipt_not_pending';
  end if;
  if v_receipt.revision is distinct from p_expected_revision then raise exception 'receipt_revision_conflict'; end if;
  -- status_changed_at is not maintained for older rows; the POS invoice time is the
  -- earliest moment the receipt can have been pending. No known start: never due.
  v_pending_since := coalesce(v_receipt.status_changed_at, v_receipt.ref_date);
  if v_pending_since is null or v_pending_since > v_now - interval '30 minutes' then
    raise exception 'receipt_pending_review_not_due';
  end if;
  if public.ledger_month_is_closed_v1(date_trunc('month', v_receipt.business_date)::date) then
    raise exception 'receipt_month_closed';
  end if;
  -- A pending receipt is outside the closed paid source, so canceling it leaves the closure,
  -- Ledger and card settlement untouched. Paid would change the closed snapshot and need an
  -- owner reclose (card settlement may lock it): refused until separately approved.
  if p_resolution = 'paid' and exists (select 1 from public.pos_sales_business_day_closures c
      where c.business_date = v_receipt.business_date) then
    raise exception 'receipt_business_day_closed';
  end if;

  if p_resolution = 'paid' then
    if v_receipt.final_amount is null or v_receipt.final_amount < 0 or v_receipt.final_amount <> trunc(v_receipt.final_amount)
      or v_receipt.final_amount > 999999999999 then
      raise exception 'receipt_invalid_final_amount';
    end if;
    v_receive := case when p_payment_method = 'cash' then p_cash_received_amount else v_receipt.final_amount end;
    if p_payment_method = 'cash' and (v_receive is null or v_receive < v_receipt.final_amount
      or v_receive > 999999999999 or v_receive <> trunc(v_receive)) then
      raise exception 'receipt_invalid_cash_received';
    end if;
    if p_payment_method <> 'cash' and p_cash_received_amount is not null then
      raise exception 'receipt_invalid_cash_received';
    end if;
    v_return := case when p_payment_method = 'cash' then v_receive - v_receipt.final_amount else 0 end;
  end if;

  v_before := jsonb_build_object(
    'paymentStatus', v_receipt.payment_status, 'isCanceled', v_receipt.is_canceled,
    'statusChangedAt', v_receipt.status_changed_at, 'pendingSince', v_pending_since,
    'finalAmount', v_receipt.final_amount, 'receiveAmount', v_receipt.receive_amount,
    'returnAmount', v_receipt.return_amount, 'revision', v_receipt.revision,
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'source', p.source,
      'paymentType', p.payment_type, 'paymentName', p.payment_name, 'cardName', p.card_name, 'amount', p.amount) order by p.id)
      from public.pos_sales_receipt_payments p where p.receipt_id = p_receipt_id), '[]'::jsonb));

  if p_resolution = 'paid' then
    -- The POS snapshot of a pending receipt is not proof of payment; the admin evidence replaces it.
    delete from public.pos_sales_receipt_payments where receipt_id = p_receipt_id;
    insert into public.pos_sales_receipt_payments (
      source, receipt_id, receipt_ref_id, business_date, ref_date, payment_type, payment_name, card_id, card_name,
      amount, raw_json, synced_at, updated_at
    ) values (
      'manual', p_receipt_id, v_receipt.ref_id, v_receipt.business_date, v_receipt.ref_date,
      case when p_payment_method = 'card' then 2 end,
      case p_payment_method when 'cash' then 'Tiền mặt' when 'transfer' then 'Chuyển khoản' when 'card' then 'Card' else 'Khác' end,
      null, null, v_receipt.final_amount,
      jsonb_build_object('source', 'pending-payment-resolution', 'paymentMethod', p_payment_method, 'requestId', p_request_id),
      v_now, v_now
    );
    update public.pos_sales_receipt_lines set payment_status = 3, updated_at = v_now where receipt_id = p_receipt_id;
  else
    update public.pos_sales_receipt_lines set is_canceled = true, updated_at = v_now where receipt_id = p_receipt_id;
  end if;

  v_next_revision := v_receipt.revision + 1;
  update public.pos_sales_receipts set
    payment_status = case when p_resolution = 'paid' then 3 else payment_status end,
    is_canceled = (p_resolution = 'canceled'),
    receive_amount = case when p_resolution = 'paid' then v_receive else receive_amount end,
    return_amount = case when p_resolution = 'paid' then v_return else return_amount end,
    status_changed_at = v_now,
    is_modified = true, modified_at = v_now, modified_by = p_actor_username,
    modification_note = v_note, revision = v_next_revision,
    -- Same re-evaluation hand-off as admin_update_paid_sales_receipt / POS status change.
    inventory_deduction_auto_eligible_at = v_now,
    inventory_deduction_processing_paused = false,
    inventory_deduction_processing_paused_at = null,
    inventory_deduction_processing_error = null,
    inventory_deduction_last_checked_at = null,
    inventory_deduction_pending_fingerprint = null,
    inventory_deduction_pending_status = null,
    updated_at = v_now
  where id = p_receipt_id;

  v_after := jsonb_build_object(
    'pendingResolution', jsonb_build_object('resolution', p_resolution, 'paymentMethod', p_payment_method,
      'evidenceNote', v_note, 'resolvedAt', v_now, 'resolvedBy', p_actor_username),
    'paymentStatus', case when p_resolution = 'paid' then 3 else v_receipt.payment_status end,
    'isCanceled', p_resolution = 'canceled', 'finalAmount', v_receipt.final_amount,
    'receiveAmount', case when p_resolution = 'paid' then v_receive else v_receipt.receive_amount end,
    'returnAmount', case when p_resolution = 'paid' then v_return else v_receipt.return_amount end,
    'revision', v_next_revision);
  v_result := v_after || jsonb_build_object('receiptId', p_receipt_id, 'isModified', true,
    'modifiedAt', v_now, 'modifiedBy', p_actor_username, 'modificationNote', v_note);
  insert into public.pos_sales_receipt_modifications (
    receipt_id, request_id, revision_before, revision_after, modified_by, modification_note, before_state, after_state, result
  ) values (p_receipt_id, p_request_id, v_receipt.revision, v_next_revision, p_actor_username, v_note, v_before, v_after, v_result);
  return v_result;
end;
$$;

revoke all on function public.admin_resolve_pending_sales_receipt_v1(bigint,bigint,uuid,text,text,text,numeric,text)
  from public, anon, authenticated;
grant execute on function public.admin_resolve_pending_sales_receipt_v1(bigint,bigint,uuid,text,text,text,numeric,text)
  to service_role;

commit;
