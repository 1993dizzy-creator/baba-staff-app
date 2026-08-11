begin;

-- 공통 설정 저장을 payroll_settings, 식대 정책, 개근 보너스 정책까지 하나의
-- transaction으로 확장한다. 기존 v1은 이미 적용된 호환 경로이므로 그대로 두고 호출한다.
create function public.payroll_update_common_settings_v2(
  p_actor_user_id bigint,
  p_payment_day integer,
  p_employee_insurance_rate_bp integer,
  p_employer_insurance_rate_bp integer,
  p_director_insurance_enabled boolean,
  p_director_insurance_base_amount numeric,
  p_director_insurance_rate_bp integer,
  p_late_major_threshold_minutes integer,
  p_late_minor_penalty_minutes integer,
  p_late_major_penalty_rate_bp integer,
  p_unauthorized_absence_penalty_days integer,
  p_meal_daily_amount numeric default null,
  p_meal_effective_from date default null,
  p_meal_note text default null,
  p_bonus_minimum_actual_workdays integer default null,
  p_bonus_allowed_late_count integer default null,
  p_bonus_allowed_early_leave_count integer default null,
  p_bonus_amount numeric default null,
  p_bonus_effective_month date default null,
  p_bonus_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_current_month date := date_trunc('month', now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_result jsonb;
  v_bonus_current public.payroll_attendance_bonus_policy_versions%rowtype;
  v_bonus_created public.payroll_attendance_bonus_policy_versions%rowtype;
  v_bonus_revision bigint;
  v_bonus_changed boolean := false;
  v_bonus_supplied boolean := p_bonus_minimum_actual_workdays is not null
    or p_bonus_allowed_late_count is not null
    or p_bonus_allowed_early_leave_count is not null
    or p_bonus_amount is not null
    or p_bonus_effective_month is not null;
begin
  perform public.payroll_assert_actor_v2(p_actor_user_id);

  if v_bonus_supplied and (
    p_bonus_minimum_actual_workdays is null
    or p_bonus_allowed_late_count is null
    or p_bonus_allowed_early_leave_count is null
    or p_bonus_amount is null
    or p_bonus_effective_month is null
  ) then
    raise exception 'INVALID_ATTENDANCE_BONUS_POLICY' using errcode = '22023';
  end if;
  if v_bonus_supplied and (
    p_bonus_effective_month <> date_trunc('month', p_bonus_effective_month)::date
    or p_bonus_effective_month < v_current_month
  ) then
    raise exception 'ATTENDANCE_BONUS_INVALID_EFFECTIVE_MONTH' using errcode = '22023';
  end if;
  if v_bonus_supplied and (
    p_bonus_minimum_actual_workdays <= 0
    or p_bonus_allowed_late_count < 0
    or p_bonus_allowed_early_leave_count < 0
    or p_bonus_amount <= 0
    or p_bonus_amount <> trunc(p_bonus_amount)
  ) then
    raise exception 'INVALID_ATTENDANCE_BONUS_POLICY' using errcode = '22023';
  end if;

  -- v1의 payroll_settings + 식대 처리는 이 함수와 같은 DB transaction에 참여한다.
  -- 아래 개근 처리에서 실패하면 v1이 수행한 변경도 함께 롤백된다.
  v_result := public.payroll_update_common_settings_v1(
    p_actor_user_id,
    p_payment_day,
    p_employee_insurance_rate_bp,
    p_employer_insurance_rate_bp,
    p_director_insurance_enabled,
    p_director_insurance_base_amount,
    p_director_insurance_rate_bp,
    p_late_major_threshold_minutes,
    p_late_minor_penalty_minutes,
    p_late_major_penalty_rate_bp,
    p_unauthorized_absence_penalty_days,
    p_meal_daily_amount,
    p_meal_effective_from,
    p_meal_note
  );

  if v_bonus_supplied then
    perform pg_advisory_xact_lock(hashtext('payroll_attendance_bonus_policy_versions'));
    select * into v_bonus_current
    from public.payroll_attendance_bonus_policy_versions
    order by effective_month desc, revision desc
    limit 1;

    if not found
      or v_bonus_current.effective_month is distinct from p_bonus_effective_month
      or v_bonus_current.minimum_actual_workdays is distinct from p_bonus_minimum_actual_workdays
      or v_bonus_current.allowed_late_count is distinct from p_bonus_allowed_late_count
      or v_bonus_current.allowed_early_leave_count is distinct from p_bonus_allowed_early_leave_count
      or v_bonus_current.bonus_amount is distinct from p_bonus_amount
      or v_bonus_current.note is distinct from nullif(btrim(p_bonus_note), '') then
      select coalesce(max(revision), 0) + 1 into v_bonus_revision
      from public.payroll_attendance_bonus_policy_versions;
      insert into public.payroll_attendance_bonus_policy_versions (
        effective_month, minimum_actual_workdays, allowed_late_count,
        allowed_early_leave_count, bonus_amount, revision, created_by, note
      ) values (
        p_bonus_effective_month, p_bonus_minimum_actual_workdays, p_bonus_allowed_late_count,
        p_bonus_allowed_early_leave_count, p_bonus_amount, v_bonus_revision, p_actor_user_id,
        nullif(btrim(p_bonus_note), '')
      ) returning * into v_bonus_created;
      v_bonus_changed := true;
    end if;
  end if;

  return v_result || jsonb_build_object(
    'attendanceBonusPolicyChanged', v_bonus_changed,
    'attendanceBonusPolicy', case when v_bonus_changed then to_jsonb(v_bonus_created) else null end
  );
end;
$$;

revoke all on function public.payroll_update_common_settings_v2(
  bigint, integer, integer, integer, boolean, numeric, integer, integer, integer, integer,
  integer, numeric, date, text, integer, integer, integer, numeric, date, text
) from public, anon, authenticated;
grant execute on function public.payroll_update_common_settings_v2(
  bigint, integer, integer, integer, boolean, numeric, integer, integer, integer, integer,
  integer, numeric, date, text, integer, integer, integer, numeric, date, text
) to service_role;

comment on function public.payroll_update_common_settings_v2(
  bigint, integer, integer, integer, boolean, numeric, integer, integer, integer, integer,
  integer, numeric, date, text, integer, integer, integer, numeric, date, text
) is
  '공통 payroll_settings, 식대 정책, 개근 보너스 정책을 원자적으로 저장한다. 개근 값이 생략되거나 최신 version과 같으면 새 revision을 만들지 않는다.';

commit;
