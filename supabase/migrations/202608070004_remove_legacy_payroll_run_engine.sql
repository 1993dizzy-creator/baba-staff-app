-- BABA 레거시 구조 Cleanup Phase 1-A: 폐기된 급여 Run 엔진 완전 제거.
--
-- 배경: 202607270002_create_payroll_runs.sql에서 만든 payroll_runs/
-- payroll_run_employees/payroll_run_items/payroll_run_reviews/payroll_run_audit_logs
-- 5개 테이블과, 그 위에서 동작하던 payroll_create_run/payroll_recalculate_run/
-- payroll_insert_payload/payroll_refresh_totals/payroll_mutate_item/
-- payroll_resolve_review/payroll_transition_run 각 v2~v4(총 21개) RPC는
-- 202608050001_add_employee_payment_batches.sql이 만든 신규 직원별 지급 원장
-- (payroll_payment_batches / payroll_employee_payments / payroll_pay_employee_v1)
-- 으로 완전히 대체되었다.
--
-- 2차 레거시 전수조사(읽기 전용) 결과, 이 Migration을 작성하기 직전 다시 SELECT로
-- 재검증했을 때도 다음이 모두 사실이었다:
--   - app/, lib/, components/ 어디에서도 이 21개 RPC 이름 또는 5개 테이블 이름을
--     문자열로도 참조하지 않는다(employee-payment ledger로 완전 대체 완료).
--   - 이 21개 RPC의 body를 포함해 public 스키마의 다른 어떤 함수도 이들을
--     내부에서 호출하지 않는다(pg_get_functiondef 텍스트 검색으로 확인).
--   - 이 5개 테이블/21개 함수에 걸린 trigger가 없다(pg_trigger).
--   - public 스키마에 view/materialized view 자체가 없다(pg_views).
--   - 이 5개 테이블에 RLS policy가 없다(pg_policy) — row level security는
--     활성화돼 있으나 정책이 없어 기본적으로 전부 거부되는 상태였다.
--   - 이 5개 테이블로 들어오는 외부 FK가 없다(전부 테이블 계열 내부 또는
--     users로 나가는 단방향 FK만 존재).
--   - 5개 테이블 모두 실제 row 0건(정확한 COUNT(*) 재확인).
--
-- 이번 Migration은 이 죽은 payroll_run 엔진 1세트만 제거한다. 현재 운영 핵심인
-- payroll_payment_batches/payroll_employee_payments/payroll_payment_audit_logs/
-- payroll_pay_employee_v1과 그 외 급여계약/보험/식대/직원레벨 등 다른 어떤 이력
-- 테이블·함수에도 손대지 않는다. 기존 Migration 파일은 수정하지 않았다.

begin;

-- ---------------------------------------------------------------------------
-- 1. legacy RPC 21개 제거 (CASCADE 미사용 — 의존성이 없음을 위에서 재확인했으므로
--    RESTRICT 기본 동작으로 충분하고, 예상 밖 연쇄 삭제를 원천 차단한다)
-- ---------------------------------------------------------------------------

drop function public.payroll_create_run_v2(p_month date, p_calculated_at timestamptz, p_engine_version text, p_source_snapshot jsonb, p_employees jsonb, p_actor_user_id bigint);
drop function public.payroll_create_run_v3(p_month date, p_calculated_at timestamptz, p_engine_version text, p_source_snapshot jsonb, p_employees jsonb, p_actor_user_id bigint);
drop function public.payroll_create_run_v4(p_month date, p_calculated_at timestamptz, p_engine_version text, p_source_snapshot jsonb, p_employees jsonb, p_actor_user_id bigint);

drop function public.payroll_recalculate_run_v2(p_run_id bigint, p_calculated_at timestamptz, p_engine_version text, p_source_snapshot jsonb, p_employees jsonb, p_actor_user_id bigint);
drop function public.payroll_recalculate_run_v3(p_run_id bigint, p_calculated_at timestamptz, p_engine_version text, p_source_snapshot jsonb, p_employees jsonb, p_actor_user_id bigint);
drop function public.payroll_recalculate_run_v4(p_run_id bigint, p_calculated_at timestamptz, p_engine_version text, p_source_snapshot jsonb, p_employees jsonb, p_actor_user_id bigint);

drop function public.payroll_insert_payload_v2(p_run_id bigint, p_employees jsonb, p_actor_user_id bigint, p_copy_manual_from_run_id bigint);
drop function public.payroll_insert_payload_v3(p_run_id bigint, p_employees jsonb, p_actor_user_id bigint, p_copy_manual_from_run_id bigint);
drop function public.payroll_insert_payload_v4(p_run_id bigint, p_employees jsonb, p_actor_user_id bigint, p_copy_manual_from_run_id bigint);

drop function public.payroll_refresh_totals_v2(p_run_id bigint);
drop function public.payroll_refresh_totals_v3(p_run_id bigint);
drop function public.payroll_refresh_totals_v4(p_run_id bigint);

drop function public.payroll_mutate_item_v2(p_run_id bigint, p_run_employee_id bigint, p_item_id bigint, p_operation text, p_category text, p_direction text, p_amount bigint, p_description text, p_reason text, p_actor_user_id bigint);
drop function public.payroll_mutate_item_v3(p_run_id bigint, p_run_employee_id bigint, p_item_id bigint, p_operation text, p_category text, p_direction text, p_amount bigint, p_description text, p_reason text, p_actor_user_id bigint);
drop function public.payroll_mutate_item_v4(p_run_id bigint, p_run_employee_id bigint, p_item_id bigint, p_operation text, p_category text, p_direction text, p_amount bigint, p_description text, p_reason text, p_actor_user_id bigint);

drop function public.payroll_resolve_review_v2(p_run_id bigint, p_run_employee_id bigint, p_review_id bigint, p_action text, p_custom_minutes integer, p_reason text, p_actor_user_id bigint);
drop function public.payroll_resolve_review_v3(p_run_id bigint, p_run_employee_id bigint, p_review_id bigint, p_action text, p_custom_minutes integer, p_reason text, p_actor_user_id bigint);
drop function public.payroll_resolve_review_v4(p_run_id bigint, p_run_employee_id bigint, p_review_id bigint, p_action text, p_custom_minutes integer, p_reason text, p_actor_user_id bigint);

drop function public.payroll_transition_run_v2(p_run_id bigint, p_action text, p_reason text, p_payment_date date, p_payment_method text, p_payment_note text, p_actor_user_id bigint);
drop function public.payroll_transition_run_v3(p_run_id bigint, p_action text, p_reason text, p_payment_date date, p_payment_method text, p_payment_note text, p_actor_user_id bigint);
drop function public.payroll_transition_run_v4(p_run_id bigint, p_action text, p_reason text, p_payment_date date, p_payment_method text, p_payment_note text, p_actor_user_id bigint);

-- ---------------------------------------------------------------------------
-- 2. legacy 테이블 5개 제거 — child → parent 순서(CASCADE 미사용).
--    각 테이블 모두 Production row 0건, active code dependency 0건을 이 Migration
--    작성 직전 다시 확인했다. employee-payment ledger(payroll_payment_batches/
--    payroll_employee_payments/payroll_payment_audit_logs)로 대체가 이미 완료된
--    상태에서 한 번도 실제 급여 run이 이 구조로 만들어지지 않고 폐기되었다.
-- ---------------------------------------------------------------------------

-- payroll_run_audit_logs: payroll_runs, payroll_run_employees를 참조하는 최말단 자식.
drop table public.payroll_run_audit_logs;

-- payroll_run_items: payroll_run_employees, payroll_run_reviews를 참조.
drop table public.payroll_run_items;

-- payroll_run_reviews: payroll_run_employees를 참조.
drop table public.payroll_run_reviews;

-- payroll_run_employees: payroll_runs를 참조.
drop table public.payroll_run_employees;

-- payroll_runs: 계열의 루트 테이블.
drop table public.payroll_runs;

commit;
