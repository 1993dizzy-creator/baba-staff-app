-- Remove only the retired automatic POS recheck queue. No receipt/history DML.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $remove_pending_recheck$
declare
 v_oid regprocedure := to_regprocedure('public.sales_correct_admin_resolution_v2(bigint,bigint,jsonb)');
 v_definition text;
 v_anchor constant text := ' update pos_resolution_private.recheck_jobs set next_attempt_at=least(next_attempt_at,clock_timestamp()) where receipt_id=p_receipt_id;';
begin
 if v_oid is null then raise exception 'POS_RECHECK_REMOVAL_CORRECTION_REQUIRED'; end if;
 -- Stop rather than discard queued/leased work if the operating precondition changed.
 if to_regclass('pos_resolution_private.recheck_jobs') is not null then
  lock table pos_resolution_private.recheck_jobs in access exclusive mode;
  if exists(select 1 from pos_resolution_private.recheck_jobs) then
   raise exception 'POS_RECHECK_REMOVAL_QUEUE_NOT_EMPTY';
  end if;
 end if;
 v_definition := replace(replace(pg_get_functiondef(v_oid),E'\r\n',E'\n'),E'\r',E'\n');
 if position('pos_resolution_private.recheck_jobs' in v_definition)>0 then
  if length(v_definition)-length(replace(v_definition,v_anchor,''))<>length(v_anchor) then
   raise exception 'POS_RECHECK_REMOVAL_CORRECTION_CONTRACT_MISMATCH';
  end if;
  v_definition := replace(v_definition,v_anchor,'');
  if position('pos_resolution_private.recheck_jobs' in v_definition)>0 then
   raise exception 'POS_RECHECK_REMOVAL_UNEXPECTED_QUEUE_REFERENCE';
  end if;
  -- CREATE OR REPLACE preserves function identity, owner and existing EXECUTE ACL.
  execute v_definition;
 end if;
end $remove_pending_recheck$;

drop function if exists public.sales_claim_pending_rechecks_v1() restrict;
drop function if exists public.sales_finish_pending_recheck_v1(bigint,uuid,text) restrict;

-- PL/pgSQL body references are not fully represented in pg_depend. Fail closed
-- if a further application function still references the retired queue.
do $remaining_dependencies$
declare v_dependency text;
begin
 select p.oid::regprocedure::text into v_dependency
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in('public','pos_resolution_private') and p.prokind='f'
 and position('pos_resolution_private.recheck_jobs' in p.prosrc)>0 limit 1;
 if v_dependency is not null then
  raise exception 'POS_RECHECK_REMOVAL_DEPENDENCY_REMAINS: %',v_dependency;
 end if;
end $remaining_dependencies$;

drop table if exists pos_resolution_private.recheck_jobs restrict;
commit;
