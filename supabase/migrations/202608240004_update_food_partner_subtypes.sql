-- Keep the existing dry_food identity while correcting its user-facing labels.
update public.business_partner_subtypes
set name_ko = '건어물',
    name_vi = 'Đồ khô',
    updated_at = now()
where lower(btrim(code)) = 'dry_food'
  and partner_type = 'food'
  and (name_ko, name_vi) is distinct from ('건어물', 'Đồ khô');

-- A broad food supplier is distinct from food_other and ad-hoc market purchases.
-- The NOT EXISTS guard makes replay safe without changing any existing stable code.
insert into public.business_partner_subtypes (
  code, partner_type, name_ko, name_vi, sort_order, is_active
)
select 'general_food', 'food', '종합 식자재', 'Thực phẩm tổng hợp', 75, true
where not exists (
  select 1
  from public.business_partner_subtypes
  where lower(btrim(code)) = 'general_food'
);
