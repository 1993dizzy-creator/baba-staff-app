alter table public.pos_item_mappings
  add column if not exists archived_at timestamptz null,
  add column if not exists archived_by text null,
  add column if not exists archive_reason text null;

create index if not exists pos_item_mappings_archived_at_idx
  on public.pos_item_mappings (archived_at);

drop index if exists public.pos_item_mappings_active_product_uidx;
create unique index pos_item_mappings_active_product_uidx
  on public.pos_item_mappings (pos_product_id)
  where target_type = 'product'
    and is_active = true
    and archived_at is null
    and pos_product_id is not null;

drop index if exists public.pos_item_mappings_active_option_uidx;
create unique index pos_item_mappings_active_option_uidx
  on public.pos_item_mappings (pos_product_id, pos_option_id)
  where target_type = 'option'
    and is_active = true
    and archived_at is null
    and pos_product_id is not null
    and pos_option_id is not null;

do $$
declare
  function_oid oid;
  function_definition text;
begin
  for function_oid in
    select procedure.oid
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = 'apply_sales_inventory_deduction_batch'
  loop
    function_definition := pg_get_functiondef(function_oid);

    if position('mapping.archived_at is not null' in function_definition) = 0 then
      function_definition := replace(
        function_definition,
        'or mapping.is_active is not true',
        'or mapping.is_active is not true
      or mapping.archived_at is not null'
      );

      if position('mapping.archived_at is not null' in function_definition) = 0 then
        raise exception
          'Unable to add archived mapping guard to apply_sales_inventory_deduction_batch';
      end if;

      execute function_definition;
    end if;
  end loop;
end
$$;
