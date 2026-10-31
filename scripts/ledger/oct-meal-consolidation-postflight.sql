-- READ ONLY. Validates the 20 specific October meal reclassifications.
-- The APPLY transaction already required 108/108 account-days, unchanged daily
-- movements / P&L and unchanged original history before COMMIT. Preserve compact
-- before/after hashes of those checks in its completion audit; DO NOT compare
-- today's entire ledger or candidates with the old snapshots. Normal later POS,
-- cash and source-sync writes are unrelated to this consolidation.
begin transaction isolation level repeatable read read only;
with batch_events as (
  select id, created_at, after_snapshot s
  from public.ledger_audit_logs
  where action='meal_manual_consolidation_completed'
    and after_snapshot->>'batch'='oct-2026-meal-consolidation-20-630000-v1'
), batch as (
  select id,created_at,s from batch_events order by id desc limit 1
), manifest as (
  select
    (x->>'manual_id')::bigint manual_id,
    (x->>'automatic_id')::bigint automatic_id,
    (x->>'business_date')::date business_date,
    (x->>'amount')::numeric amount,
    x->>'manual_hash' manual_hash,
    x->>'movement_hash' movement_hash
  from batch b cross join lateral jsonb_array_elements(coalesce(b.s->'manifest','[]'::jsonb)) as item(x)
), pairs as (
  select e.manual_id,e.automatic_id,e.business_date,e.amount,
    -- Cancellation retains the original row and movements. The cancellation
    -- audit supplies the *pre-cancellation* full-row hash (status/timestamp changed).
    (m.id is not null and m.status='cancelled' and m.type='expense'
      and m.source_type='manual' and m.business_date=e.business_date
      and m.recognition_month='2026-10-01'::date and m.amount=e.amount
      and m.economic_effect_sign=1 and m.correction_of_id is null
      and movm.n=1 and movm.cash_amount=-e.amount
      and movm.history_hash=e.movement_hash
      and exists (
        select 1 from public.ledger_audit_logs hist
        where hist.action='manual_transaction_cancelled' and hist.entity_type='transaction'
          and hist.entity_id=e.manual_id
          and hist.reason='식대 통합 · 원수기 #'||e.manual_id::text||' → 자동식대 #'||e.automatic_id::text
          and md5((hist.before_snapshot->'transaction')::text)=e.manual_hash
          and hist.after_snapshot->'transaction'->>'status'='cancelled'
      )) manual_retained_and_audited,
    (a.id is not null and a.status='confirmed' and a.type='expense'
      and a.source_type='attendance_meal_daily_candidate'
      and a.correction_of_id is null and a.business_date=e.business_date
      and a.recognition_month='2026-10-01'::date and a.category_id=m.category_id
      and a.amount=(pin.pinned->>'automatic_amount')::numeric
      and candidate.status='confirmed' and candidate.candidate_type='employee_meal'
      and candidate.source_type='attendance_meal_daily'
      and candidate.resolved_transaction_id=a.id
      and pin.pinned is not null
      and (pin.pinned->>'amount')::numeric=e.amount
      and (pin.pinned->>'business_date')::date=e.business_date
      and (pin.pinned->>'source_key')=m.source_key) automatic_link_and_pinned_pair,
    (c.id is not null and c.status='confirmed' and c.type='expense'
      and c.source_type='ledger_correction'
      and c.source_key=(b.s->>'batch')||':'||e.manual_id::text
      and c.correction_of_id=e.automatic_id
      and c.business_date=e.business_date and c.recognition_month=m.recognition_month
      and c.category_id=m.category_id and c.amount=e.amount
      and c.economic_effect_sign=1 and c.operation_id=(b.s->>'operationId')::uuid
      and c.source_snapshot->>'batch'=b.s->>'batch'
      and c.source_snapshot->>'adjustmentType'='employee_meal'
      and c.source_snapshot->>'manualTransactionId'=e.manual_id::text
      and c.source_snapshot->>'originalTransactionId'=e.automatic_id::text
      and c.source_snapshot->>'attributionPolicy'='original_meal_business_date') correction_valid,
    (movm.n=1 and movc.n=1 and movm.fund_id=movc.fund_id
      and movm.cash_amount=movc.cash_amount and movc.cash_amount=-e.amount
      and exists(select 1 from public.ledger_fund_accounts f
        where f.id=movc.fund_id and f.code='store_cash')) cash_day_and_profit_delta_zero,
    exists(
      select 1 from public.ledger_audit_logs audit
      where audit.action='meal_manual_consolidated' and audit.entity_type='transaction'
        and audit.entity_id=c.id
        and audit.after_snapshot->>'batch'=b.s->>'batch'
        and audit.after_snapshot->>'manualTransactionId'=e.manual_id::text
        and audit.after_snapshot->>'originalTransactionId'=e.automatic_id::text
    ) correction_audited
  from manifest e
  cross join batch b
  left join public.ledger_transactions m on m.id=e.manual_id
  left join public.ledger_transactions a on a.id=e.automatic_id
  left join public.ledger_transactions c on c.source_type='ledger_correction'
    and c.source_key=(b.s->>'batch')||':'||e.manual_id::text
  left join public.ledger_candidates candidate on a.source_key='candidate:'||candidate.id::text
  left join lateral (
    select ep.value AS pinned from jsonb_array_elements(coalesce(b.s->'expectedPairs','[]'::jsonb)) as ep(value)
    where (ep.value->>'manual_id')::bigint=e.manual_id and (ep.value->>'automatic_id')::bigint=e.automatic_id
    limit 1
  ) pin on true
  left join lateral (
    select count(*) n,min(mv.fund_account_id) fund_id,sum(mv.amount) cash_amount,
      md5(coalesce(jsonb_agg(to_jsonb(mv) order by mv.id),'[]'::jsonb)::text) history_hash
    from public.ledger_movements mv where mv.transaction_id=m.id
  ) movm on true
  left join lateral (
    select count(*) n,min(mv.fund_account_id) fund_id,sum(mv.amount) cash_amount
    from public.ledger_movements mv where mv.transaction_id=c.id
  ) movc on true
), pair_counts as (
  select count(*) total,
    count(*) filter(where manual_retained_and_audited) cancellations_ok,
    count(*) filter(where automatic_link_and_pinned_pair) originals_ok,
    count(*) filter(where correction_valid) corrections_ok,
    count(*) filter(where cash_day_and_profit_delta_zero) movement_profit_ok,
    count(*) filter(where correction_audited) correction_audits_ok,
    coalesce(sum(amount),0) total_amount
  from pairs
), recorded_checks as (
  select b.s,
    (coalesce(nullif(s->'atApplyChecks'->>'dailyBeforeHash',''),'') <> ''
      and s->'atApplyChecks'->>'dailyBeforeHash'=s->'atApplyChecks'->>'dailyAfterHash') daily_at_apply,
    (coalesce(nullif(s->'atApplyChecks'->>'profitBeforeHash',''),'') <> ''
      and s->'atApplyChecks'->>'profitBeforeHash'=s->'atApplyChecks'->>'profitAfterHash') profit_at_apply,
    (coalesce(nullif(s->'atApplyChecks'->>'historyBeforeHash',''),'') <> ''
      and s->'atApplyChecks'->>'historyBeforeHash'=s->'atApplyChecks'->>'historyAfterHash') history_at_apply,
    (s->>'protectedTxHash' is not null and s->>'protectedTxHash'=
      md5(coalesce((select jsonb_agg(to_jsonb(t) order by id)::text
        from public.ledger_transactions t where id in(2112,2163)),'null'))) protected_transactions_still_intact,
    (s->'septemberClosureSnapshot' is not null and s->'septemberClosureSnapshot'=
      coalesce((select jsonb_agg(to_jsonb(cl) order by id)
        from public.ledger_month_closures cl where month='2026-09-01'::date),'[]'::jsonb)) september_close_still_intact,
    coalesce(jsonb_array_length(s->'verifiedDaily'),0) verified_days_at_apply,
    coalesce(jsonb_array_length(s->'expectedPairs'),0) expected_pairs_at_apply
  from batch b
), live_evidence as (
  -- DIAGNOSTIC ONLY: later legitimate transactions may change current balances.
  -- A current mismatch does NOT fail batch_integrity_pass. Reconcile separately.
  select count(*) current_account_days_matching_old_sheet
  from batch b cross join lateral jsonb_array_elements(coalesce(b.s->'verifiedDaily','[]'::jsonb)) v(x)
  where (x->>'amount')::numeric=(
    select coalesce(sum(m.amount),0)
    from public.ledger_transactions t
    join public.ledger_movements m on m.transaction_id=t.id
    join public.ledger_fund_accounts f on f.id=m.fund_account_id
    where t.status='confirmed' and t.business_date=(x->>'business_date')::date
      and f.code=x->>'account_code')
), verdict as (
  select (select count(*) from batch_events)=1 completed_once,
    coalesce((b.s->>'count')::integer=20,false) batch_declares_20,
    coalesce((b.s->>'amount')::numeric=630000,false) batch_declares_630000,
    coalesce(pc.total=20 and pc.total_amount=630000,false) manifest_exact_20_630000,
    coalesce(pc.cancellations_ok=20,false) cancelled_manual_count_ok,
    coalesce(pc.originals_ok=20,false) original_meals_ok,
    coalesce(pc.corrections_ok=20,false) correction_count_ok,
    coalesce(pc.movement_profit_ok=20,false) target_cash_and_profit_delta_zero,
    coalesce(pc.correction_audits_ok=20,false) correction_audits_ok,
    coalesce((select count(*) from public.ledger_transactions t
      where t.source_snapshot->>'batch'=b.s->>'batch')=20,false) no_extra_batch_transactions,
    coalesce(rc.daily_at_apply,false) all_daily_movements_unchanged_at_apply,
    coalesce(rc.profit_at_apply,false) monthly_profit_unchanged_at_apply,
    coalesce(rc.history_at_apply,false) source_and_other_history_unchanged_at_apply,
    coalesce(rc.protected_transactions_still_intact,false) tx2112_tx2163_still_intact,
    coalesce(rc.september_close_still_intact,false) september_close_still_intact,
    coalesce(rc.verified_days_at_apply=108,false) account_days_108_verified_at_apply,
    coalesce(rc.expected_pairs_at_apply=20,false) expected_pairs_20_at_apply,
    le.current_account_days_matching_old_sheet,
    pc.total AS manifest_count,pc.total_amount AS manifest_amount,
    pc.cancellations_ok,pc.originals_ok,pc.corrections_ok,
    pc.movement_profit_ok,pc.correction_audits_ok AS correction_audits_count
  from (select count(*) n from batch_events) meta
  left join batch b on true
  cross join pair_counts pc
  left join recorded_checks rc on true
  cross join live_evidence le
)
select *,
 (completed_once and batch_declares_20 and batch_declares_630000
  and manifest_exact_20_630000 and cancelled_manual_count_ok
  and original_meals_ok and correction_count_ok and target_cash_and_profit_delta_zero
  and correction_audits_ok and no_extra_batch_transactions
  and all_daily_movements_unchanged_at_apply and monthly_profit_unchanged_at_apply
  and source_and_other_history_unchanged_at_apply and tx2112_tx2163_still_intact
  and september_close_still_intact and account_days_108_verified_at_apply
  and expected_pairs_20_at_apply) AS batch_integrity_pass
from verdict;

-- One confirmed automatic row per October 1-30 day; the separate protected
-- September-source correction dated October 1 is NOT an October meal duplicate.
select t.business_date,
  count(*) filter(where t.source_type='attendance_meal_daily_candidate') AS automatic_count,
  count(*) filter(where t.source_type='manual') AS standalone_manual_count
from public.ledger_transactions t
join public.ledger_categories c on c.id=t.category_id and c.name='직원 식대'
where t.status='confirmed' and t.correction_of_id is null
  and t.business_date between '2026-10-01'::date and '2026-10-30'::date
  and t.source_type in('attendance_meal_daily_candidate','manual')
group by t.business_date order by t.business_date;

select t.id,t.business_date,t.correction_of_id,t.amount,t.memo,t.source_snapshot
from public.ledger_transactions t
where t.source_snapshot->>'batch'='oct-2026-meal-consolidation-20-630000-v1'
order by t.business_date,t.id;

select p.oid::regprocedure signature,p.proacl,p.prosecdef,
  has_function_privilege('anon',p.oid,'execute') anon_execute,
  has_function_privilege('authenticated',p.oid,'execute') authenticated_execute,
  has_function_privilege('service_role',p.oid,'execute') service_execute
from pg_proc p where p.oid in (
  'public.ledger_adjust_open_meal_transaction_v1(bigint,numeric,text,bigint)'::regprocedure,
  'public.ledger_create_manual_transaction_v1(text,timestamptz,date,numeric,bigint,bigint,bigint,bigint,text,text,bigint,text)'::regprocedure);
select version,name from supabase_migrations.schema_migrations where version='20261031070537';
commit;
