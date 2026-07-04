alter table public.inventory_logs
  drop constraint if exists inventory_logs_source_check;

alter table public.inventory_logs
  add constraint inventory_logs_source_check
  check (
    source is null
    or source in (
      'quick_save',
      'edit_form',
      'create',
      'delete',
      'photo',
      'pos_sales',
      'keg_replace',
      'system'
    )
  );
