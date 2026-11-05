-- Local-only migration; Production execution requires separate user approval.
-- Notion execution plan: https://app.notion.com/p/40f7ad2aac798127ae73c0e282de80da
-- Preserve the four existing 2026-08-01 opening_balance_seed movements.
-- Earlier cash reconstruction must not count a second time after the cutover.
-- Card clearing is intentionally untouched, including sale #1190 -> August settlement.
-- Patch existing sums only; no row DML, new function, table, grant, seed or close.
-- Preserve existing upper cutoffs, function signatures, ownership, ACLs and guards.
-- Abort atomically if any reviewed sum is absent or ambiguous. Do not replace
-- an unexpected live function with a stale repository definition.
BEGIN;
DO $fund_boundary$
DECLARE
  r record;
  v_oid regprocedure;
  v_definition text;
  v_patched text;
  v_original_body text;
  v_expected_body text;
  v_actual_body text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.ledger_owner_financial_capacity_v1(date)', $anchor$and f.type in ('cash', 'bank', 'personal_custody');$anchor$, $replacement$and f.type in ('cash', 'bank', 'personal_custody')
    and (f.code not in ('store_cash','baba_corporate_bank','cho_personal_custody','vuong_personal_custody') or ((((now() at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date >= date '2026-08-01' and t.business_date >= date '2026-08-01') or (((now() at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date < date '2026-08-01' and t.business_date < date '2026-08-01')));$replacement$),
    ('public.ledger_owner_recovery_capacity_v1()', $anchor$and f.type in ('cash', 'bank', 'personal_custody');$anchor$, $replacement$and f.type in ('cash', 'bank', 'personal_custody')
    and (f.code not in ('store_cash','baba_corporate_bank','cho_personal_custody','vuong_personal_custody') or ((((now() at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date >= date '2026-08-01' and t.business_date >= date '2026-08-01') or (((now() at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date < date '2026-08-01' and t.business_date < date '2026-08-01')));$replacement$),
    ('public.ledger_pay_owner_allocation_v1(bigint,numeric,bigint,timestamptz,text,bigint)', $anchor$and t.status = 'confirmed' and t.occurred_at <= now();$anchor$, $replacement$and t.status = 'confirmed' and t.occurred_at <= now()
    and not exists (select 1 from public.ledger_fund_accounts boundary_account where boundary_account.id=m.fund_account_id and not (boundary_account.code not in ('store_cash','baba_corporate_bank','cho_personal_custody','vuong_personal_custody') or ((((p_paid_at at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date >= date '2026-08-01' and t.business_date >= date '2026-08-01') or (((p_paid_at at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date < date '2026-08-01' and t.business_date < date '2026-08-01'))));$replacement$),
    ('public.ledger_owner_payment_fund_guard_v1()', $anchor$and t.status='confirmed'and t.occurred_at<=now();$anchor$, $replacement$and t.status='confirmed'and t.occurred_at<=now()
    and not exists (select 1 from public.ledger_fund_accounts boundary_account where boundary_account.id=m.fund_account_id and not (boundary_account.code not in ('store_cash','baba_corporate_bank','cho_personal_custody','vuong_personal_custody') or (((select business_date from public.ledger_transactions where id=new.transaction_id) >= date '2026-08-01' and t.business_date >= date '2026-08-01') or ((select business_date from public.ledger_transactions where id=new.transaction_id) < date '2026-08-01' and t.business_date < date '2026-08-01'))));$replacement$),
    ('public.ledger_create_reserve_entry_v1(bigint,text,numeric,timestamptz,text,bigint)', $anchor$and ledger_transaction.occurred_at <= now();$anchor$, $replacement$and ledger_transaction.occurred_at <= now()
    and not exists (select 1 from public.ledger_fund_accounts boundary_account where boundary_account.id=movement.fund_account_id and not (boundary_account.code not in ('store_cash','baba_corporate_bank','cho_personal_custody','vuong_personal_custody') or ((((p_occurred_at at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date >= date '2026-08-01' and ledger_transaction.business_date >= date '2026-08-01') or (((p_occurred_at at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date < date '2026-08-01' and ledger_transaction.business_date < date '2026-08-01'))));$replacement$),
    ('public.ledger_reserve_insert_entry_v2(bigint,text,text,numeric,bigint,text,uuid,bigint)', $anchor$and ledger_transaction.occurred_at <= now();$anchor$, $replacement$and ledger_transaction.occurred_at <= now()
    and not exists (select 1 from public.ledger_fund_accounts boundary_account where boundary_account.id=movement.fund_account_id and not (boundary_account.code not in ('store_cash','baba_corporate_bank','cho_personal_custody','vuong_personal_custody') or ((((now() at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date >= date '2026-08-01' and ledger_transaction.business_date >= date '2026-08-01') or (((now() at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date < date '2026-08-01' and ledger_transaction.business_date < date '2026-08-01'))));$replacement$),
    ('public.ledger_create_owner_investment_cash_event_v1(bigint,text,numeric,timestamptz,bigint,text,text,bigint)', $anchor$and t.occurred_at <= p_occurred_at;$anchor$, $replacement$and t.occurred_at <= p_occurred_at
    and not exists (select 1 from public.ledger_fund_accounts boundary_account where boundary_account.id=m.fund_account_id and not (boundary_account.code not in ('store_cash','baba_corporate_bank','cho_personal_custody','vuong_personal_custody') or ((v_date >= date '2026-08-01' and t.business_date >= date '2026-08-01') or (v_date < date '2026-08-01' and t.business_date < date '2026-08-01'))));$replacement$)
  ) AS patch(signature, anchor, replacement)
  LOOP
    v_oid := to_regprocedure(r.signature);
    IF v_oid IS NULL THEN RAISE EXCEPTION 'Missing boundary target: %', r.signature; END IF;
    v_definition := replace(pg_get_functiondef(v_oid), E'\r\n', E'\n');
    IF position(r.replacement in v_definition)>0 THEN
      RAISE EXCEPTION 'Boundary target already changed outside migration history: %', r.signature;
    END IF;
    IF (length(v_definition)-length(replace(v_definition,r.anchor,'')))<>length(r.anchor) THEN
      RAISE EXCEPTION 'Ambiguous/missing boundary sum: %', r.signature;
    END IF;
    SELECT replace(prosrc,E'\r\n',E'\n') INTO STRICT v_original_body
      FROM pg_proc WHERE oid=v_oid;
    v_expected_body := replace(v_original_body,r.anchor,r.replacement);
    v_patched := replace(v_definition,r.anchor,r.replacement);
    EXECUTE v_patched;
    SELECT replace(prosrc,E'\r\n',E'\n') INTO STRICT v_actual_body
      FROM pg_proc WHERE oid=v_oid;
    IF v_actual_body IS DISTINCT FROM v_expected_body THEN
      RAISE EXCEPTION 'Boundary post-definition mismatch: %', r.signature;
    END IF;
  END LOOP;
END;
$fund_boundary$;
COMMIT;
