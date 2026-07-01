alter table public.pos_item_mappings
  add column if not exists source_quantity numeric null,
  add column if not exists source_unit text null,
  add column if not exists source_package_content_quantity numeric null,
  add column if not exists source_package_content_unit text null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pos_item_mappings_source_quantity_positive_check'
      and conrelid = 'public.pos_item_mappings'::regclass
  ) then
    alter table public.pos_item_mappings
      add constraint pos_item_mappings_source_quantity_positive_check
      check (source_quantity is null or source_quantity > 0)
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'pos_item_mappings_source_package_content_quantity_positive_check'
      and conrelid = 'public.pos_item_mappings'::regclass
  ) then
    alter table public.pos_item_mappings
      add constraint pos_item_mappings_source_package_content_quantity_positive_check
      check (
        source_package_content_quantity is null
        or source_package_content_quantity > 0
      )
      not valid;
  end if;
end
$$;
