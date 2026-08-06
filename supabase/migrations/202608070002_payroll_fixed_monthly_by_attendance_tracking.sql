-- 근태 기록을 쓰지 않는 직원(attendance_tracking_enabled=false — 예: 회계·마케팅처럼 매장
-- 근무시간표 자체가 없는 phuc·sỹ)도 월 고정급(monthly + fixed_monthly) 계약을 등록할 수
-- 있게 한다.
--
-- 지금까지 payroll_create_contract_version_v5 / payroll_correct_latest_unused_contract_v3는
-- users.role in ('owner','master')일 때만 월 고정급 경로(근무시간 불필요)를 타고, 그 외에는
-- 무조건 employee_work_schedule_versions에서 근무시간을 조회해 minute 방식을 강제했다.
-- attendance_tracking_enabled=false인 staff/manager/leader는 애초에 근무시간 version이
-- 없으므로(근태 자체를 안 쓰니까) 이 경로에서 항상 work_schedule_not_found로 막혀
-- 계약을 저장할 방법이 없었다.
--
-- 이 Migration은 owner 판정 대신 "월 고정급이 필요한 대상" 판정을
--   is_fixed_monthly_target = role in ('owner','master') or attendance_tracking_enabled = false
-- 로 넓힌 v6/v4 함수만 새로 추가한다. role을 owner로 바꾸거나 owner 권한을 부여하는 로직은
-- 전혀 없다 — 그저 "이 사람 계약에 근무시간이 필요한가"만 다시 판정할 뿐이고, 실제 월
-- 고정급 계산 경로(payroll_create_contract_version_v3 / payroll_correct_latest_unused_contract_v1
-- 호출, standard_minutes_per_day=540, calculation_basis='fixed_monthly')는 기존 owner
-- 경로를 100% 그대로 재사용한다. 가짜 근무시간 version은 어디에서도 만들지 않는다.
--
-- 기존 payroll_create_contract_version_v3/v4/v5, payroll_correct_latest_unused_contract_v1/v2/v3는
-- rollback 대비를 위해 그대로 둔다(수정·삭제하지 않음). API가 새 버전을 호출하도록 하는 것은
-- 애플리케이션 코드(별도 배포)의 몫이다. 데이터 UPDATE는 포함하지 않는다.

begin;

-- ---------------------------------------------------------------------------
-- 0. 사전 확인 — 이 Migration이 감싸는 v5/v3 함수가 존재하고, v6/v4가 아직 없는지 확인
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regprocedure('public.payroll_create_contract_version_v5(bigint,text,numeric,numeric,numeric,date,bigint,text)') is null then
    raise exception 'PAYROLL_FIXED_MONTHLY_PREFLIGHT_MISSING_V5_CREATE';
  end if;
  if to_regprocedure('public.payroll_correct_latest_unused_contract_v3(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text)') is null then
    raise exception 'PAYROLL_FIXED_MONTHLY_PREFLIGHT_MISSING_V3_CORRECT';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'users' and column_name = 'attendance_tracking_enabled'
  ) then
    raise exception 'PAYROLL_FIXED_MONTHLY_PREFLIGHT_MISSING_ATTENDANCE_TRACKING_ENABLED';
  end if;
  if to_regprocedure('public.payroll_create_contract_version_v6(bigint,text,numeric,numeric,numeric,date,bigint,text)') is not null then
    raise exception 'PAYROLL_FIXED_MONTHLY_PREFLIGHT_V6_ALREADY_EXISTS';
  end if;
  if to_regprocedure('public.payroll_correct_latest_unused_contract_v4(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text)') is not null then
    raise exception 'PAYROLL_FIXED_MONTHLY_PREFLIGHT_V4_CORRECT_ALREADY_EXISTS';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. payroll_create_contract_version_v6 — v5와 동일하나 월 고정급 판정 조건만 확장
-- ---------------------------------------------------------------------------

create or replace function public.payroll_create_contract_version_v6(
  p_user_id bigint,p_pay_type text,p_base_salary numeric,p_fixed_raise_amount numeric,
  p_standard_workdays numeric,p_effective_from date,p_actor_user_id bigint,p_note text default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_role text;
  v_attendance_tracking_enabled boolean;
  v_is_fixed_monthly_target boolean;
  v_schedule public.employee_work_schedule_versions%rowtype;
  v_minutes integer;
begin
  perform public.payroll_assert_actor_v2(p_actor_user_id);
  perform pg_advisory_xact_lock(p_user_id);
  select lower(coalesce(role,'')), attendance_tracking_enabled
    into v_role, v_attendance_tracking_enabled
  from public.users where id=p_user_id and is_active and not is_system_account;
  if not found then return jsonb_build_object('status','user_not_found');end if;

  -- owner/master이거나 근태 기록을 쓰지 않는 직원은 월 고정급 경로를 탄다. role은 여기서
  -- 전혀 바뀌지 않는다(owner로 승격하지 않음) — 이 계약 하나에만 적용되는 판정이다.
  v_is_fixed_monthly_target := v_role in ('owner','master') or v_attendance_tracking_enabled = false;

  if v_is_fixed_monthly_target then
    return public.payroll_create_contract_version_v3(p_user_id,'monthly','fixed_monthly',p_base_salary,p_fixed_raise_amount,p_standard_workdays,540,1,'none','ignore','ignore','ignore','unpaid',p_effective_from,p_actor_user_id,p_note);
  end if;

  if (select count(*) from public.employee_work_schedule_versions where user_id=p_user_id and effective_from<=p_effective_from and (effective_to is null or effective_to>p_effective_from))=0 then return jsonb_build_object('status','work_schedule_not_found');end if;
  if (select count(*) from public.employee_work_schedule_versions where user_id=p_user_id and effective_from<=p_effective_from and (effective_to is null or effective_to>p_effective_from))>1 then return jsonb_build_object('status','work_schedule_overlap');end if;
  select * into strict v_schedule from public.employee_work_schedule_versions where user_id=p_user_id and effective_from<=p_effective_from and (effective_to is null or effective_to>p_effective_from);
  v_minutes:=((extract(hour from v_schedule.end_time)::integer*60+extract(minute from v_schedule.end_time)::integer)-(extract(hour from v_schedule.start_time)::integer*60+extract(minute from v_schedule.start_time)::integer)+1440)%1440-v_schedule.unpaid_break_minutes;
  if v_minutes<=0 then return jsonb_build_object('status','invalid_work_schedule');end if;
  return public.payroll_create_contract_version_v3(p_user_id,p_pay_type,'minute',p_base_salary,p_fixed_raise_amount,p_standard_workdays,v_minutes,1,'none','ignore','ignore','requires_approval','unpaid',p_effective_from,p_actor_user_id,p_note);
end $$;

revoke all on function public.payroll_create_contract_version_v6(bigint,text,numeric,numeric,numeric,date,bigint,text) from public,anon,authenticated;
grant execute on function public.payroll_create_contract_version_v6(bigint,text,numeric,numeric,numeric,date,bigint,text) to service_role;

comment on function public.payroll_create_contract_version_v6(bigint,text,numeric,numeric,numeric,date,bigint,text) is
  'payroll_create_contract_version_v5와 동일하나 월 고정급(근무시간 불필요) 판정을 owner/master 역할뿐 아니라 attendance_tracking_enabled=false인 직원까지 포함하도록 넓혔다(role in (''owner'',''master'') or attendance_tracking_enabled = false). role을 owner로 바꾸지 않는다 — 이 계약 하나의 계산 방식만 결정한다. 계약 생성 API가 호출하는 최신 버전.';

-- ---------------------------------------------------------------------------
-- 2. payroll_correct_latest_unused_contract_v4 — v3와 동일하나 월 고정급 판정 조건만 확장
-- ---------------------------------------------------------------------------

create or replace function public.payroll_correct_latest_unused_contract_v4(
  p_contract_id bigint,p_user_id bigint,p_expected_revision bigint,p_expected_audit_log_id bigint,p_expected_effective_from date,
  p_pay_type text,p_base_salary numeric,p_fixed_raise_amount numeric,p_standard_workdays numeric,
  p_effective_from date,p_actor_user_id bigint,p_note text,p_reason text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_role text;
  v_attendance_tracking_enabled boolean;
  v_is_fixed_monthly_target boolean;
  v_schedule public.employee_work_schedule_versions%rowtype;
  v_minutes integer;
  v_basis text;
begin
  perform public.payroll_assert_actor_v2(p_actor_user_id);
  perform pg_advisory_xact_lock(p_user_id);
  select lower(coalesce(role,'')), attendance_tracking_enabled
    into v_role, v_attendance_tracking_enabled
  from public.users where id=p_user_id and is_active and not is_system_account;
  if not found then return jsonb_build_object('status','user_not_found');end if;

  v_is_fixed_monthly_target := v_role in ('owner','master') or v_attendance_tracking_enabled = false;

  if v_is_fixed_monthly_target then
    v_minutes:=540;v_basis:='fixed_monthly';
  else
    v_basis:='minute';
    if (select count(*) from public.employee_work_schedule_versions where user_id=p_user_id and effective_from<=p_effective_from and (effective_to is null or effective_to>p_effective_from))=0 then return jsonb_build_object('status','work_schedule_not_found');end if;
    if (select count(*) from public.employee_work_schedule_versions where user_id=p_user_id and effective_from<=p_effective_from and (effective_to is null or effective_to>p_effective_from))>1 then return jsonb_build_object('status','work_schedule_overlap');end if;
    select * into strict v_schedule from public.employee_work_schedule_versions where user_id=p_user_id and effective_from<=p_effective_from and (effective_to is null or effective_to>p_effective_from);
    v_minutes:=((extract(hour from v_schedule.end_time)::integer*60+extract(minute from v_schedule.end_time)::integer)-(extract(hour from v_schedule.start_time)::integer*60+extract(minute from v_schedule.start_time)::integer)+1440)%1440-v_schedule.unpaid_break_minutes;
    if v_minutes<=0 then return jsonb_build_object('status','invalid_work_schedule');end if;
  end if;
  return public.payroll_correct_latest_unused_contract_v1(p_contract_id,p_user_id,p_expected_revision,p_expected_audit_log_id,p_expected_effective_from,p_pay_type,v_basis,p_base_salary,p_fixed_raise_amount,p_standard_workdays,v_minutes,1,'none','ignore','ignore',case when v_is_fixed_monthly_target then 'ignore' else 'requires_approval' end,'unpaid',p_effective_from,p_actor_user_id,p_note,p_reason);
end $$;

revoke all on function public.payroll_correct_latest_unused_contract_v4(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text) from public,anon,authenticated;
grant execute on function public.payroll_correct_latest_unused_contract_v4(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text) to service_role;
comment on function public.payroll_correct_latest_unused_contract_v4(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text) is
  'payroll_correct_latest_unused_contract_v3와 동일하나 월 고정급 판정을 owner/master 역할뿐 아니라 attendance_tracking_enabled=false인 직원까지 포함하도록 넓혔다. role을 owner로 바꾸지 않는다. 계약 정정 API가 호출하는 최신 버전.';

commit;
