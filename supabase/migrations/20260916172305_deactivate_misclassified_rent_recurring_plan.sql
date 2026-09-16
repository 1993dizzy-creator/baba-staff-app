-- Repository copy of the already applied Production correction.
-- The 60M amount is a reserve intention, not recurring rent expense.
do $$
declare
  v_plan public.ledger_recurring_expense_plans%rowtype;
  v_before_snapshot jsonb;
  v_after_snapshot jsonb;
begin
  select * into v_plan
  from public.ledger_recurring_expense_plans
  where source_key_prefix = 'rent'
    and effective_from = date '2026-09-01'
    and amount = 60000000
    and is_active = true
  order by id desc
  limit 1
  for update;

  if not found then
    return;
  end if;

  v_before_snapshot := to_jsonb(v_plan);

  update public.ledger_recurring_expense_plans
  set is_active = false,
      memo = '사용자 확인 2026-09-17: 월 60M은 임대료 비용 인식이 아니라 다음 연간 임대료 준비금 적립 계획. 반복비용 계획 비활성화.',
      updated_at = now()
  where id = v_plan.id
  returning * into v_plan;

  v_after_snapshot := to_jsonb(v_plan);

  insert into public.ledger_audit_logs (
    actor_user_id, action, entity_type, entity_id,
    before_snapshot, after_snapshot, reason
  ) values (
    1, 'recurring_plan_deactivated', 'recurring_plan', v_plan.id,
    v_before_snapshot, v_after_snapshot,
    '60M은 월 임대료 비용이 아니라 준비금 적립 계획으로 사용자 확인'
  );
end$$;
