do $$
declare
  pos_product_id_type text;
  mapping_product_id_type text;
begin
  select format_type(attribute.atttypid, attribute.atttypmod)
    into pos_product_id_type
  from pg_attribute attribute
  join pg_class relation
    on relation.oid = attribute.attrelid
  join pg_namespace namespace
    on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relname = 'pos_products'
    and attribute.attname = 'id'
    and attribute.attnum > 0
    and not attribute.attisdropped;

  if pos_product_id_type is null then
    raise exception 'public.pos_products.id was not found';
  end if;

  select format_type(attribute.atttypid, attribute.atttypmod)
    into mapping_product_id_type
    from pg_attribute attribute
    join pg_class relation
      on relation.oid = attribute.attrelid
    join pg_namespace namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'pos_item_mappings'
      and attribute.attname = 'pos_product_id'
      and attribute.attnum > 0
      and not attribute.attisdropped;

  if mapping_product_id_type is null then
    execute format(
      'alter table public.pos_item_mappings add column pos_product_id %s null',
      pos_product_id_type
    );
  elsif mapping_product_id_type <> pos_product_id_type then
    raise exception
      'public.pos_item_mappings.pos_product_id type (%) does not match public.pos_products.id type (%)',
      mapping_product_id_type,
      pos_product_id_type;
  end if;
end
$$;

alter table public.pos_item_mappings
  add column if not exists target_type text not null default 'product',
  add column if not exists pos_option_id text null,
  add column if not exists pos_product_code_snapshot text null,
  add column if not exists pos_product_name_snapshot text null,
  add column if not exists pos_option_name_snapshot text null,
  add column if not exists mapping_version integer not null default 1,
  add column if not exists last_reconciled_at timestamptz null,
  add column if not exists updated_at timestamptz null,
  add column if not exists updated_by text null;

alter table public.pos_item_mappings
  alter column target_type set default 'product',
  alter column mapping_version set default 1;

update public.pos_item_mappings
set target_type = 'product'
where target_type is null;

update public.pos_item_mappings
set mapping_version = 1
where mapping_version is null;

alter table public.pos_item_mappings
  alter column target_type set not null,
  alter column mapping_version set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pos_item_mappings_target_type_check'
      and conrelid = 'public.pos_item_mappings'::regclass
  ) then
    alter table public.pos_item_mappings
      add constraint pos_item_mappings_target_type_check
      check (target_type in ('product', 'option'))
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'pos_item_mappings_mapping_version_check'
      and conrelid = 'public.pos_item_mappings'::regclass
  ) then
    alter table public.pos_item_mappings
      add constraint pos_item_mappings_mapping_version_check
      check (mapping_version > 0)
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'pos_item_mappings_option_target_check'
      and conrelid = 'public.pos_item_mappings'::regclass
  ) then
    alter table public.pos_item_mappings
      add constraint pos_item_mappings_option_target_check
      check (
        (target_type = 'product' and pos_option_id is null)
        or
        (target_type = 'option' and pos_option_id is not null)
      )
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'pos_item_mappings_pos_product_id_fkey'
      and conrelid = 'public.pos_item_mappings'::regclass
  ) then
    alter table public.pos_item_mappings
      add constraint pos_item_mappings_pos_product_id_fkey
      foreign key (pos_product_id)
      references public.pos_products(id)
      on update cascade
      on delete restrict
      not valid;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and indexname = 'pos_item_mappings_active_product_uidx'
  ) then
    if exists (
      select 1
      from public.pos_item_mappings
      where target_type = 'product'
        and is_active = true
        and pos_product_id is not null
      group by pos_product_id
      having count(*) > 1
    ) then
      raise notice
        'Skipped pos_item_mappings_active_product_uidx because active product mappings contain duplicates';
    else
      create unique index pos_item_mappings_active_product_uidx
        on public.pos_item_mappings (pos_product_id)
        where target_type = 'product'
          and is_active = true
          and pos_product_id is not null;
    end if;
  end if;

  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and indexname = 'pos_item_mappings_active_option_uidx'
  ) then
    if exists (
      select 1
      from public.pos_item_mappings
      where target_type = 'option'
        and is_active = true
        and pos_product_id is not null
        and pos_option_id is not null
      group by pos_product_id, pos_option_id
      having count(*) > 1
    ) then
      raise notice
        'Skipped pos_item_mappings_active_option_uidx because active option mappings contain duplicates';
    else
      create unique index pos_item_mappings_active_option_uidx
        on public.pos_item_mappings (pos_product_id, pos_option_id)
        where target_type = 'option'
          and is_active = true
          and pos_product_id is not null
          and pos_option_id is not null;
    end if;
  end if;
end
$$;

create index if not exists pos_item_mappings_pos_product_id_idx
  on public.pos_item_mappings (pos_product_id);

create index if not exists pos_item_mappings_pos_item_code_idx
  on public.pos_item_mappings (pos_item_code);

alter table public.pos_item_mapping_recipes
  add column if not exists is_required boolean not null default true,
  add column if not exists version integer not null default 1,
  add column if not exists updated_at timestamptz null,
  add column if not exists updated_by text null;

alter table public.pos_item_mapping_recipes
  alter column is_required set default true,
  alter column version set default 1;

update public.pos_item_mapping_recipes
set is_required = true
where is_required is null;

update public.pos_item_mapping_recipes
set version = 1
where version is null;

alter table public.pos_item_mapping_recipes
  alter column is_required set not null,
  alter column version set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pos_item_mapping_recipes_version_check'
      and conrelid = 'public.pos_item_mapping_recipes'::regclass
  ) then
    alter table public.pos_item_mapping_recipes
      add constraint pos_item_mapping_recipes_version_check
      check (version > 0)
      not valid;
  end if;
end
$$;

create index if not exists pos_item_mapping_recipes_mapping_id_idx
  on public.pos_item_mapping_recipes (mapping_id);
