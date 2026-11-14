# 신규 고정급 입사월 일할 계산 — 로컬 개발 결과

기준 HEAD: `0353e568`. 직원 생성 5차 `ee24f73f`의 UI·저장 흐름을 유지했다.
운영 DB 접속·쓰기, Migration 운영 적용, Push, 배포, Notion 수정 및 테이블 현황 Production HOLD 변경은 수행하지 않았다.

## 구현

- 신규 생성 요청의 `first_month_proration=true`와 서버 등록 활성화 조건을 모두 충족할 때만 전용 생성 RPC를 사용한다. 기존 직원·기존 계약·5차에서 이미 만든 직원은 등록하지 않는다.
- 기존 직원 생성 RPC 호출과 pending 정책 등록은 같은 트랜잭션이다. 최초 계약 RPC는 기존 v6 계약 생성 함수를 재사용하며, 계약 연결까지 성공해야 active가 된다.
- pending 상태에서 같은 계약이 있으면 연결을 재시도한다. 다른 계약은 덮어쓰지 않는다. active 동일 요청 재시도는 기존 계약을 반환한다.
- 기존 `calculateFixedMonthlyPayroll()`의 월 원액 반환은 변경하지 않는다. 일할 대상 입사월의 base_work만 달력일로 계산하고 무단결근 공제 단가·unearnedCompensationAmount는 월 원액 기준으로 유지한다.
- 입사월 입사일부터 월말 또는 확정 퇴사일까지 양 끝 날짜를 포함한다. 현재월/미래월 예상액은 경과일 누적액이 아닌 해당 월 예상 지급 기본급이다. 다음 달부터 기존 전액 계산이다.
- 신규 정책 입사월에만 계산 증거를 저장한다. 정책 없는 직원과 다음 달 계산에는 빈 필드나 새 엔진 버전을 추가하지 않는다.
- pending·입사일·계약·재입사·기간 불일치는 해당 직원/월의 blocking 검토로 처리한다. 월중 계약 전환에 임의로 마지막 계약을 적용하지 않는다.
- 실제 예상 비용은 일할액을 사용하고 계약 월급 표시·정렬 기준은 그대로 둔다.
- 신규 정책의 지급 완료 행은 해당 지급 스냅샷으로 표시하며, 재입사로 기존 월의 실시간 대상 집합에서 사라져도 보존한다. 기존 정책 없는 지급 완료 화면 경로는 변경하지 않는다.
- 기존 고정급/월급제/시급, 근태 종속, 복리후생 제외, 레벨 기준월, KO/VI, 미저장 보호를 유지했다. 정책 연결 확인 전 자동 적용 완료를 표시하지 않는다. 구버전 sessionStorage 설정에는 새 자동 적용 문구를 붙이지 않는다.

## 보류·제한

**기존 지급 API는 첫 배치를 만들 때 전 직원 사전 검사를 요구한다.** pending/검토 직원이 있으면 정상 직원의 첫 지급도 막힐 수 있다. 이 규칙은 요청대로 우회하거나 변경하지 않았다. 직원별 계산 분리는 구현했지만 첫 배치에서 정상 직원만 먼저 지급한다는 보장은 미완료다. 이 제한을 해결하거나 운영 정책으로 수용하기 전 신규 등록 활성화를 권고하지 않는다.

입사일 정정은 명시적 관리자 RPC를 제공하며 별도 관리 UI는 추가하지 않았다. 같은 월 안의 미사용·미마감 건만 이유와 전후 감사 기록을 남기고 정정한다. 다른 월로의 이동은 별도 계약/급여 검토가 필요하다. 재입사는 자동 적용 대상이 아니다.

PGlite와 브라우저 mock 검증은 실제 운영 Postgres/PostgREST 및 동시 세션 검증을 대체하지 않는다. 네이티브 PostgreSQL 동시 요청, 운영 Migration/스키마 캐시 반영, 전체 Next.js production build는 실행하지 않았다. TypeScript 검사는 실행했다.

## DB 구조와 정식 Migration

- 파일: `C:\workspace\baba-staff-app\supabase\migrations\20261114124930_new_fixed_employee_first_month_proration.sql`
- 버전: `20261114124930`
- Supabase CLI 3.1.0의 `supabase migration new new_fixed_employee_first_month_proration`로 생성했다. 기존 적용 Migration은 수정하지 않았다.
- 테이블: `public.payroll_first_month_policies` — user_id PK, policy_version, hire_date, first_contract_id UNIQUE FK, pending/active 상태, 등록 시각/처리자, change_history. 일할 금액은 저장하지 않는다.
- RLS 활성화, public/anon/authenticated/service_role 직접 테이블 권한 없음. 필요한 RPC만 service_role에 EXECUTE 허용. 등록·연결·정정 RPC는 기존 관리자 처리자 검증을 재사용한다.
- `employee_create_with_proration_v1`: 기존 v6 생성과 pending 등록의 원자성.
- `payroll_link_first_month_contract_v1`: 기존 계약 생성과 연결·활성화, 동일 계약 복구/멱등 반환.
- `payroll_first_month_policies_v1`: 서버 계산/계약 조회용 정책과 재입사·입사일 일치 여부 조회.
- `payroll_correct_first_month_hire_date_v1`: 명시적 미사용 건 정정과 감사 기록.
- 내부 `payroll_first_month_used_v1`: 지급 및 취소 감사 이력 잠금 판정.
- `payroll_first_month_payment_guard_v1` 트리거: 기존 지급 트랜잭션 안에서 정책·현재 직원·계약·계산 증거·일할액을 대조한다. 정상 등록 건은 회계월이 마감돼도 지급을 막지 않는다. 기존 배치/회계 함수는 변경하지 않는다.
- 신규 등록/활성화 및 정책 날짜 정정은 마감된 과거 입사월을 자동 처리하지 않는다. 이미 active인 같은 계약의 재조회/멱등 반환과 정상 지급은 구분한다.

## 계산 사례

월 원액 8,000,000₫, 2026년 11월:

| 입사/퇴사 | 재직일수 | 입사월 기본 지급액 |
| --- | ---: | ---: |
| 11월 1일 입사 | 30/30 | 8,000,000₫ |
| 11월 15일 입사 | 16/30 | 4,266,667₫ |
| 11월 16일 입사 | 15/30 | 4,000,000₫ |
| 11월 30일 입사 | 1/30 | 266,667₫ |
| 11월 16일 입사, 25일 퇴사 | 10/30 | 2,666,667₫ |

12월은 기존 전액 지급이다. 기본 계약 8,000,000 + 고정 인상 1,000,000 + 레벨 인상 1,000,000인 검증에서는 월 원액 10,000,000, 15/30 지급액 5,000,000이었다. 무단결근 공제는 일할액이 아닌 월 원액/계약 기준 근무일수로 계산했다.

## 검증 증거

- 개발 전 기본 회귀: 160/160 PASS.
- 최종 확대 회귀: 324건 중 321 PASS, 3 FAIL. 아래 3건은 `0353e568`의 원본 소스를 `.local/first-month-baseline-src`에 복원해 동일 조건으로 실행해도 동일하게 FAIL한다. 이 실패를 통과로 처리하지 않았다.
  - `tests/payroll-overview-policy.test.ts`: employee detail groups salary… (`paddingLeft: 10` 기대).
  - 같은 파일: overview exposes resolved insurance enrollment… (기존 DetailSection 조건 기대).
  - `tests/payroll-tax-integration.test.ts`: admin PIT UI hides not-applicable tax… (기존 taxBurdenMode 표시식 기대).
- 추가 미사용 계약 정정 PGlite 검사 1건 PASS. 기존 정정 코어가 연결된 계약 ID를 유지하고 원액/감사를 정정하며, 정정 전의 오래된 금액 증거로는 지급할 수 없음을 확인했다.
- 신규 검증 범위 합계: 계산·엔진·기준 HEAD 동등성·기능 활성화 10건, 정식 Migration PGlite 9건, 저장 복구 helper 4건 PASS (총 23건; 최종 회귀에 포함된 22건과 추가 정정 1건).
- PGlite: 기존 행 보존, 신규 등록, pending→active, 등록/활성화 실패 시 롤백, 동일 요청/응답 유실 재시도, 기존 계약 복구/충돌, 직접 쓰기 및 비인가 호출 거부, 입사일 정정/재입사, 지급·취소 잠금, 원액 정정, 오래된 증거 차단, 마감 후 정상 지급을 검증했다.
- 기준 HEAD와 비교한 기존 고정급·월급제·시급제의 실제 계산 항목, overview 객체, 지급 스냅샷과 해시가 동일하다. 실제 근태/시간표가 있는 fixture도 포함한다.
- `tsc --noEmit --incremental false --pretty false`: PASS.
- 변경한 TS/TSX 파일 대상 ESLint: PASS.
- `git diff --check`: PASS.
- 실제 생성 컴포넌트의 로컬 Chrome headless 검증: KO/VI × 320·390·430·1280px PASS. 실제 Container·폼·공유 컨트롤을 사용하고 인증/라우터/서버 응답만 mock 처리했다. 저장 성공/부분 실패/새로고침 복구/응답 유실/충돌/중복 클릭/입력 보호를 검사했다. 320px KO/VI 이미지도 확인했다.
- 운영 자격 증명이나 운영 DB는 테스트에 제공하지 않았다. 테스트 로그·브라우저 캡처·임시 baseline은 `.local/`에만 생성했다.

## 운영 적용 순서 — 이번 작업에서는 실행하지 않음

1. Owner가 기존 첫 배치 전체 사전 검사 한계를 확인하고 신규 정책 활성화 여부를 결정한다. 변경이 필요하면 별도 승인 범위로 개발한다.
2. 별도 운영 DB 적용 승인을 받아 정식 Migration 파일의 테이블/RPC/트리거/권한만 적용한다. 기존 직원 backfill은 없다.
3. PostgREST 스키마 캐시와 신규 RPC/권한 가용성을 확인한다.
4. 별도 Push/배포 승인 범위에서 코드 배포. 서버 환경변수 `PAYROLL_FIRST_MONTH_PRORATION_ENABLED`는 우선 미설정/false로 둔다. 구 경로의 직원 생성은 유지되고, 새 UI의 고정급 자동 정책 요청은 직원 생성 전에 명시적인 준비 미완료 안내로 차단된다. 전액 경로로 자동 우회하지 않는다.
5. 배치 한계를 포함한 운영 준비가 확인된 뒤 별도 승인으로 `PAYROLL_FIRST_MONTH_PRORATION_ENABLED=true`를 활성화한다.
6. 신규 등록을 다시 끌 때는 이 변수만 false로 변경한다. 이미 등록된 정책의 조회·계산·지급 검증은 계속 작동해야 하므로 테이블/함수 삭제나 소급 backfill/rollback을 하지 않는다.

최종 로컬 커밋 SHA와 커밋 후 작업 트리 상태는 완료 메시지에 별도로 기록한다.

## 변경 파일 전체 Windows 경로

- `C:\workspace\baba-staff-app\app\(protected)\admin\users\create\page.tsx`
- `C:\workspace\baba-staff-app\app\api\admin\payroll\contracts\route.ts`
- `C:\workspace\baba-staff-app\app\api\admin\payroll\overview\route.ts`
- `C:\workspace\baba-staff-app\app\api\admin\payroll\payments\route.ts`
- `C:\workspace\baba-staff-app\app\api\admin\users\create\route.ts`
- `C:\workspace\baba-staff-app\docs\payroll-first-month-proration-20261114.md`
- `C:\workspace\baba-staff-app\lib\payroll\first-month-paid.ts`
- `C:\workspace\baba-staff-app\lib\payroll\first-month-proration-server.ts`
- `C:\workspace\baba-staff-app\lib\payroll\first-month-proration.ts`
- `C:\workspace\baba-staff-app\lib\payroll\monthly-run.ts`
- `C:\workspace\baba-staff-app\lib\payroll\new-employee-setup.ts`
- `C:\workspace\baba-staff-app\lib\payroll\overview-projection.ts`
- `C:\workspace\baba-staff-app\lib\payroll\overview.ts`
- `C:\workspace\baba-staff-app\lib\payroll\ui-labels.ts`
- `C:\workspace\baba-staff-app\lib\text\admin-users.ts`
- `C:\workspace\baba-staff-app\supabase\migrations\20261114124930_new_fixed_employee_first_month_proration.sql`
- `C:\workspace\baba-staff-app\tests\admin-users-create-ui.test.ts`
- `C:\workspace\baba-staff-app\tests\new-employee-proration-recovery.test.mjs`
- `C:\workspace\baba-staff-app\tests\new-employee-setup.test.ts`
- `C:\workspace\baba-staff-app\tests\payroll-first-month-proration-db.test.mjs`
- `C:\workspace\baba-staff-app\tests\payroll-first-month-proration.test.mjs`
- `C:\workspace\baba-staff-app\tests\payroll-fixed-monthly-policy.test.ts`
- `C:\workspace\baba-staff-app\tests\payroll-paid-extra-work-snapshot.test.ts`
