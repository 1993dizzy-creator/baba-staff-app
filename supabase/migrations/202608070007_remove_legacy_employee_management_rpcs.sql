-- BABA 레거시 구조 Cleanup Phase 1-C2: 직원관리 구버전 RPC 13개 완전 제거.
--
-- 배경: Phase 1-C(202608070006_flatten_employee_management_rpcs.sql, 운영 적용
-- 완료)에서 employee_update_profile_and_level_v9 / employee_create_with_schedule_v5 /
-- employee_rehire_with_level_policy_v3가 구버전 RPC(v8/v7, v4, reset_v1)에 위임하지
-- 않고 해당 로직을 전부 흡수한 독립 함수가 되었다. 그 결과 아래 13개는 더 이상 최신
-- entry로부터도, 다른 어떤 함수로부터도 호출되지 않는다.
--
-- 이 Migration 작성 직전 재확인한 결과(전부 0):
--   - app/, lib/, components/, tests/, scripts/ 전수 검색 — 13개 이름 중 어느 것도
--     실제 RPC 호출(.rpc("..."))로 참조되지 않는다. tests/에서 나오는 매치는 전부
--     과거 migration 파일(202608030001/202608040001/202608060001 등)의 내용을
--     검증하는 텍스트 assertion일 뿐, 현재 코드/DB 상태를 참조하지 않는다.
--   - public 스키마의 다른 어떤 일반 함수(prokind='f')도 이 13개를 호출하지 않는다
--     (pg_get_functiondef 텍스트 검색으로 재확인).
--   - 이 13개를 trigger function으로 쓰는 trigger가 없다(pg_trigger).
--   - 이 13개에 대한 pg_depend 의존(view/default expression 등)이 없다.
--   - Phase 1-C 이후 운영 DB의 v9/v5/v3 body를 재조회해 이들 중 어느 것도 v8/v7,
--     v1~v4(create), reset_v1/v2(rehire)를 더 이상 호출하지 않음을 재확인했다.
--
-- PostgREST로 외부에 노출된 RPC이지만, 이 프로젝트 밖에서 이 13개를 호출하는 별도
-- client는 존재하지 않는다(BABA 관리자 앱이 유일한 client이며, 그 앱은 v9/v5/v3만
-- 호출한다).
--
-- DROP 순서는 dependency가 전혀 없어(위 재확인 결과) family/버전 순서로만 정리했다.
-- CASCADE는 사용하지 않는다. table/데이터는 전혀 건드리지 않는다.
--
-- 절대 건드리지 않는 것: employee_update_profile_and_level_v9,
-- employee_create_with_schedule_v5, employee_rehire_with_level_policy_v3(이상
-- Phase 1-C 최신 entry), employee_create_work_schedule_version_v1(별도 급여 schedule
-- 기능, 이번 13개와 무관), employee_update_level_policy_v1(별도 고아 함수 — 이번
-- Phase 범위 밖, 후보로만 남겨둔다), users/employee_work_schedule_versions/
-- employee_level_program_versions/employee_level_audit_logs 등 어떤 테이블도.

begin;

-- ---------------------------------------------------------------------------
-- 1. employee_update_profile_and_level 구버전 7개 (v2~v8) — v9로 완전 대체됨.
-- ---------------------------------------------------------------------------

drop function public.employee_update_profile_and_level_v8(
  p_user_id bigint, p_updates jsonb, p_level_program_enabled boolean,
  p_base_date_override date, p_actor_id bigint, p_actor_username text
);

drop function public.employee_update_profile_and_level_v7(
  p_user_id bigint, p_updates jsonb, p_level_program_enabled boolean,
  p_base_date_override date, p_actor_id bigint, p_actor_username text
);

drop function public.employee_update_profile_and_level_v6(
  p_user_id bigint, p_updates jsonb, p_level_program_enabled boolean,
  p_effective_from date, p_base_date_mode text, p_base_date_override date,
  p_change_reason text, p_actor_id bigint, p_actor_username text
);

drop function public.employee_update_profile_and_level_v5(
  p_user_id bigint, p_updates jsonb, p_level_program_enabled boolean,
  p_effective_from date, p_change_reason text, p_actor_id bigint, p_actor_username text
);

drop function public.employee_update_profile_and_level_v4(
  p_user_id bigint, p_updates jsonb, p_level_program_enabled boolean,
  p_base_date_override date, p_actor_id bigint, p_actor_username text
);

drop function public.employee_update_profile_and_level_v3(
  p_user_id bigint, p_updates jsonb, p_level_program_enabled boolean,
  p_base_date_override date, p_actor_id bigint, p_actor_username text
);

drop function public.employee_update_profile_and_level_v2(
  p_user_id bigint, p_updates jsonb, p_base_date_override date,
  p_actor_id bigint, p_actor_username text
);

-- ---------------------------------------------------------------------------
-- 2. employee_create_with_schedule 구버전 4개 (v1~v4) — v5로 완전 대체됨.
-- ---------------------------------------------------------------------------

drop function public.employee_create_with_schedule_v4(
  p_employee jsonb, p_actor_id bigint, p_actor_username text
);

drop function public.employee_create_with_schedule_v3(
  p_employee jsonb, p_level_program_enabled boolean, p_change_reason text,
  p_actor_id bigint, p_actor_username text
);

drop function public.employee_create_with_schedule_v2(
  p_employee jsonb, p_level_program_enabled boolean, p_change_reason text,
  p_actor_id bigint, p_actor_username text
);

drop function public.employee_create_with_schedule_v1(
  p_employee jsonb, p_actor_id bigint, p_actor_username text
);

-- ---------------------------------------------------------------------------
-- 3. employee_rehire 구버전 2개 — v3로 완전 대체됨.
-- ---------------------------------------------------------------------------

drop function public.employee_rehire_with_level_policy_v2(
  p_user_id bigint, p_rehire_date date, p_level_program_enabled boolean,
  p_change_reason text, p_actor_id bigint, p_actor_username text, p_previous_level smallint
);

drop function public.employee_rehire_with_level_reset_v1(
  p_user_id bigint, p_rehire_date date, p_actor_id bigint, p_actor_username text,
  p_change_reason text, p_previous_level smallint
);

commit;
