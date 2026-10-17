# 추가근무 migration 최종 검토

최종 SQL은 `supabase/migrations/20261017072217_part_time_early_extra_work_october.sql`이다. 사용자가 미적용 상태로 명시한 파일을 수정했으며, 이전에 적용된 migration은 변경하지 않았다. Production 적용·Git 명령·배포는 하지 않았다.

검토 파일 SHA-256: `3511f39255f81cbed6fbde33c215480f3a82df9c0376f7eca6c5fcfdaa6c887b`.

## 취소 RPC Production 계약

| 상황 | 최종 반환값 또는 오류 |
|---|---|
| 정상 취소 | `{id, status: "cancelled"}` |
| 활성 decision 없음 또는 근태 없음 | `{status: "not_active"}` |
| 취소 사유 누락 | `PAYROLL_EXTRA_WORK_CANCEL_REASON_REQUIRED`, SQLSTATE 22023 |
| 지급완료 직원 | `PAYROLL_EXTRA_WORK_LOCKED_FOR_PAID_EMPLOYEE`, SQLSTATE 55000 |

두 RPC의 직원 advisory lock → 근태 advisory lock → active decision 행 FOR UPDATE 순서를 유지했다. 취소 후 반복 요청은 not_active를 반환하며 이력 행을 추가·재작성하지 않는다. 취소 사유·취소자·취소시각과 원래 승인 snapshot/hash/금액은 테이블에 보존한다.

`app/api/admin/payroll/part-time-extra-work/route.ts` DELETE는 RPC 결과를 `{ok:true, decision:data}`로 그대로 전달한다. `PartTimeExtraWorkSection.tsx`는 HTTP 성공 여부와 오류 code만 확인하고 성공 시 refresh하므로 전체 decision 행의 필드에 의존하지 않는다. 지급완료 오류는 기존 `PAID` 매핑을 통해 HTTP 409가 된다. 사유 누락은 API의 기존 입력 검증에서 HTTP 400으로 차단한다. API 반환 구조를 바꿀 필요는 없었으며 cancelled/not_active passthrough 회귀 테스트를 추가했다.

## 실제 지급 단가 검증

SHA-256 일치만으로 급여 단가를 신뢰하지 않는다. 승인 RPC가 직원 잠금을 획득한 후, 해당 영업일의 유일한 계약·스케줄과 사용자·레벨 적용 이력을 조회해 단가를 다시 계산한다. snapshot에서 단가를 복원해 정답으로 사용하는 방식이 아니다.

| 급여 유형 | 기존 엔진과 동일한 지급기준 분당 급여 |
|---|---|
| hourly | 계약 base_salary ÷ 60. 고정/레벨 인상은 합산하지 않음 |
| daily | 계약 base_salary ÷ 그날 스케줄 순근무분. 고정/레벨 인상은 합산하지 않음 |
| monthly | `(계약 base_salary + fixed_raise_amount + 적용 레벨 인상) ÷ 계약 standard_workdays ÷ 그날 스케줄 순근무분` |

스케줄 순근무분은 `attendance-facts.ts`와 같이 03:00 이전 시각을 다음날로 해석하고, 예정 근무분에서 unpaid_break_minutes를 차감한다. 계약에 저장된 standard_minutes_per_day를 임의 분모로 사용하지 않는다. hourly는 이 분모를 사용하지 않는다.

월급제 인상 계산은 실제 JS 경로인 `calculateCompensatedPayrollRates` → `calculateCombinedSalary`, `calculateEmployeeLevel`, 날짜별 버전 선택 규칙과 대조했다.

- 해당 날짜에 유효한 레벨 프로그램의 가장 높은 revision을 선택한다. 일자 버전이 없는 경우 월초 버전, 그것도 없으면 사용자 설정을 쓰는 엔진 fallback을 유지한다.
- hire_date / override 모드, disabled / nullable 설정, 자동·수동 적용 role, 시스템 계정 제외를 구분한다.
- 계산일은 영업일과 퇴사일 중 이른 날이다. 기준일 이전에는 레벨 인상이 없다. 적용 대상의 기준일이 누락되면 승인 단가 검증을 실패시킨다.
- 3개월마다 500,000₫, 최대 7회다. 월말 기념일은 해당 월의 마지막 날짜로 보정한다. 비대상·disabled는 레벨 인상만 제외하고 월급제 고정 인상은 유지한다.
- JS와 같은 double precision 연산 순서로 단가를 산정하고 `Math.round`와 같은 양수 반올림으로 시간당 환산액과 후보금액을 비교한다. 임의의 허용 오차를 두지 않는다.

검증 값은 snapshot.minuteRateAmount, RPC hourly_rate_amount, candidate_amount다. 실제 기준과 다르면 `PAYROLL_EXTRA_WORK_RATE_MISMATCH`로 거절하며 기존 active decision도 변경하지 않는다. 계약/스케줄 중복·분모 불능·필수 인상 기준 누락은 실패 처리한다.

이 단가 검증은 **새 승인 요청 전체**에 적용한다. 8·9월에도 단가·금액·snapshot/hash를 함께 바꿔 재승인하는 우회를 허용하지 않는다. 저장된 과거 행의 일괄 재계산·backfill은 없으며 기존 지급완료 잠금과 적용일 이전 after-only 규칙은 유지한다. 10월 hourly/daily 조기근무 및 월급제 기존 마감/cutoff 규칙도 유지한다.

## 회귀 검증

- 급여·급여 연동 장부 전체 **838/838 통과**, 실패·스킵 0. 로그: `.tmp/payroll-extra-work-final-rate-regression.log`.
- 실제 PostgreSQL **17.6** 다중 연결 테스트 **9/9 통과**(부모 포함). 기존 역순 잠금의 40P01 재현, 수정된 함수의 승인/취소·중복 승인·재승인 40회 및 원천 변경 경합을 확인했다. 수정 후 예상 밖 데드락은 0회다.
- 직원 잠금을 기다리는 동안 계약 급여가 변경된 경우, 이전 snapshot/hash가 내부적으로 정상이어도 RATE_MISMATCH로 차단했다. 로그: `.tmp/extra-work-rate-race-api.log`.
- 신규 단가 회귀 **5개**는 실제 JS 정책 모듈을 정답으로 사용한다. hourly/daily 및 월급제 17개 조건에서 정상 단가는 승인되고, 단가·환산 시급·금액·snapshot/hash를 함께 바꾼 요청은 거부됨을 확인했다.
- 월급제 disabled/null 설정·수동 role·시스템 계정·퇴사일·인상 상한·버전 override/fallback·월말/2월 기념일·필수 기준일 누락을 포함한다.
- daily는 계약의 600분이 아닌 스케줄 순근무 270분을 사용하며, 고정/레벨 인상이 부당 합산되지 않음을 검증했다.
- 취소의 정확한 JSON shape와 오류 문자열/SQLSTATE, 반복 취소의 not_active 및 감사 행 불변성을 검증했다. API는 cancelled/not_active 결과를 그대로 전달하고 지급완료를 409로 처리한다.
- 변경 테스트 파일 ESLint 통과. 앱 소스 TypeScript 검사 통과(`.tmp/early-extra-tsconfig.json`), 오류 로그 비어 있음.

테스트는 PGlite 및 소유한 loopback 전용 PostgreSQL에서 수행했다. 운영 데이터의 현재 상태를 새로 조회하거나 운영 함수에 실행 테스트를 한 결과는 아니다.

## 이번 수정 파일

- `supabase/migrations/20261017072217_part_time_early_extra_work_october.sql`
- `tests/helpers/payroll-extra-work-db.mjs`
- `tests/payroll-part-time-early-extra-work-db.test.mjs`
- `tests/payroll-part-time-early-extra-work-api-ui.test.mjs`
- `tests/payroll-part-time-extra-work-concurrency.mjs`
- `tests/payroll-part-time-extra-work-rate-policy.test.mjs` (신규)
- 최종 검토 보고서와 기존 보완 보고서

최종 SQL에서 교체하는 운영 함수는 승인·취소 RPC 두 개다. 새 테이블·새 공개 RPC·기존 데이터 수정문은 추가하지 않았다. 함수 본문의 INSERT/UPDATE는 향후 승인·취소 호출 시에만 실행된다.
