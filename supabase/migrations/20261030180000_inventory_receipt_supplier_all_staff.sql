-- Receipt-only supplier edits are available to every active app user.
-- Patch the existing RPC in place so its deployed accounting protections, including
-- any billed-amount support, remain unchanged. No receipt or item data is rewritten.
begin;

do $migration$
declare
  v_definition text;
  v_guard text := E'  if v_supplier_changed and v_role <> all(array[''owner'',''master'']) then\n    return jsonb_build_object(''status'',''supplier_change_forbidden'');\n  end if;\n';
begin
  select pg_get_functiondef('public.inventory_apply_purchase_receipt_edit_v1(bigint,bigint,numeric,jsonb,jsonb,date,bigint)'::regprocedure)
    into v_definition;
  if position(v_guard in v_definition) = 0 then
    v_guard := replace(v_guard, E'\n', E'\r\n');
  end if;

  -- Require exactly one expected guard. An unfamiliar/already-patched definition
  -- must be reviewed rather than silently replacing other function logic.
  if length(v_definition) - length(replace(v_definition, v_guard, '')) <> length(v_guard) then
    raise exception 'INVENTORY_RECEIPT_SUPPLIER_GUARD_MISMATCH';
  end if;

  execute replace(v_definition, v_guard, '');
end;
$migration$;

revoke all on function public.inventory_apply_purchase_receipt_edit_v1(bigint,bigint,numeric,jsonb,jsonb,date,bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.inventory_apply_purchase_receipt_edit_v1(bigint,bigint,numeric,jsonb,jsonb,date,bigint)
  to service_role;

commit;
