# 추가근무 migration 적용 전 보완

최종 취소 RPC 계약·지급 단가 검증 보완은 [최종 검토 보고서](2026-10-17-part-time-extra-work-final-review.md)에 정리했다. 아래 테스트 수는 이 보완 단계의 기록이다.

미적용 파일 `20261017072217_part_time_early_extra_work_october.sql`을 보완했다. Production 연결·적용, Git 명령, 배포는 실행하지 않았다. 기존 적용 migration 파일은 변경하지 않았다.

## 잠금 순서

승인과 취소를 모두 **직원 advisory lock(82119) → 근태 advisory lock(82121) → active decision 행 FOR UPDATE** 순서로 맞췄다.

취소 함수는 근태에서 직원 ID를 일반 SELECT로 읽은 뒤 두 advisory lock을 취득한다. 그 다음 active decision을 다시 조회·잠그므로, 기다리는 동안 승인 교체가 발생해도 이전 decision ID를 취소하지 않는다. decision의 직원 ID도 다시 대조한다.

지급 함수와 같은 직원 잠금을 유지하며 잠금 취득 후 지급완료 여부를 확인한다. 취소 이유·취소자·취소시각과 기존 승인 snapshot/hash/금액을 보존한다. 재승인은 취소된 행을 복원하지 않고 새 행을 추가한다. 동일 승인 재요청은 기존 ID와 `unchanged`를 반환하고 active 결정은 하나만 존재한다.

취소 RPC도 신규 migration에서 함께 `CREATE OR REPLACE`한다. 두 함수 모두 SECURITY INVOKER·고정 search_path이며 PUBLIC/anon/authenticated에는 실행권한을 주지 않고 postgres/service_role만 허용한다. 함수 인자·반환 형태는 유지한다.

## 영업시간·snapshot 검증

- 2026-10-01 이후 유효 hourly/daily에만 오픈 이후 조기근무와 마감 이내 늦은 근무를 합산하고, 총 30분 이상을 허용한다.
- 10월 이후 승인 RPC는 실제 계산기가 생성한 전체 snapshot 키를 확인하고, JSON.stringify와 같은 명시적 키 순서·공백 없는 JSON을 재구성해 SHA-256을 대조한다. JSONB 자체의 표시 순서·공백을 해시하지 않는다.
- snapshot의 대상·시간·후보분·제외분·수당과 RPC 인자를 대조한다. 최종본에서는 DB가 유효 계약·스케줄 순근무분·날짜별 인상 기준으로 분당 급여를 독립 산정하며, snapshot 단가와 hash를 함께 부풀린 요청도 차단한다.
- 직원 잠금을 기다린 후 실제 출퇴근과 snapshot을 대조한다. 해당 날짜의 계약 ID/revision/급여유형/기간, 스케줄 ID/revision/시간/기간, 최신 active 매장 버전과 요일별 영업시간·휴무 여부도 다시 확인한다.
- 오픈 전/마감 후 근무를 제외한 구간과 예정 출퇴근을 교차해 조기분·늦은분·제외분을 재계산한다. 실제 퇴근이 예정 출근보다 빠르면 미근무 구간을 조기근무로 인정하지 않는다.
- 새 정책의 03:00 이전 스케줄/영업 시각은 다음 달력일로 해석한다. monthly는 기존 after-only 및 다음날 03:00 제한을 그대로 사용하며 fixed_monthly는 제외한다.
- 8·9월 요청에는 새 snapshot 정규화 검증을 소급하지 않는다. 새 승인 요청의 실제 지급 단가 대조는 날짜와 무관하게 수행한다. 기존 after-only 승인 규칙과 지급완료 잠금을 유지하며 migration 적용 자체의 과거 결정·지급 snapshot·장부 변경/backfill은 없다.
- DB가 잠금 대기 중 원천 변경을 발견하면 `PAYROLL_EXTRA_WORK_STALE_SOURCE`로 차단하며 승인 API는 기존 stale 응답과 같은 HTTP 409를 반환한다.

## 실제 PostgreSQL 동시성 검증

`tests/payroll-part-time-extra-work-concurrency.mjs`는 새로 생성한 loopback 전용 PostgreSQL **17.6** 클러스터에서 별도 연결로 실제 잠금 경쟁을 일으킨다. 운영 URL이나 `.env`는 읽지 않는다. 테스트 후 모든 연결과 소유한 서버를 종료한다.

실행 명령:

```powershell
node --experimental-strip-types --test tests/payroll-part-time-extra-work-concurrency.mjs
```

로컬 PostgreSQL 바이너리는 `QA_POSTGRES_BIN`으로 지정할 수 있다. 현재 workspace에 있던 17.6 바이너리로 실행했다.

| 시나리오 | 결과 |
|---|---|
| 운영에서 제시된 `행 → 직원` 순서를 로컬 함수로 복제한 음성 대조군 | 실제 40P01 데드락 1회 재현 |
| 승인 선행 → 취소 대기, 교체된 active 행 취소 | 10회 통과, 취소 대상 ID/이력 확인 |
| 취소 선행 → 승인 대기, 새 결정 추가 | 10회 통과 |
| 신규 중복 승인 | 10회 통과, 같은 ID/unchanged, active 1개 |
| 취소 후 중복 재승인 | 10회 통과, 과거 이력 보존, active 1개 |
| 대기 중 지급완료 전환 후 승인·취소 | 둘 다 55000 차단, 기존 승인 유지 |
| 대기 중 실제 출근 변경 | stale 차단, 결정 추가 없음 |
| 대기 중 스케줄 revision·오픈시간·유효 매장 버전·계약 revision 변경 | 각각 stale 차단, 결정 추가 없음 |

수정된 함수의 40회 승인/취소/중복 승인 시나리오와 추가 경합 검증에서 **예상 밖 데드락 0회**다. TAP 집계는 부모 테스트를 포함해 **8/8 통과**, 스킵 0이다. 로그: `.tmp/payroll-extra-work-concurrency-final.log`.

PGlite 회귀는 실제 JS 계산기 snapshot을 사용해 조기 30+늦은 0, 조기 15+늦은 15, 오픈 전 제외, 03:00 cutoff, 월급제 10월·분당 단가 반올림, 변조된 hash/금액/근무분 차단, 적용일 이전 승인 불변, 지급완료 승인·취소 차단, 취소 RPC 권한·감사 필드를 검증한다. 8·9월 자료 보호는 로컬 과거 승인/정정 행·지급 snapshot·장부 보존 행의 적용 전후 JSON 동일성으로 확인했다. 이번 작업에서 운영 자료를 조회·변경한 검증은 아니다.

## 최종 검사 결과

- 급여·급여 연동 장부 회귀 **832/832 통과**, 실패·스킵 0. 로그: `.tmp/payroll-extra-work-hardening-regression.log`.
- 최종 보완 파일을 대상으로 PGlite/API/실제 PostgreSQL을 함께 재실행해 **21/21 통과**했다. 여기에는 위의 실제 PostgreSQL 동시성 **8/8**이 포함된다. 로그: `.tmp/payroll-extra-work-hardening-final-focused.log`.
- 원천 timestamp 비교는 원본 정밀도로 하고, 근무분 계산은 JavaScript Date와 같은 밀리초 정밀도로 맞췄다. 17:30:00.000001 출근 같은 경계에서도 30분 후보가 DB에서 29분으로 달라지지 않음을 검증했다.
- 변경 TypeScript/JS 파일 ESLint 통과. 앱 소스 TypeScript 검사 통과(`.tmp/early-extra-tsconfig.json`), 오류 로그 비어 있음.
- 적용 시 교체되는 함수는 승인·취소 RPC 두 개이며, 데이터 backfill/기존 행 일괄 수정은 없다. 이번 실행은 로컬 disposable DB의 테스트 적용에 한정된다.

## 수정 파일

- `supabase/migrations/20261017072217_part_time_early_extra_work_october.sql`: 두 RPC의 잠금 순서와 승인 원천 검증.
- `app/api/admin/payroll/part-time-extra-work/route.ts`: DB stale 오류를 HTTP 409로 응답.
- `tests/helpers/payroll-extra-work-db.mjs`: PGlite/실제 PostgreSQL 공용 로컬 fixture, 실제 계산기 payload.
- `tests/payroll-part-time-early-extra-work-db.test.mjs`: 정책·hash·금액·과거 자료·권한 회귀 보강.
- `tests/payroll-part-time-early-extra-work-api-ui.test.mjs`: 대기 후 stale API 응답 검증.
- `tests/payroll-part-time-extra-work-concurrency.mjs`: 다중 연결 및 데드락 재현/방지 테스트.
- 기존 정책 보고서와 본 보완 보고서.
