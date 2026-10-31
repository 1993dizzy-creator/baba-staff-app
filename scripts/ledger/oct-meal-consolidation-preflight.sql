-- READ ONLY. Save results for review; no history repair or data writes.
-- First also run evidence/20261031/preflight_manual_meal_20_READONLY.sql and
-- evidence/20261031/preflight_108_recheck_READONLY.sql (must remain 108/108).
-- Reconcile against the supplied CSV snapshots; never treat them as live approval.
begin transaction isolation level repeatable read read only;
select version, name from supabase_migrations.schema_migrations
where version = '20261031070537';
select p.oid::regprocedure signature, pg_get_functiondef(p.oid) definition, p.proacl
from pg_proc p where p.oid in (
  'public.ledger_adjust_open_meal_transaction_v1(bigint,numeric,text,bigint)'::regprocedure,
  'public.ledger_create_manual_transaction_v1(text,timestamptz,date,numeric,bigint,bigint,bigint,bigint,text,text,bigint,text)'::regprocedure,
  'public.ledger_cancel_manual_transaction_v1(bigint,timestamptz,text,bigint)'::regprocedure);

-- Proposed manifest. Each manual transaction must have exactly one automatic meal.
-- Review IDs, memo, movements and dates before copying manifest into apply.sql.
with proposed as (
  select m.id manual_id, a.id automatic_id, m.business_date, m.amount, m.memo,
    md5(to_jsonb(m)::text) manual_hash, md5(to_jsonb(a)::text) automatic_hash,
    md5(to_jsonb(c)::text) candidate_hash,
    (select md5(coalesce(jsonb_agg(to_jsonb(mv) order by mv.id), '[]')::text)
      from public.ledger_movements mv where mv.transaction_id = m.id) movement_hash,
    public.ledger_manual_transaction_blocker_v1(m) blocker
  from public.ledger_transactions m
  join public.ledger_categories cat on cat.id = m.category_id and cat.name = '직원 식대'
  left join public.ledger_transactions a on a.business_date = m.business_date
    and a.source_type = 'attendance_meal_daily_candidate' and a.status = 'confirmed' and a.correction_of_id is null
  left join public.ledger_candidates c on a.source_key = 'candidate:' || c.id::text
  where m.id in (2419,2420,2421,2422,2825,2826,2827,2828,2829,3338,3339,3340,3341,3342,3343,3344,3345,3346,3347,3348) and m.source_type = 'manual' and m.status = 'confirmed' and m.type = 'expense'
    and m.business_date >= '2026-10-01' and m.business_date < '2026-11-01'
    and m.id <> 2163 and m.correction_of_id is null
)
select count(*) proposed_count, sum(amount) proposed_amount,
  jsonb_agg(to_jsonb(proposed) order by manual_id) manifest from proposed;

-- Export all four accounts, INCLUDING zero days: 27 x 4 = 108.
-- Compare these amounts against the independently verified sheet/account evidence.
select d::date business_date, f.code account_code, coalesce(sum(m.amount),0) amount
from generate_series('2026-10-01'::date,'2026-10-27'::date,interval '1 day') d
cross join public.ledger_fund_accounts f
left join public.ledger_transactions t on t.business_date = d::date and t.status = 'confirmed'
left join public.ledger_movements m on m.transaction_id = t.id and m.fund_account_id = f.id
where f.is_business_fund and f.active_from <= '2026-10-01' and (f.active_to is null or f.active_to >= '2026-10-27')
group by d,f.code order by d,f.code;

select * from public.ledger_transactions where id in (2112,2163);
select * from public.ledger_month_closures where month < '2026-11-01' order by month;
select c.* from public.ledger_candidates c where c.candidate_type = 'employee_meal'
and c.resolved_transaction_id in (select id from public.ledger_transactions where business_date >= '2026-10-01' and business_date < '2026-11-01');
-- Investigate Oct 28-30 independently. No 90,000 shortfall is added by these scripts.
select t.business_date,t.id,t.source_type,t.correction_of_id,t.amount,t.economic_effect_sign,m.fund_account_id,m.amount movement
from public.ledger_transactions t left join public.ledger_movements m on m.transaction_id=t.id
join public.ledger_categories c on c.id=t.category_id and c.name='직원 식대'
where t.business_date between '2026-10-28' and '2026-10-30' order by t.business_date,t.id;
commit;
