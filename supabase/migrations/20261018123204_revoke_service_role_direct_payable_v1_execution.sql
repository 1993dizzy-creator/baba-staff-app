-- Safely discontinue external service_role access to the legacy, non-idempotent
-- payable payment RPC. Keep V1 for internal V2 SECURITY DEFINER dispatch.
-- No historical ledger, payment, allocation or inventory data is modified.
DO $preflight$
DECLARE
  v_v1 oid := to_regprocedure('public.ledger_pay_payables_v1(bigint,bigint,timestamp with time zone,numeric,jsonb,text,bigint)');
  v_v2 oid := to_regprocedure('public.ledger_pay_payables_v2(uuid,bigint,bigint,timestamp with time zone,numeric,jsonb,text,bigint)');
BEGIN
  IF v_v1 IS NULL OR v_v2 IS NULL THEN
    RAISE EXCEPTION 'Required payable V1/V2 function missing; no privilege change';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations
                 WHERE version='20261018105936'
                   AND name='add_payable_payment_idempotency_v2') THEN
    RAISE EXCEPTION 'Payable V2 migration history missing; no privilege change';
  END IF;
  IF NOT EXISTS (
      SELECT 1 FROM pg_proc a JOIN pg_proc b ON b.oid=v_v2
      WHERE a.oid=v_v1
        AND a.proowner=b.proowner
        AND pg_get_userbyid(a.proowner)='postgres'
        AND a.prosecdef AND b.prosecdef
        AND md5(pg_get_functiondef(a.oid))='3f8bf6091685eb7b087ee448786d07f0'
        AND md5(pg_get_functiondef(b.oid))='b7c2bb0e6d7a3c5c2a6ea9c53ce67a92'
        AND has_function_privilege('service_role',b.oid,'EXECUTE')
        AND NOT has_function_privilege('authenticated',b.oid,'EXECUTE')
        AND NOT has_function_privilege('anon',b.oid,'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'Payable V1/V2 ownership, body, security or grants changed; no privilege change';
  END IF;
END;
$preflight$;

REVOKE EXECUTE ON FUNCTION public.ledger_pay_payables_v1(
  bigint,bigint,timestamp with time zone,numeric,jsonb,text,bigint
) FROM service_role;

DO $verify$
DECLARE
  v_v1 oid := 'public.ledger_pay_payables_v1(bigint,bigint,timestamp with time zone,numeric,jsonb,text,bigint)'::regprocedure;
  v_v2 oid := 'public.ledger_pay_payables_v2(uuid,bigint,bigint,timestamp with time zone,numeric,jsonb,text,bigint)'::regprocedure;
BEGIN
  IF has_function_privilege('service_role',v_v1,'EXECUTE')
     OR has_function_privilege('authenticated',v_v1,'EXECUTE')
     OR has_function_privilege('anon',v_v1,'EXECUTE')
     OR NOT has_function_privilege('service_role',v_v2,'EXECUTE') THEN
     RAISE EXCEPTION 'Unexpected RPC EXECUTE privileges after revoke';
  END IF;
END;
$verify$;