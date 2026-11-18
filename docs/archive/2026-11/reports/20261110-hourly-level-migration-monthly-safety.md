# 직원 레벨 4차 Migration — 월급제 추가근무 검산 보완

## 범위와 기준

- 시작: 로컬 main d26bb2d709b162f198921e33928be17c93185749, 작업 트리 clean.
- Owner 지시대로 운영 미적용인 기존 정식 Migration 파일만 수정했다. 새 Migration이나 임시 SQL 산출물을 만들지 않았다.
- 앞선 보고서의 월급제 분기 바이트 동일성 PASS는 정책 정확성 증거로 충분하지 않았다. 이 보완 검증이 해당 월급제 계산에 관한 기존 결론을 대체한다. 기존 보고서·검증 이력은 삭제하지 않았다.

## 수정 파일 전체 경로

- C:\workspace\baba-staff-app\supabase\migrations\20261110134802_hourly_level_extra_work_rate.sql
- C:\workspace\baba-staff-app\tests\hourly-level-extra-work-db.test.mjs
- C:\workspace\baba-staff-app\docs\reports\20261110-hourly-level-migration-monthly-safety.md

## 변경 내용

월급제 승인 RPC의 레벨 계산에서 업무일에 유효한 최고 revision을 조회하고, 기존 엔진과 같은 월초 seed fallback을 유지한다. hire_date/override의 저장된 날짜 및 hire_month/override_month의 저장된 기준월을 사용한다. 현재 입사일이나 현재 미러·미래 예약으로 과거 정책을 덮어 계산하지 않는다. 정책이 없는 경우에만 기존 엔진의 미러·입사월 자동 계산을 사용한다.

salary_raise_enabled=false 버전은 레벨만 계산하고 급여 인상은 0으로 검산한다. 계약 특별 인상은 한 번 유지한다. 기존 3개월 승급, Lv.7 상한, 날짜 말일 clamp, 퇴사일 계산 상한을 유지한다.

SQL 수정은 월급제 분기 안으로 한정했다. 시급제 새 공식, 일급제, 지급 잠금, 승인 원본/감사 저장, 취소 함수, 함수 권한과 인자를 변경하지 않았다. 정책·미러·기존 지급/근태/계약·장부를 정정하는 SQL을 추가하지 않았다.

최종 정식 Migration SHA-256: 82b83b885a30636214f63dd3431e67711f6ce63ecbb8dd2c9fd467b139952665

## 검증

- 수정 전: 새 월급제 테스트 4건 모두 실패, 기존 4건 PASS. 실제 SQL과 TS 정책 계산 불일치를 재현했다.
- 수정 후 PGlite: 9/9 PASS. 실제 정식 Migration SQL을 읽어 격리 PostgreSQL 엔진에서 승인 요청까지 실행했다. 기존 daily/monthly 바이트 동일성 검사는 일급제 보존 + 실제 정책 기대값/TS 계산/SQL 승인 검산으로 보완했다.
- 네이티브 PostgreSQL 17: 변경한 월급제 4건만 추가 실행하여 4/4 PASS. 최종 정식 파일 그대로 사용했다. localhost 임시 Docker DB만 사용했고 검증 후 컨테이너를 종료했다.
- ESLint: 변경 테스트 파일 PASS.
- git diff --check: PASS.
- 새 테스트의 정책 oracle은 수동 복사 대신 실제 levelUserFieldsFromVersion, calculateEmployeeLevel, calculateCompensatedPayrollRates를 사용하며 독립적인 기대 레벨·급여도 검증한다.

### 포함된 회귀 사례

- QUYEN 제공 사례: 실제 입사 2025-08-01, override_month 2025-10-01, 2026-10-01/10-31/11-01/11-10 모두 Lv.4(인상 2,000,000₫). 잘못된 Lv.5(추가 500,000₫)를 담아 해시까지 다시 만든 요청은 RATE_MISMATCH로 거절한다.
- HAI LINH: 기존 override 2026-01-03, 10월 시행 override_month 2026-02-01. 9월 말 옛 정책 Lv.2 및 지급 잠금, 10월 Lv.2, 11월 1일/10일 Lv.3. 미래 12월 예약·현재 미러가 해당 과거 기준을 바꾸지 않는다. 운영 데이터 정정은 없다.
- 네 모드 각각 현재 입사일과 다른 저장 기준, 급여 인상 제외 true/false, OFF, 해당 날짜 최고 revision, 월초 seed/정책 gap, 월 기준 승급 전후, 레거시 31일 날짜 clamp, 자동 월 기준 16일 cutoff, Lv.7 상한.
- 정상 승인 전후 정책·직원·계약·근태·지급·장부 전체 행 이미지 불변 및 위조 요청 거절 후 승인/감사 행 불변.
- 월급제 분기 밖 전체 SQL의 SHA-256이 d8d18141 원본과 동일하다. 시급제·일급제·지급 잠금·함수 권한·감사 계약을 그대로 보존했다.

## 기존 PASS 재사용 / 미검증 경계

앞서 보고한 PostgreSQL 12/12 전체를 재실행하지 않았다. v11 저장 원자성·예약·동시성 및 변경하지 않은 시급제/일급제 경로 등 영향 밖 증거를 재사용한다. 월급제 분기에 대한 기존 바이트 동일성 결론은 재사용하지 않고 위 신규 정책 검증으로 대체한다.

앱 UI/API/TS 계산 엔진은 변경하지 않아 기존 관련 PASS를 재사용했다. 전체 Build/TypeScript 및 무관한 기존 실패 테스트는 반복하지 않았다.

운영 DB 접속·쓰기·Migration 적용, Push, 배포는 수행하지 않았다. 운영 실제 지급 MD5를 이번에 재조회하거나 실데이터 승인 테스트하지 않았다. 기존 적용 Migration도 수정하지 않았다. 정식 파일 실행은 테스트용 격리 DB 검증에만 한정했다.

검증 로그/실행 임시 도구는 Git 제외 C:\workspace\baba-staff-app\.local\ 아래 보존했다: monthly-level-safety-before.log, monthly-level-safety-final.log, monthly-safety-native.log, monthly-safety-eslint.log. 최종 로컬 main 커밋 SHA는 완료 응답에 기록한다.
