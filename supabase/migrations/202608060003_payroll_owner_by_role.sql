-- role/position 통합 작업의 일부: 급여 계약의 "사장급(owner)" 판정 기준을
-- users.position='owner'에서 users.role IN ('owner','master')로 옮긴다.
--
-- 지금까지 payroll_create_contract_version_v4 / payroll_correct_latest_unused_contract_v2는
-- users.position='owner'만 owner로 판정했다. HAN 계정(role=master, position=owner)이
-- 급여 계약에서 owner 취급을 받는 것은 이 position 값 덕분이었다 — role=master는
-- position 허용값에 아예 없어서, position='owner'로 우회 설정해 둔 상태였다.
--
-- 이제 owner 판정을 role 기준(role IN ('owner','master'))으로 옮기면 이 우회가
-- 필요 없어진다. lib/payroll/eligibility.ts의 isPayrollOwnerRole(role은 owner 또는
-- master)과 정확히 같은 정의를 SQL에서도 그대로 따른다 — 급여 대상자 제외 판정과
-- 급여 계약의 owner 판정이 이제 동일한 기준을 공유한다.
--
-- 기존 payroll_create_contract_version_v3/v4, payroll_correct_latest_unused_contract_v1/v2는
-- rollback 대비를 위해 그대로 둔다(수정·삭제하지 않음). 이 Migration은 v5/v3 함수를
-- 새로 추가만 하고, API가 새 버전을 호출하도록 하는 것은 애플리케이션 코드(별도 배포)의
-- 몫이다. 데이터 UPDATE는 포함하지 않는다.

begin;

-- ---------------------------------------------------------------------------
-- 0. 사전 확인 — 이 Migration이 감싸는 v3/v4/v1/v2 함수가 기대한 시그니처 그대로
--    존재하는지만 가볍게 확인한다(전체 정의 비교는 하지 않음 — 202608020002처럼
--    무거운 preflight는 이 추가형 Migration에는 과하다고 판단했다).
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regprocedure('public.payroll_create_contract_version_v3(bigint,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text)') is null then
    raise exception 'PAYROLL_OWNER_BY_ROLE_PREFLIGHT_MISSING_V3_CREATE';
  end if;
  if to_regprocedure('public.payroll_correct_latest_unused_contract_v1(bigint,bigint,bigint,bigint,date,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text,text)') is null then
    raise exception 'PAYROLL_OWNER_BY_ROLE_PREFLIGHT_MISSING_V1_CORRECT';
  end if;
  if to_regprocedure('public.payroll_create_contract_version_v4(bigint,text,numeric,numeric,numeric,date,bigint,text)') is null then
    raise exception 'PAYROLL_OWNER_BY_ROLE_PREFLIGHT_MISSING_V4_CREATE';
  end if;
  if to_regprocedure('public.payroll_correct_latest_unused_contract_v2(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text)') is null then
    raise exception 'PAYROLL_OWNER_BY_ROLE_PREFLIGHT_MISSING_V2_CORRECT';
  end if;
  if to_regprocedure('public.payroll_create_contract_version_v5(bigint,text,numeric,numeric,numeric,date,bigint,text)') is not null then
    raise exception 'PAYROLL_OWNER_BY_ROLE_PREFLIGHT_V5_ALREADY_EXISTS';
  end if;
  if to_regprocedure('public.payroll_correct_latest_unused_contract_v3(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text)') is not null then
    raise exception 'PAYROLL_OWNER_BY_ROLE_PREFLIGHT_V3_CORRECT_ALREADY_EXISTS';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. payroll_create_contract_version_v5 — v4와 동일하나 owner 판정만 role 기준
-- ---------------------------------------------------------------------------

create or replace function public.payroll_create_contract_version_v5(
  p_user_id bigint,p_pay_type text,p_base_salary numeric,p_fixed_raise_amount numeric,
  p_standard_workdays numeric,p_effective_from date,p_actor_user_id bigint,p_note text default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_role text;v_schedule public.employee_work_schedule_versions%rowtype;v_minutes integer;
begin
  perform public.payroll_assert_actor_v2(p_actor_user_id);
  perform pg_advisory_xact_lock(p_user_id);
  select lower(coalesce(role,'')) into v_role from public.users where id=p_user_id and is_active and not is_system_account;
  if not found then return jsonb_build_object('status','user_not_found');end if;
  if v_role in ('owner','master') then
    return public.payroll_create_contract_version_v3(p_user_id,'monthly','fixed_monthly',p_base_salary,p_fixed_raise_amount,p_standard_workdays,540,1,'none','ignore','ignore','ignore','unpaid',p_effective_from,p_actor_user_id,p_note);
  end if;
  if (select count(*) from public.employee_work_schedule_versions where user_id=p_user_id and effective_from<=p_effective_from and (effective_to is null or effective_to>p_effective_from))=0 then return jsonb_build_object('status','work_schedule_not_found');end if;
  if (select count(*) from public.employee_work_schedule_versions where user_id=p_user_id and effective_from<=p_effective_from and (effective_to is null or effective_to>p_effective_from))>1 then return jsonb_build_object('status','work_schedule_overlap');end if;
  select * into strict v_schedule from public.employee_work_schedule_versions where user_id=p_user_id and effective_from<=p_effective_from and (effective_to is null or effective_to>p_effective_from);
  v_minutes:=((extract(hour from v_schedule.end_time)::integer*60+extract(minute from v_schedule.end_time)::integer)-(extract(hour from v_schedule.start_time)::integer*60+extract(minute from v_schedule.start_time)::integer)+1440)%1440-v_schedule.unpaid_break_minutes;
  if v_minutes<=0 then return jsonb_build_object('status','invalid_work_schedule');end if;
  return public.payroll_create_contract_version_v3(p_user_id,p_pay_type,'minute',p_base_salary,p_fixed_raise_amount,p_standard_workdays,v_minutes,1,'none','ignore','ignore','requires_approval','unpaid',p_effective_from,p_actor_user_id,p_note);
end $$;

revoke all on function public.payroll_create_contract_version_v5(bigint,text,numeric,numeric,numeric,date,bigint,text) from public,anon,authenticated;
grant execute on function public.payroll_create_contract_version_v5(bigint,text,numeric,numeric,numeric,date,bigint,text) to service_role;

comment on function public.payroll_create_contract_version_v5(bigint,text,numeric,numeric,numeric,date,bigint,text) is
  'payroll_create_contract_version_v4와 동일하나 owner 판정 기준을 users.position=''owner''에서 users.role in (''owner'',''master'')로 옮겼다(lib/payroll/eligibility.ts의 isPayrollOwnerRole과 동일 정의). monthly-payroll-v7 계약 생성 API가 호출하는 최신 버전.';

-- ---------------------------------------------------------------------------
-- 2. payroll_correct_latest_unused_contract_v3 — v2와 동일하나 owner 판정만 role 기준
-- ---------------------------------------------------------------------------

create or replace function public.payroll_correct_latest_unused_contract_v3(
  p_contract_id bigint,p_user_id bigint,p_expected_revision bigint,p_expected_audit_log_id bigint,p_expected_effective_from date,
  p_pay_type text,p_base_salary numeric,p_fixed_raise_amount numeric,p_standard_workdays numeric,
  p_effective_from date,p_actor_user_id bigint,p_note text,p_reason text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_role text;v_schedule public.employee_work_schedule_versions%rowtype;v_minutes integer;v_basis text;
begin
  perform public.payroll_assert_actor_v2(p_actor_user_id);
  perform pg_advisory_xact_lock(p_user_id);
  select lower(coalesce(role,'')) into v_role from public.users where id=p_user_id and is_active and not is_system_account;
  if not found then return jsonb_build_object('status','user_not_found');end if;
  if v_role in ('owner','master') then v_minutes:=540;v_basis:='fixed_monthly';
  else
    v_basis:='minute';
    if (select count(*) from public.employee_work_schedule_versions where user_id=p_user_id and effective_from<=p_effective_from and (effective_to is null or effective_to>p_effective_from))=0 then return jsonb_build_object('status','work_schedule_not_found');end if;
    if (select count(*) from public.employee_work_schedule_versions where user_id=p_user_id and effective_from<=p_effective_from and (effective_to is null or effective_to>p_effective_from))>1 then return jsonb_build_object('status','work_schedule_overlap');end if;
    select * into strict v_schedule from public.employee_work_schedule_versions where user_id=p_user_id and effective_from<=p_effective_from and (effective_to is null or effective_to>p_effective_from);
    v_minutes:=((extract(hour from v_schedule.end_time)::integer*60+extract(minute from v_schedule.end_time)::integer)-(extract(hour from v_schedule.start_time)::integer*60+extract(minute from v_schedule.start_time)::integer)+1440)%1440-v_schedule.unpaid_break_minutes;
    if v_minutes<=0 then return jsonb_build_object('status','invalid_work_schedule');end if;
  end if;
  return public.payroll_correct_latest_unused_contract_v1(p_contract_id,p_user_id,p_expected_revision,p_expected_audit_log_id,p_expected_effective_from,p_pay_type,v_basis,p_base_salary,p_fixed_raise_amount,p_standard_workdays,v_minutes,1,'none','ignore','ignore',case when v_role in ('owner','master') then 'ignore' else 'requires_approval' end,'unpaid',p_effective_from,p_actor_user_id,p_note,p_reason);
end $$;

revoke all on function public.payroll_correct_latest_unused_contract_v3(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text) from public,anon,authenticated;
grant execute on function public.payroll_correct_latest_unused_contract_v3(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text) to service_role;
comment on function public.payroll_correct_latest_unused_contract_v3(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text) is
  'payroll_correct_latest_unused_contract_v2와 동일하나 owner 판정 기준을 users.position=''owner''에서 users.role in (''owner'',''master'')로 옮겼다. 계약 정정 API가 호출하는 최신 버전.';

commit;
