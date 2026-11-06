-- READ-ONLY. Run before and after july-opening-4funds-20261106-ONE-OFF.sql and
-- keep both outputs. Every statement is a SELECT; nothing is written.
-- Expected before: q1 4 business accounts active; q2 no rows; q3 #3~#6 total
-- 300,353,642; q4 Aug/Sep revision 5, Oct revision 1, July absent; q5/q6 baseline.
-- Expected after: q2 exactly the 4 seeds (total 600,859,817, 1 movement and 1
-- audit each); q3~q6 identical to the before output.

-- q1. Fund accounts (card_clearing id 4 is never seeded).
SELECT id, code, type, is_active, is_business_fund, active_from, active_to
  FROM public.ledger_fund_accounts ORDER BY id;

-- q2. July 1 openings / seed keys and their movements and audits.
SELECT t.id, t.type, t.status, t.business_date, t.occurred_at, t.amount, t.source_type, t.source_key,
       t.source_fingerprint, t.created_by, t.confirmed_by,
       (SELECT jsonb_agg(jsonb_build_object('fund',m.fund_account_id,'amount',m.amount)) FROM public.ledger_movements m WHERE m.transaction_id=t.id) AS movements,
       (SELECT count(*) FROM public.ledger_audit_logs a WHERE a.entity_type='transaction' AND a.entity_id=t.id) AS audits
  FROM public.ledger_transactions t
 WHERE (t.type='opening' AND t.business_date='2026-07-01') OR t.source_key LIKE '2026-07-01:%'
 ORDER BY t.id;

-- q3. Protected: August openings #3~#6, POS card #1190, Carlsberg carry-forward #3804.
SELECT t.id, t.type, t.status, t.business_date, t.amount, t.source_key, t.updated_at,
       (SELECT jsonb_agg(jsonb_build_object('id',m.id,'fund',m.fund_account_id,'amount',m.amount) ORDER BY m.id) FROM public.ledger_movements m WHERE m.transaction_id=t.id) AS movements,
       md5(to_jsonb(t)::text) AS row_md5
  FROM public.ledger_transactions t WHERE t.id IN (3,4,5,6,1190,3804) ORDER BY t.id;

-- q4. Month closures (status / revision / hash).
SELECT month, status, revision, snapshot_hash, md5(summary_snapshot::text) AS summary_md5
  FROM public.ledger_month_closures ORDER BY month;

-- q5. Movements from 2026-08-01 per account (the 8~11월 balances read only these
-- for the four business accounts) and card_clearing totals.
SELECT m.fund_account_id, count(*) AS movements, sum(m.amount) AS total
  FROM public.ledger_movements m JOIN public.ledger_transactions t ON t.id=m.transaction_id
 WHERE t.status='confirmed' AND t.business_date>='2026-08-01'
 GROUP BY m.fund_account_id ORDER BY m.fund_account_id;
SELECT count(*) AS card_clearing_movements, coalesce(sum(amount),0) AS card_clearing_total
  FROM public.ledger_movements WHERE fund_account_id=4;

-- q6. Live balance of the four business accounts (confirmed, occurred_at <= now,
-- business_date >= 2026-08-01): must be identical before and after.
SELECT m.fund_account_id, sum(m.amount) AS live_balance
  FROM public.ledger_movements m JOIN public.ledger_transactions t ON t.id=m.transaction_id
 WHERE t.status='confirmed' AND t.occurred_at<=now() AND t.business_date>='2026-08-01'
   AND m.fund_account_id IN (1,2,3,5)
 GROUP BY m.fund_account_id ORDER BY m.fund_account_id;
