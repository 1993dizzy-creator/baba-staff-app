-- READ ONLY, after the separately approved manual batch. PASS requires every
-- boolean below true, 20 cancellations + 20 linked corrections, total 630000.
begin transaction isolation level repeatable read read only;
with batch as (
  select after_snapshot s from public.ledger_audit_logs where action='meal_manual_consolidation_completed'
  and after_snapshot->>'batch'='oct-2026-meal-consolidation-20-630000-v1'
), daily as (
  select t.business_date,m.fund_account_id,sum(m.amount) amount from public.ledger_transactions t
  join public.ledger_movements m on m.transaction_id=t.id where t.status='confirmed' group by 1,2
), profit as (
  select recognition_month,category_id,type,sum(amount*economic_effect_sign) amount from public.ledger_transactions
  where status='confirmed' group by 1,2,3
)
select (select count(*) from batch)=1 completed_once,
  s->'beforeDaily'=(select jsonb_agg(to_jsonb(d) order by business_date,fund_account_id) from daily d) all_daily_movements_unchanged,
  s->'beforeProfit'=(select jsonb_agg(to_jsonb(p) order by recognition_month,category_id,type) from profit p) monthly_profit_unchanged,
  s->'preserved'->'protectedTransactions'=(select jsonb_agg(to_jsonb(t) order by id) from public.ledger_transactions t where id in(2112,2163)) tx2112_tx2163_unchanged,
  s->'preserved'->'closures'=(select jsonb_agg(to_jsonb(c) order by id) from public.ledger_month_closures c) closures_unchanged,
  s->'preserved'->'candidates'=(select jsonb_agg(to_jsonb(c) order by id) from public.ledger_candidates c) source_drift_unchanged,
  (select count(*) from jsonb_array_elements(s->'verifiedDaily') x where (x->>'amount')::numeric =
    (select coalesce(sum(m.amount),0) from public.ledger_transactions t join public.ledger_movements m on m.transaction_id=t.id
     join public.ledger_fund_accounts f on f.id=m.fund_account_id where t.status='confirmed'
     and t.business_date=(x->>'business_date')::date and f.code=x->>'account_code')) matching_account_days,
  (select count(*) from jsonb_array_elements(s->'manifest') x join public.ledger_transactions t on t.id=(x->>'manual_id')::bigint where t.status='cancelled') cancelled_manual_count,
  (select count(*) from public.ledger_transactions t where t.source_snapshot->>'batch'=s->>'batch' and t.status='confirmed') correction_count,
  (select sum(amount*economic_effect_sign) from public.ledger_transactions t where t.source_snapshot->>'batch'=s->>'batch' and t.status='confirmed') correction_amount
from batch;

-- List display: one automatic meal per date after cancelling the manual rows.
select t.business_date,count(*) visible_meal_count from public.ledger_transactions t
join public.ledger_categories c on c.id=t.category_id and c.name='직원 식대'
where t.status='confirmed' and t.correction_of_id is null
and t.business_date between '2026-10-01' and '2026-10-31' group by 1 order by 1;
select t.id,t.business_date,t.correction_of_id,t.amount,t.memo,t.source_snapshot
from public.ledger_transactions t where t.source_snapshot->>'batch'='oct-2026-meal-consolidation-20-630000-v1' order by t.business_date,t.id;
select p.oid::regprocedure signature,p.proacl,p.prosecdef,
  has_function_privilege('anon',p.oid,'execute') anon_execute,
  has_function_privilege('authenticated',p.oid,'execute') authenticated_execute,
  has_function_privilege('service_role',p.oid,'execute') service_execute
from pg_proc p where p.oid in (
  'public.ledger_adjust_open_meal_transaction_v1(bigint,numeric,text,bigint)'::regprocedure,
  'public.ledger_create_manual_transaction_v1(text,timestamptz,date,numeric,bigint,bigint,bigint,bigint,text,text,bigint,text)'::regprocedure);
select version,name from supabase_migrations.schema_migrations where version='20261031070537';
commit;
