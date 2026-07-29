-- Read-only dry run. Expected row count before the fix: 12.
select
  id,
  item_name,
  item_name_vi,
  part,
  category,
  category_vi
from public.inventory
where part = 'bar'
  and category = '음료'
  and (
    category_vi is null
    or btrim(category_vi) = ''
    or category_vi = '음료'
  )
order by id;

-- Run only after the dry-run result is reviewed and approved.
-- update public.inventory
-- set category_vi = 'Đồ uống'
-- where part = 'bar'
--   and category = '음료'
--   and (
--     category_vi is null
--     or btrim(category_vi) = ''
--     or category_vi = '음료'
--   );

-- Read-only post-update verification. Expected: 13 standardized rows.
select
  category_vi,
  count(*) as row_count
from public.inventory
where part = 'bar'
  and category = '음료'
group by category_vi
order by category_vi;
