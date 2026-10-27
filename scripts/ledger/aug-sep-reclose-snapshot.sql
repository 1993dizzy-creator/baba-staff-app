-- READ ONLY. Export every result before the approved operation and again after.
-- Keep the exported rows privately; do not paste credentials into this file.
begin isolation level repeatable read read only;

select month,status,revision,snapshot_hash,closed_at,reopened_at,summary_snapshot
from public.ledger_month_closures order by month;
select * from public.ledger_month_closure_history order by month,revision;

-- Balances are computed using confirmed movements, both current and as-of.
with boundaries(label,cutoff) as (values
  ('august','2026-09-01'::date),('september','2026-10-01'::date),('current',null::date)
)
select b.label,f.id,f.code,count(m.id) movement_count,coalesce(sum(m.amount),0) balance
from boundaries b cross join public.ledger_fund_accounts f
left join (public.ledger_movements m join public.ledger_transactions t
  on t.id=m.transaction_id and t.status='confirmed')
  on m.fund_account_id=f.id and (b.cutoff is null or t.business_date<b.cutoff)
group by b.label,f.id,f.code order by b.label,f.id;

-- Full protected relation checksums include row counts, not just net balances.
-- Movement created_at remains unchanged, so the whole-row hash must match.
select 'movements' relation,count(*) rows,md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'[]')) hash from public.ledger_movements t
union all select 'payables',count(*),md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'[]')) from public.ledger_payables t
union all select 'payable_allocations',count(*),md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'[]')) from public.ledger_payable_allocations t
union all select 'reserve_plans',count(*),md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'[]')) from public.ledger_reserve_plans t
union all select 'reserve_entries',count(*),md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'[]')) from public.ledger_reserve_entries t
union all select 'card_reconciliations',count(*),md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'[]')) from public.ledger_card_reconciliations t
union all select 'card_lines',count(*),md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'[]')) from public.ledger_card_reconciliation_lines t
union all select 'card_fee_closures',count(*),md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'[]')) from public.ledger_card_fee_closures t
union all select 'card_fee_lines',count(*),md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'[]')) from public.ledger_card_fee_allocation_lines t;

select id,to_jsonb(t) snapshot from public.ledger_transactions t
where id in(1055,1304,2191,2192,2384,2752) order by id;
select * from public.payroll_payment_batches where id=3;
select id,type,status,business_date,recognition_month,amount,economic_effect_sign,source_type,source_key
from public.ledger_transactions where recognition_month in(date '2026-08-01',date '2026-09-01') order by id;
select * from public.ledger_recurring_expense_plans order by id;
select id,source_type,source_key,correction_of_id,recognition_month,amount,economic_effect_sign
from public.ledger_transactions where source_key in(
 'legacy_sheet_expense_detail_offset:2026-08:rent',
 'payroll_insurance_duplicate_offset:2026-09:2191',
 'payroll_insurance_duplicate_offset:2026-09:2192') or source_type='recurring_expense' order by id;
select * from public.ledger_audit_logs where action in('correction_created','recurring_expense_created','recurring_plan_created','month_reopen','month_reclose') order by id;
select version,name from supabase_migrations.schema_migrations
where version='20261027112354';
commit;
