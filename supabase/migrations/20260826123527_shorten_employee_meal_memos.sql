-- Keep historical auto-posted employee meal rows concise without changing their
-- amount, timing, source provenance, candidate resolution, or cash movements.
update public.ledger_transactions
set memo = '직원 식대 · ' || (source_snapshot->>'employee_count') || '명'
where status = 'confirmed'
  and type = 'expense'
  and source_type = 'attendance_meal_daily_candidate'
  and correction_of_id is null
  and business_date between date '2026-08-01' and date '2026-08-26'
  and source_snapshot->>'employee_count' ~ '^[1-9][0-9]*$'
  and source_key ~ '^candidate:[0-9]+$'
  and memo ~ (
    '^직원 식대 · ' || (source_snapshot->>'employee_count') ||
    '명 × [1-9][0-9,]*(\.[0-9]+)?₫ · 18시 자동집계$'
  )
  and exists (
    select 1
    from public.ledger_categories as category
    where category.id = ledger_transactions.category_id
      and category.kind = 'expense'
      and category.name = '직원 식대'
  )
  and exists (
    select 1
    from public.ledger_candidates as candidate
    where ledger_transactions.source_key = 'candidate:' || candidate.id::text
      and candidate.candidate_type = 'employee_meal'
      and candidate.source_type = 'attendance_meal_daily'
      and candidate.source_key = 'meal:' || ledger_transactions.business_date::text
      and candidate.business_date = ledger_transactions.business_date
      and candidate.status = 'confirmed'
      and candidate.resolved_transaction_id = ledger_transactions.id
      and candidate.proposed_category_id = ledger_transactions.category_id
      and candidate.source_snapshot = ledger_transactions.source_snapshot
      and candidate.source_fingerprint = ledger_transactions.source_fingerprint
  );
