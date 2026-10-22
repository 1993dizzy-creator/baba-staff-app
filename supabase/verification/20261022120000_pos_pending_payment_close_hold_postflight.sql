-- READ-ONLY postflight for 20261022120000_pos_pending_payment_close_hold.sql.
-- SELECT only. Run AFTER applying. Section 0 can also be run BEFORE applying to
-- capture the close function identity for comparison.

-- 0) sales_close_business_day_v1 identity: OID/owner/ACL/options must be unchanged by the migration.
select p.oid, p.oid::regprocedure as signature, pg_get_userbyid(p.proowner) as owner, p.proacl, p.prosecdef, p.proconfig,
  (length(p.prosrc) - length(replace(p.prosrc, '''pending_payment''', ''))) / length('''pending_payment''') as pending_hold_occurrences
from pg_proc p
where p.oid = 'public.sales_close_business_day_v1(date,text,jsonb,jsonb,bigint,text,boolean,bigint)'::regprocedure;
-- expected after apply: pending_hold_occurrences = 1, prosecdef = true, owner/proacl same as before.

-- 1) New resolution function: SECURITY INVOKER, execute only for service_role (no PUBLIC/anon/authenticated).
select p.oid::regprocedure as signature, pg_get_userbyid(p.proowner) as owner, p.prosecdef, p.proconfig, p.proacl,
  has_function_privilege('anon', p.oid, 'execute') as anon_exec,
  has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec,
  has_function_privilege('service_role', p.oid, 'execute') as service_role_exec
from pg_proc p
where p.oid = 'public.admin_resolve_pending_sales_receipt_v1(bigint,bigint,uuid,text,text,text,numeric,text)'::regprocedure;
-- expected: prosecdef = false, anon_exec = false, authenticated_exec = false, service_role_exec = true.

-- 2) No new tables/columns/triggers from this migration; no data was changed by applying it.
select
  (select count(*) from public.pos_sales_receipt_modifications
    where after_state ? 'pendingResolution') as pending_resolution_rows,       -- expected 0 right after apply
  (select count(*) from public.pos_sales_receipts
    where payment_status = 1 and is_canceled is not true) as active_pending_receipts, -- compare with the pre-apply count
  (select count(*) from public.pos_sales_business_day_closures) as closures,       -- compare with the pre-apply count
  (select count(*) from public.pos_sales_business_day_close_checks
    where detail_snapshot->>'failureCode' = 'pending_payment') as pending_hold_checks; -- expected 0 until a 03:05 hold

-- 3) Current pending receipts by business day and whether that day already has a closure (read-only overview).
select r.business_date, count(*) as pending_count, sum(r.final_amount) as pending_amount,
  exists(select 1 from public.pos_sales_business_day_closures c where c.business_date = r.business_date) as day_closed
from public.pos_sales_receipts r
where r.payment_status = 1 and r.is_canceled is not true
group by r.business_date
order by r.business_date;
