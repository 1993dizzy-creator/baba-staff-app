# 2026-09-02 공휴일 추가수당 검증

검증일: 2026-10-09. 로컬 소스 수정·오프라인 테스트만 수행했다. 운영 DB는 APP 서버와 같은 Supabase 클라이언트의 SELECT 조회만 사용했다. DB 변경, Migration 작성·적용, Git 명령, Vercel 배포는 수행하지 않았다.

## 확인된 원인과 확인 한계

운영 공휴일 #6의 `internal_pay_multiplier=2`를 확인했다. 신고된 Quân의 423,077₫은 `11,000,000 / 26`, Linh의 384,615₫은 `10,000,000 / 26`을 반올림한 값이다. 원계약급만 사용하면 월급제의 고정 인상·레벨 인상이 빠진다. 정상 산식은 `(baseSalary + fixedRaiseAmount + levelRaiseAmount) / standardWorkdays`이다.

그러나 수정 전 **현재 로컬 v11 코드에서 신고 오류가 재현되지 않았다**. `monthly-run.ts`는 날짜별 유효 계약을 선택하고 `calculateCombinedSalary`의 결과를 `calculatePayrollRates(dailyContract, compensation.combinedSalary)`에 전달하며, 이미 반올림된 `baseWorkItem.amount`를 `holidayPremiumItem`에 전달했다. `holiday-premium.ts`는 그 금액에 `(effectiveMultiplier - 1)`만 곱한다. `work-policy.ts`의 기본 인자는 `contract.baseSalary`이지만 이 v11 경로에는 합산 급여가 명시되어 있었다. 따라서 로컬 코드가 원계약급만 사용했다고 단정할 수 없으며, 운영에 표시된 구금액을 만든 실행 코드·캐시·응답은 별도 확인이 필요하다.

운영 SELECT 결과 9월 지급 배치는 없었다. 8월 배치 #1은 completed이며 지급 행 18건이 존재했다. 그러므로 아래 '기존 방식'은 **신고 산식을 다른 직원에게 동일하게 적용한 비교값**이며 운영에 저장된 9월 지급액을 뜻하지 않는다. 신고 금액이 제공된 두 명 외 직원의 실제 구 APP 표시값은 독립적으로 확인하지 못했다.

## 변경 내용

- `calculateCompensatedPayrollRates`가 합산 급여와 일급·분급을 한 번에 산출한다. 일반 근무와 공휴일은 같은 기본 근무 항목을 사용한다. 레벨 기준일이 없으면 원계약급으로 대체 지급하지 않고 확인을 요구한다.
- 기본 근무·공휴일·저장 근태 비교 항목에 계약 ID/유효기간, 계약급, 고정 인상, 레벨 인상, 합산 급여, 분급·일급, 레벨 버전 증거를 보존한다.
- 레벨 설정을 월과 겹치는 범위로 한 번 읽고 날짜별 유효 버전을 선택한다. 현재 DB 정책은 레벨 설정 변경일을 월 1일로 제한하며, 이 변경은 그 정책을 수정하지 않는다. 계약은 기존 날짜별 반개방 유효기간 선택을 유지한다.
- 계산 엔진 표시를 v12로 변경한다. 기존 지급 스냅샷을 UPDATE하거나 재저장하지 않는다.
- 200%는 기본 근무 100% + 공휴일 추가 100%이다. 고정월급제는 기존 정책대로 공휴일 추가수당을 지급하지 않는다. 시급·일급제는 기존 단가 정책을 유지한다. 휴무·미완료 근태·누락/중복 계약은 공휴일 근무 수당을 지급하지 않는다.

## 직원별 비교 — 공휴일 추가수당, 단위 ₫

9월 2일 APP 근태 14건 중 실제 근무 12명, 휴무 2명. 아래 산출은 읽기 전용 APP 계약·근태·스케줄·레벨 원천으로 실제 엔진을 오프라인 실행한 결과다. [T9](https://docs.google.com/spreadsheets/d/1a7Fgj05NBXIe6KWLQ-kSe7c0BOp1kOrJTUvcASfQDXk/edit#gid=817628461)의 AN/AO 계약급여·일일급여와 비교했으며 **수동 수정된 공휴일 추가수당 열은 검증 기준에서 제외**했다.

| 직원 | 기존 방식: 원계약급 기준 | 정상 추가수당 | 차액 |
|---|---:|---:|---:|
| Quân | 423,077 | 519,231 | +96,154 |
| Linh | 384,615 | 576,923 | +192,308 |
| Điệp | 326,923 | 384,615 | +57,692 |
| Uyên | 384,615 | 442,308 | +57,693 |
| Nhơn | 346,154 | 442,308 | +96,154 |
| Triêm | 326,923 | 365,385 | +38,462 |
| Khôi | 288,462 | 326,923 | +38,461 |
| Thành | 307,692 | 307,692 | 0 |
| Đức — 시급제 | 175,000 | 175,000 | 0 |
| Thêm | 307,692 | 307,692 | 0 |
| Thủy | 71,429 | 71,429 | 0 |
| Thiết — 시급제 | 245,000 | 245,000 | 0 |
| **합계** | **3,587,582** | **4,164,506** | **+576,924** |

Quyền·Nhung은 휴무로 추가수당 0₫. Thêm은 기존 조퇴 관련 확인 경고가 있어 위 금액은 계산 미리보기이며 지급 승인 완료를 뜻하지 않는다. Thủy의 계약은 `monthly / minute`, 28일 기준이므로 고정월급제 제외 대상이 아니다.

Quân 정상 기준: 11,000,000 + 1,000,000 + 1,500,000 = 13,500,000₫ / 26일. Linh 정상 기준: 10,000,000 + 4,000,000 + 1,000,000 = 15,000,000₫ / 26일.

원계약급 방식 대비 추가 지출 비교값은 **576,924₫(급여 공제 전)**이다. 세금·보험·실수령 차액이나 실제 지급 예정액은 아니다. **로컬 v11 수정 전과 v12 수정 후의 실제 산출액은 12명 모두 같고 추가수당 합계 4,164,506₫, 차액 0₫**이다.

## 검증 결과

| 항목 | 결과 |
|---|---|
| 신규 공휴일 실제 엔진 테스트 | 25 통과 / 0 실패 |
| 집중 관련 급여 테스트 | 174 통과 / 0 실패 |
| 전체 급여·근태·레벨 회귀 | 819건 중 818 통과 / 1 실패 |
| 수정 파일 ESLint | 오류·경고 없음 |
| 저장소 ESLint (.tmp/artifacts 제외) | 기존 오류 4 / 경고 4 |
| Production build | Next.js 16.2.1, TypeScript 검사 및 정적 페이지 72개 생성 성공 |
| 8월 데이터 보존 재조회 | 지급 행 18건의 스냅샷·지급 이력 및 completed 배치 동일 |

전체 회귀 실패는 `tests/payroll-overview-waterfall-performance.test.ts:11`의 기존 소스 문자열 검증이다. 수정하지 않은 `monthly-standing-server.ts`의 옵션에 `staffCurrent`가 추가되어 있는데 테스트의 정규식은 옵션이 `attendancePromise` 뒤에서 끝난다고 가정한다. 이번 급여 계산 수정으로 발생한 기능 실패는 아니다. 저장소 ESLint의 기존 오류는 `app/(protected)/mypage/page.tsx`의 effect 내 상태 변경, `lib/language-context.tsx`의 `any` 및 effect 내 상태 변경, `tests/ledger-manual-amount-edit-db.test.mjs`의 `module` 변수다.

오프라인 테스트는 실제 APP 원천의 필요한 입력만 별도 fixture로 보존한다. 인증정보, 8월 지급 스냅샷, 지급 이력은 fixture에 포함하지 않는다. 테스트의 Supabase 접근은 즉시 예외를 발생시킨다.

## 수정 파일

- `lib/payroll/compensation.ts`
- `lib/payroll/monthly-run.ts`
- `tests/payroll-holiday-compensation-integration.test.mjs`
- `tests/fixtures/payroll-holiday-20260902.json`
- `tests/payroll-holiday-premium.test.ts`
- `tests/payroll-settings-history.test.ts`
- `tests/payroll-store-setting-timeline-wiring.test.ts`
- `tests/payroll-v6-policy.test.ts`
- `tests/employee-level-program-versions.test.ts`
- 이 검토 문서

`work-policy.ts`와 `holiday-premium.ts`는 검토했으며 기존 산술/200% 정책 자체에는 변경이 필요하지 않았다. 기존 Migration과 이전 입고 정정 작업 파일은 수정하지 않았다.

## 배포 전 필요한 확인

1. 운영 APP의 Quân/Linh 9월 응답에서 기본 근무 일급, 공휴일 기준금액, 계약/레벨 revision을 읽기 전용으로 대조하고, 운영 실행 코드가 이 로컬 코드와 일치하는지 확인한다. 로컬 v11이 이미 정상인 만큼 배포만으로 신고 문제를 해결한다고 보장할 수 없다.
2. 9월 미지급 미리보기를 갱신해 정상 금액을 검토한다. Thêm의 조퇴 확인 등 기존 지급 차단 사유를 해결하고 세금·실수령액을 다시 확인한다. 576,924₫을 무조건 별도 인센티브로 더하면 정상 계산 결과와 중복될 수 있다.
3. 8월 completed 배치와 지급 스냅샷은 기존 지급 이력으로 유지한다. 새 계산 hash/engine 표시가 바뀌어도 이미 지급된 행을 재지급·재저장하지 않는다.
4. 별도 GPT 검토 후 배포·지급 여부를 결정한다. 이 변경은 Migration이나 운영 데이터 backfill을 요구하지 않는다.

로그: `.tmp/holiday-focused.txt`, `.tmp/holiday-related-tests.txt`, `.tmp/holiday-all-payroll-tests.txt`, `.tmp/holiday-scoped-eslint.txt`, `.tmp/holiday-repository-eslint.txt`, `.tmp/holiday-production-build.txt`, `.tmp/holiday-august-preservation.json`.
