alter table public.pos_item_mappings
  drop constraint if exists pos_item_mappings_mapping_type_check;

alter table public.pos_item_mappings
  add constraint pos_item_mappings_mapping_type_check
  check (
    mapping_type in ('direct', 'recipe', 'combo', 'manual', 'ignore')
  );

alter table public.pos_inventory_deductions
  drop constraint if exists pos_inventory_deductions_mapping_type_check;

alter table public.pos_inventory_deductions
  add constraint pos_inventory_deductions_mapping_type_check
  check (
    mapping_type is null
    or mapping_type in ('direct', 'recipe', 'combo', 'manual', 'ignore')
  );
