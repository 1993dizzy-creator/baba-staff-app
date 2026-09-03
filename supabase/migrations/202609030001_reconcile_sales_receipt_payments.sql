create function public.reconcile_sales_receipt_payments_v1(p_snapshots jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_snapshot jsonb;
  v_payment jsonb;
  v_receipt record;
  v_ref_id text;
  v_payment_id bigint;
  v_external_id text;
  v_duplicate_external_id text;
  v_duplicate_composite_identity text;
  v_kept_ids bigint[];
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
    select count(distinct value->>'receiptRefId')
    from jsonb_array_elements(p_snapshots)
  ) then
    raise exception 'duplicate_payment_snapshot_receipt' using errcode = '22023';
  end if;

  for v_snapshot in
    select value
    from jsonb_array_elements(p_snapshots)
    order by value->>'receiptRefId'
  loop
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
      select receipt.id, receipt.business_date, receipt.ref_date, receipt.is_modified,
             receipt.payment_status, receipt.is_canceled, receipt.final_amount
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
    end loop;

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
      raise exception 'duplicate_payment_external_id: %, %', v_ref_id, v_duplicate_external_id
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
      raise exception 'duplicate_payment_composite_identity: %, %',
        v_ref_id, v_duplicate_composite_identity
        using errcode = '22023';
    end if;

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

      select payment.id
        into v_payment_id
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
        )
      order by payment.id desc
      limit 1;

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

    delete from public.pos_sales_receipt_payments payment
    where payment.receipt_id = v_receipt.id
      and not (payment.id = any(v_kept_ids));
    get diagnostics v_row_count = row_count;
    v_deleted := v_deleted + v_row_count;

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
end;
$function$;

alter function public.reconcile_sales_receipt_payments_v1(jsonb) owner to postgres;

revoke all on function public.reconcile_sales_receipt_payments_v1(jsonb) from public;
revoke all on function public.reconcile_sales_receipt_payments_v1(jsonb) from anon;
revoke all on function public.reconcile_sales_receipt_payments_v1(jsonb) from authenticated;
revoke all on function public.reconcile_sales_receipt_payments_v1(jsonb) from service_role;
grant execute on function public.reconcile_sales_receipt_payments_v1(jsonb) to postgres, service_role;
