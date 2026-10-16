-- Reconcile only validated, authoritative snapshots. Keep stable identities; remove
-- validated replacements before writes so the existing UNIQUE index stays intact.
-- Supabase CLI batches this file and its migration-history INSERT atomically.
-- Do not add transaction commands: COMMIT would precede the runner's history write.

-- Pin the independently reviewed production definition, not a file checksum.
-- A missing/drifted function must abort before CREATE OR REPLACE or ACL changes.
do $preflight$
declare
  v_function oid := pg_catalog.to_regprocedure('public.reconcile_sales_receipt_payments_v1(jsonb)');
  v_definition_md5 text;
begin
  if v_function is not null then
    v_definition_md5 := pg_catalog.md5(pg_catalog.pg_get_functiondef(v_function));
  end if;
  if v_definition_md5 is distinct from 'e6f024dfeda8366453100e60bb023670' then
    raise exception 'pos_payment_reconciliation_definition_mismatch'
      using errcode = '55000',
        hint = 'Stop and re-review the existing function definition before applying this migration.';
  end if;
end;
$preflight$;

create or replace function public.reconcile_sales_receipt_payments_v1(p_snapshots jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_snapshot jsonb;
  v_payment jsonb;
  v_receipt public.pos_sales_receipts%rowtype;
  v_ref_id text;
  v_payment_id bigint;
  v_external_id text;
  v_duplicate_external_id text;
  v_duplicate_composite_identity text;
  v_kept_ids bigint[];
  v_plan jsonb;
  v_planned jsonb;
  v_match_count integer;
  v_identity_event text := 'snapshot_invalid';
  v_sqlstate text;
  v_error_message text;
  v_failure_type text;
  v_created integer := 0;
  v_updated integer := 0;
  v_deleted integer := 0;
  v_unchanged integer := 0;
  v_skipped_modified integer := 0;
  v_row_count integer := 0;
  v_change_count_before integer := 0;
begin
  if jsonb_typeof(p_snapshots) is distinct from 'array' then
    raise exception 'payment_snapshots_must_be_array' using errcode = '22023';
  end if;

  if (
    select count(*)
    from jsonb_array_elements(p_snapshots)
  ) is distinct from (
    select count(distinct nullif(btrim(value->>'receiptRefId'), ''))
    from jsonb_array_elements(p_snapshots)
  ) then
    raise exception 'duplicate_payment_snapshot_receipt' using errcode = '22023';
  end if;

  for v_snapshot in
    select value
    from jsonb_array_elements(p_snapshots)
    order by btrim(value->>'receiptRefId')
  loop
    v_receipt := null;
    v_ref_id := null;
    v_identity_event := 'snapshot_invalid';
    if jsonb_typeof(v_snapshot) is distinct from 'object'
      or jsonb_typeof(v_snapshot->'receiptRefId') is distinct from 'string'
    then
      raise exception 'invalid_payment_snapshot' using errcode = '22023';
    end if;

    v_ref_id := nullif(btrim(v_snapshot->>'receiptRefId'), '');
    if v_ref_id is null or jsonb_typeof(v_snapshot->'payments') is distinct from 'array' then
      raise exception 'payment_snapshot_unavailable' using errcode = '22023';
    end if;

    begin
      select receipt.*
        into strict v_receipt
      from public.pos_sales_receipts receipt
      where receipt.source = 'cukcuk'
        and receipt.ref_id = v_ref_id
      for update;
    exception
      when no_data_found then
        raise exception 'payment_snapshot_receipt_not_found: %', v_ref_id using errcode = '22023';
      when too_many_rows then
        raise exception 'payment_snapshot_receipt_ambiguous: %', v_ref_id using errcode = '22023';
    end;

    if v_receipt.is_modified is true then
      v_skipped_modified := v_skipped_modified + 1;
      continue;
    end if;

    if v_receipt.payment_status = 3
      and v_receipt.is_canceled is not true
      and coalesce(v_receipt.final_amount, 0) > 0
      and jsonb_array_length(v_snapshot->'payments') = 0
    then
      raise exception 'paid_payment_snapshot_empty: %', v_ref_id using errcode = '22023';
    end if;

    v_change_count_before := v_created + v_updated + v_deleted;

    for v_payment in select value from jsonb_array_elements(v_snapshot->'payments')
    loop
      if jsonb_typeof(v_payment) is distinct from 'object'
        or jsonb_typeof(v_payment->'receipt_ref_id') is distinct from 'string'
        or jsonb_typeof(v_payment->'source') is distinct from 'string'
        or jsonb_typeof(v_payment->'amount') is distinct from 'number'
        or (v_payment->>'amount')::numeric < 0
        or nullif(v_payment->>'receipt_ref_id', '') is distinct from v_ref_id
        or coalesce(v_payment->>'source', '') <> 'cukcuk'
        or jsonb_typeof(coalesce(v_payment->'raw_json', '{}'::jsonb)) <> 'object'
      then
        raise exception 'invalid_payment_snapshot_row: %', v_ref_id using errcode = '22023';
      end if;

      if exists (
        select 1 from jsonb_each(v_payment) f
        where f.key in ('payment_name', 'card_name', 'card_id')
          and jsonb_typeof(f.value) not in ('string', 'null')
      ) or exists (
        select 1 from jsonb_each(coalesce(v_payment->'raw_json', '{}'::jsonb)) f
        where f.key in ('SAInvoicePaymentID', 'SAInvoicePaymentId', 'saInvoicePaymentID', 'saInvoicePaymentId')
          and jsonb_typeof(f.value) not in ('string', 'null')
      ) or (
        select count(distinct btrim(f.value #>> '{}'))
        from jsonb_each(coalesce(v_payment->'raw_json', '{}'::jsonb)) f
        where f.key in ('SAInvoicePaymentID', 'SAInvoicePaymentId', 'saInvoicePaymentID', 'saInvoicePaymentId')
          and jsonb_typeof(f.value) = 'string'
      ) > 1 or exists (
        select 1 from jsonb_each(coalesce(v_payment->'raw_json', '{}'::jsonb)) f
        where f.key in ('RefID', 'RefId', 'refID', 'refId')
          and (jsonb_typeof(f.value) <> 'string' or f.value #>> '{}' is distinct from v_ref_id)
      ) then
        raise exception 'invalid_payment_snapshot_identity' using errcode = '22023';
      end if;
    end loop;

    -- A paid snapshot must account for the whole receipt before deleting anything.
    if v_receipt.payment_status = 3 and v_receipt.is_canceled is not true
      and (select coalesce(sum((value->>'amount')::numeric), 0)
           from jsonb_array_elements(v_snapshot->'payments')) <> v_receipt.final_amount
    then
      raise exception 'payment_snapshot_amount_mismatch' using errcode = '22023';
    end if;

    -- Automatic sync must never replace manual payment rows, even if a receipt flag drifted.
    if exists (select 1 from public.pos_sales_receipt_payments
               where receipt_id = v_receipt.id and source is distinct from 'cukcuk') then
      raise exception 'payment_snapshot_manual_payment_protected' using errcode = '22023';
    end if;

    select external_id
      into v_duplicate_external_id
    from (
      select nullif(btrim(coalesce(
        payment->'raw_json'->>'SAInvoicePaymentID',
        payment->'raw_json'->>'SAInvoicePaymentId',
        payment->'raw_json'->>'saInvoicePaymentID',
        payment->'raw_json'->>'saInvoicePaymentId'
      )), '') external_id
      from jsonb_array_elements(v_snapshot->'payments') payment
    ) incoming
    where external_id is not null
    group by external_id
    having count(*) > 1
    limit 1;
    if v_duplicate_external_id is not null then
      v_identity_event := 'id_duplicate';
      raise exception 'duplicate_payment_external_id'
        using errcode = '22023';
    end if;

    select concat_ws(
             '|',
             payment_type::text,
             payment_name,
             card_name
           )
      into v_duplicate_composite_identity
    from (
      select
        coalesce(nullif(payment->>'payment_type', '')::integer, -1) payment_type,
        coalesce(nullif(payment->>'payment_name', ''), '') payment_name,
        coalesce(nullif(payment->>'card_name', ''), '') card_name
      from jsonb_array_elements(v_snapshot->'payments') payment
    ) incoming
    group by payment_type, payment_name, card_name
    having count(*) > 1
    limit 1;
    if v_duplicate_composite_identity is not null then
      v_identity_event := 'method_duplicate';
      raise exception 'duplicate_payment_composite_identity'
        using errcode = '22023';
    end if;

    -- Duplicate existing identities cannot be resolved by arbitrarily picking a row.
    if exists (
      select nullif(btrim(coalesce(raw_json->>'SAInvoicePaymentID', raw_json->>'SAInvoicePaymentId', raw_json->>'saInvoicePaymentID', raw_json->>'saInvoicePaymentId')), '')
      from public.pos_sales_receipt_payments where receipt_id = v_receipt.id
      and nullif(btrim(coalesce(raw_json->>'SAInvoicePaymentID', raw_json->>'SAInvoicePaymentId', raw_json->>'saInvoicePaymentID', raw_json->>'saInvoicePaymentId')), '') is not null
      group by nullif(btrim(coalesce(raw_json->>'SAInvoicePaymentID', raw_json->>'SAInvoicePaymentId', raw_json->>'saInvoicePaymentID', raw_json->>'saInvoicePaymentId')), '') having count(*) > 1
    ) then
      raise exception 'ambiguous_existing_payment_external_id' using errcode = '22023';
    end if;

    -- Losing an identity while an identified payment disappears is ambiguous.
    -- Legacy snapshots with IDs absent on both sides retain the original fallback.
    if exists (select 1 from jsonb_array_elements(v_snapshot->'payments') p
               where nullif(btrim(coalesce(p->'raw_json'->>'SAInvoicePaymentID', p->'raw_json'->>'SAInvoicePaymentId', p->'raw_json'->>'saInvoicePaymentID', p->'raw_json'->>'saInvoicePaymentId')), '') is null)
      and exists (
        select 1 from public.pos_sales_receipt_payments e
        where e.receipt_id = v_receipt.id and nullif(btrim(coalesce(e.raw_json->>'SAInvoicePaymentID', e.raw_json->>'SAInvoicePaymentId', e.raw_json->>'saInvoicePaymentID', e.raw_json->>'saInvoicePaymentId')), '') is not null
        and not exists (select 1 from jsonb_array_elements(v_snapshot->'payments') p
                        where nullif(btrim(coalesce(p->'raw_json'->>'SAInvoicePaymentID', p->'raw_json'->>'SAInvoicePaymentId', p->'raw_json'->>'saInvoicePaymentID', p->'raw_json'->>'saInvoicePaymentId')), '') = nullif(btrim(coalesce(e.raw_json->>'SAInvoicePaymentID', e.raw_json->>'SAInvoicePaymentId', e.raw_json->>'saInvoicePaymentID', e.raw_json->>'saInvoicePaymentId')), ''))
      ) then
      v_identity_event := 'id_missing';
      raise exception 'payment_external_id_missing' using errcode = '22023';
    end if;

    v_identity_event := 'id_unchanged';
    if exists (select 1 from jsonb_array_elements(v_snapshot->'payments') p
               where nullif(btrim(coalesce(p->'raw_json'->>'SAInvoicePaymentID', p->'raw_json'->>'SAInvoicePaymentId', p->'raw_json'->>'saInvoicePaymentID', p->'raw_json'->>'saInvoicePaymentId')), '') is null) then
      v_identity_event := 'id_missing';
    elsif exists (
      select 1 from jsonb_array_elements(v_snapshot->'payments') p
      where not exists (select 1 from public.pos_sales_receipt_payments e
        where e.receipt_id = v_receipt.id and nullif(btrim(coalesce(e.raw_json->>'SAInvoicePaymentID', e.raw_json->>'SAInvoicePaymentId', e.raw_json->>'saInvoicePaymentID', e.raw_json->>'saInvoicePaymentId')), '') = nullif(btrim(coalesce(p->'raw_json'->>'SAInvoicePaymentID', p->'raw_json'->>'SAInvoicePaymentId', p->'raw_json'->>'saInvoicePaymentID', p->'raw_json'->>'saInvoicePaymentId')), ''))
    ) then
      v_identity_event := 'id_changed_or_new';
    end if;

    v_plan := '[]'::jsonb;
    v_kept_ids := array[]::bigint[];
    for v_payment in select value from jsonb_array_elements(v_snapshot->'payments')
    loop
      v_external_id := nullif(btrim(coalesce(
        v_payment->'raw_json'->>'SAInvoicePaymentID',
        v_payment->'raw_json'->>'SAInvoicePaymentId',
        v_payment->'raw_json'->>'saInvoicePaymentID',
        v_payment->'raw_json'->>'saInvoicePaymentId'
      )), '');
      v_payment_id := null;

      select count(*), min(payment.id)
        into v_match_count, v_payment_id
      from public.pos_sales_receipt_payments payment
      where payment.receipt_id = v_receipt.id
        and not (payment.id = any(v_kept_ids))
        and (
          (
            v_external_id is not null
            and nullif(btrim(coalesce(
              payment.raw_json->>'SAInvoicePaymentID',
              payment.raw_json->>'SAInvoicePaymentId',
              payment.raw_json->>'saInvoicePaymentID',
              payment.raw_json->>'saInvoicePaymentId'
            )), '') = v_external_id
          )
          or (
            v_external_id is null
            and nullif(btrim(coalesce(
              payment.raw_json->>'SAInvoicePaymentID',
              payment.raw_json->>'SAInvoicePaymentId',
              payment.raw_json->>'saInvoicePaymentID',
              payment.raw_json->>'saInvoicePaymentId'
            )), '') is null
            and payment.payment_type is not distinct from nullif(v_payment->>'payment_type', '')::integer
            and payment.payment_name is not distinct from nullif(v_payment->>'payment_name', '')
            and payment.card_name is not distinct from nullif(v_payment->>'card_name', '')
          )
        );

      if v_match_count > 1 then
        raise exception 'ambiguous_payment_identity' using errcode = '22023';
      end if;
      if v_external_id is null and v_payment_id is not null and exists (
        select 1 from public.pos_sales_receipt_payments e where e.id = v_payment_id
          and nullif(e.card_id, '') is not null and nullif(v_payment->>'card_id', '') is not null
          and e.card_id <> v_payment->>'card_id'
      ) then
        raise exception 'ambiguous_legacy_payment_card_identity' using errcode = '22023';
      end if;

      -- Preserve row IDs only when their unique method key stays the same.
      -- A stable external ID whose method changes is a validated replacement;
      -- deleting it first also makes method-key swaps safe.
      if v_payment_id is not null and exists (
        select 1 from public.pos_sales_receipt_payments e where e.id = v_payment_id
          and coalesce(e.payment_type, -1) = coalesce(nullif(v_payment->>'payment_type', '')::integer, -1)
          and coalesce(e.payment_name, '') = coalesce(nullif(v_payment->>'payment_name', ''), '')
          and coalesce(e.card_name, '') = coalesce(nullif(v_payment->>'card_name', ''), '')
      ) then
        v_kept_ids := array_append(v_kept_ids, v_payment_id);
      else
        v_payment_id := null;
      end if;
      v_plan := v_plan || jsonb_build_array(jsonb_build_object('payment', v_payment, 'keepId', v_payment_id));
    end loop;

    -- Only rows absent from the validated retain plan are stale/replacements.
    delete from public.pos_sales_receipt_payments payment
    where payment.receipt_id = v_receipt.id and not (payment.id = any(v_kept_ids));
    get diagnostics v_row_count = row_count;
    v_deleted := v_deleted + v_row_count;

    for v_planned in select value from jsonb_array_elements(v_plan)
    loop
      v_payment := v_planned->'payment';
      v_payment_id := (v_planned->>'keepId')::bigint;

      if v_payment_id is null then
        insert into public.pos_sales_receipt_payments (
          source, receipt_id, receipt_ref_id, business_date, ref_date,
          payment_type, payment_name, card_id, card_name, amount,
          raw_json, synced_at, updated_at
        ) values (
          'cukcuk', v_receipt.id, v_ref_id, v_receipt.business_date, v_receipt.ref_date,
          nullif(v_payment->>'payment_type', '')::integer,
          nullif(v_payment->>'payment_name', ''),
          nullif(v_payment->>'card_id', ''),
          nullif(v_payment->>'card_name', ''),
          (v_payment->>'amount')::numeric,
          coalesce(v_payment->'raw_json', '{}'::jsonb),
          coalesce(nullif(v_payment->>'synced_at', '')::timestamptz, now()),
          coalesce(nullif(v_payment->>'updated_at', '')::timestamptz, now())
        ) returning id into v_payment_id;
        v_created := v_created + 1;
      else
        update public.pos_sales_receipt_payments payment
        set source = 'cukcuk',
            receipt_ref_id = v_ref_id,
            business_date = v_receipt.business_date,
            ref_date = v_receipt.ref_date,
            payment_type = nullif(v_payment->>'payment_type', '')::integer,
            payment_name = nullif(v_payment->>'payment_name', ''),
            card_id = nullif(v_payment->>'card_id', ''),
            card_name = nullif(v_payment->>'card_name', ''),
            amount = (v_payment->>'amount')::numeric,
            raw_json = coalesce(v_payment->'raw_json', '{}'::jsonb),
            synced_at = coalesce(nullif(v_payment->>'synced_at', '')::timestamptz, now()),
            updated_at = coalesce(nullif(v_payment->>'updated_at', '')::timestamptz, now())
        where payment.id = v_payment_id
          and (
            payment.source,
            payment.receipt_ref_id,
            payment.business_date,
            payment.ref_date,
            payment.payment_type,
            payment.payment_name,
            payment.card_id,
            payment.card_name,
            payment.amount,
            payment.raw_json
          ) is distinct from (
            'cukcuk'::text,
            v_ref_id,
            v_receipt.business_date,
            v_receipt.ref_date,
            nullif(v_payment->>'payment_type', '')::integer,
            nullif(v_payment->>'payment_name', ''),
            nullif(v_payment->>'card_id', ''),
            nullif(v_payment->>'card_name', ''),
            (v_payment->>'amount')::numeric,
            coalesce(v_payment->'raw_json', '{}'::jsonb)
          );
        get diagnostics v_row_count = row_count;
        v_updated := v_updated + v_row_count;
      end if;

      v_kept_ids := array_append(v_kept_ids, v_payment_id);
    end loop;

    if v_created + v_updated + v_deleted = v_change_count_before then
      v_unchanged := v_unchanged + 1;
    end if;

  end loop;

  return jsonb_build_object(
    'createdCount', v_created,
    'updatedCount', v_updated,
    'deletedCount', v_deleted,
    'unchangedReceiptCount', v_unchanged,
    'skippedModifiedReceiptCount', v_skipped_modified
  );
exception when others then
  get stacked diagnostics v_sqlstate = returned_sqlstate, v_error_message = message_text;
  v_failure_type := case
    when v_sqlstate = '23505' then 'payment_unique_conflict'
    when split_part(v_error_message, ':', 1) = any(array[
      'payment_snapshots_must_be_array', 'duplicate_payment_snapshot_receipt',
      'invalid_payment_snapshot', 'payment_snapshot_unavailable',
      'payment_snapshot_receipt_not_found', 'payment_snapshot_receipt_ambiguous',
      'paid_payment_snapshot_empty', 'invalid_payment_snapshot_row',
      'invalid_payment_snapshot_identity', 'payment_snapshot_amount_mismatch',
      'payment_snapshot_manual_payment_protected', 'duplicate_payment_external_id',
      'duplicate_payment_composite_identity', 'ambiguous_existing_payment_external_id',
      'payment_external_id_missing', 'ambiguous_payment_identity',
      'ambiguous_legacy_payment_card_identity'
    ]) then split_part(v_error_message, ':', 1)
    else 'payment_reconciliation_failed'
  end;
  -- Whitelist diagnostics: never include raw payloads, card/account details,
  -- credentials or PostgreSQL's failing-row DETAIL (which can contain PII).
  raise exception using errcode = v_sqlstate,
    message = v_failure_type,
    detail = jsonb_build_object(
      'businessDate', v_receipt.business_date, 'receiptRefId', v_ref_id,
      'receiptNo', v_receipt.ref_no,
      'failureType', v_failure_type,
      'identityEvent', v_identity_event, 'uniqueConflict', v_sqlstate = '23505'
    )::text;
end;
$function$;

alter function public.reconcile_sales_receipt_payments_v1(jsonb) owner to postgres;

revoke all on function public.reconcile_sales_receipt_payments_v1(jsonb) from public;
revoke all on function public.reconcile_sales_receipt_payments_v1(jsonb) from anon;
revoke all on function public.reconcile_sales_receipt_payments_v1(jsonb) from authenticated;
revoke all on function public.reconcile_sales_receipt_payments_v1(jsonb) from service_role;
grant execute on function public.reconcile_sales_receipt_payments_v1(jsonb) to postgres, service_role;

