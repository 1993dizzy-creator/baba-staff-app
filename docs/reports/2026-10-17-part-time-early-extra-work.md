# 파트타임 조기근무 정책 변경 검토

소스와 로컬 테스트만 변경했다. 운영 DB DDL/DML, migration 적용, Git 명령, 배포는 실행하지 않았다.

## 적용 정책과 계산 비교

- 영업일 `2026-10-01`부터 hourly/daily에만 오픈 이후 조기근무를 후보시간에 합산한다.
- 실제 근무 구간과 매장 영업 구간이 겹치는 범위에서 조기근무를 분 단위 내림한다. 퇴근이 예정 출근보다 빠르면 실제 퇴근까지만 인정한다.
- 늦은 퇴근은 기존대로 매장 마감 이내로 제한한다. 같은 영업일의 조기+늦은 근무가 30분 이상이면 전체 후보분을 검토 대상으로 삼는다.
- 수당은 `round(후보분 × 해당 날짜 계약·보상 계산의 분당 단가)`이며 승인과 source hash가 모두 일치해야 합산된다.
- monthly의 기존 늦은 퇴근/다음날 03:00 제한, fixed_monthly 제외, 기본급·지각·조퇴 패널티는 유지한다.
- 새 정책의 영업시간/스케줄에서 03:00 이전 시각은 다음 달력일로 해석한다. 예를 들어 해당 영업일 23:45 출근, 다음날 00:30 예정 출근, 01:00 퇴근이면 조기근무는 45분이다. 이 해석 변경은 10월 이후 hourly/daily에만 적용한다.

아래는 시급 35,000₫, 예정 18:00–23:00, 영업 16:00–다음날 01:00의 로컬 계산 비교다. 금액은 **승인 시** 합산액이며 미승인 상태에서는 모두 0₫다.

| 실제 출퇴근 | 조기분 | 늦은분 | 이전 후보 | 10월 hourly/daily 후보 | 승인 시 수당 |
|---|---:|---:|---:|---:|---:|
| 17:40–23:09 | 20 | 9 | 없음 | 없음(29분) | 0₫ |
| 17:45–23:15 | 15 | 15 | 없음 | 30분 | 17,500₫ |
| 17:30–23:00 | 30 | 0 | 없음 | 30분 | 17,500₫ |
| 17:00–23:20 | 60 | 20 | 없음 | 80분 | 46,667₫ |
| 15:30–다음날 01:30 | 120 | 120 | 120분 | 240분 | 140,000₫ |

마지막 행에서 오픈 전 30분과 마감 후 30분은 제외한다. 9월 이전 날짜와 monthly 계약은 이전 계산을 유지한다.

## 전체 경로 추적

1. `lib/payroll/monthly-run.ts`의 `loadPayrollMonthSnapshot`이 영업일별 계약·스케줄·active 영업시간 버전·취소되지 않은 결정을 읽는다. 날짜별 유효 계약/보상으로 분당 단가를 결정하며, 휴무일에는 추가근무 영업시간 맵을 만들지 않는다.
2. `calculatePayrollBatch` → `calculateEmployee` → `calculatePartTimeExtraWork`가 후보를 생성한다. 휴가·무단결근·불완전 근태는 후보 생성 전에 제외하고 fixed_monthly는 별도 경로에서 제외한다.
3. `lib/payroll/part-time-extra-work.ts`에서 10월 hourly/daily만 `beforeScheduleMinutes + afterScheduleMinutes`로 합산한다. 새 snapshot에만 `extraWorkPolicy: part-time-open-early-v1`, `payType`을 추가한다. 9월 이전 및 monthly snapshot의 필드·순서를 바꾸지 않는다.
4. 기존 `partTimeExtraWorkSourceHash`는 snapshot의 SHA-256을 만든다. 새 정책 이전 hash는 새 후보와 일치하지 않아 재승인 전 수당을 지급하지 않는다. 근태·영업시간·계약/단가·스케줄 변경도 기존대로 stale 처리한다.
5. `app/api/admin/payroll/part-time-extra-work/route.ts` POST는 owner/master 인증 후 서버 overview를 재계산하고 클라이언트 hash를 비교한다. 클라이언트가 보내는 후보분·금액은 사용하지 않고 재계산된 payload만 승인 RPC에 전달한다. DELETE는 취소 RPC를 호출한다. 이 경로는 수정 없이 새 계산기를 사용한다.
6. 승인된 후보만 월 급여의 별도 `part_time_extra_work` automatic addition으로 한 번 합산된다. 미검토/stale은 지급 차단 review, 거절은 0원이다. `lib/payroll/overview.ts`가 해당 addition을 수당 합계로 집계한다.
7. `components/payroll/PartTimeExtraWorkSection.tsx`는 후보 총시간/금액, 조기분 포함 여부와 새 정책을 한·베트남어로 표시한다. 이전 지급 snapshot에서 조기분이 합산되었던 경우도 저장된 합계 기준으로 정확히 표시한다.
8. `lib/payroll/payment-snapshot.ts`가 후보·결정과 automatic items를 저장하고 `payrollPaymentSnapshotHash`가 함께 해시한다. payments API는 재계산 snapshot/hash로 `payroll_pay_employee_v3`를 호출한다. 새 정책은 이 경로에 자동 전파되므로 전역 엔진 버전을 변경하지 않았다.
9. `lib/payroll/source-export/build-export.ts`는 승인 후보의 총분·수당·decision ID·source hash를 `approvedPartTime`에 내보내고 직원/전체 export hash에 반영한다. pending/rejected는 승인 수당으로 export하지 않는다.
10. 지급완료 추가근무 GET과 overview의 `lib/payroll/paid-extra-work.ts` 경로는 저장된 지급 snapshot의 결정만 표시한다. 신규 migration은 기존 결정/지급 snapshot/장부 행을 재작성하지 않는다. 기존 지급 RPC와 장부 동기화 경로는 수정하지 않았다.

## 신규 migration — 미적용

`supabase/migrations/20261017072217_part_time_early_extra_work_october.sql`

- CLI `migration new`로 생성한 후속 파일이다. 이전 migration 파일은 수정하지 않았다.
- 변경 대상은 `payroll_admin_set_part_time_extra_work_decision_v1(bigint,bigint,date,date,...)`, `payroll_admin_cancel_part_time_extra_work_decision_v1(bigint,text,bigint)` 두 함수와 해당 함수 권한의 재명시다. 미적용 파일의 후속 보완 내용은 [동시성·검증 보완 보고서](2026-10-17-part-time-extra-work-hardening.md)를 참고한다.
- 10월 이후 실제 유효 계약의 ID/revision/사용자/기간을 확인하고 hourly/daily에만 조기분을 합산한다. fixed_monthly를 거절하고 monthly는 after-only를 유지한다.
- 기존 `candidate_minutes = after_schedule_minutes`, `after_schedule_minutes >= 30`을 날짜·계약별 합계 검증과 `candidate_minutes >= 30`으로 교체한다. 새 snapshot 정책·급여유형·분·금액 일치도 확인한다.
- 두 RPC 모두 직원 advisory lock(82119) → 근태 advisory lock(82121) → active decision 행 FOR UPDATE 순서를 사용한다. 취소는 행 잠금 없이 직원 ID만 먼저 읽고, 두 advisory lock 이후 active decision을 다시 읽는다.
- 10월 요청은 DB에서 전체 snapshot/hash/금액과 실제 근태·유효 계약/스케줄·영업시간 버전을 대조하고, 영업구간 내 근무분을 재계산한다. 대기 중 변경된 원천은 stale로 차단하며 API는 HTTP 409로 응답한다.
- 기존 유일 active 결정 제약, idempotent 재요청, append-only 교체/취소 이력, 지급완료 잠금을 유지한다.
- `SECURITY INVOKER`, 고정 search_path, PUBLIC/anon/authenticated 실행권한 제외, postgres/service_role 실행권한을 유지한다.
- 기존 테이블의 compatibility CHECK가 이미 after-only와 before+after 양쪽을 허용하므로 테이블·제약 변경은 없다.
- **적용 자체의 데이터 변경/backfill: 없음.** 함수 본문의 INSERT/UPDATE는 향후 관리자가 결정을 저장할 때만 실행된다.
- 소스와 함수 변경은 함께 반영되어야 한다. 이번 작업에서는 어느 쪽도 Production에 반영하지 않았다.

## 검증 결과

- 최종 급여·급여 연동 장부 회귀 테스트: **826/826 통과**(실패·스킵 0). `tests`의 `payroll*.test.ts/mjs`, `ledger*payroll*.test.ts/mjs`를 Node strip-types 및 test-concurrency=1로 실행했다. 최종 로그는 `.tmp/early-extra-payroll-final.log`다.
- 신규 정책 테스트: 계산기/실제 급여엔진 11개, 로컬 PostgreSQL(PGlite) 3개, 실제 API handler/React 렌더 4개.
- 경계값: 29분 제외, 15+15분 포함, 조기근무만 30분 포함, 오픈 전/마감 후 제외, 실제 퇴근 상한.
- 회귀: 지각·조퇴 패널티와 기본급 유지, 휴무·휴가·결근·누락 근태 제외, 날짜별 시급/오픈 변경, 월급제 03:00 cutoff, fixed_monthly 제외.
- 과거 hourly/daily 및 monthly의 후보 JSON/hash를 이전 계산과 byte 단위 비교했다. 기존 Đức/Thiết 9월 회귀 및 지급 snapshot 테스트도 통과했다. 이들은 로컬 테스트이며 운영 직원의 실제 이력을 새로 조회한 결과는 아니다.
- 로컬 DB에서 이전 RPC가 15+15분 후보를 거절하고 새 함수가 승인함을 검증했다. 반복 승인에서 active 결정 1개, 취소→재승인 시 이력 보존, 지급완료 후 승인/취소 거절, 일반 사용자/위조된 정책/잘못된 계약·근태 거절을 확인했다.
- migration 적용 전후 로컬의 과거 승인·정정 행, 8·9월 지급 snapshot 및 장부 보존용 행의 JSON이 동일했다. 실제 운영 장부 전체를 비교한 검증은 아니다.
- 변경 파일 ESLint 통과. 앱 소스 범위 TypeScript 검사 통과(`.tmp/early-extra-tsconfig.json`). 저장소 기본 전체 타입검사는 기존 비급여 테스트의 `.ts` import 설정·장부 테스트 타입 오류로 실패했다. 오류 로그에 이번 변경 소스의 오류는 없었다.
- 테스트는 로컬에서 수행했고 운영 데이터 변경을 동반하는 테스트는 하지 않았다.

## 운영 읽기 검증의 제한과 남은 확인

Supabase 프로젝트 목록 및 migration history 읽기는 성공했다. 운영 이력에는 `20260912070744`, `20260912075601`이 등록되어 있고 신규 migration은 없다. 등록 사실만으로 함수 본문이 로컬 파일과 동일하다고 단정하지 않았다.

운영 함수 정의·권한·관련 스키마를 SELECT하는 `supabase_execute_sql` 호출은 자동 승인 검토에서 거절되었다. 반환 사유는 `MCP tool call requires approval, but approval policy is never`다. 승인 차단을 우회하거나 다른 자격 증명으로 재조회하지 않았다.

따라서 다음은 **이번 세션에서 독립적으로 확인하지 못했다**.

- Sơn(ID 29), 2026-10-01~16 실제 근태의 일별 후보 및 이전 정책 합계. **15일·1,298분·약 757,167₫는 사용자 제공 읽기 전용 시뮬레이션 기준값**이다. 35,000₫/시에서 1,298분의 총액 산술은 757,166.67₫이나, 실제 엔진은 일별 반올림하므로 원자료를 통한 합산 확인이 필요하다. 임의 근태로 이 결과를 재현했다고 주장하지 않는다.
- Đức 9월 운영 승인·정정 이력, Thiết 실제 운영 승인 수당 및 8·9월 실제 지급/장부 행의 변경 전후 대조.
- 운영 함수의 현재 본문/인자/권한 및 미등록 수동 SQL 변경 여부.

향후 적용 전에는 읽기 전용 접근으로 위 항목과 로컬/원격 이력 차이를 먼저 확인해야 한다.

## 수정 파일

- `lib/payroll/part-time-extra-work.ts`
- `components/payroll/PartTimeExtraWorkSection.tsx`
- `supabase/migrations/20261017072217_part_time_early_extra_work_october.sql`
- `tests/payroll-part-time-early-extra-work.test.mjs`
- `tests/payroll-part-time-early-extra-work-db.test.mjs`
- `tests/payroll-part-time-early-extra-work-api-ui.test.mjs`
- 본 보고서
