-- Add only the canonical expense categories missing from the existing Ledger master.
-- This does not alter Inventory mappings, Payroll categories, or automatic posting logic.
do $$
declare
  v_labor bigint;
  v_admin bigint;
begin
  select id into v_labor
  from public.ledger_categories
  where kind = 'expense' and name = '인건비';

  select id into v_admin
  from public.ledger_categories
  where kind = 'expense' and name = '일반관리비';

  if v_labor is null or v_admin is null then
    raise exception 'Required Ledger parent categories are missing';
  end if;

  insert into public.ledger_categories(name, kind, parent_id, cost_behavior, is_active)
  values
    ('청소·위생비', 'expense', v_admin, 'semi_variable', true),
    ('배송·운송비', 'expense', v_admin, 'variable', true),
    ('운영 소모품', 'expense', v_admin, 'variable', true),
    ('인쇄·홍보비', 'expense', v_admin, 'variable', true),
    ('직원 주거비', 'expense', v_labor, 'fixed', true),
    ('세금', 'expense', v_admin, 'semi_variable', true)
  on conflict (kind, name) do nothing;
end;
$$;
