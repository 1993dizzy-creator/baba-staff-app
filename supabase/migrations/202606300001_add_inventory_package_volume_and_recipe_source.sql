alter table public.inventory
  add column if not exists package_content_quantity numeric null,
  add column if not exists package_content_unit text null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'inventory_package_content_quantity_positive_check'
      and conrelid = 'public.inventory'::regclass
  ) then
    alter table public.inventory
      add constraint inventory_package_content_quantity_positive_check
      check (package_content_quantity is null or package_content_quantity > 0)
      not valid;
  end if;
end
$$;

alter table public.pos_item_mapping_recipes
  add column if not exists source_quantity numeric null,
  add column if not exists source_unit text null,
  add column if not exists source_package_content_quantity numeric null,
  add column if not exists source_package_content_unit text null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pos_item_mapping_recipes_source_quantity_positive_check'
      and conrelid = 'public.pos_item_mapping_recipes'::regclass
  ) then
    alter table public.pos_item_mapping_recipes
      add constraint pos_item_mapping_recipes_source_quantity_positive_check
      check (source_quantity is null or source_quantity > 0)
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'pos_item_mapping_recipes_source_package_content_quantity_positive_check'
      and conrelid = 'public.pos_item_mapping_recipes'::regclass
  ) then
    alter table public.pos_item_mapping_recipes
      add constraint pos_item_mapping_recipes_source_package_content_quantity_positive_check
      check (
        source_package_content_quantity is null
        or source_package_content_quantity > 0
      )
      not valid;
  end if;
end
$$;
