-- Ledger payables / payment-verification legacy audit — READ ONLY.
--
-- Purpose: find legacy or drifted payable data before any cleanup.
-- This file only SELECTs. It is NOT a migration and must not be placed under
-- supabase/migrations. Run it in the SQL editor as-is; the transaction is
-- read-only and ends with ROLLBACK. Do not add UPDATE/DELETE here — any repair
-- must be a separate, reviewed migration with row counts and a rollback plan.
--
-- Data model (from migrations 202608210003/202608210004/20260921170100):
--   ledger_payables(id, expense_transaction_id UNIQUE, party_id, original_amount numeric(16,3) > 0,
--                   due_date, status in unpaid|partially_paid|paid|cancelled)
--   ledger_payable_allocations(payable_id, payment_transaction_id, allocated_amount > 0,
--                   UNIQUE(payable_id, payment_transaction_id))
--   ledger_transactions: expense side  = the payable's expense_transaction_id
--                        payment side  = type 'payable_payment' (source_snapshot.allocationMode oldest_first|custom)
--   Candidates: ledger_candidates(source_type 'inventory_purchase_log', source_key = inventory source key,
--                        status confirmed → resolved_transaction_id = expense transaction).
--
-- Payable status contract (ledger_payables.status, set by ledger_pay_payables_v1):
--   confirmed allocation = 0                          → 'unpaid'
--   0 < confirmed allocation < original_amount        → 'partially_paid'   (never 'partial')
--   confirmed allocation >= original_amount           → 'paid'
--   'cancelled' is excluded from status checks.
--
-- paymentVerification marker contract:
--   Payment verification = payable whose expense transaction has
--   source_snapshot->>'paymentVerification' = 'pending'. The marker is NEVER cleared after payment,
--   so "marker present" does NOT mean "unpaid".
--     * verification_unresolved   = marker AND original_amount - confirmed allocation > 0
--                                   → the only rows the 결제 미확인 UI shows / counts as operational.
--     * verification_marker_paid  = marker AND confirmed allocation >= original_amount
--                                   → legacy/reference only; not operational unpaid.
--
-- Legacy sheet carryover payments:
--   source_key LIKE 'legacy-sheet-payment:%' are August back-calculated payments that include
--   payables from before the app ledger started, so amount <> allocation sum is intentional.
--   They are reported separately (D2) and must not be "fixed" or given synthetic allocations.
--
-- Paid amount conventions differ between code paths (see K below):
--   * payables list API / month close preflight: only allocations whose payment transaction is 'confirmed'
--   * ledger_pay_payables_v1 and the party detail API: all allocations regardless of payment status
--
-- Production read-only results reported on 2026-09-25 (reference only; re-run to refresh):
--   B payable_status_mismatch ........................ 0 expected after the partially_paid rule
--     (5 rows first flagged were all normal partially_paid)
--   C over-allocated payable ......................... 0
--   D1 payment/allocation mismatch (non-legacy) ...... 0; D2 legacy-sheet-payment carryover: 3
--     (8/15 Chợ 2,200,000 / alloc 627,500 · 8/20 오징어 9,033,750 / alloc 0 · 8/24 Coca-Cola 4,150,000 / alloc 1,604,968)
--   E abnormal/cancelled-target allocation ........... 0
--   G same inventory source with duplicate expenses .. 0
--   K non-confirmed payable_payment allocations ...... 0
--   M payment fund movement mismatch ................. 0
--   verification_unresolved: 22 rows / 13,281,400 · verification_marker_paid: 35 rows / 20,032,897

begin transaction read only;

-- S. Summary: verification marker split into operational (unresolved) vs reference (fully paid).
with alloc as (
  select a.payable_id, sum(a.allocated_amount) filter (where pt.status = 'confirmed') as confirmed_paid
  from public.ledger_payable_allocations a
  left join public.ledger_transactions pt on pt.id = a.payment_transaction_id
  group by a.payable_id
), p as (
  select p.id, p.status, p.original_amount,
         coalesce(e.source_snapshot->>'paymentVerification', '') = 'pending' as has_marker,
         greatest(0, p.original_amount - coalesce(alloc.confirmed_paid, 0)) as remaining
  from public.ledger_payables p
  join public.ledger_transactions e on e.id = p.expense_transaction_id and e.status = 'confirmed'
  left join alloc on alloc.payable_id = p.id
  where p.status <> 'cancelled'
)
select 'S_summary' as check_name,
       count(*) as open_or_paid_payables,
       count(*) filter (where has_marker and remaining > 0) as verification_unresolved_count,
       coalesce(sum(remaining) filter (where has_marker and remaining > 0), 0) as verification_unresolved_amount,
       count(*) filter (where has_marker and remaining = 0) as verification_marker_paid_count,
       coalesce(sum(original_amount) filter (where has_marker and remaining = 0), 0) as verification_marker_paid_amount
from p;

-- A. verification_marker_with_payment: marker present AND confirmed payments exist
--    (partially or fully). Expected after a real verification payment; suspicious when the
--    payment came from a generic oldest_first party payment (see L) rather than the
--    verification flow (custom single allocation).                      Risk: medium · Human review
select p.id as payable_id, p.party_id, e.business_date, p.original_amount,
       sum(a.allocated_amount) as confirmed_paid,
       array_agg(distinct pt.source_snapshot->>'allocationMode') as allocation_modes
from public.ledger_payables p
join public.ledger_transactions e on e.id = p.expense_transaction_id
join public.ledger_payable_allocations a on a.payable_id = p.id
join public.ledger_transactions pt on pt.id = a.payment_transaction_id and pt.status = 'confirmed'
where e.source_snapshot->>'paymentVerification' = 'pending' and p.status <> 'cancelled'
group by p.id, p.party_id, e.business_date, p.original_amount
order by e.business_date;

-- B. payable_status_mismatch: stored status disagrees with confirmed allocations
--    (status is only recomputed by the pay RPC). Uses the exact DB values
--    unpaid | partially_paid | paid; cancelled is excluded.
--    Auto-fixable in principle (status is derived) · Risk: low · confirm which paid convention (K) first
with alloc as (
  select a.payable_id, sum(a.allocated_amount) filter (where pt.status = 'confirmed') as confirmed_paid, sum(a.allocated_amount) as all_paid
  from public.ledger_payable_allocations a left join public.ledger_transactions pt on pt.id = a.payment_transaction_id
  group by a.payable_id
), judged as (
  select p.id as payable_id, p.party_id, p.status, p.original_amount,
         coalesce(alloc.confirmed_paid, 0) as confirmed_paid, coalesce(alloc.all_paid, 0) as all_paid,
         case
           when coalesce(alloc.confirmed_paid, 0) = 0 then 'unpaid'
           when coalesce(alloc.confirmed_paid, 0) < p.original_amount then 'partially_paid'
           else 'paid'
         end as expected_status
  from public.ledger_payables p
  left join alloc on alloc.payable_id = p.id
  where p.status <> 'cancelled'
)
select 'B_payable_status_mismatch' as check_name, *
from judged
where status <> expected_status
order by payable_id;

-- C. Over-allocated payable: allocations exceed original_amount.            Risk: high · Human review
select p.id as payable_id, p.party_id, p.original_amount,
       sum(a.allocated_amount) as all_paid,
       sum(a.allocated_amount) filter (where pt.status = 'confirmed') as confirmed_paid
from public.ledger_payables p
join public.ledger_payable_allocations a on a.payable_id = p.id
left join public.ledger_transactions pt on pt.id = a.payment_transaction_id
group by p.id, p.party_id, p.original_amount
having sum(a.allocated_amount) > p.original_amount
order by p.id;

-- D1. payment_allocation_mismatch (operational): confirmed payable_payment with no allocation,
--     or whose allocations do not sum to the payment amount (the RPC requires an exact match).
--     Legacy sheet carryover payments are excluded here and listed in D2.
--     Risk: high · Human review
select 'D1_payment_allocation_mismatch' as check_name,
       t.id as payment_transaction_id, t.party_id, t.business_date, t.amount,
       coalesce(sum(a.allocated_amount), 0) as allocated_total, t.source_type, t.source_key
from public.ledger_transactions t
left join public.ledger_payable_allocations a on a.payment_transaction_id = t.id
where t.type = 'payable_payment' and t.status = 'confirmed'
  and coalesce(t.source_key, '') not like 'legacy-sheet-payment:%'
group by t.id
having coalesce(sum(a.allocated_amount), 0) <> t.amount
order by t.business_date;

-- D2. legacy_sheet_payment_carryover (expected, informational): August back-calculated
--     'legacy-sheet-payment:%' payments whose amount includes payables from before the app
--     ledger started, so amount <> allocation sum by design. Do NOT modify these rows or create
--     allocations for the difference. Only re-check if a new row appears here.
--     Risk: none (expected legacy) · No action
select 'D2_legacy_sheet_payment_carryover' as check_name,
       t.id as payment_transaction_id, t.party_id, lp.name as party_name, t.business_date, t.amount,
       coalesce(sum(a.allocated_amount), 0) as allocated_total,
       t.amount - coalesce(sum(a.allocated_amount), 0) as pre_app_carryover, t.source_key
from public.ledger_transactions t
left join public.ledger_parties lp on lp.id = t.party_id
left join public.ledger_payable_allocations a on a.payment_transaction_id = t.id
where t.type = 'payable_payment' and t.status = 'confirmed'
  and t.source_key like 'legacy-sheet-payment:%'
group by t.id, lp.name
having coalesce(sum(a.allocated_amount), 0) <> t.amount
order by t.business_date;

-- E. Orphan / abnormal allocation links: allocation whose payment is not a payable_payment,
--    whose payment party differs from the payable party, or whose payable is cancelled.
--    Risk: high · Human review
select a.id as allocation_id, a.payable_id, a.payment_transaction_id, a.allocated_amount,
       p.status as payable_status, p.party_id as payable_party, pt.party_id as payment_party,
       pt.type as payment_type, pt.status as payment_status
from public.ledger_payable_allocations a
join public.ledger_payables p on p.id = a.payable_id
join public.ledger_transactions pt on pt.id = a.payment_transaction_id
where pt.type <> 'payable_payment'
   or pt.party_id is distinct from p.party_id
   or p.status = 'cancelled'
order by a.id;

-- F. Historical payable bridge / sheet balance adjustments from the pre-app import.
--    Identified by source_key prefix (lib/ledger/cash-outflow.ts OPERATING_BALANCE_ADJUSTMENT_PREFIXES);
--    created outside the repo's migrations. Counted as actual cash outflow when they reduce funds.
--    Risk: low (expected legacy) · Human review only if amounts look wrong
select t.id, t.type, t.status, t.business_date, t.amount, t.party_id, t.source_type, t.source_key, t.memo
from public.ledger_transactions t
where t.source_key like 'historical-payable-bridge:%'
   or t.source_key like 'sheet-balance-adjustment:%'
   or t.source_key like 'legacy_sheet_expense_reconciliation:%'
order by t.business_date, t.id;

-- G. Same inventory source booked more than once (confirmed candidates → confirmed expenses
--    with payables), e.g. one verification-pending payable and one ordinary payable.
--    Risk: high (double expense / double payable) · Human review
select c.source_key,
       count(distinct e.id) as confirmed_expense_count,
       count(distinct p.id) as payable_count,
       bool_or(e.source_snapshot->>'paymentVerification' = 'pending') as has_verification,
       bool_or(coalesce(e.source_snapshot->>'paymentVerification', '') <> 'pending') as has_ordinary,
       array_agg(distinct c.id) as candidate_ids, array_agg(distinct e.id) as expense_ids
from public.ledger_candidates c
join public.ledger_transactions e on e.id = c.resolved_transaction_id and e.status = 'confirmed'
left join public.ledger_payables p on p.expense_transaction_id = e.id and p.status <> 'cancelled'
where c.source_type = 'inventory_purchase_log' and c.status = 'confirmed'
group by c.source_key
having count(distinct e.id) > 1
order by c.source_key;

-- H. verification_unresolved (OPERATIONAL — the rows the 결제 미확인 UI shows).
--    Marker present AND original_amount - confirmed allocation > 0. A marker alone is NOT unpaid.
--    The app stores no separate inventory payment flag; the only payment evidence is ledger
--    allocations. Review aid: partners whose payment_mode is 'immediate' (pay-on-delivery) — since
--    20260921170100 these auto-book as verification_pending instead of an immediate cash expense —
--    are listed first, with age.
--    Risk: medium · Human review (needs receipts); never auto-pay
with confirmed_alloc as (
  select a.payable_id, sum(a.allocated_amount) as confirmed_paid
  from public.ledger_payable_allocations a
  join public.ledger_transactions pt on pt.id = a.payment_transaction_id and pt.status = 'confirmed'
  group by a.payable_id
), unresolved as (
  select p.id as payable_id, p.party_id, lp.name as party_name, bp.payment_mode, e.business_date,
         p.original_amount, coalesce(ca.confirmed_paid, 0) as confirmed_paid,
         p.original_amount - coalesce(ca.confirmed_paid, 0) as remaining,
         current_date - e.business_date as age_days
  from public.ledger_payables p
  join public.ledger_transactions e on e.id = p.expense_transaction_id and e.status = 'confirmed'
  join public.ledger_parties lp on lp.id = p.party_id
  left join public.business_partner_ledger_parties bpl on bpl.ledger_party_id = p.party_id
  left join public.business_partners bp on bp.id = bpl.business_partner_id
  left join confirmed_alloc ca on ca.payable_id = p.id
  where e.source_snapshot->>'paymentVerification' = 'pending'
    and p.status <> 'cancelled'
    and p.original_amount - coalesce(ca.confirmed_paid, 0) > 0
)
select 'H_verification_unresolved' as check_name, *
from unresolved
order by payment_mode nulls last, business_date;

-- H2. verification_unresolved by party — matches the per-party counts/amounts to check in
--     장부작성 > 미납금 현황 > 결제 미확인 (count = rows, amount = Σ remaining).
with confirmed_alloc as (
  select a.payable_id, sum(a.allocated_amount) as confirmed_paid
  from public.ledger_payable_allocations a
  join public.ledger_transactions pt on pt.id = a.payment_transaction_id and pt.status = 'confirmed'
  group by a.payable_id
)
select 'H2_verification_unresolved_by_party' as check_name,
       lp.name as party_name, count(*) as unresolved_count,
       sum(p.original_amount - coalesce(ca.confirmed_paid, 0)) as unresolved_amount
from public.ledger_payables p
join public.ledger_transactions e on e.id = p.expense_transaction_id and e.status = 'confirmed'
join public.ledger_parties lp on lp.id = p.party_id
left join confirmed_alloc ca on ca.payable_id = p.id
where e.source_snapshot->>'paymentVerification' = 'pending'
  and p.status <> 'cancelled'
  and p.original_amount - coalesce(ca.confirmed_paid, 0) > 0
group by lp.name
order by unresolved_amount desc, lp.name;

-- I. verification_marker_paid (REFERENCE ONLY — not operational unpaid).
--    Marker still present because it is never cleared, but confirmed allocation >= original_amount.
--    The API still returns these (appPaymentStatus 'confirmed'); the entries UI lists only
--    remaining > 0. No fix needed unless status also drifted (B).     Risk: low · Informational
select 'I_verification_marker_paid' as check_name,
       p.id as payable_id, p.party_id, e.business_date, p.original_amount, p.status
from public.ledger_payables p
join public.ledger_transactions e on e.id = p.expense_transaction_id and e.status = 'confirmed'
where e.source_snapshot->>'paymentVerification' = 'pending' and p.status <> 'cancelled'
  and p.original_amount <= coalesce((
    select sum(a.allocated_amount) from public.ledger_payable_allocations a
    join public.ledger_transactions pt on pt.id = a.payment_transaction_id and pt.status = 'confirmed'
    where a.payable_id = p.id), 0)
order by e.business_date;

-- J. Payable whose expense transaction is no longer confirmed (corrected / cancelled / rebooked)
--    but the payable itself is still open.                                Risk: medium · Human review
select p.id as payable_id, p.party_id, p.status, p.original_amount, e.id as expense_id, e.status as expense_status,
       e.source_type, e.source_key
from public.ledger_payables p
join public.ledger_transactions e on e.id = p.expense_transaction_id
where p.status <> 'cancelled' and e.status <> 'confirmed'
order by p.id;

-- K. Allocations whose payment transaction is not confirmed. The pay RPC and party detail API
--    still count them as paid; the list API and close preflight do not → the two views disagree.
--    Risk: medium · Human review
select a.id as allocation_id, a.payable_id, a.allocated_amount, pt.id as payment_id, pt.status as payment_status, pt.business_date
from public.ledger_payable_allocations a
join public.ledger_transactions pt on pt.id = a.payment_transaction_id
where pt.status <> 'confirmed'
order by pt.business_date;

-- L. Legacy /payables page payments (allocations = null → RPC oldest_first) that consumed
--    verification-pending payables. The old UI previewed only ordinary payables, so these
--    may have silently "verified" an unconfirmed receipt.               Risk: medium · Human review
select pt.id as payment_transaction_id, pt.party_id, pt.business_date, pt.amount,
       a.payable_id, a.allocated_amount, e.business_date as expense_date
from public.ledger_transactions pt
join public.ledger_payable_allocations a on a.payment_transaction_id = pt.id
join public.ledger_payables p on p.id = a.payable_id
join public.ledger_transactions e on e.id = p.expense_transaction_id
where pt.type = 'payable_payment' and pt.status = 'confirmed'
  and pt.source_snapshot->>'allocationMode' = 'oldest_first'
  and e.source_snapshot->>'paymentVerification' = 'pending'
order by pt.business_date, pt.id;

-- M. payable_payment whose fund movements do not equal -amount (missing or split wrongly).
--    Risk: high · Human review
select t.id, t.business_date, t.amount, coalesce(sum(m.amount), 0) as movement_total, count(m.*) as movement_count
from public.ledger_transactions t
left join public.ledger_movements m on m.transaction_id = t.id
where t.type = 'payable_payment' and t.status = 'confirmed'
group by t.id
having coalesce(sum(m.amount), 0) <> -t.amount
order by t.business_date;

rollback;
