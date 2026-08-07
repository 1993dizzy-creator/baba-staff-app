-- Phase 1-D2: BAR keeping 구버전 mutation RPC 실제 제거
--
-- 배경
--   Phase 1-D(202608080001_flatten_bar_keeping_rpcs.sql)에서 bar_mutate_keeping_v5와
--   bar_update_and_move_keeping을 구버전 delegation 없이 완전히 독립적인 로직으로
--   재작성했다. 그 결과 아래 4개 함수는 더 이상 어떤 코드에서도 호출되지 않는
--   완전한 orphan이 되었다(Phase 1-D2 착수 전 운영 DB에서 재확인 완료):
--     - bar_mutate_keeping        (base)
--     - bar_mutate_keeping_v2
--     - bar_mutate_keeping_v3
--     - bar_mutate_keeping_v4
--
-- 재확인한 dependency 결과(모두 0)
--   - application runtime(app/, lib/, components/, scripts/) 참조: 0
--     (supabase/functions 디렉터리 자체가 이 repo에 존재하지 않음)
--   - public schema 내 다른 함수 body에서의 호출: 0
--     (pg_get_functiondef 전수 조사, bar_mutate_keeping_v5/bar_update_and_move_keeping 포함)
--   - pg_depend(암시적 타입 종속 제외), trigger, view, materialized view, RLS policy,
--     column default expression: 0
--   - EXECUTE 권한은 postgres/service_role에만 부여되어 있었고 anon/authenticated
--     노출은 없었음(DROP으로 권한도 함께 사라지므로 별도 REVOKE 불필요)
--
-- 이번 migration이 하는 일
--   위 4개 함수를 정확한 identity signature로 DROP한다. CASCADE는 사용하지 않는다
--   (의존 객체가 전혀 없음을 이미 확인했으므로 필요하지도 않다).
--   그 외 어떤 함수도 CREATE/CREATE OR REPLACE하지 않고, 어떤 테이블도 건드리지
--   않으며, 데이터 변경도 없다.
--
--   보호 대상(이번 migration이 절대 건드리지 않음): bar_mutate_keeping_v5,
--   bar_update_and_move_keeping, bar_delete_active_keeping_v1, bar_delete_keeping_v2,
--   bar_create_keeping(현재 사용 중인 14-arg 오버로드 포함 전체), bar_update_zone,
--   bar_update_zone_photo, bar_keepings, bar_activity_logs, bar_zones 등 모든 테이블,
--   inventory, sales, users.
--
-- 운영 DB 적용 여부: 이번 turn에서는 로컬 migration 작성 + 로컬 검증까지만
-- 진행하며, 운영 Supabase에는 어떤 DDL도 실행하지 않는다.

begin;

drop function public.bar_mutate_keeping(
  p_id bigint,
  p_expected_version integer,
  p_action text,
  p_payload jsonb,
  p_actor_user_id bigint
);

drop function public.bar_mutate_keeping_v2(
  p_id bigint,
  p_expected_version integer,
  p_action text,
  p_payload jsonb,
  p_actor_user_id bigint
);

drop function public.bar_mutate_keeping_v3(
  p_id bigint,
  p_expected_version integer,
  p_action text,
  p_payload jsonb,
  p_actor_user_id bigint
);

drop function public.bar_mutate_keeping_v4(
  p_id bigint,
  p_expected_version integer,
  p_action text,
  p_payload jsonb,
  p_actor_user_id bigint
);

commit;
