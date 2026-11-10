-- DRAFT ONLY. Separate Owner approval required. Never run automatically.
-- Whole file, one connection, stop on error; ROLLBACK on any error before retry.
-- Pins exact source versions + current level/employment mirrors from read-only capture.
-- PAYMENT GATE: all target payment rows; MD5 of comma-joined per-row JSONB MD5, ordered by id.
-- Requires 22 total rows AND 22 paid rows; any baseline mismatch ALWAYS aborts.
-- No payroll/attendance/contract/payment/ledger DML. No migration/history changes.
BEGIN READ ONLY;
SET LOCAL timezone='UTC';
SET LOCAL row_security=off;
DO $preflight$
DECLARE payment_count bigint; paid_count bigint;paid_hash text;matched bigint;
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
END $preflight$;
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
SELECT t.user_id,to_jsonb(o) old_version,to_jsonb(n) new_version,jsonb_build_object('id',u.id,'hire_date',u.hire_date,'termination_date',u.termination_date,'is_active',u.is_active,'is_system_account',u.is_system_account,'level_program_enabled',u.level_program_enabled,'level_base_date_override',u.level_base_date_override,'level_base_mode',u.level_base_mode) current_mirror,
  date '2026-10-01' proposed_effective_from
FROM t JOIN public.employee_level_program_versions o ON o.id=t.old_id
JOIN public.employee_level_program_versions n ON n.id=t.new_id JOIN public.users u ON u.id=t.user_id
ORDER BY t.user_id;
COMMIT;
