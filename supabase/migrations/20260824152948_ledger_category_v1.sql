-- Ledger V1 category cleanup: Inventory is the source for routine purchase classification.
-- Existing historical category IDs are preserved; new hierarchy is additive.

do $$
declare
  v_purchase bigint;
  v_food bigint;
  v_alcohol bigint;
  v_bar bigint;
  v_consumable bigint;
  v_labor bigint;
  v_utility bigint;
  v_facility bigint;
  v_admin bigint;
  v_income bigint;
  r record;
  v_leaf bigint;
begin
  insert into public.ledger_categories(name,kind,cost_behavior,is_active)
  values('매입비','expense','variable',true)
  on conflict(kind,name) do update set is_active=true
  returning id into v_purchase;

  insert into public.ledger_categories(name,kind,parent_id,cost_behavior,is_active)
  values
    ('식자재 매입','expense',v_purchase,'variable',true),
    ('주류 매입','expense',v_purchase,'variable',true),
    ('음료·BAR 재료','expense',v_purchase,'variable',true),
    ('소모품·잡화','expense',v_purchase,'variable',true),
    ('기타 매입','expense',v_purchase,'variable',true)
  on conflict(kind,name) do update
    set parent_id=excluded.parent_id,cost_behavior=excluded.cost_behavior,is_active=true;

  select id into v_food from public.ledger_categories where kind='expense' and name='식자재 매입';
  select id into v_alcohol from public.ledger_categories where kind='expense' and name='주류 매입';
  select id into v_bar from public.ledger_categories where kind='expense' and name='음료·BAR 재료';
  select id into v_consumable from public.ledger_categories where kind='expense' and name='소모품·잡화';

  insert into public.ledger_categories(name,kind,cost_behavior,is_active)
  values
    ('인건비','expense','fixed',true),
    ('공과금','expense','semi_variable',true),
    ('임차·시설비','expense','fixed',true),
    ('일반관리비','expense','none',true),
    ('영업수입','income','variable',true)
  on conflict(kind,name) do update set cost_behavior=excluded.cost_behavior,is_active=true;

  select id into v_labor from public.ledger_categories where kind='expense' and name='인건비';
  select id into v_utility from public.ledger_categories where kind='expense' and name='공과금';
  select id into v_facility from public.ledger_categories where kind='expense' and name='임차·시설비';
  select id into v_admin from public.ledger_categories where kind='expense' and name='일반관리비';
  select id into v_income from public.ledger_categories where kind='income' and name='영업수입';

  -- Preserve existing IDs while fixing their hierarchy.
  update public.ledger_categories set parent_id=v_labor where kind='expense' and name in ('급여/인건비','직원 식대');
  update public.ledger_categories set parent_id=v_utility where kind='expense' and name='전기료';
  update public.ledger_categories set parent_id=v_facility where kind='expense' and name='임대료';
  update public.ledger_categories set parent_id=v_admin where kind='expense' and name in ('기타 비용','카드 정산 차액');
  update public.ledger_categories set parent_id=v_income where kind='income' and name in ('POS 매출','기타 수입');

  insert into public.ledger_categories(name,kind,parent_id,cost_behavior,is_active)
  values
    ('보험·복리후생','expense',v_labor,'fixed',true),
    ('수도료','expense',v_utility,'semi_variable',true),
    ('가스비','expense',v_utility,'semi_variable',true),
    ('인터넷·통신비','expense',v_utility,'fixed',true),
    ('수리·유지보수','expense',v_facility,'none',true),
    ('설비·비품','expense',v_facility,'none',true),
    ('인테리어','expense',v_facility,'none',true),
    ('회계·세무','expense',v_admin,'fixed',true),
    ('결제·은행 수수료','expense',v_admin,'variable',true),
    ('예금이자','income',v_income,'none',true)
  on conflict(kind,name) do update
    set parent_id=excluded.parent_id,cost_behavior=excluded.cost_behavior,is_active=true;

  -- Inventory categories -> Ledger leaf categories.
  for r in
    select * from (values
      ('가공식품',v_food),('건어물',v_food),('견과류',v_food),('과일',v_food),
      ('기름',v_food),('면류',v_food),('버섯',v_food),('소스',v_food),('스낵',v_food),
      ('식자재',v_food),('유제품',v_food),('육류',v_food),('절임',v_food),('조미료',v_food),
      ('채소',v_food),('치즈',v_food),('튀김류',v_food),('해산물',v_food),
      ('생맥주',v_alcohol),('수제맥주',v_alcohol),('병맥주',v_alcohol),('소주',v_alcohol),
      ('와인',v_alcohol),('위스키',v_alcohol),('코냑',v_alcohol),('진',v_alcohol),
      ('보드카',v_alcohol),('럼',v_alcohol),('데킬라',v_alcohol),('리큐르',v_alcohol),
      ('베르무트',v_alcohol),
      ('음료',v_bar),('시럽',v_bar),('허브',v_bar),
      ('컵·잔류',v_consumable)
    ) as x(raw_name,parent_id)
  loop
    insert into public.ledger_categories(name,kind,parent_id,cost_behavior,is_active)
    values(r.raw_name,'expense',r.parent_id,'variable',true)
    on conflict(kind,name) do update
      set parent_id=excluded.parent_id,cost_behavior='variable',is_active=true
    returning id into v_leaf;

    insert into public.ledger_inventory_category_mappings(inventory_category,ledger_category_id,is_active)
    values(r.raw_name,v_leaf,true)
    on conflict(inventory_category) do update
      set ledger_category_id=excluded.ledger_category_id,is_active=true;
  end loop;

  insert into public.ledger_categories(name,kind,parent_id,cost_behavior,is_active)
  values('기타 재고매입','expense',(select id from public.ledger_categories where kind='expense' and name='기타 매입'),'variable',true)
  on conflict(kind,name) do update
    set parent_id=excluded.parent_id,cost_behavior='variable',is_active=true
  returning id into v_leaf;

  insert into public.ledger_inventory_category_mappings(inventory_category,ledger_category_id,is_active)
  values('기타',v_leaf,true)
  on conflict(inventory_category) do update
    set ledger_category_id=excluded.ledger_category_id,is_active=true;
end;
$$;

-- Refresh category proposals for existing pending Inventory candidates.
update public.ledger_candidates c
set proposed_category_id = m.ledger_category_id,
    updated_at = now()
from public.ledger_inventory_category_mappings m
where c.status='pending'
  and c.candidate_type='inventory_purchase'
  and m.is_active=true
  and lower(btrim(m.inventory_category)) = lower(btrim(c.source_snapshot->>'category'))
  and c.proposed_category_id is distinct from m.ledger_category_id;

comment on table public.ledger_inventory_category_mappings
  is 'Inventory category to Ledger expense-category mapping. Routine inventory purchases are categorized from Inventory, not from the legacy spreadsheet taxonomy.';
