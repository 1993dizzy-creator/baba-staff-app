create table if not exists public.pos_inventory_deduction_batches (
  id bigserial primary key,
  flow_version text not null default 'sales_db_v1',
  business_date_from date null,
  business_date_to date null,
  source text not null default 'manual_preview',
  status text not null default 'previewed',
  receipt_count integer not null default 0,
  ready_receipt_count integer not null default 0,
  blocked_receipt_count integer not null default 0,
  skipped_receipt_count integer not null default 0,
  already_applied_receipt_count integer not null default 0,
  missing_mapping_count integer not null default 0,
  manual_review_count integer not null default 0,
  invalid_mapping_count integer not null default 0,
  incomplete_recipe_count integer not null default 0,
  insufficient_stock_count integer not null default 0,
  review_required_count integer not null default 0,
  created_by text null,
  created_at timestamptz not null default now(),
  previewed_at timestamptz not null default now(),
  confirmed_by text null,
  confirmed_at timestamptz null,
  reverted_by text null,
  reverted_at timestamptz null,
  error_message text null,
  note text null,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint pos_inventory_deduction_batches_status_check
    check (
      status in (
        'previewed',
        'partially_applied',
        'applied',
        'partially_reverted',
        'reverted',
        'canceled',
        'failed'
      )
    ),
  constraint pos_inventory_deduction_batches_date_check
    check (
      business_date_from is null
      or business_date_to is null
      or business_date_from <= business_date_to
    )
);

create index if not exists pos_inventory_deduction_batches_dates_idx
  on public.pos_inventory_deduction_batches (
    business_date_from,
    business_date_to
  );

create index if not exists pos_inventory_deduction_batches_status_created_idx
  on public.pos_inventory_deduction_batches (status, created_at desc);

do $$
declare
  receipt_id_type text;
begin
  select format_type(attribute.atttypid, attribute.atttypmod)
    into receipt_id_type
  from pg_attribute attribute
  join pg_class relation on relation.oid = attribute.attrelid
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relname = 'pos_sales_receipts'
    and attribute.attname = 'id'
    and attribute.attnum > 0
    and not attribute.attisdropped;

  if receipt_id_type is null then
    raise exception 'public.pos_sales_receipts.id was not found';
  end if;

  if to_regclass('public.pos_inventory_deduction_receipts') is null then
    execute format(
      $create$
      create table public.pos_inventory_deduction_receipts (
        id bigserial primary key,
        batch_id bigint not null,
        receipt_id %s not null,
        receipt_ref_no text null,
        business_date date null,
        status text not null default 'previewed',
        inventory_affecting_hash text not null,
        amount_hash text not null,
        previewed_receipt_updated_at timestamptz null,
        blocked_reasons jsonb not null default '[]'::jsonb,
        line_summary jsonb not null default '{}'::jsonb,
        selected_for_apply boolean not null default false,
        applied_at timestamptz null,
        applied_by text null,
        reverted_at timestamptz null,
        reverted_by text null,
        review_required_at timestamptz null,
        review_reason text null,
        error_message text null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint pos_inventory_deduction_receipts_batch_fkey
          foreign key (batch_id)
          references public.pos_inventory_deduction_batches(id)
          on delete restrict,
        constraint pos_inventory_deduction_receipts_receipt_fkey
          foreign key (receipt_id)
          references public.pos_sales_receipts(id)
          on delete restrict,
        constraint pos_inventory_deduction_receipts_batch_receipt_key
          unique (batch_id, receipt_id),
        constraint pos_inventory_deduction_receipts_status_check
          check (
            status in (
              'ready',
              'skipped',
              'missing_mapping',
              'manual_review',
              'invalid_mapping',
              'incomplete_recipe',
              'insufficient_stock',
              'already_applied',
              'review_required',
              'applied',
              'reverted',
              'failed'
            )
          ),
        constraint pos_inventory_deduction_receipts_selection_check
          check (selected_for_apply = false or status = 'ready')
      )
      $create$,
      receipt_id_type
    );
  end if;
end
$$;

create index if not exists pos_inventory_deduction_receipts_batch_status_idx
  on public.pos_inventory_deduction_receipts (
    batch_id,
    status,
    selected_for_apply
  );

create index if not exists pos_inventory_deduction_receipts_receipt_idx
  on public.pos_inventory_deduction_receipts (receipt_id, created_at desc);

alter table public.pos_inventory_deductions
  add column if not exists flow_version text null default 'sales_db_v1',
  add column if not exists batch_id bigint null,
  add column if not exists batch_receipt_id bigint null,
  add column if not exists receipt_ref_no text null,
  add column if not exists business_date date null,
  add column if not exists mapping_type text null,
  add column if not exists operation_type text null default 'preview',
  add column if not exists mapping_snapshot jsonb null default '{}'::jsonb,
  add column if not exists inventory_affecting_hash text null,
  add column if not exists amount_hash text null,
  add column if not exists idempotency_key text null,
  add column if not exists quantity_sold numeric null,
  add column if not exists deduct_quantity_per_unit numeric null,
  add column if not exists deduct_quantity_total numeric null,
  add column if not exists current_quantity_snapshot numeric null,
  add column if not exists after_quantity_snapshot numeric null,
  add column if not exists blocked_reason text null,
  add column if not exists reverted_at timestamptz null,
  add column if not exists reverted_by text null,
  add column if not exists updated_at timestamptz null default now();

do $$
declare
  receipt_id_type text;
  receipt_line_id_type text;
  mapping_id_type text;
  recipe_id_type text;
  deduction_id_type text;
begin
  select format_type(attribute.atttypid, attribute.atttypmod)
    into receipt_id_type
  from pg_attribute attribute
  join pg_class relation on relation.oid = attribute.attrelid
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relname = 'pos_sales_receipts'
    and attribute.attname = 'id'
    and attribute.attnum > 0
    and not attribute.attisdropped;

  select format_type(attribute.atttypid, attribute.atttypmod)
    into receipt_line_id_type
  from pg_attribute attribute
  join pg_class relation on relation.oid = attribute.attrelid
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relname = 'pos_sales_receipt_lines'
    and attribute.attname = 'id'
    and attribute.attnum > 0
    and not attribute.attisdropped;

  select format_type(attribute.atttypid, attribute.atttypmod)
    into mapping_id_type
  from pg_attribute attribute
  join pg_class relation on relation.oid = attribute.attrelid
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relname = 'pos_item_mappings'
    and attribute.attname = 'id'
    and attribute.attnum > 0
    and not attribute.attisdropped;

  select format_type(attribute.atttypid, attribute.atttypmod)
    into recipe_id_type
  from pg_attribute attribute
  join pg_class relation on relation.oid = attribute.attrelid
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relname = 'pos_item_mapping_recipes'
    and attribute.attname = 'id'
    and attribute.attnum > 0
    and not attribute.attisdropped;

  select format_type(attribute.atttypid, attribute.atttypmod)
    into deduction_id_type
  from pg_attribute attribute
  join pg_class relation on relation.oid = attribute.attrelid
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relname = 'pos_inventory_deductions'
    and attribute.attname = 'id'
    and attribute.attnum > 0
    and not attribute.attisdropped;

  if receipt_id_type is null
    or receipt_line_id_type is null
    or mapping_id_type is null
    or recipe_id_type is null
    or deduction_id_type is null then
    raise exception 'One or more sales inventory deduction FK target types were not found';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'pos_inventory_deductions'
      and column_name = 'receipt_id'
  ) then
    execute format(
      'alter table public.pos_inventory_deductions add column receipt_id %s null',
      receipt_id_type
    );
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'pos_inventory_deductions'
      and column_name = 'receipt_line_id'
  ) then
    execute format(
      'alter table public.pos_inventory_deductions add column receipt_line_id %s null',
      receipt_line_id_type
    );
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'pos_inventory_deductions'
      and column_name = 'mapping_id'
  ) then
    execute format(
      'alter table public.pos_inventory_deductions add column mapping_id %s null',
      mapping_id_type
    );
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'pos_inventory_deductions'
      and column_name = 'recipe_id'
  ) then
    execute format(
      'alter table public.pos_inventory_deductions add column recipe_id %s null',
      recipe_id_type
    );
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'pos_inventory_deductions'
      and column_name = 'reversal_of_deduction_id'
  ) then
    execute format(
      'alter table public.pos_inventory_deductions add column reversal_of_deduction_id %s null',
      deduction_id_type
    );
  end if;
end
$$;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'pos_inventory_deductions'
      and column_name = 'processed_line_id'
      and is_nullable = 'NO'
  ) then
    alter table public.pos_inventory_deductions
      alter column processed_line_id drop not null;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'pos_inventory_deductions_batch_fkey'
      and conrelid = 'public.pos_inventory_deductions'::regclass
  ) then
    alter table public.pos_inventory_deductions
      add constraint pos_inventory_deductions_batch_fkey
      foreign key (batch_id)
      references public.pos_inventory_deduction_batches(id)
      on delete restrict
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'pos_inventory_deductions_batch_receipt_fkey'
      and conrelid = 'public.pos_inventory_deductions'::regclass
  ) then
    alter table public.pos_inventory_deductions
      add constraint pos_inventory_deductions_batch_receipt_fkey
      foreign key (batch_receipt_id)
      references public.pos_inventory_deduction_receipts(id)
      on delete restrict
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'pos_inventory_deductions_operation_type_check'
      and conrelid = 'public.pos_inventory_deductions'::regclass
  ) then
    alter table public.pos_inventory_deductions
      add constraint pos_inventory_deductions_operation_type_check
      check (operation_type in ('preview', 'deduction', 'revert'))
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'pos_inventory_deductions_sales_status_check'
      and conrelid = 'public.pos_inventory_deductions'::regclass
  ) then
    alter table public.pos_inventory_deductions
      add constraint pos_inventory_deductions_sales_status_check
      check (
        flow_version <> 'sales_db_v1'
        or status in (
          'previewed',
          'selected',
          'skipped',
          'applied',
          'blocked',
          'reverted',
          'failed'
        )
      )
      not valid;
  end if;
end
$$;

create unique index if not exists pos_inventory_deductions_idempotency_uidx
  on public.pos_inventory_deductions (idempotency_key)
  where idempotency_key is not null;

create index if not exists pos_inventory_deductions_batch_receipt_idx
  on public.pos_inventory_deductions (batch_id, batch_receipt_id);

do $$
declare
  receipt_id_type text;
  receipt_line_id_type text;
  deduction_id_type text;
begin
  select format_type(attribute.atttypid, attribute.atttypmod)
    into receipt_id_type
  from pg_attribute attribute
  join pg_class relation on relation.oid = attribute.attrelid
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relname = 'pos_sales_receipts'
    and attribute.attname = 'id'
    and attribute.attnum > 0
    and not attribute.attisdropped;

  select format_type(attribute.atttypid, attribute.atttypmod)
    into receipt_line_id_type
  from pg_attribute attribute
  join pg_class relation on relation.oid = attribute.attrelid
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relname = 'pos_sales_receipt_lines'
    and attribute.attname = 'id'
    and attribute.attnum > 0
    and not attribute.attisdropped;

  select format_type(attribute.atttypid, attribute.atttypmod)
    into deduction_id_type
  from pg_attribute attribute
  join pg_class relation on relation.oid = attribute.attrelid
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relname = 'pos_inventory_deductions'
    and attribute.attname = 'id'
    and attribute.attnum > 0
    and not attribute.attisdropped;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'inventory_logs'
      and column_name = 'related_receipt_id'
  ) then
    execute format(
      'alter table public.inventory_logs add column related_receipt_id %s null',
      receipt_id_type
    );
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'inventory_logs'
      and column_name = 'related_receipt_line_id'
  ) then
    execute format(
      'alter table public.inventory_logs add column related_receipt_line_id %s null',
      receipt_line_id_type
    );
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'inventory_logs'
      and column_name = 'related_deduction_id'
  ) then
    execute format(
      'alter table public.inventory_logs add column related_deduction_id %s null',
      deduction_id_type
    );
  end if;

  alter table public.inventory_logs
    add column if not exists related_batch_id bigint null;
end
$$;

create index if not exists inventory_logs_related_batch_idx
  on public.inventory_logs (related_batch_id);
