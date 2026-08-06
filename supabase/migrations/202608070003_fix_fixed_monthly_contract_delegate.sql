-- Hotfix: payroll_create_contract_version_v6과 payroll_correct_latest_unused_contract_v4가
-- attendance_tracking_enabled=false 직원(예: 마케팅 phuc, 회계 sỹ)을 fixed_monthly 대상으로
-- 올바르게 판정하고도, 내부에서 각각 payroll_create_contract_version_v3 /
-- payroll_correct_latest_unused_contract_v1을 그대로 호출하고 있었다. 두 함수 모두 아직
-- users.position='owner'인 대상에게만 fixed_monthly를 허용하는 예전 정책 게이트를 그대로
-- 갖고 있어서(v3: '... elsif p_calculation_basis = ''fixed_monthly'' then fixed_monthly_owner_only',
-- v1: 'v_position <> ''owner'' and p_calculation_basis = ''fixed_monthly'' then invalid_contract'),
-- position이 'owner'가 아닌 근태 미사용 직원의 계약 생성/정정이 매번 이 게이트에서 거부됐다.
-- role 판정으로 owner를 넓힌 202608060003/202608070002는 v6/v4의 "누가 fixed_monthly
-- 대상인가" 판정만 넓혔을 뿐, v3/v1이 내부에서 다시 position 기준으로 재검사한다는 점을
-- 놓쳤다.
--
-- 이 Migration은 v6/v4가 호출하는 델리게이트를 정책 게이트가 없는 함수로 바꾼다:
--   * payroll_create_contract_version_v6: fixed_monthly 분기에서 v3 대신
--     payroll_create_contract_version_v2를 직접 호출한다. v2는 owner/position 판정을
--     전혀 하지 않는 정책 중립 함수라서(actor 권한과 effective_from >= 2026-08-01만 검사)
--     v6이 이미 끝낸 "이 대상은 fixed_monthly를 쓸 수 있다" 판정을 다시 뒤집지 않는다.
--     매월 1일 적용 검증은 v3/v1도 원래 create 경로에는 없었으므로(정정 경로에만 있었다)
--     v6 자신이 새로 갖춘다.
--   * payroll_correct_latest_unused_contract_v4: v1 대신 새로 추가하는
--     payroll_correct_latest_unused_contract_core_v2를 호출한다. core_v2는 v1의 revision
--     conflict/최신 계약/급여 사용 잠금/기간 충돌/audit log 로직을 전부 그대로 재사용하되,
--     "position='owner'만 fixed_monthly 허용" 게이트만 제거했다. 대신 데이터 정합성만
--     본다 — fixed_monthly는 반드시 monthly pay_type과 짝지어야 하고 매월 1일부터 적용돼야
--     한다(v1이 owner에게만 적용하던 이 규칙을, calculation_basis='fixed_monthly'인 모든
--     호출에 동일하게 적용한다). "누가" fixed_monthly를 쓸 수 있는지는 여전히 호출자인 v4가
--     v_is_fixed_monthly_target(= role in ('owner','master') or attendance_tracking_enabled
--     = false)로 판정해서 calculation_basis를 결정해 넘긴다 — core_v2는 그 판정을 하지 않는다.
--
-- payroll_create_contract_version_v1/v2/v3/v4/v5, payroll_correct_latest_unused_contract_v1/
-- v2/v3는 rollback 대비를 위해 전혀 수정하지 않는다. v2-create/v1-correct는 이번에도 여전히
-- 다른 호출자(v3-create, v2-correct/v3-correct 체인)가 그대로 쓰고 있으므로 건드리지 않는다.
-- role을 owner로 바꾸거나 owner 권한을 부여하는 로직은 전혀 없다. 가짜 근무시간 version도
-- 어디에서도 만들지 않는다. 데이터 UPDATE는 포함하지 않는다.

begin;

-- ---------------------------------------------------------------------------
-- 0. 사전 확인 — 이 Migration이 감싸는 v6/v4/v2-create/v1-correct 함수가 기대한 시그니처
--    그대로 존재하고, v6/v4가 정확히 알려진 버그 있는 본문(v3/v1 위임)을 갖고 있으며,
--    core_v2가 아직 없는지 확인한다.
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regprocedure('public.payroll_create_contract_version_v6(bigint,text,numeric,numeric,numeric,date,bigint,text)') is null then
    raise exception 'PAYROLL_FIXED_MONTHLY_DELEGATE_FIX_PREFLIGHT_MISSING_V6_CREATE';
  end if;
  if to_regprocedure('public.payroll_correct_latest_unused_contract_v4(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text)') is null then
    raise exception 'PAYROLL_FIXED_MONTHLY_DELEGATE_FIX_PREFLIGHT_MISSING_V4_CORRECT';
  end if;
  if to_regprocedure('public.payroll_create_contract_version_v2(bigint,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text)') is null then
    raise exception 'PAYROLL_FIXED_MONTHLY_DELEGATE_FIX_PREFLIGHT_MISSING_V2_CREATE';
  end if;
  if to_regprocedure('public.payroll_correct_latest_unused_contract_v1(bigint,bigint,bigint,bigint,date,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text,text)') is null then
    raise exception 'PAYROLL_FIXED_MONTHLY_DELEGATE_FIX_PREFLIGHT_MISSING_V1_CORRECT';
  end if;
  if to_regprocedure('public.payroll_correct_latest_unused_contract_core_v2(bigint,bigint,bigint,bigint,date,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text,text)') is not null then
    raise exception 'PAYROLL_FIXED_MONTHLY_DELEGATE_FIX_PREFLIGHT_CORE_V2_ALREADY_EXISTS';
  end if;
end
$$;

do $$
declare
  v_v6_def text;
  v_v4_def text;
begin
  select pg_get_functiondef(p.oid) into v_v6_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'payroll_create_contract_version_v6';
  if v_v6_def is null or position('return public.payroll_create_contract_version_v3(p_user_id,''monthly'',''fixed_monthly''' in v_v6_def) = 0 then
    raise exception 'PAYROLL_FIXED_MONTHLY_DELEGATE_FIX_PREFLIGHT_V6_UNEXPECTED_BODY';
  end if;

  select pg_get_functiondef(p.oid) into v_v4_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'payroll_correct_latest_unused_contract_v4';
  if v_v4_def is null or position('return public.payroll_correct_latest_unused_contract_v1(' in v_v4_def) = 0 then
    raise exception 'PAYROLL_FIXED_MONTHLY_DELEGATE_FIX_PREFLIGHT_V4_UNEXPECTED_BODY';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. payroll_correct_latest_unused_contract_core_v2 — v1의 본문을 그대로 재사용하되
--    position='owner' 전용 게이트만 제거한 정책 중립 정정 코어. "누가 fixed_monthly를
--    쓸 수 있는가"는 호출자(v4)의 몫이고, 코어는 fixed_monthly/monthly 짝과 매월 1일
--    적용만 데이터 정합성으로 검사한다.
-- ---------------------------------------------------------------------------

create or replace function public.payroll_correct_latest_unused_contract_core_v2(
  p_contract_id bigint,
  p_user_id bigint,
  p_expected_revision bigint,
  p_expected_audit_log_id bigint,
  p_expected_effective_from date,
  p_pay_type text,
  p_calculation_basis text,
  p_base_salary numeric,
  p_fixed_raise_amount numeric,
  p_standard_workdays numeric,
  p_standard_minutes_per_day integer,
  p_time_block_minutes integer,
  p_rounding_mode text,
  p_late_adjustment_mode text,
  p_early_leave_adjustment_mode text,
  p_overtime_mode text,
  p_paid_leave_mode text,
  p_effective_from date,
  p_actor_user_id bigint,
  p_note text,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contract public.payroll_contract_versions%rowtype;
  v_corrected public.payroll_contract_versions%rowtype;
  v_latest_id bigint;
  v_latest_audit_log_id bigint;
  v_before jsonb;
  v_used boolean := false;
begin
  if nullif(btrim(p_reason), '') is null then return jsonb_build_object('status', 'correction_reason_required'); end if;
  if p_contract_id is null or p_user_id is null or p_expected_revision is null or p_expected_audit_log_id is null
     or p_expected_effective_from is null or p_effective_from is null or p_pay_type is null
     or p_calculation_basis is null or p_base_salary is null or p_fixed_raise_amount is null
     or p_standard_minutes_per_day is null or p_time_block_minutes is null or p_rounding_mode is null
     or p_late_adjustment_mode is null or p_early_leave_adjustment_mode is null
     or p_overtime_mode is null or p_paid_leave_mode is null or p_actor_user_id is null
  then return jsonb_build_object('status', 'invalid_contract'); end if;
  if p_base_salary < 0 or p_base_salary <> trunc(p_base_salary) then return jsonb_build_object('status', 'invalid_contract'); end if;
  if p_fixed_raise_amount < 0 or p_fixed_raise_amount <> trunc(p_fixed_raise_amount) then return jsonb_build_object('status', 'invalid_contract'); end if;
  if p_pay_type not in ('monthly', 'daily', 'hourly')
     or p_calculation_basis not in ('minute', 'hour', 'day', 'fixed_monthly')
     or p_rounding_mode not in ('none', 'floor', 'ceil', 'nearest')
     or p_late_adjustment_mode not in ('separate', 'deduct_minutes', 'ignore')
     or p_early_leave_adjustment_mode not in ('separate', 'deduct_minutes', 'ignore')
     or p_overtime_mode not in ('requires_approval', 'ignore')
     or p_paid_leave_mode not in ('manual_review', 'paid', 'unpaid')
     or p_standard_minutes_per_day not between 1 and 1440
     or p_time_block_minutes not between 1 and 1440
     or (p_pay_type = 'hourly' and p_calculation_basis = 'day')
     or (p_pay_type <> 'monthly' and p_fixed_raise_amount <> 0)
     or (p_pay_type = 'monthly' and (p_standard_workdays is null or p_standard_workdays <= 0))
     or (p_pay_type <> 'monthly' and p_standard_workdays is not null)
  then return jsonb_build_object('status', 'invalid_contract'); end if;

  perform 1 from public.users
  where id = p_actor_user_id and is_active = true and role in ('owner', 'master');
  if not found then return jsonb_build_object('status', 'forbidden'); end if;

  perform 1 from public.users
  where id = p_user_id and is_active = true and is_system_account = false;
  if not found then return jsonb_build_object('status', 'user_not_found'); end if;

  -- 정책 중립: 이 코어는 대상의 position/role을 조회하지 않는다. "이 사람이 fixed_monthly를
  -- 쓸 수 있는가"는 호출자가 이미 판정해서 p_calculation_basis로 넘긴 값을 그대로 믿는다.
  -- 대신 fixed_monthly 자체의 데이터 정합성(monthly와만 짝, 매월 1일 적용)은 누가 호출하든
  -- 동일하게 강제한다.
  if p_calculation_basis = 'fixed_monthly' and p_pay_type <> 'monthly' then
    return jsonb_build_object('status', 'invalid_contract');
  end if;
  if p_calculation_basis = 'fixed_monthly' and extract(day from p_effective_from) <> 1 then
    return jsonb_build_object('status', 'invalid_fixed_monthly_effective_date');
  end if;

  perform pg_advisory_xact_lock(p_user_id);
  select * into v_contract
  from public.payroll_contract_versions
  where id = p_contract_id and user_id = p_user_id
  for update;
  if not found then return jsonb_build_object('status', 'contract_not_found'); end if;
  if v_contract.revision <> p_expected_revision then return jsonb_build_object('status', 'revision_conflict'); end if;
  select max(id) into v_latest_audit_log_id
  from public.payroll_contract_audit_logs
  where contract_version_id = v_contract.id;
  if v_latest_audit_log_id is distinct from p_expected_audit_log_id then
    return jsonb_build_object('status', 'revision_conflict');
  end if;
  if p_fixed_raise_amount <> v_contract.fixed_raise_amount and nullif(btrim(p_note), '') is null then
    return jsonb_build_object('status', 'fixed_raise_reason_required');
  end if;
  if v_contract.effective_from <> p_expected_effective_from or p_effective_from <> v_contract.effective_from then
    return jsonb_build_object('status', 'effective_from_change_forbidden');
  end if;

  select id into v_latest_id
  from public.payroll_contract_versions
  where user_id = p_user_id
  order by revision desc, effective_from desc, id desc
  limit 1;
  if v_latest_id <> v_contract.id then return jsonb_build_object('status', 'not_latest_contract'); end if;

  if exists (
    select 1 from public.payroll_contract_versions other
    where other.user_id = p_user_id and other.id <> v_contract.id
      and daterange(other.effective_from, coalesce(other.effective_to, 'infinity'::date), '[)')
          && daterange(v_contract.effective_from, coalesce(v_contract.effective_to, 'infinity'::date), '[)')
  ) then return jsonb_build_object('status', 'period_conflict'); end if;

  select exists (
    select 1
    from public.payroll_run_employees employee
    join public.payroll_runs run on run.id = employee.payroll_run_id
    where employee.user_id = p_user_id
      and run.status in ('finalized', 'paid')
      and (
        jsonb_path_exists(employee.contract_snapshot, '$[*] ? (@.id == $contractId || @.revision == $revision)', jsonb_build_object('contractId', p_contract_id, 'revision', p_expected_revision))
        or jsonb_path_exists(employee.attendance_snapshot, '$.** ? (@.contractRevision == $revision)', jsonb_build_object('revision', p_expected_revision))
      )
  ) into v_used;
  if v_used then return jsonb_build_object('status', 'locked_payroll_contract'); end if;

  select exists (
    select 1
    from public.payroll_run_employees employee
    where employee.user_id = p_user_id
      and (
        jsonb_path_exists(employee.contract_snapshot, '$[*] ? (@.id == $contractId || @.revision == $revision)', jsonb_build_object('contractId', p_contract_id, 'revision', p_expected_revision))
        or jsonb_path_exists(employee.attendance_snapshot, '$.** ? (@.contractRevision == $revision)', jsonb_build_object('revision', p_expected_revision))
        or exists (
          select 1 from public.payroll_run_items item
          where item.payroll_run_employee_id = employee.id
            and jsonb_path_exists(item.source_snapshot, '$.** ? (@.contractId == $contractId || @.contractRevision == $revision)', jsonb_build_object('contractId', p_contract_id, 'revision', p_expected_revision))
        )
        or exists (
          select 1 from public.payroll_run_reviews review
          where review.payroll_run_employee_id = employee.id
            and jsonb_path_exists(review.source_snapshot, '$.** ? (@.contractId == $contractId || @.contractRevision == $revision)', jsonb_build_object('contractId', p_contract_id, 'revision', p_expected_revision))
        )
      )
  ) into v_used;
  if v_used then return jsonb_build_object('status', 'contract_already_used'); end if;

  v_before := to_jsonb(v_contract);
  update public.payroll_contract_versions set
    pay_type = p_pay_type,
    calculation_basis = p_calculation_basis,
    base_salary = p_base_salary,
    fixed_raise_amount = p_fixed_raise_amount,
    standard_workdays = p_standard_workdays,
    standard_minutes_per_day = p_standard_minutes_per_day,
    time_block_minutes = p_time_block_minutes,
    rounding_mode = p_rounding_mode,
    late_adjustment_mode = p_late_adjustment_mode,
    early_leave_adjustment_mode = p_early_leave_adjustment_mode,
    overtime_mode = p_overtime_mode,
    paid_leave_mode = p_paid_leave_mode,
    note = nullif(btrim(p_note), '')
  where id = v_contract.id and revision = p_expected_revision
  returning * into v_corrected;
  if not found then return jsonb_build_object('status', 'revision_conflict'); end if;

  insert into public.payroll_contract_audit_logs(
    contract_version_id, user_id, action, actor_user_id, snapshot, reason
  ) values (
    v_corrected.id, v_corrected.user_id, 'corrected', p_actor_user_id,
    jsonb_build_object(
      'contractId', v_corrected.id,
      'userId', v_corrected.user_id,
      'revision', v_corrected.revision,
      'effectiveFrom', v_corrected.effective_from,
      'before', v_before,
      'after', to_jsonb(v_corrected),
      'actorUserId', p_actor_user_id,
      'correctedAt', now(),
      'reason', btrim(p_reason)
    ),
    btrim(p_reason)
  );
  return jsonb_build_object('status', 'corrected', 'contract', to_jsonb(v_corrected));
exception
  when exclusion_violation then return jsonb_build_object('status', 'period_conflict');
end $$;

revoke all on function public.payroll_correct_latest_unused_contract_core_v2(bigint,bigint,bigint,bigint,date,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text,text) from public, anon, authenticated;
grant execute on function public.payroll_correct_latest_unused_contract_core_v2(bigint,bigint,bigint,bigint,date,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text,text) to service_role;

comment on function public.payroll_correct_latest_unused_contract_core_v2(bigint,bigint,bigint,bigint,date,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text,text)
  is 'payroll_correct_latest_unused_contract_v1과 동일한 revision conflict/최신 계약/급여 사용 잠금/기간 충돌/audit log 코어이지만, position=''owner''만 fixed_monthly를 허용하던 정책 게이트를 제거했다. 대상이 fixed_monthly를 쓸 수 있는지는 호출자(v4)가 판정해서 calculation_basis로 넘긴다 — 이 함수는 fixed_monthly가 monthly와 짝을 이루는지, 매월 1일부터 적용되는지만 검사한다. payroll_correct_latest_unused_contract_v4가 호출하는 코어.';

-- ---------------------------------------------------------------------------
-- 2. payroll_create_contract_version_v6 hotfix — fixed_monthly 분기가 더 이상
--    payroll_create_contract_version_v3(position='owner' 게이트 있음)를 거치지 않고
--    payroll_create_contract_version_v2(정책 중립)를 직접 호출한다. 매월 1일 적용
--    검증은 v6 자신이 새로 갖춘다. v_is_fixed_monthly_target 판정식과 근태 사용 분기는
--    변경하지 않는다.
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
    -- v3는 position='owner'가 아니면 fixed_monthly를 fixed_monthly_owner_only로 거부해서
    -- 근태 미사용 non-owner 계약 저장이 항상 실패했다(운영 오류 원인). v2는 owner/position
    -- 판정을 하지 않으므로 v6이 이미 끝낸 위 판정을 다시 뒤집지 않는다. v3에는 없던 매월
    -- 1일 적용 검증은 여기서 직접 한다.
    if extract(day from p_effective_from) <> 1 then
      return jsonb_build_object('status','invalid_fixed_monthly_effective_date');
    end if;
    return public.payroll_create_contract_version_v2(p_user_id,'monthly','fixed_monthly',p_base_salary,p_fixed_raise_amount,p_standard_workdays,540,1,'none','ignore','ignore','ignore','unpaid',p_effective_from,p_actor_user_id,p_note);
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
  'payroll_create_contract_version_v5와 동일한 월 고정급 판정(role in (''owner'',''master'') or attendance_tracking_enabled = false)을 쓰되, fixed_monthly 분기에서 position=''owner'' 게이트가 있는 v3 대신 정책 중립인 payroll_create_contract_version_v2를 직접 호출하고 매월 1일 적용을 v6 자신이 검증한다(202608070003 hotfix). role을 owner로 바꾸지 않는다. 계약 생성 API가 호출하는 최신 버전.';

-- ---------------------------------------------------------------------------
-- 3. payroll_correct_latest_unused_contract_v4 hotfix — payroll_correct_latest_unused_contract_v1
--    (position='owner' 게이트 있음) 대신 payroll_correct_latest_unused_contract_core_v2를
--    호출한다. v_is_fixed_monthly_target 판정식과 근태 사용 분기는 변경하지 않는다.
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
  return public.payroll_correct_latest_unused_contract_core_v2(p_contract_id,p_user_id,p_expected_revision,p_expected_audit_log_id,p_expected_effective_from,p_pay_type,v_basis,p_base_salary,p_fixed_raise_amount,p_standard_workdays,v_minutes,1,'none','ignore','ignore',case when v_is_fixed_monthly_target then 'ignore' else 'requires_approval' end,'unpaid',p_effective_from,p_actor_user_id,p_note,p_reason);
end $$;

revoke all on function public.payroll_correct_latest_unused_contract_v4(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text) from public,anon,authenticated;
grant execute on function public.payroll_correct_latest_unused_contract_v4(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text) to service_role;
comment on function public.payroll_correct_latest_unused_contract_v4(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text) is
  'payroll_correct_latest_unused_contract_v3와 동일한 월 고정급 판정을 쓰되, position=''owner'' 게이트가 있는 v1 대신 정책 중립인 payroll_correct_latest_unused_contract_core_v2를 호출한다(202608070003 hotfix). role을 owner로 바꾸지 않는다. 계약 정정 API가 호출하는 최신 버전.';

commit;
