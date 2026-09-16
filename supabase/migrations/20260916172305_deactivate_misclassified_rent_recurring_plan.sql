-- Repository copy of the already applied Production correction.
-- The 60M amount is a reserve intention, not recurring rent expense.
update public.ledger_recurring_expense_plans
set is_active = false,
    updated_at = now()
where source_key_prefix = 'rent'
  and effective_from = date '2026-09-01'
  and amount = 60000000
  and is_active = true;
