-- BABA 레거시 구조 Cleanup Phase 1-B: default_normal_checkout_time 완전 제거.
--
-- 배경: 근태 통합정책 엔진(lib/attendance/policy-engine.ts)은 evaluateAttendancePolicy()
-- 도입 이후 "특별 조기마감이 있으면 그 시각, 없으면 요일별 매장 마감시간"과 직원별
-- 예정 퇴근시간을 조합해 조퇴·미퇴근 기준을 계산하며, default_normal_checkout_time은
-- 그 코드에 명시된 대로("default_normal_checkout_time은 더 이상 참조하지 않는다")
-- 더 이상 어떤 계산에도 쓰이지 않는다. lib/store-settings/types.ts에도 이미
-- @deprecated로 표시되어 있었다.
--
-- 이 Migration 작성 직전 재확인한 결과:
--   - 관리자 설정 UI(/admin/settings/store)에는 이 값을 직접 편집하는 입력 컨트롤이
--     없다 — 기존 서버값을 그대로 다시 전송하는 호환 payload로만 남아 있었다.
--   - public 스키마의 일반 함수(prokind='f') 중 이 컬럼을 실제로 참조하는 것은
--     store_schedule_settings_v1(쓰기)과 store_setting_snapshot_v1(읽어서 JSON에
--     포함) 두 개뿐이다(pg_get_functiondef 텍스트 검색으로 확인). 이 두 함수를
--     각각 정리하지 않고 컬럼만 먼저 지우면 store_get_settings_overview_v1 등 이
--     snapshot 함수를 호출하는 모든 경로(근태 조회·퇴근·payroll 계산·근태 Shadow
--     전부)가 즉시 깨지므로, 반드시 함수 두 개를 먼저 고친 뒤 컬럼을 지운다.
--   - 이 컬럼에 걸린 trigger는 없다(pg_trigger 전수 확인, 7개 trigger 중 0개).
--   - public 스키마에 view 자체가 없다(pg_views 전수 확인).
--   - RLS policy는 store_attendance_policies에 없다(기존과 동일, REVOKE/GRANT만 사용).
--
-- late_grace_minutes / early_leave_grace_minutes / missing_checkout_grace_minutes와
-- store_business_hours, business_day_cutoff_time, store_business_day_overrides 등
-- 실제 계산에 쓰이는 다른 근태·매장 정책 값은 이번 Migration에서 전혀 건드리지 않는다.
-- 과거 store_setting_versions/store_setting_audit_logs 이력도 그대로 보존한다.
--
-- store_schedule_settings_v1은 인자 개수가 바뀌므로(같은 signature로 유지 불가)
-- 이 프로젝트가 이 함수에 이미 두 번 적용한 선례(202607240001, 202607250001)와
-- 동일하게 DROP 후 같은 이름으로 새 signature를 재생성한다 — 불필요한 v2 이름을
-- 새로 만들지 않는다. store_setting_snapshot_v1은 인자가 그대로이므로 CREATE OR
-- REPLACE만으로 충분하다(기존 grant가 함수 OID에 그대로 유지된다).

begin;

-- ---------------------------------------------------------------------------
-- 1. store_schedule_settings_v1: p_default_normal_checkout_time 인자 제거.
-- ---------------------------------------------------------------------------

drop function public.store_schedule_settings_v1(
  p_effective_from_business_date date,
  p_expected_revision bigint,
  p_timezone text,
  p_business_day_cutoff_time time without time zone,
  p_hours jsonb,
  p_actor_user_id bigint,
  p_late_grace_minutes integer,
  p_default_normal_checkout_time time without time zone,
  p_early_leave_grace_minutes integer,
  p_missing_checkout_grace_minutes integer
);

create function public.store_schedule_settings_v1(
  p_effective_from_business_date date,
  p_expected_revision bigint,
  p_timezone text,
  p_business_day_cutoff_time time without time zone,
  p_hours jsonb,
  p_actor_user_id bigint,
  p_late_grace_minutes integer,
  p_early_leave_grace_minutes integer default 0,
  p_missing_checkout_grace_minutes integer default 60
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_current_business_date date := public.store_business_date_for_timestamp_v1(now());
  v_latest_revision bigint;
  v_version_id bigint;
  v_item jsonb;
  v_weekday integer;
  v_is_closed boolean;
  v_open time;
  v_close time;
begin
  perform pg_advisory_xact_lock(hashtext('store_settings_schedule_v1'));

  select role::text into v_role
  from public.users
  where id = p_actor_user_id and is_active = true;

  if lower(coalesce(v_role, '')) not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;

  select coalesce(max(revision), 0) into v_latest_revision
  from public.store_setting_versions;

  if p_expected_revision is distinct from v_latest_revision then
    return jsonb_build_object(
      'status', 'version_conflict',
      'latestRevision', v_latest_revision
    );
  end if;
  if p_effective_from_business_date <= v_current_business_date then
    return jsonb_build_object('status', 'invalid_effective_date');
  end if;
  if p_timezone <> 'Asia/Ho_Chi_Minh' then
    return jsonb_build_object('status', 'invalid_timezone');
  end if;
  if p_late_grace_minutes not between 0 and 180
    or p_early_leave_grace_minutes not between 0 and 180
    or p_missing_checkout_grace_minutes not between 0 and 360
  then
    return jsonb_build_object('status', 'invalid_attendance_policy');
  end if;
  if p_hours is null
    or jsonb_typeof(p_hours) <> 'array'
    or jsonb_array_length(p_hours) <> 7
  then
    return jsonb_build_object('status', 'invalid_hours');
  end if;
  if exists (
    select 1
    from public.store_setting_versions
    where state = 'active'
      and effective_from_business_date > v_current_business_date
  ) then
    return jsonb_build_object('status', 'scheduled_exists');
  end if;

  insert into public.store_setting_versions (
    timezone,
    business_day_cutoff_time,
    effective_from_business_date,
    revision,
    created_by
  )
  values (
    p_timezone,
    p_business_day_cutoff_time,
    p_effective_from_business_date,
    v_latest_revision + 1,
    p_actor_user_id
  )
  returning id into v_version_id;

  insert into public.store_attendance_policies (
    setting_version_id,
    late_grace_minutes,
    early_leave_grace_minutes,
    missing_checkout_grace_minutes
  )
  values (
    v_version_id,
    p_late_grace_minutes,
    p_early_leave_grace_minutes,
    p_missing_checkout_grace_minutes
  );

  for v_item in select value from jsonb_array_elements(p_hours) loop
    if jsonb_typeof(v_item) <> 'object'
      or not (v_item ?& array['weekday','isClosed','openTime','closeTime'])
      or (select count(*) from jsonb_object_keys(v_item)) <> 4
      or jsonb_typeof(v_item->'weekday') <> 'number'
      or jsonb_typeof(v_item->'isClosed') <> 'boolean'
    then
      raise check_violation using message = 'invalid hours object';
    end if;

    v_weekday := (v_item->>'weekday')::integer;
    v_is_closed := (v_item->>'isClosed')::boolean;
    v_open := nullif(v_item->>'openTime', '')::time;
    v_close := nullif(v_item->>'closeTime', '')::time;

    insert into public.store_business_hours (
      setting_version_id,
      weekday,
      is_closed,
      open_time,
      close_time
    )
    values (v_version_id, v_weekday, v_is_closed, v_open, v_close);
  end loop;

  if (
    select count(*)
    from public.store_business_hours
    where setting_version_id = v_version_id
  ) <> 7 then
    raise check_violation using message = 'seven weekdays required';
  end if;

  insert into public.store_setting_audit_logs (
    setting_version_id,
    action,
    actor_user_id,
    after_snapshot
  )
  values (
    v_version_id,
    'created',
    p_actor_user_id,
    public.store_setting_snapshot_v1(v_version_id)
  );

  return jsonb_build_object(
    'status', 'ok',
    'setting', public.store_setting_snapshot_v1(v_version_id),
    'latestRevision', v_latest_revision + 1
  );
exception
  when check_violation
    or unique_violation
    or not_null_violation
    or invalid_text_representation
    or invalid_datetime_format
    or datetime_field_overflow
  then
    return jsonb_build_object('status', 'invalid_hours');
end
$$;

-- 새로 CREATE된 함수는 기본적으로 PUBLIC에 EXECUTE가 열리므로, 기존과 동일하게
-- grantee별로 명시적으로 잠근다(202607250001의 선례와 동일한 스타일).
revoke all on function public.store_schedule_settings_v1(
  date, bigint, text, time without time zone, jsonb, bigint, integer, integer, integer
) from public;

revoke all on function public.store_schedule_settings_v1(
  date, bigint, text, time without time zone, jsonb, bigint, integer, integer, integer
) from anon;

revoke all on function public.store_schedule_settings_v1(
  date, bigint, text, time without time zone, jsonb, bigint, integer, integer, integer
) from authenticated;

grant execute on function public.store_schedule_settings_v1(
  date, bigint, text, time without time zone, jsonb, bigint, integer, integer, integer
) to service_role;

-- ---------------------------------------------------------------------------
-- 2. store_setting_snapshot_v1: 인자는 그대로(p_version_id bigint)이므로 CREATE OR
--    REPLACE만으로 처리한다 — 기존 grant는 함수 OID가 유지되어 자동으로 보존된다.
--    attendancePolicy JSON에서 defaultNormalCheckoutTime 키만 제거한다.
-- ---------------------------------------------------------------------------

create or replace function public.store_setting_snapshot_v1(p_version_id bigint)
returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'id', v.id,
    'timezone', v.timezone,
    'businessDayCutoffTime', to_char(v.business_day_cutoff_time, 'HH24:MI'),
    'effectiveFromBusinessDate', to_char(v.effective_from_business_date, 'YYYY-MM-DD'),
    'revision', v.revision,
    'state', v.state,
    'createdBy', v.created_by,
    'createdAt', v.created_at,
    'cancelledBy', v.cancelled_by,
    'cancelledAt', v.cancelled_at,
    'attendancePolicy', jsonb_build_object(
      'lateGraceMinutes', coalesce(p.late_grace_minutes, 0),
      'earlyLeaveGraceMinutes', coalesce(p.early_leave_grace_minutes, 0),
      'missingCheckoutGraceMinutes', coalesce(p.missing_checkout_grace_minutes, 60)
    ),
    'hours', coalesce((
      select jsonb_agg(jsonb_build_object(
        'weekday', h.weekday,
        'isClosed', h.is_closed,
        'openTime', case when h.open_time is null then null else to_char(h.open_time, 'HH24:MI') end,
        'closeTime', case when h.close_time is null then null else to_char(h.close_time, 'HH24:MI') end
      ) order by h.weekday)
      from public.store_business_hours h
      where h.setting_version_id = v.id
    ), '[]'::jsonb)
  )
  from public.store_setting_versions v
  left join public.store_attendance_policies p
    on p.setting_version_id = v.id
  where v.id = p_version_id
$$;

-- ---------------------------------------------------------------------------
-- 3. store_attendance_policies.default_normal_checkout_time 컬럼 제거.
--    이 시점에는 이 컬럼을 참조하는 함수가 하나도 없음을 위 1·2번에서 이미
--    보장했다(재확인: 이번 Migration 작성 전 public 스키마 전체에서 이 컬럼을
--    참조하는 일반 함수는 store_schedule_settings_v1/store_setting_snapshot_v1
--    둘뿐이었다). trigger/view/policy 의존 없음(CASCADE 미사용).
-- ---------------------------------------------------------------------------

alter table public.store_attendance_policies
  drop column default_normal_checkout_time;

commit;
