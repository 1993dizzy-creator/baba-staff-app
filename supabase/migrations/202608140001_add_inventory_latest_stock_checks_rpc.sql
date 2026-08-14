begin;

create function public.inventory_latest_stock_checks_v1(p_item_ids bigint[])
returns table (
  item_id bigint,
  last_stock_check_date date
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select
    logs.item_id,
    max(
      coalesce(
        logs.business_date,
        (
          (logs.created_at at time zone 'Asia/Ho_Chi_Minh')
          - interval '3 hours'
        )::date
      )
    ) as last_stock_check_date
  from public.inventory_logs as logs
  where logs.reason = 'stock_check'
    and logs.item_id = any(coalesce(p_item_ids, '{}'::bigint[]))
    and (logs.business_date is not null or logs.created_at is not null)
  group by logs.item_id
  order by logs.item_id;
$$;

comment on function public.inventory_latest_stock_checks_v1(bigint[]) is
  'Returns the latest stock-check business date per requested inventory item.';

revoke all on function public.inventory_latest_stock_checks_v1(bigint[])
  from public, anon, authenticated;
grant execute on function public.inventory_latest_stock_checks_v1(bigint[])
  to service_role;

commit;
