# 직원 레벨 기준월 리뉴얼 — 구현 메모 (Owner 검토 대기)

상태: 로컬 main 구현·테스트 완료. **운영 DB Migration 미적용, Push·배포 안 함.**

## 정책

| 구분 | 규칙 |
|---|---|
| 입사월 기준(자동) `hire_month` | 입사일 1~15일: 입사월이 기준월. 16일~말일: 다음 달이 기준월(연도 이월 포함). **저장할 때 확정한 기준월을 버전에 보관**하고, 계산은 그 값을 쓴다(입사일 수정·재입사가 과거 이력을 바꾸지 않음). 입사일 수정으로 기준월이 달라지면 적용 월을 정해 새 버전으로 저장해야 한다(v10이 적용 월 없는 저장을 `LEVEL_BASE_MONTH_REVIEW_REQUIRED`로 거부) |
| 직접 기준월 `override_month` | 관리자가 `YYYY-MM`을 지정하고 자동 계산은 쓰지 않음. 실제 입사월 이전은 불가. 퇴사월 이후도 불가 |
| 공통 | 기준월 1일이 Lv.0. 승급은 기준월 +3·+6·+9개월…의 1일. 최대 Lv.7, 1회 500,000₫, 24개월 후 협의(★) 유지 |
| 기준월 이전 | 입사 후 기준월 시작 전(예: 16일 이후 입사자의 입사월)은 Lv.0으로 표시 |
| 기존 날짜 기준 `hire_date`/`override` | 기존 버전·감사 로그를 그대로 둠. 다른 설정을 바꿀 때도 '기존 날짜 기준 유지'로 보존. 소급 변경 없음 |
| 급여 인상 반영 `salary_raise_enabled` | 레벨 ON과 별개. 기존 버전은 반영(true)으로 보존. **신규 직원·레벨 OFF→ON·레벨 ON 재입사는 반영 여부를 반드시 선택**(API·RPC 모두 `SALARY_RAISE_DECISION_REQUIRED`). 미반영이면 실제 급여 반영액 0₫. 시급제는 원래부터 레벨 인상 미반영. `users.part`·`pay_type`로 FT/PT를 판정하지 않음 |

- 레벨 계산 엔진(기준일 + 3개월 단위 기념일)은 바꾸지 않았다. 기준월을 그 달 1일로 넣어 같은 결과를 얻는다.
- 특별 인상(계약 `fixed_raise_amount`)과 정기 레벨 인상은 별도 항목이며, 중복으로 더하지 않는다.

## 과거 지급 보호

- 레거시 직원은 새 코드에서도 레벨 정보·보상 계산 결과·급여 해시가 바이트 단위로 같다. HEAD 코드와 42개 조합을 비교하는 테스트로 고정했다.
- 새 필드는 기본값일 때 아예 넣지 않는다. 급여 해시는 값이 없는 키를 건너뛰기 때문이다.
- `payroll_employee_payments`의 스냅샷·해시·금액·상태는 앱 코드와 Migration 모두 쓰지 않는다.
- 새 레벨 버전은 기존 규칙대로 이번 달·다음 달부터만 적용된다.

## DB 초안 `docs/sql/employee-level-month-base-v1-draft.sql` (미적용)

- **컬럼:**
  - `employee_level_program_versions.salary_raise_enabled` (기본 true)
  - `users.level_base_mode`
  - 감사 로그: 이전/다음 급여 인상 여부, 이전/다음 버전 전체 스냅샷
- **체크 제약:**
  - 월 모드 기준일은 1일이어야 한다.
  - `override_month`는 입사월 1일 이상을 허용한다.
  - 감사 로그 동작 목록에 `level_salary_raise_changed`를 추가한다.
- **신규 RPC:** `employee_update_profile_and_level_v10`, `employee_create_with_schedule_v6`, `employee_rehire_with_level_policy_v4`, `employee_level_hire_month_base`
  - 권한은 기존 RPC와 같이 service_role만 실행할 수 있다.
  - v9·v5·v3는 그대로 둔다.
- **같은 적용월 덮어쓰기:** 덮어쓰기 전 버전 행 전체를 감사 로그 `previous_version_snapshot`에 보존한다.

## 감사 후 남은 결정 사항

- **기존 `hire_date` 방식 버전의 위험(기존 동작, 이번 변경과 무관):** 이 방식은 계산할 때 현재 `users.hire_date`를 쓴다. 그래서 재입사나 입사일 수정이 있으면 과거 월 레벨이 다시 계산된다.
  - 예: 과거 9월 Lv.3 → 재입사 후 계산 불가.
  - 현재 운영 데이터는 모든 `hire_date` 버전의 `base_date`가 입사일과 같아서, 저장값을 쓰도록 바꿔도 결과가 같다.
  - 다만 과거 버전의 의미를 바꾸는 일이므로 Owner 결정이 필요하다.

## 앱·DB 호환성

- **Migration 전에 새 앱을 배포하면** 다음이 모두 실패한다.
  - 레벨 버전 조회(`salary_raise_enabled`): 직원관리, 근태 직원목록·프로필, 바, 급여 직원·계약, 월 급여 계산·개요
  - `users.level_base_mode` 조회: 위와 같은 화면
  - v10·v6·v4 호출: 직원 저장·생성·재입사
- **Migration 후 기존 앱(v9·v5·v3)은 레거시 직원에 대해 정상 동작한다**(PGlite로 실제 v9·v5·v3 정의를 실행해 확인). 월 모드 직원은 새 앱에서만 생기므로, 새 앱 배포 뒤에는 v9·v5·v3 회수를 권장한다.

## 운영 적용 순서 (각 단계 별도 승인)

1. **Migration을 먼저 적용한다.** 이 코드는 새 컬럼(`salary_raise_enabled`, `level_base_mode`)을 조회하므로, Migration보다 먼저 배포하면 직원·급여·근태·바 화면 조회가 실패한다.
2. DB 검증: 컬럼·제약·함수·권한을 확인하고 레거시 행이 그대로인지 확인한다.
3. 앱을 배포한다(v10·v6·v4 호출, v4는 `p_salary_raise_enabled` 인자 포함).
4. 시트 기준월로 기존 직원 버전을 정정한다. 운영 DB 쓰기이므로 별도 승인이 필요하다.
   - DIEP, TRIEM, KHOI, THÀNH, NHUNG: 입사월 자동 → 시트와 같은 결과
   - VUONG, QUYEN, QUAN, UYEN, NHON: 직접 기준월 2025-10 → 기존 결과와 같음
   - HAI LINH: 직접 기준월 2026-02 → 기존 2026-01-03과 승급일이 다름
   - 적용 월은 이번 달 또는 다음 달이다(과거 월 소급 없음).
