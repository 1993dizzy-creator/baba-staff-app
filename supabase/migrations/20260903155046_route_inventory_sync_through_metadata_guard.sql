create or replace function public.ledger_sync_inventory_candidates_v1(
  p_rows jsonb,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  return public.ledger_sync_inventory_candidates_v2(
    p_rows,
    p_actor_user_id
  );
end;
$function$;

alter function public.ledger_sync_inventory_candidates_v1(jsonb, bigint)
  owner to postgres;

revoke all on function public.ledger_sync_inventory_candidates_v1(jsonb, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.ledger_sync_inventory_candidates_v1(jsonb, bigint)
  to postgres, service_role;
