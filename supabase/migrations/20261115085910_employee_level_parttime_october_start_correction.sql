-- One-time correction: level ON start month for 3 existing part-time employees. Production execution requires Owner approval.
-- Sơn(29) v33->v45, Thiết(28) v31->v46, Cô Thêm(24) v27->v47: the OFF version now ends and the reserved ON version
-- now starts on 2026-10-01 (was 2026-12-01). Only the policy START month changes; each ON version's base month
-- (2026-10-01 / 2026-09-01 / 2026-08-01), revision, salary_raise_enabled, ids and every other column are unchanged.
-- employee_update_profile_and_level_v11 (next-month reservation for every employee) is NOT changed.
-- Sơn v33 becomes the empty interval [2026-10-01,2026-10-01): kept (never deleted) as history. range_check (to>=from)
-- allows it, the gist no-overlap constraint ignores empty ranges, and every reader (app + RPC) uses
-- effective_from<=d and effective_to>d, so it is never selected for any date.
-- Self-contained: no file includes, psql variables, session actor settings or manual edits. Pinned
-- row/mirror/payment/extra-work fingerprints abort on drift. Execute the whole file on one connection, stop on
-- error, ROLLBACK before retry. Writes: 6 version interval endpoints, 3 user level mirrors, 3 appended audit rows.
-- No payroll, attendance, contract, payment, extra-work or ledger DML; no schema/privilege changes.
BEGIN;
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL timezone='UTC';
SET LOCAL row_security=off;
SELECT pg_advisory_xact_lock(hashtext('employee_level_parttime_start_correction_20261115_v1'));
LOCK TABLE public.users, public.employee_level_program_versions,
  public.employee_level_audit_logs IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.payroll_employee_payments, public.payroll_payment_batches,
  public.payroll_part_time_extra_work_decisions IN SHARE MODE;
CREATE TEMP TABLE _level_pt_targets(user_id bigint,old_id bigint,new_id bigint,base_date date,old_hash text,new_hash text,user_hash text) ON COMMIT DROP;
INSERT INTO _level_pt_targets VALUES
    (29,33,45,'2026-10-01'::date,'e6aae1277a434584b69799665c32e066','97873a9a5c6ca082e5e2f39d0461794c','b4d69d1d4e7aa5e1599fdfc0fb041684'),
    (28,31,46,'2026-09-01'::date,'300185a4f45d0128bd74b2ca9da5dbed','de7f7e00730c1158207b486bd7abbef2','55bcbf81e557055707f412efd408bc6b'),
    (24,27,47,'2026-08-01'::date,'d23f4a4e843a30c9970f271ae29c539b','0df9b8518fa1945a04b3ce4d35eb7840','c8d6e50ef0bb4c5ed5fb14e845795d34');
DO $correction$
DECLARE payment_count bigint; paid_count bigint; paid_hash text; payment_ids text; matched bigint; changed bigint;
  actor_id bigint; actor_name text; audit_hash text; others_hash text; before_row record; execution_context jsonb;
  ew_count bigint; ew_active bigint; ew_amount numeric; ew_hash text; ew_ok bigint;
BEGIN
  -- 1) Paid payments of the 3 employees (Aug/Sep, all rows) are pinned and must never change.
  select count(*),count(*) filter(where p.payment_status='paid'),md5(coalesce(string_agg(md5(to_jsonb(p)::text),',' order by p.id),'')),string_agg(p.id::text,',' order by p.id)
    into payment_count,paid_count,paid_hash,payment_ids
  from public.payroll_employee_payments p where p.user_id in (24,28,29);
  if payment_count <> 5 or paid_count <> 5 or payment_ids <> '14,18,47,51,54' or paid_hash <> '3d2dd50914fac4aec04ce3631c6e2ed0' then
    raise exception 'PAID_PAYMENT_BASELINE_MISMATCH: rows %, paid %, ids %, hash %',payment_count,paid_count,payment_ids,paid_hash;
  end if;
  -- 2) Stop if any app payment batch exists for October 2026 or later.
  if exists(select 1 from public.payroll_payment_batches b where b.payroll_month >= date '2026-10-01') then
    raise exception 'PAYMENT_BATCH_FROM_OCTOBER_EXISTS';
  end if;
  -- 3) Sơn's October extra work (29 active approvals, 1,398,834 VND) and all Oct+ decisions of the 3 are pinned.
  select count(*),count(*) filter(where d.cancelled_at is null and d.decision='approved'),
         coalesce(sum(d.candidate_amount) filter(where d.cancelled_at is null and d.decision='approved'),0)
    into ew_count,ew_active,ew_amount
  from public.payroll_part_time_extra_work_decisions d where d.user_id=29 and d.payroll_month=date '2026-10-01';
  if ew_count <> 29 or ew_active <> 29 or ew_amount <> 1398834 then
    raise exception 'SON_OCTOBER_EXTRA_WORK_BASELINE_MISMATCH: rows %, active %, amount %',ew_count,ew_active,ew_amount;
  end if;
  select md5(coalesce(string_agg(md5(to_jsonb(d)::text),',' order by d.id),'')) into ew_hash
  from public.payroll_part_time_extra_work_decisions d where d.user_id in (24,28,29) and d.payroll_month >= date '2026-10-01';
  if ew_hash <> '11e6f9ae3a63e4579b288f8ea626fcae' then
    raise exception 'EXTRA_WORK_DECISION_BASELINE_MISMATCH: %',ew_hash;
  end if;
  -- 4) Exact source versions and user mirrors. No other version for these users, except Sơn's untouched
  --    September version v32. Each base month equals the hire-month rule (day>15 -> next month).
  select count(*) into matched from _level_pt_targets t
  join public.employee_level_program_versions o on o.id=t.old_id and o.user_id=t.user_id
  join public.employee_level_program_versions n on n.id=t.new_id and n.user_id=t.user_id
  join public.users u on u.id=t.user_id
  where md5(to_jsonb(o)::text)=t.old_hash and md5(to_jsonb(n)::text)=t.new_hash
    and md5((jsonb_build_object('id',u.id,'hire_date',u.hire_date,'termination_date',u.termination_date,'is_active',u.is_active,'is_system_account',u.is_system_account,'level_program_enabled',u.level_program_enabled,'level_base_date_override',u.level_base_date_override,'level_base_mode',u.level_base_mode))::text)=t.user_hash
    and not o.enabled and o.effective_from <= date '2026-10-01' and o.effective_to=date '2026-12-01'
    and n.enabled and n.salary_raise_enabled and n.base_date_mode='hire_month' and n.base_date=t.base_date
    and n.effective_from=date '2026-12-01' and n.effective_to is null and n.revision=o.revision+1
    and n.base_date=(date_trunc('month',u.hire_date)+case when extract(day from u.hire_date)>15 then interval '1 month' else interval '0 month' end)::date
    and u.is_active and not u.is_system_account and u.termination_date is null
    and u.level_program_enabled is false and u.level_base_mode is null and u.level_base_date_override is null
    and not exists (select 1 from public.employee_level_program_versions x
      where x.user_id=t.user_id and x.id not in(t.old_id,t.new_id) and not (x.id=32 and x.user_id=29));
  if matched <> 3 then raise exception 'LEVEL_CORRECTION_SOURCE_DRIFT: matched %/3',matched; end if;
  if (select md5(to_jsonb(v)::text) from public.employee_level_program_versions v where v.id=32 and v.user_id=29)
     is distinct from '0a438621978b4b2d3d4bc6f7f90e1a4b' then
    raise exception 'LEVEL_CORRECTION_SOURCE_DRIFT: son_september_version';
  end if;
  if exists(select 1 from public.employee_level_audit_logs where change_reason='employee_level_parttime_start_correction_20261115_v1') then
    raise exception 'LEVEL_CORRECTION_ALREADY_APPLIED'; end if;
  -- The 11-employee October transition (20261110091705) must already be in place and is left untouched.
  if (select count(*) from public.employee_level_audit_logs where change_reason='employee_level_october_correction_20261110_v1')<>11 then
    raise exception 'OCTOBER_TRANSITION_BASELINE_MISSING'; end if;
  -- Actor: the unique creator of the 3 pinned reservations, an active non-system owner/master.
  select min(n.created_by) into actor_id
    from public.employee_level_program_versions n join _level_pt_targets t on t.new_id=n.id
    having count(*)=3 and count(n.created_by)=3 and count(distinct n.created_by)=1;
  if actor_id is null then raise exception 'CORRECTION_ACTOR_COHORT_MISMATCH'; end if;
  select username into actor_name from public.users
    where id=actor_id and role in('owner','master') and is_active and not is_system_account;
  if nullif(btrim(actor_name),'') is null then raise exception 'APPROVED_CORRECTION_ACTOR_REQUIRED'; end if;
  if exists(select 1 from public.employee_level_program_versions n join _level_pt_targets t on t.new_id=n.id
    where n.created_by is distinct from actor_id or n.created_by_username is distinct from actor_name) then
    raise exception 'CORRECTION_ACTOR_IDENTITY_MISMATCH';
  end if;
  execution_context := jsonb_build_object('migration','employee_level_parttime_october_start_correction',
    'actor_source','pinned_reservation_cohort_creator','database_user',current_user,'session_user',session_user);
  select md5(coalesce(jsonb_agg(to_jsonb(a) order by a.id)::text,'[]')) into audit_hash
    from public.employee_level_audit_logs a;
  -- Every other employee's level versions and user rows (incl. the 11 October-transition employees).
  select md5(coalesce(string_agg(md5(to_jsonb(v)::text),',' order by v.id),''))
      || md5(coalesce((select string_agg(md5(to_jsonb(u)::text),',' order by u.id) from public.users u where u.id not in (24,28,29)),''))
    into others_hash
    from public.employee_level_program_versions v where not exists (select 1 from _level_pt_targets t where t.old_id=v.id or t.new_id=v.id);
  CREATE TEMP TABLE _level_pt_before ON COMMIT DROP AS
    select t.user_id,to_jsonb(o) old_version,to_jsonb(n) new_version,
      jsonb_build_object('id',u.id,'hire_date',u.hire_date,'termination_date',u.termination_date,'is_active',u.is_active,'is_system_account',u.is_system_account,'level_program_enabled',u.level_program_enabled,'level_base_date_override',u.level_base_date_override,'level_base_mode',u.level_base_mode) user_mirror,
      md5((to_jsonb(u)-'level_program_enabled'-'level_base_date_override'-'level_base_mode')::text) other_user_hash
    from _level_pt_targets t join public.employee_level_program_versions o on o.id=t.old_id
    join public.employee_level_program_versions n on n.id=t.new_id join public.users u on u.id=t.user_id;
  -- Close the OFF version first (Sơn v33 -> empty interval), then start the ON version on 2026-10-01.
  update public.employee_level_program_versions v set effective_to=date '2026-10-01'
    from _level_pt_targets t where v.id=t.old_id;
  get diagnostics changed=row_count;
  if changed<>3 then raise exception 'OLD_VERSION_COUNT_MISMATCH'; end if;
  update public.employee_level_program_versions v set effective_from=date '2026-10-01'
    from _level_pt_targets t where v.id=t.new_id;
  get diagnostics changed=row_count;
  if changed<>3 then raise exception 'NEW_VERSION_COUNT_MISMATCH'; end if;
  -- Mirrors follow the version now in force (v10 rule): ON, hire_month, override NULL.
  update public.users u set level_program_enabled=true,level_base_mode='hire_month',level_base_date_override=null
    from _level_pt_targets t where u.id=t.user_id;
  get diagnostics changed=row_count;
  if changed<>3 then raise exception 'USER_MIRROR_COUNT_MISMATCH'; end if;
  for before_row in select b.*,t.old_id,t.new_id from _level_pt_before b
    join _level_pt_targets t using(user_id) order by b.user_id desc loop
    insert into public.employee_level_audit_logs(user_id,action,previous_enabled,next_enabled,
      previous_base_date_override,next_base_date_override,previous_base_date_mode,next_base_date_mode,
      previous_effective_base_date,next_effective_base_date,actor_id,actor_username,change_reason,
      previous_salary_raise_enabled,next_salary_raise_enabled,previous_version_snapshot,next_version_snapshot)
    select u.id,'level_program_enabled',false,true,
      (before_row.user_mirror->>'level_base_date_override')::date,u.level_base_date_override,
      before_row.old_version->>'base_date_mode',n.base_date_mode,
      (before_row.old_version->>'base_date')::date,n.base_date,actor_id,actor_name,'employee_level_parttime_start_correction_20261115_v1',
      (before_row.old_version->>'salary_raise_enabled')::boolean,n.salary_raise_enabled,
      jsonb_build_object('operation','employee_level_parttime_start_correction_20261115_v1','old_version',before_row.old_version,'new_version',before_row.new_version,'user_mirror',before_row.user_mirror,'execution_context',execution_context),
      jsonb_build_object('operation','employee_level_parttime_start_correction_20261115_v1','old_version',to_jsonb(o),'new_version',to_jsonb(n),'user_mirror',jsonb_build_object('id',u.id,'hire_date',u.hire_date,'termination_date',u.termination_date,'is_active',u.is_active,'is_system_account',u.is_system_account,'level_program_enabled',u.level_program_enabled,'level_base_date_override',u.level_base_date_override,'level_base_mode',u.level_base_mode),
        'note','policy start month corrected from 2026-12-01 to 2026-10-01; base month, revision and salary raise unchanged','execution_context',execution_context)
    from public.users u join public.employee_level_program_versions o on o.id=before_row.old_id
      join public.employee_level_program_versions n on n.id=before_row.new_id where u.id=before_row.user_id;
  end loop;
  if (select count(*) from public.employee_level_audit_logs where change_reason='employee_level_parttime_start_correction_20261115_v1')<>3 then
    raise exception 'CORRECTION_AUDIT_COUNT_MISMATCH'; end if;
  if (select md5(coalesce(jsonb_agg(to_jsonb(a) order by a.id)::text,'[]'))
      from public.employee_level_audit_logs a where change_reason<>'employee_level_parttime_start_correction_20261115_v1')<>audit_hash then
    raise exception 'EXISTING_AUDIT_CHANGED'; end if;
  if (select md5(coalesce(string_agg(md5(to_jsonb(v)::text),',' order by v.id),''))
      || md5(coalesce((select string_agg(md5(to_jsonb(u)::text),',' order by u.id) from public.users u where u.id not in (24,28,29)),''))
      from public.employee_level_program_versions v where not exists (select 1 from _level_pt_targets t where t.old_id=v.id or t.new_id=v.id))<>others_hash then
    raise exception 'OTHER_EMPLOYEE_LEVEL_CHANGED'; end if;
  if exists(select 1 from _level_pt_targets t join _level_pt_before b using(user_id)
      join public.employee_level_program_versions o on o.id=t.old_id
      join public.employee_level_program_versions n on n.id=t.new_id join public.users u on u.id=t.user_id
      where (to_jsonb(o)-'effective_to')<>(b.old_version-'effective_to')
        or (to_jsonb(n)-'effective_from')<>(b.new_version-'effective_from')
        or o.effective_to is distinct from date '2026-10-01' or n.effective_from is distinct from date '2026-10-01'
        or n.base_date is distinct from t.base_date
        or u.level_base_mode is distinct from 'hire_month' or u.level_program_enabled is distinct from true
        or u.level_base_date_override is not null
        or md5((to_jsonb(u)-'level_program_enabled'-'level_base_date_override'-'level_base_mode')::text)<>b.other_user_hash) then
    raise exception 'POSTFLIGHT_LEVEL_OR_NON_LEVEL_DRIFT'; end if;
END $correction$;
-- Postflight is part of the SAME transaction: no validation failure can commit.
DO $postflight$
DECLARE payment_count bigint; paid_count bigint; paid_hash text; matched bigint; bad text; ew_count bigint; ew_ok bigint;
BEGIN
  select count(*),count(*) filter(where p.payment_status='paid'),md5(coalesce(string_agg(md5(to_jsonb(p)::text),',' order by p.id),'')) into payment_count,paid_count,paid_hash
  from public.payroll_employee_payments p where p.user_id in (24,28,29);
  if payment_count <> 5 or paid_count <> 5 or paid_hash <> '3d2dd50914fac4aec04ce3631c6e2ed0' then
    raise exception 'PAID_PAYMENT_BASELINE_MISMATCH: rows %, paid %, hash %',payment_count,paid_count,paid_hash;
  end if;
  if exists(select 1 from public.payroll_payment_batches b where b.payroll_month >= date '2026-10-01') then
    raise exception 'PAYMENT_BATCH_FROM_OCTOBER_EXISTS'; end if;
  if (select md5(coalesce(string_agg(md5(to_jsonb(d)::text),',' order by d.id),''))
      from public.payroll_part_time_extra_work_decisions d where d.user_id in (24,28,29) and d.payroll_month >= date '2026-10-01')
     <> '11e6f9ae3a63e4579b288f8ea626fcae' then
    raise exception 'EXTRA_WORK_DECISION_CHANGED'; end if;
  -- Re-verify every active Oct/Nov decision of Sơn against the corrected level: the version in force on the
  -- business date (same selection as payroll_admin_set_part_time_extra_work_decision_v1) gives a 0 VND level
  -- raise, so the hourly rate stays the contract rate, and the stored SHA-256 source hash still matches the
  -- calculator's canonical snapshot (same key order as the RPC).
  with d as (select * from public.payroll_part_time_extra_work_decisions
    where user_id=29 and payroll_month in (date '2026-10-01',date '2026-11-01') and cancelled_at is null and decision='approved'),
  r as (select d.*, (select v from public.employee_level_program_versions v where v.user_id=29 and v.effective_from<=d.business_date
          and (v.effective_to is null or v.effective_to>d.business_date) order by v.revision desc limit 1) lv,
        (select c from public.payroll_contract_versions c where c.id::text=d.source_snapshot->>'contractId'
          and c.revision::text=d.source_snapshot->>'contractRevision' and c.user_id=29) ct,
        array['attendanceRecordId','checkInAt','checkOutAt','userId','businessDate','contractId','contractRevision','minuteRateAmount','hourlyRateAmount',
          'scheduleId','scheduleRevision','scheduleStartTime','scheduleEndTime','storeSettingId','storeSettingRevision','storeOpenTime','storeCloseTime',
          'beforeScheduleMinutes','afterScheduleMinutes','excludedBeforeOpenMinutes','excludedAfterCloseMinutes','candidateMinutes','candidateAmount']
          || case when d.source_snapshot ? 'extraWorkPolicy' then array['extraWorkPolicy','payType'] else array[]::text[] end keys
      from d)
  select count(*),count(*) filter(where (r.lv).id=45 and (r.lv).enabled and (r.lv).base_date=date '2026-10-01'
      and ((extract(year from r.business_date)::int-2026)*12+extract(month from r.business_date)::int-10)/3=0
      and (r.ct).pay_type='hourly' and r.hourly_rate_amount=(r.ct).base_salary
      and (r.source_snapshot->>'hourlyRateAmount')::numeric=r.hourly_rate_amount
      and encode(sha256(convert_to((select '{'||string_agg(to_json(k)::text||':'||(r.source_snapshot->k)::text,',' order by o)||'}'
            from unnest(r.keys) with ordinality u(k,o)),'UTF8')),'hex')=r.source_hash)
    into ew_count,ew_ok from r;
  if ew_count <> 31 or ew_ok <> 31 then
    raise exception 'SON_EXTRA_WORK_SOURCE_RECHECK_FAILED: % of %',ew_ok,ew_count; end if;
  -- Expected levels (version in force per date; month-base level = completed months from the base month / 3).
  with c(user_id,d,expected) as (values
      (24,date '2026-10-01',0),(24,date '2026-10-31',0),(24,date '2026-11-01',1),
      (28,date '2026-10-01',0),(28,date '2026-11-30',0),(28,date '2026-12-01',1),
      (29,date '2026-10-01',0),(29,date '2026-12-31',0),(29,date '2027-01-01',1)),
  r as (select c.*,(select v from public.employee_level_program_versions v where v.user_id=c.user_id and v.effective_from<=c.d
          and (v.effective_to is null or v.effective_to>c.d) order by v.revision desc limit 1) lv from c)
  select string_agg(r.user_id||'@'||r.d,',') into bad from r
  where not ((r.lv).enabled and (r.lv).base_date_mode='hire_month'
    and least(7,greatest(0,((extract(year from r.d)::int-extract(year from (r.lv).base_date)::int)*12
      +extract(month from r.d)::int-extract(month from (r.lv).base_date)::int))/3)=r.expected);
  if bad is not null then raise exception 'EXPECTED_LEVEL_MISMATCH: %',bad; end if;
  -- August/September history is unchanged: the same version is in force as before the correction.
  with c(user_id,d,expected_id) as (values
      (24,date '2026-08-01',27::bigint),(24,date '2026-09-30',27),(28,date '2026-08-16',31),(28,date '2026-09-30',31),
      (29,date '2026-09-01',32),(29,date '2026-09-30',32))
  select string_agg(c.user_id||'@'||c.d,',') into bad from c
  where (select v.id from public.employee_level_program_versions v where v.user_id=c.user_id and v.effective_from<=c.d
          and (v.effective_to is null or v.effective_to>c.d) order by v.revision desc limit 1) is distinct from c.expected_id;
  if bad is not null then raise exception 'HISTORY_VERSION_CHANGED: %',bad; end if;
  -- Sơn v33 is kept as an empty interval and is never selected.
  if not exists(select 1 from public.employee_level_program_versions where id=33 and user_id=29 and not enabled
      and effective_from=date '2026-10-01' and effective_to=date '2026-10-01') then
    raise exception 'SON_V33_NOT_KEPT_AS_EMPTY_INTERVAL'; end if;
  WITH t(user_id,old_id,new_id,base_date,old_hash,new_hash,user_hash) AS (VALUES
    (29,33,45,'2026-10-01'::date,'e6aae1277a434584b69799665c32e066','97873a9a5c6ca082e5e2f39d0461794c','b4d69d1d4e7aa5e1599fdfc0fb041684'),
    (28,31,46,'2026-09-01'::date,'300185a4f45d0128bd74b2ca9da5dbed','de7f7e00730c1158207b486bd7abbef2','55bcbf81e557055707f412efd408bc6b'),
    (24,27,47,'2026-08-01'::date,'d23f4a4e843a30c9970f271ae29c539b','0df9b8518fa1945a04b3ce4d35eb7840','c8d6e50ef0bb4c5ed5fb14e845795d34'))
  SELECT count(*) INTO matched FROM t
  JOIN public.employee_level_program_versions o ON o.id=t.old_id AND o.user_id=t.user_id
  JOIN public.employee_level_program_versions n ON n.id=t.new_id AND n.user_id=t.user_id
  JOIN public.users u ON u.id=t.user_id
  JOIN public.employee_level_audit_logs a ON a.user_id=t.user_id AND a.change_reason='employee_level_parttime_start_correction_20261115_v1'
  WHERE o.effective_to=date '2026-10-01' AND n.effective_from=date '2026-10-01' AND n.effective_to IS NULL
    AND n.base_date=t.base_date AND n.base_date_mode='hire_month' AND n.enabled AND n.salary_raise_enabled
    AND u.level_base_mode='hire_month' AND u.level_program_enabled AND u.level_base_date_override IS NULL
    AND md5((a.previous_version_snapshot->'old_version')::text)=t.old_hash
    AND md5((a.previous_version_snapshot->'new_version')::text)=t.new_hash
    AND md5((a.previous_version_snapshot->'user_mirror')::text)=t.user_hash
    AND a.next_version_snapshot->'old_version'=to_jsonb(o)
    AND a.next_version_snapshot->'new_version'=to_jsonb(n)
    AND a.next_version_snapshot->'user_mirror'=jsonb_build_object('id',u.id,'hire_date',u.hire_date,'termination_date',u.termination_date,'is_active',u.is_active,'is_system_account',u.is_system_account,'level_program_enabled',u.level_program_enabled,'level_base_date_override',u.level_base_date_override,'level_base_mode',u.level_base_mode);
  IF matched<>3 OR (SELECT count(*) FROM public.employee_level_audit_logs WHERE change_reason='employee_level_parttime_start_correction_20261115_v1')<>3 THEN
    RAISE EXCEPTION 'PARTTIME_START_CORRECTION_POSTFLIGHT_FAILED: matched %/3',matched;
  END IF;
END $postflight$;
COMMIT;
