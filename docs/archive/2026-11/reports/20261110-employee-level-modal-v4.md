# 장기근무 레벨 모달 4차 개선 — 로컬 검증 보고

- 기준 HEAD: d4ac9ecf2cff24c79c2a40092d03745d1083787d, main 직렬 개발. 시작 시 작업 트리 clean.
- 범위: 모달, 정책 저장 안전성, 시급제 레벨 급여와 추가근무 승인 검산, 최소 권한 이력 조회.
- 운영 DB 읽기/쓰기, 기존 Migration 수정·재실행, Push, 배포는 수행하지 않았다. 아래 DB 검사는 임시 격리 DB만 사용했다.

## 기능 변경

1. 네이티브 dialog를 document.body로 portal하고 visualViewport 크기/이동과 safe-area로 위치를 계산한다. 대상 모달 스타일만 수정했다. 헤더·footer는 고정하고 본문만 스크롤한다.
2. 급여 반영 및 이번 달/다음 달 선택을 제거했다. 레벨 ON 새 정책·생성·재입사는 자동 급여 반영한다. 기존 반영 제외 정책과 단순 기본정보 저장은 보존한다. OFF는 레벨 인상 0이다.
3. 새 정책은 다음 달 1일만 허용한다. 기준월과 시행일은 별개이며 현재 정책 단순 조회는 현재 적용 중으로 표시한다. 변경 요약은 실제 새 시행일을 KO/VI로 표시한다. 취소는 임시 상태를 버리며 편집에 반영은 DB를 호출하지 않는다.
4. 새 v11 저장 wrapper는 사용자 행 잠금, 현재 정책 ID·revision 검사, 모든 미래 예약 보호, 변경 없음 무버전·무레벨감사 저장을 보장한다. 기존 v10을 호출해 기존 저장·권한·퇴사 검사를 재사용한다. 기존 hire_month 저장 기준월은 입사일이 실제 변경됐을 때만 재검토한다.
5. 접힌 레벨 변동 내역은 해당 날짜에 유효했던 버전으로 과거/현재/향후를 계산한다. 알 수 없는 기간은 현재 기준월로 추정하지 않는다. 정책 변경 경계의 점프는 정기 승급으로 만들지 않으며 관리자 정책 기록은 분리한다. 계산상 승급이 지급 완료 증거가 아님을 표시한다. 인증된 owner/master만 최소 사용자·정책·감사·급여 계약 정보를 조회한다.
6. 시급제는 계약 하루 기준분 × (계약 월 근무일수 ?? 26) ÷ 60을 분모로 사용한다. 근무 스케줄·실제 시간·추가근무 시간은 분모를 바꾸지 않는다. Math.round(계약 시급 + 누적 승급 수 × 500000 / 월 기준시간)으로 최종 1₫ 반올림한다. 잘못된 계약 시간은 blocking 검토 상태로 반환한다.
7. 공통 분당 시급을 정상근무·휴일·추가근무·지각·조퇴에 연결했다. 추가근무 승인 DB RPC의 독립 시급 검산도 같은 공식으로 수정했다. 각 수당·공제 정책, 월급제·일급제 수식은 유지했다. hourly에는 월급 계약용 특별 인상을 중복 가산하지 않는다.

## 계산 예시

| 계약 시급 | 하루 계약 시간 | 월 일수 | 레벨 | 기존 시급 | 변경 시급 |
|---|---:|---:|---:|---:|---:|
| 35,000₫ | 7시간 | 26 | Lv.1 | 35,000₫ | 37,747₫ |
| 35,000₫ | 7.5시간 | 26 | Lv.1 | 35,000₫ | 37,564₫ |
| 35,000₫ | 7시간 | 26 | OFF / Lv.0 / 승급 전 | 35,000₫ | 35,000₫ |

## 정식 Migration / 운영 적용 경계

Supabase CLI 3.1.0의 migration new로 두 정식 파일을 생성했다. Windows CLI가 OS 정책으로 실행되지 않아 같은 CLI의 공식 Linux-musl 실행 파일을 임시 컨테이너에서 실행했다. DB 연결이나 db push는 하지 않았다.

- `C:\workspace\baba-staff-app\supabase\migrations\20261110133028_employee_level_safe_next_month_v11.sql`
  - SHA-256: `92547e237089f4f9ef7df31b866cc1b659ecdd560a237d3303accb235ff2ae91`
- `C:\workspace\baba-staff-app\supabase\migrations\20261110134802_hourly_level_extra_work_rate.sql`
  - SHA-256: `dad15b30af5cc6aa712287cacb7186a3852d5ed0c9d7f65393f67ee6ad8f1143`

- v11은 서비스 역할 전용 새 함수다. 예약 덮어쓰기 방지를 위해 DB 잠금 안에서 검증하므로 앱 검사만으로 대체할 수 없다.
- 추가근무 Migration은 현재 승인 RPC를 완전한 SQL로 재정의한다. 월급제·일급제 분기, 지급 잠금, 승인·감사·취소 계약은 보존하며 시급제 검산만 변경한다.
- 소스 배포 전에 Owner 승인 하에 이 두 새 Migration 적용이 필요하다. 운영 적용/Push/배포 승인은 이번 로컬 개발 승인에 포함되지 않는다.
- 레벨 기존 11명/22버전/11미러와 기존 감사·지급·근태·계약·장부 행을 일괄 수정하는 SQL은 없다. DIEP/HAI LINH 정정도 하지 않았다.

## 검증 결과

| 검사 | 결과 |
|---|---|
| 영향 범위 14개 테스트 파일 | 144건 중 143 PASS, 기존 실패 1건 |
| 확대 급여 회귀 7개 파일 | 46건 중 43 PASS, 기존 실패 3건 |
| 실제 PostgreSQL 17 최종 Migration 검증 | 12/12 PASS |
| KO/VI × 320/390/430/1280px 실제 페이지 번들 | 8/8 PASS |
| UI 경계 시나리오 | 4/4 PASS |
| TypeScript noEmit | PASS |
| 변경 TS/TSX ESLint | PASS |
| git diff --check | PASS |

- PostgreSQL: localhost 임시 Docker DB에서 실제 정식 SQL 그대로 실행. v11 원자 저장·중복 방지·현재월 거부·stale 거부·예약 보존·서비스 권한·감사 INSERT 실패 롤백·동시 두 저장 직렬화 8건. 추가근무 RPC는 실제 TS 계산과 Lv.0~7, 계약 7/7.5시간, NULL 26일, 제외/OFF/승급 경계/레거시 버전, 위조 시급 거부, invalid hours, daily/monthly 유지·지급/장부 불변 4건. 임시 컨테이너 종료했다.
- UI: 전역 dialog margin:0 및 transform 부모 아래에서 실제 페이지 번들을 실행했다. 740→400→568px 높이 변화, 본문 끝 스크롤 후 헤더/footer 고정, 가로 넘침 없음, 접힌 이력, 모달 취소/Escape/임시 반영/최종 저장/중복 저장 방지 확인. 별도 visualViewport offsetTop=75,height=360 키보드 시뮬레이션, 변경 없음/예약/과거 반영 제외 정책의 기본정보 저장도 PASS.
- 기존 PASS 재사용: 월 기준·레거시 버전 계산 및 employment 날짜 분리 엔진을 수정하지 않았다. 기존 월 기준/legacy 비교 테스트를 재사용했고 시급제 요구가 바뀐 급여 기대값·UI/RPC 계약만 최소 조정했다. 월급·일급 회귀와 과거 레벨 정보/해시 비교는 유지했다.
- 기존 정정 Migration SHA-256은 5098fdd430d9045f0f6efd38d8aa496d3bbe34fa932b3bf74ab81ec7623e7e6c, 월 기준 foundation draft는 fc91dc514971beabbb2fbac7ab91b6d8be585e1fb71b12dac5f5a00c60f76dd7로 변경 전과 동일하다. 기존 October 격리 PASS를 재사용했다.

### 기존 실패 / 미검증

- 공휴일 통합 테스트 missing required level base date: hire_date=null fixture가 직원 선별에서 제외되어 items 접근 실패. HEAD의 원래 engine/compensation/work-policy로도 동일 실패 재현했다. 무관한 선별 정책/테스트는 바꾸지 않았다.
- payroll-overview-policy의 두 정적 UI 검사: paddingLeft:10 및 옛 보험 section 조건을 기대한다. HEAD의 원본 CompensationCard로도 두 실패 재현했다. 이번 수정은 해당 레이아웃을 바꾸지 않았다.
- payroll-part-time-extra-work-rate-policy는 존재하지 않는 20261017072217_part_time_early_extra_work_october.sql을 참조하여 로딩 실패한다. HEAD에도 해당 파일이 없다. 실제 적용 SQL 경로를 사용하는 새 hourly-level-extra-work-db 테스트와 네이티브 PostgreSQL 검증으로 이번 변경을 검증했다.
- 실제 iOS/Android 기기·PWA 설치 환경·OS 키보드는 미검증이며 Chromium 뷰포트/visualViewport 시뮬레이션으로 확인했다.
- 운영 지급 22행 MD5 6a3013ee9ab4288f07fcb3d361d889bc는 이번에 운영 DB에서 재조회하지 않았다. 임시 DB 전체 행 비교, 기존 Migration 불변, 실제 지급 쓰기 경로 무변경으로 보호를 검증했다. 과거 확정/지급 스냅샷을 재저장하지 않았다.
- 기존 추가근무 승인의 옛 시급/해시가 새 계산과 다르면 기존 stale 승인 검토 흐름을 유지한다. 저장된 승인·지급을 자동 갱신하지 않는다. 새 미마감 시급 계산은 레벨 정책에 따라 달라질 수 있다.

## 수정 파일 전체 경로

- `C:\workspace\baba-staff-app\app\(protected)\admin\users\create\page.tsx`
- `C:\workspace\baba-staff-app\app\(protected)\admin\users\page.tsx`
- `C:\workspace\baba-staff-app\app\api\admin\users\[id]\level-history\route.ts`
- `C:\workspace\baba-staff-app\app\api\admin\users\create\route.ts`
- `C:\workspace\baba-staff-app\app\api\admin\users\route.ts`
- `C:\workspace\baba-staff-app\components\payroll\CompensationCard.tsx`
- `C:\workspace\baba-staff-app\docs\reports\20261110-employee-level-modal-v4.md`
- `C:\workspace\baba-staff-app\lib\employee-level\history.ts`
- `C:\workspace\baba-staff-app\lib\payroll\compensation.ts`
- `C:\workspace\baba-staff-app\lib\payroll\monthly-run.ts`
- `C:\workspace\baba-staff-app\lib\payroll\overview.ts`
- `C:\workspace\baba-staff-app\lib\payroll\types.ts`
- `C:\workspace\baba-staff-app\lib\payroll\ui-labels.ts`
- `C:\workspace\baba-staff-app\lib\payroll\work-policy.ts`
- `C:\workspace\baba-staff-app\lib\text\admin-users.ts`
- `C:\workspace\baba-staff-app\lib\text\payroll-overview.ts`
- `C:\workspace\baba-staff-app\supabase\migrations\20261110133028_employee_level_safe_next_month_v11.sql`
- `C:\workspace\baba-staff-app\supabase\migrations\20261110134802_hourly_level_extra_work_rate.sql`
- `C:\workspace\baba-staff-app\tests\admin-users-detail-layout.test.ts`
- `C:\workspace\baba-staff-app\tests\employee-level-admin-policy.test.ts`
- `C:\workspace\baba-staff-app\tests\employee-level-base-date-mode.test.ts`
- `C:\workspace\baba-staff-app\tests\employee-level-history-api.test.mjs`
- `C:\workspace\baba-staff-app\tests\employee-level-history.test.ts`
- `C:\workspace\baba-staff-app\tests\employee-level-month-base.test.ts`
- `C:\workspace\baba-staff-app\tests\employee-level-month-transition-api.test.mjs`
- `C:\workspace\baba-staff-app\tests\employee-level-month-transition.test.ts`
- `C:\workspace\baba-staff-app\tests\employee-level-safe-save-db.test.mjs`
- `C:\workspace\baba-staff-app\tests\hourly-level-compensation.test.ts`
- `C:\workspace\baba-staff-app\tests\hourly-level-extra-work-db.test.mjs`
- `C:\workspace\baba-staff-app\tests\hourly-level-payroll-integration.test.mjs`
- `C:\workspace\baba-staff-app\tests\payroll-compensation.test.ts`
- `C:\workspace\baba-staff-app\tests\payroll-holiday-compensation-integration.test.mjs`

검증 임시 코드·로그·스크린샷은 Git 제외 .local 아래에 보존했다: v4-focused-final2.log, v4-payroll-regression.log, v4-native-final.log, v4-browser.log, v4-browser-edge.log, v4-head-overview-baseline.log, level-v4-existing-failure.log, v4-tsc-final2.log, v4-eslint-final2.log 및 users-ui-check/v4-*.png.
최종 로컬 main 커밋 SHA는 완료 응답에 기록한다. 시작 시 기존 미커밋 작업은 없었고 이번 작업 파일만 커밋한다.
