-- Investigation only; NOT a correction, migration, or authorization to post.
-- One database snapshot; leaves no changes. Run by an authorized read-only reviewer.
begin transaction isolation level repeatable read read only;

with
scope as (
  select 5::bigint as party_id, date '2026-11-17' as cutoff,
         5097::bigint as payment_id, 1493::bigint as legacy_payment_id,
         6582000::numeric as owner_reported_payment,
         4982000::numeric as owner_reported_closing
),
sources as (
  select p.id, p.expense_transaction_id, p.original_amount, p.status,
         t.business_date, t.status as transaction_status,
         t.source_type, t.source_key, t.source_snapshot,
         t.source_snapshot->>'paymentVerification' as verification_marker
  from public.ledger_payables p
  join public.ledger_transactions t on t.id = p.expense_transaction_id
  cross join scope s
  where p.party_id = s.party_id and t.business_date <= s.cutoff
),
allocations as (
  select a.id, a.payable_id, a.payment_transaction_id, a.allocated_amount,
         t.status as payment_status, t.business_date as payment_date
  from public.ledger_payable_allocations a
  join public.ledger_transactions t on t.id = a.payment_transaction_id
  where a.payable_id in (select id from sources)
),
balances as (
  select p.*,
    coalesce((select sum(a.allocated_amount) from allocations a cross join scope s
      where a.payable_id = p.id and a.payment_status = 'confirmed'
        and a.payment_date <= s.cutoff), 0) as allocated_as_of,
    p.original_amount - coalesce((select sum(a.allocated_amount)
      from allocations a cross join scope s
      where a.payable_id = p.id and a.payment_status = 'confirmed'
        and a.payment_date <= s.cutoff), 0) as raw_remaining_as_of
  from sources p
),
totals as (
  select coalesce(sum(greatest(raw_remaining_as_of, 0)), 0) as app_closing,
         count(*) filter (where raw_remaining_as_of < 0) as overallocated_count
  from balances
  where status <> 'cancelled' and transaction_status = 'confirmed'
    and coalesce(verification_marker, '') <> 'pending'
),
payment as (select t.* from public.ledger_transactions t cross join scope s where t.id = s.payment_id),
legacy as (select t.* from public.ledger_transactions t cross join scope s where t.id = s.legacy_payment_id)
select jsonb_build_object(
  'scope', (select to_jsonb(s) from scope s),
  'warning', 'Owner targets are supplied assertions, not independently verified bank/supplier evidence. No posting is proposed by this SELECT.',
  'payment', (select to_jsonb(p) from payment p),
  'payment_allocations', coalesce((select jsonb_agg(to_jsonb(a) order by a.id)
    from public.ledger_payable_allocations a cross join scope s
    where a.payment_transaction_id = s.payment_id), '[]'::jsonb),
  'payment_movements', coalesce((select jsonb_agg(to_jsonb(m) order by m.id)
    from public.ledger_movements m cross join scope s where m.transaction_id = s.payment_id), '[]'::jsonb),
  'payment_audit', coalesce((select jsonb_agg(to_jsonb(a) order by a.id)
    from public.ledger_audit_logs a cross join scope s
    where a.entity_type = 'transaction' and a.entity_id = s.payment_id), '[]'::jsonb),
  'payables_as_of', coalesce((select jsonb_agg(to_jsonb(b) order by b.id) from balances b), '[]'::jsonb),
  'arithmetic', (select jsonb_build_object(
    'app_closing', v.app_closing,
    'recorded_payment', p.amount,
    'payment_record_shortfall', s.owner_reported_payment - p.amount,
    'app_before_this_payment', v.app_closing + p.amount,
    'owner_implied_before_payment', s.owner_reported_closing + s.owner_reported_payment,
    'closing_if_only_payment_corrected', v.app_closing - (s.owner_reported_payment - p.amount),
    'unexplained_debt_difference', s.owner_reported_closing + s.owner_reported_payment - v.app_closing - p.amount,
    'overallocated_count', v.overallocated_count
  ) from totals v cross join scope s cross join payment p),
  'protected_legacy_payment', (select to_jsonb(t) from legacy t),
  'protected_legacy_allocations', coalesce((select jsonb_agg(to_jsonb(a) order by a.id)
    from public.ledger_payable_allocations a cross join scope s
    where a.payment_transaction_id = s.legacy_payment_id), '[]'::jsonb),
  'protected_closures', coalesce((select jsonb_agg(to_jsonb(c) order by c.month)
    from public.ledger_month_closures c
    where c.month in (date '2026-08-01', date '2026-09-01', date '2026-10-01')), '[]'::jsonb)
) as investigation;

rollback;
