-- MANUAL ROLLBACK for 20261022120000_pos_pending_payment_close_hold.sql.
-- Run only with explicit approval (as a follow-up migration if history must record it).
-- * Removes exactly the block the migration inserted into sales_close_business_day_v1
--   (the original blank line before validate_source follows the block and is kept),
--   restoring the previous body byte-for-byte (LF or CRLF, verified in
--   tests/pos-pending-payment-close-db.test.mjs). CREATE OR REPLACE keeps OID, owner, ACL,
--   SECURITY DEFINER and SET options; verified before COMMIT.
-- * Drops admin_resolve_pending_sales_receipt_v1 (RESTRICT).
-- * No receipt/line/payment/modification/close/check/Ledger row is changed. Resolutions
--   already made stay as audited receipt history; recorded 03:05 hold checks stay as-is.
-- * After rollback the app's status-change button fails safely (function missing) and
--   closes are no longer held by pending receipts: roll the app back too.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create temporary table pos_pending_hold_rollback_meta on commit drop as
select p.oid, p.proowner, p.proacl::text as acl, p.prosecdef, p.proconfig::text as config, p.provolatile, p.prorettype
from pg_proc p
where p.oid = 'public.sales_close_business_day_v1(date,text,jsonb,jsonb,bigint,text,boolean,bigint)'::regprocedure;

do $rollback$
declare
  v_definition text;
  v_eol text;
  v_block text := E'  -- Pending POS payments hold every close path (manual, after-sync, 03:05 final).\n'
    || E'  if exists (select 1 from public.pos_sales_receipts where business_date = p_business_date\n'
    || E'      and source = ''cukcuk'' and payment_status = 1 and is_canceled is not true) then\n'
    || E'    return jsonb_build_object(''status'', ''pending_payment'', ''pendingCount'', (select count(*) from public.pos_sales_receipts\n'
    || E'      where business_date = p_business_date and source = ''cukcuk'' and payment_status = 1 and is_canceled is not true));\n'
    || E'  end if;\n';
begin
  if to_regprocedure('public.admin_resolve_pending_sales_receipt_v1(bigint,bigint,uuid,text,text,text,numeric,text)') is null then
    raise exception 'POS_PENDING_HOLD_ROLLBACK_NOT_APPLIED: resolution function missing';
  end if;
  v_definition := pg_get_functiondef(
    'public.sales_close_business_day_v1(date,text,jsonb,jsonb,bigint,text,boolean,bigint)'::regprocedure);
  v_eol := case when position(chr(13) || chr(10) in v_definition) > 0 then chr(13) || chr(10) else chr(10) end;
  v_block := replace(v_block, chr(10), v_eol);
  if (length(v_definition) - length(replace(v_definition, v_block, ''))) <> length(v_block) then
    raise exception 'POS_PENDING_HOLD_ROLLBACK_MISMATCH: close hold block';
  end if;
  v_definition := replace(v_definition, v_block, '');
  if position('pending_payment' in v_definition) > 0 then
    raise exception 'POS_PENDING_HOLD_ROLLBACK_RESIDUE';
  end if;
  execute v_definition;
end $rollback$;

drop function public.admin_resolve_pending_sales_receipt_v1(bigint,bigint,uuid,text,text,text,numeric,text) restrict;

do $verify$
begin
  if exists (select 1 from pos_pending_hold_rollback_meta m left join pg_proc p on p.oid = m.oid
      where p.oid is null or p.proowner <> m.proowner or p.proacl::text is distinct from m.acl
        or p.prosecdef <> m.prosecdef or p.proconfig::text is distinct from m.config
        or p.provolatile <> m.provolatile or p.prorettype <> m.prorettype)
    or position('pending_payment' in pg_get_functiondef(
      'public.sales_close_business_day_v1(date,text,jsonb,jsonb,bigint,text,boolean,bigint)'::regprocedure)) > 0
    or to_regprocedure('public.admin_resolve_pending_sales_receipt_v1(bigint,bigint,uuid,text,text,text,numeric,text)') is not null then
    raise exception 'POS_PENDING_HOLD_ROLLBACK_VERIFY_FAILED';
  end if;
end $verify$;

commit;
