-- One-time employee-level October 2026 correction. Production execution requires Owner approval.
-- Self-contained: no file includes, psql variables, session actor settings or manual edits.
-- Exact cohort/version/mirror and 22-payment fingerprints are pinned below; drift aborts.
-- Audit actor is the unique original creator of all 11 pinned monthly-policy versions,
-- validated as an active, non-system owner/master with matching stored username.
-- Database executor identities and this actor source are recorded in audit snapshots.
-- Execute the complete file on one connection, stop on error, then ROLLBACK before retry.
-- Writes: 22 version interval endpoints, 11 user level mirrors, 11 appended audit rows.
-- No payroll, attendance, contract, payment or ledger DML; no schema/privilege changes.
BEGIN;
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL timezone='UTC';
SET LOCAL row_security=off;
SELECT pg_advisory_xact_lock(hashtext('employee_level_october_correction_20261110_v1'));
LOCK TABLE public.users, public.employee_level_program_versions,
  public.employee_level_audit_logs IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.payroll_employee_payments IN SHARE MODE;
CREATE TEMP TABLE _level_oct_targets(user_id bigint,old_id bigint,new_id bigint,base_date date,mode text,old_hash text,new_hash text,user_hash text) ON COMMIT DROP;
INSERT INTO _level_oct_targets VALUES
    (2,15,34,'2025-10-01'::date,'override_month','5e6540217810afe610a5b25ca8e36ff9','70a8083078631781a6a8746593fe30fc','a11d711d5e3bdbe8807dd671c195a7a2'),
    (3,8,35,'2025-10-01'::date,'override_month','9da1943c43ab0f93cd4d3431873d8733','3f52825fd98d2876a576d2d6e64b9e67','57a2ff9517afb0d14687d5643bb28d18'),
    (4,9,36,'2025-10-01'::date,'override_month','59a151c9ed4fcda3f9bb51647382c073','2129338135245f4d24bc07b2b74edb02','ed249905348b9f5f745fcd5b601f166c'),
    (5,6,37,'2025-11-01'::date,'hire_month','4f31863dbc819e26f0477ad3a78d582a','0b7c44c77eb5ded0ece11492b92b82db','e1090f3a77497e6e6e7f09b8a94c1b83'),
    (6,26,38,'2026-02-01'::date,'override_month','27560fe8a15797be0f02184d3cfe6126','5b402cd79126e67a78f03ba0849cf45c','39f3fbb55f892f30f3bbadbb50005f4f'),
    (7,11,39,'2025-10-01'::date,'override_month','e0eebb9f8abf19ea046e34c9c615b110','c2f444af5c9864a69dea22090c2b891a','336b87a8f4dcb604d3e8d1682480c835'),
    (8,13,40,'2025-10-01'::date,'override_month','9954bfec69e50d9bb0f58b589443c3d7','8f1fe36b20dddbd43fe92a9d02557a5d','988b3aeece1bdd5533dd76a1d8398f3e'),
    (10,7,41,'2026-03-01'::date,'hire_month','abf4a8604b5da9635f29423e3eeca4f1','d8ab6d8e21f1899fe2a6048456d431e1','0552864afe860bcddaa298637454ff7e'),
    (14,16,42,'2026-04-01'::date,'hire_month','38782de41986f29d2c57756326e56ac0','b5e37ad1834d23ea5b4a762cb4bacd0e','faeb49612b615504958e826ea875146c'),
    (18,12,43,'2026-06-01'::date,'hire_month','c0d84886135c6b6220d6b39b9a3d643c','b946bcc84cc5f9510ad8b04405d3e2cf','282b305fb11bbd12b9c3fc9e133b2921'),
    (19,10,44,'2026-06-01'::date,'hire_month','8cee0bc01f2353b01db9f999a14b3cdf','3d2f0de24191d4d3ba4dd2f94c6af13b','cfe2ab99dd136387fcaced795d7ee38d');
DO $correction$
DECLARE payment_count bigint; paid_count bigint; paid_hash text; matched bigint; changed bigint;
  actor_id bigint; actor_name text; audit_hash text; before_row record; execution_context jsonb;
BEGIN
  select count(*),count(*) filter(where p.payment_status='paid'),md5(coalesce(string_agg(md5(to_jsonb(p)::text),',' order by p.id),'')) into payment_count,paid_count,paid_hash
  from public.payroll_employee_payments p where p.user_id in (2,3,4,5,6,7,8,10,14,18,19);
  if payment_count <> 22 or paid_count <> 22 or paid_hash <> '6a3013ee9ab4288f07fcb3d361d889bc' then
    raise exception 'PAID_PAYMENT_BASELINE_MISMATCH: rows %, paid %, hash %',payment_count,paid_count,paid_hash;
  end if;
  with t(user_id,old_id,new_id,base_date,mode,old_hash,new_hash,user_hash) as (values
    (2,15,34,'2025-10-01'::date,'override_month','5e6540217810afe610a5b25ca8e36ff9','70a8083078631781a6a8746593fe30fc','a11d711d5e3bdbe8807dd671c195a7a2'),
    (3,8,35,'2025-10-01'::date,'override_month','9da1943c43ab0f93cd4d3431873d8733','3f52825fd98d2876a576d2d6e64b9e67','57a2ff9517afb0d14687d5643bb28d18'),
    (4,9,36,'2025-10-01'::date,'override_month','59a151c9ed4fcda3f9bb51647382c073','2129338135245f4d24bc07b2b74edb02','ed249905348b9f5f745fcd5b601f166c'),
    (5,6,37,'2025-11-01'::date,'hire_month','4f31863dbc819e26f0477ad3a78d582a','0b7c44c77eb5ded0ece11492b92b82db','e1090f3a77497e6e6e7f09b8a94c1b83'),
    (6,26,38,'2026-02-01'::date,'override_month','27560fe8a15797be0f02184d3cfe6126','5b402cd79126e67a78f03ba0849cf45c','39f3fbb55f892f30f3bbadbb50005f4f'),
    (7,11,39,'2025-10-01'::date,'override_month','e0eebb9f8abf19ea046e34c9c615b110','c2f444af5c9864a69dea22090c2b891a','336b87a8f4dcb604d3e8d1682480c835'),
    (8,13,40,'2025-10-01'::date,'override_month','9954bfec69e50d9bb0f58b589443c3d7','8f1fe36b20dddbd43fe92a9d02557a5d','988b3aeece1bdd5533dd76a1d8398f3e'),
    (10,7,41,'2026-03-01'::date,'hire_month','abf4a8604b5da9635f29423e3eeca4f1','d8ab6d8e21f1899fe2a6048456d431e1','0552864afe860bcddaa298637454ff7e'),
    (14,16,42,'2026-04-01'::date,'hire_month','38782de41986f29d2c57756326e56ac0','b5e37ad1834d23ea5b4a762cb4bacd0e','faeb49612b615504958e826ea875146c'),
    (18,12,43,'2026-06-01'::date,'hire_month','c0d84886135c6b6220d6b39b9a3d643c','b946bcc84cc5f9510ad8b04405d3e2cf','282b305fb11bbd12b9c3fc9e133b2921'),
    (19,10,44,'2026-06-01'::date,'hire_month','8cee0bc01f2353b01db9f999a14b3cdf','3d2f0de24191d4d3ba4dd2f94c6af13b','cfe2ab99dd136387fcaced795d7ee38d'))
  select count(*) into matched from t
  join public.employee_level_program_versions o on o.id=t.old_id and o.user_id=t.user_id
  join public.employee_level_program_versions n on n.id=t.new_id and n.user_id=t.user_id
  join public.users u on u.id=t.user_id
  where md5(to_jsonb(o)::text)=t.old_hash and md5(to_jsonb(n)::text)=t.new_hash
    and md5((jsonb_build_object('id',u.id,'hire_date',u.hire_date,'termination_date',u.termination_date,'is_active',u.is_active,'is_system_account',u.is_system_account,'level_program_enabled',u.level_program_enabled,'level_base_date_override',u.level_base_date_override,'level_base_mode',u.level_base_mode))::text)=t.user_hash
    and o.effective_from < date '2026-10-01' and o.effective_to=date '2026-12-01'
    and n.effective_from=date '2026-12-01' and n.effective_to is null
    and n.base_date=t.base_date and n.base_date_mode=t.mode
    and n.enabled and n.salary_raise_enabled and n.revision=o.revision+1
    and u.is_active and not u.is_system_account and u.termination_date is null
    and not exists (select 1 from public.employee_level_program_versions x
      where x.user_id=t.user_id and x.id not in(t.old_id,t.new_id)
        and (x.effective_to is null or x.effective_to>date '2026-10-01'));
  if matched <> 11 then raise exception 'LEVEL_CORRECTION_SOURCE_DRIFT: matched %/11',matched; end if;
  if exists(select 1 from public.employee_level_audit_logs where change_reason='employee_level_october_correction_20261110_v1') then
    raise exception 'LEVEL_CORRECTION_ALREADY_APPLIED'; end if;
  -- Derive the actor from the already hash-validated cohort, never from external state.
  select min(n.created_by) into actor_id
    from public.employee_level_program_versions n join _level_oct_targets t on t.new_id=n.id
    having count(*)=11 and count(n.created_by)=11 and count(distinct n.created_by)=1;
  if actor_id is null then raise exception 'CORRECTION_ACTOR_COHORT_MISMATCH'; end if;
  select username into actor_name from public.users
    where id=actor_id and role in('owner','master') and is_active and not is_system_account;
  if nullif(btrim(actor_name),'') is null then raise exception 'APPROVED_CORRECTION_ACTOR_REQUIRED'; end if;
  if exists(select 1 from public.employee_level_program_versions n join _level_oct_targets t on t.new_id=n.id
    where n.created_by is distinct from actor_id or n.created_by_username is distinct from actor_name) then
    raise exception 'CORRECTION_ACTOR_IDENTITY_MISMATCH';
  end if;
  execution_context := jsonb_build_object('migration','employee_level_october_2026_correction',
    'actor_source','pinned_month_policy_cohort_creator','database_user',current_user,'session_user',session_user);
  select md5(coalesce(jsonb_agg(to_jsonb(a) order by a.id)::text,'[]')) into audit_hash
    from public.employee_level_audit_logs a;
  CREATE TEMP TABLE _level_oct_before ON COMMIT DROP AS
    select t.user_id,to_jsonb(o) old_version,to_jsonb(n) new_version,
      jsonb_build_object('id',u.id,'hire_date',u.hire_date,'termination_date',u.termination_date,'is_active',u.is_active,'is_system_account',u.is_system_account,'level_program_enabled',u.level_program_enabled,'level_base_date_override',u.level_base_date_override,'level_base_mode',u.level_base_mode) user_mirror,
      md5((to_jsonb(u)-'level_program_enabled'-'level_base_date_override'-'level_base_mode')::text) other_user_hash
    from _level_oct_targets t join public.employee_level_program_versions o on o.id=t.old_id
    join public.employee_level_program_versions n on n.id=t.new_id join public.users u on u.id=t.user_id;
  update public.employee_level_program_versions v set effective_to=date '2026-10-01'
    from _level_oct_targets t where v.id=t.old_id;
  get diagnostics changed=row_count;
  if changed<>11 then raise exception 'OLD_VERSION_COUNT_MISMATCH'; end if;
  update public.employee_level_program_versions v set effective_from=date '2026-10-01'
    from _level_oct_targets t where v.id=t.new_id;
  get diagnostics changed=row_count;
  if changed<>11 then raise exception 'NEW_VERSION_COUNT_MISMATCH'; end if;
  update public.users u set level_program_enabled=true,level_base_mode=t.mode,
    level_base_date_override=case when t.mode='override_month' then t.base_date else null end
    from _level_oct_targets t where u.id=t.user_id;
  get diagnostics changed=row_count;
  if changed<>11 then raise exception 'USER_MIRROR_COUNT_MISMATCH'; end if;
  for before_row in select b.*,t.old_id,t.new_id from _level_oct_before b
    join _level_oct_targets t using(user_id) loop
    insert into public.employee_level_audit_logs(user_id,action,previous_enabled,next_enabled,
      previous_base_date_override,next_base_date_override,previous_base_date_mode,next_base_date_mode,
      previous_effective_base_date,next_effective_base_date,actor_id,actor_username,change_reason,
      previous_salary_raise_enabled,next_salary_raise_enabled,previous_version_snapshot,next_version_snapshot)
    select u.id,'level_base_date_changed',true,true,
      (before_row.user_mirror->>'level_base_date_override')::date,u.level_base_date_override,
      before_row.old_version->>'base_date_mode',n.base_date_mode,
      (before_row.old_version->>'base_date')::date,n.base_date,actor_id,actor_name,'employee_level_october_correction_20261110_v1',
      (before_row.old_version->>'salary_raise_enabled')::boolean,n.salary_raise_enabled,
      jsonb_build_object('operation','employee_level_october_correction_20261110_v1','old_version',before_row.old_version,'new_version',before_row.new_version,'user_mirror',before_row.user_mirror,'execution_context',execution_context),
      jsonb_build_object('operation','employee_level_october_correction_20261110_v1','old_version',to_jsonb(o),'new_version',to_jsonb(n),'user_mirror',jsonb_build_object('id',u.id,'hire_date',u.hire_date,'termination_date',u.termination_date,'is_active',u.is_active,'is_system_account',u.is_system_account,'level_program_enabled',u.level_program_enabled,'level_base_date_override',u.level_base_date_override,'level_base_mode',u.level_base_mode),'execution_context',execution_context)
    from public.users u join public.employee_level_program_versions o on o.id=before_row.old_id
      join public.employee_level_program_versions n on n.id=before_row.new_id where u.id=before_row.user_id;
  end loop;
  if (select count(*) from public.employee_level_audit_logs where change_reason='employee_level_october_correction_20261110_v1')<>11 then
    raise exception 'CORRECTION_AUDIT_COUNT_MISMATCH'; end if;
  if (select md5(coalesce(jsonb_agg(to_jsonb(a) order by a.id)::text,'[]'))
      from public.employee_level_audit_logs a where change_reason<>'employee_level_october_correction_20261110_v1')<>audit_hash then
    raise exception 'EXISTING_AUDIT_CHANGED'; end if;
  if exists(select 1 from _level_oct_targets t join _level_oct_before b using(user_id)
      join public.employee_level_program_versions o on o.id=t.old_id
      join public.employee_level_program_versions n on n.id=t.new_id join public.users u on u.id=t.user_id
      where (to_jsonb(o)-'effective_to')<>(b.old_version-'effective_to')
        or (to_jsonb(n)-'effective_from')<>(b.new_version-'effective_from')
        or o.effective_to is distinct from date '2026-10-01' or n.effective_from is distinct from date '2026-10-01'
        or u.level_base_mode is distinct from t.mode or u.level_program_enabled is distinct from true
        or u.level_base_date_override is distinct from (case when t.mode='override_month' then t.base_date else null end)
        or md5((to_jsonb(u)-'level_program_enabled'-'level_base_date_override'-'level_base_mode')::text)<>b.other_user_hash) then
    raise exception 'POSTFLIGHT_LEVEL_OR_NON_LEVEL_DRIFT'; end if;
  select count(*),count(*) filter(where p.payment_status='paid'),md5(coalesce(string_agg(md5(to_jsonb(p)::text),',' order by p.id),'')) into payment_count,paid_count,paid_hash
  from public.payroll_employee_payments p where p.user_id in (2,3,4,5,6,7,8,10,14,18,19);
  if payment_count <> 22 or paid_count <> 22 or paid_hash <> '6a3013ee9ab4288f07fcb3d361d889bc' then
    raise exception 'PAID_PAYMENT_BASELINE_MISMATCH: rows %, paid %, hash %',payment_count,paid_count,paid_hash;
  end if;
END $correction$;
-- Postflight is part of the SAME transaction: no validation failure can commit.
DO $postflight$
DECLARE payment_count bigint; paid_count bigint;paid_hash text;matched bigint;
BEGIN
  select count(*),count(*) filter(where p.payment_status='paid'),md5(coalesce(string_agg(md5(to_jsonb(p)::text),',' order by p.id),'')) into payment_count,paid_count,paid_hash
  from public.payroll_employee_payments p where p.user_id in (2,3,4,5,6,7,8,10,14,18,19);
  if payment_count <> 22 or paid_count <> 22 or paid_hash <> '6a3013ee9ab4288f07fcb3d361d889bc' then
    raise exception 'PAID_PAYMENT_BASELINE_MISMATCH: rows %, paid %, hash %',payment_count,paid_count,paid_hash;
  end if;
  WITH t(user_id,old_id,new_id,base_date,mode,old_hash,new_hash,user_hash) AS (VALUES
    (2,15,34,'2025-10-01'::date,'override_month','5e6540217810afe610a5b25ca8e36ff9','70a8083078631781a6a8746593fe30fc','a11d711d5e3bdbe8807dd671c195a7a2'),
    (3,8,35,'2025-10-01'::date,'override_month','9da1943c43ab0f93cd4d3431873d8733','3f52825fd98d2876a576d2d6e64b9e67','57a2ff9517afb0d14687d5643bb28d18'),
    (4,9,36,'2025-10-01'::date,'override_month','59a151c9ed4fcda3f9bb51647382c073','2129338135245f4d24bc07b2b74edb02','ed249905348b9f5f745fcd5b601f166c'),
    (5,6,37,'2025-11-01'::date,'hire_month','4f31863dbc819e26f0477ad3a78d582a','0b7c44c77eb5ded0ece11492b92b82db','e1090f3a77497e6e6e7f09b8a94c1b83'),
    (6,26,38,'2026-02-01'::date,'override_month','27560fe8a15797be0f02184d3cfe6126','5b402cd79126e67a78f03ba0849cf45c','39f3fbb55f892f30f3bbadbb50005f4f'),
    (7,11,39,'2025-10-01'::date,'override_month','e0eebb9f8abf19ea046e34c9c615b110','c2f444af5c9864a69dea22090c2b891a','336b87a8f4dcb604d3e8d1682480c835'),
    (8,13,40,'2025-10-01'::date,'override_month','9954bfec69e50d9bb0f58b589443c3d7','8f1fe36b20dddbd43fe92a9d02557a5d','988b3aeece1bdd5533dd76a1d8398f3e'),
    (10,7,41,'2026-03-01'::date,'hire_month','abf4a8604b5da9635f29423e3eeca4f1','d8ab6d8e21f1899fe2a6048456d431e1','0552864afe860bcddaa298637454ff7e'),
    (14,16,42,'2026-04-01'::date,'hire_month','38782de41986f29d2c57756326e56ac0','b5e37ad1834d23ea5b4a762cb4bacd0e','faeb49612b615504958e826ea875146c'),
    (18,12,43,'2026-06-01'::date,'hire_month','c0d84886135c6b6220d6b39b9a3d643c','b946bcc84cc5f9510ad8b04405d3e2cf','282b305fb11bbd12b9c3fc9e133b2921'),
    (19,10,44,'2026-06-01'::date,'hire_month','8cee0bc01f2353b01db9f999a14b3cdf','3d2f0de24191d4d3ba4dd2f94c6af13b','cfe2ab99dd136387fcaced795d7ee38d'))
  SELECT count(*) INTO matched FROM t
  JOIN public.employee_level_program_versions o ON o.id=t.old_id AND o.user_id=t.user_id
  JOIN public.employee_level_program_versions n ON n.id=t.new_id AND n.user_id=t.user_id
  JOIN public.users u ON u.id=t.user_id
  JOIN public.employee_level_audit_logs a ON a.user_id=t.user_id AND a.change_reason='employee_level_october_correction_20261110_v1'
  WHERE o.effective_to=date '2026-10-01' AND n.effective_from=date '2026-10-01'
    AND n.base_date=t.base_date AND n.base_date_mode=t.mode AND n.effective_to IS NULL
    AND u.level_base_mode=t.mode AND u.level_program_enabled
    AND u.level_base_date_override IS NOT DISTINCT FROM (CASE WHEN t.mode='override_month' THEN t.base_date ELSE NULL END)
    AND md5((a.previous_version_snapshot->'old_version')::text)=t.old_hash
    AND md5((a.previous_version_snapshot->'new_version')::text)=t.new_hash
    AND md5((a.previous_version_snapshot->'user_mirror')::text)=t.user_hash
    AND a.next_version_snapshot->'old_version'=to_jsonb(o)
    AND a.next_version_snapshot->'new_version'=to_jsonb(n)
    AND a.next_version_snapshot->'user_mirror'=jsonb_build_object('id',u.id,'hire_date',u.hire_date,'termination_date',u.termination_date,'is_active',u.is_active,'is_system_account',u.is_system_account,'level_program_enabled',u.level_program_enabled,'level_base_date_override',u.level_base_date_override,'level_base_mode',u.level_base_mode);
  IF matched<>11 OR (SELECT count(*) FROM public.employee_level_audit_logs WHERE change_reason='employee_level_october_correction_20261110_v1')<>11 THEN
    RAISE EXCEPTION 'OCTOBER_CORRECTION_POSTFLIGHT_FAILED: matched %/11',matched;
  END IF;
END $postflight$;
COMMIT;
