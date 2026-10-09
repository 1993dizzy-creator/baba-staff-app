# 9월 2일 공휴일수당 운영 경로 추적 — 인증 응답 확인 대기

조사일: 2026-10-09. 추가 APP 코드 수정·배포 없음. 운영 DB SELECT와 공개 운영 페이지/JavaScript GET만 수행했다. 지급 저장, 재계산 저장, Migration, 운영 데이터 수정, Git 명령은 실행하지 않았다.

## 현재 결론

**운영 APP의 인증된 급여 JSON 금액은 아직 확인하지 못했다.** 로그인 세션 없이 조회한 운영 API는 모두 `401 / RELOGIN_REQUIRED`를 반환했다. 따라서 운영 API가 정상 금액을 반환한다거나 구버전·캐시가 신고 오류의 원인이라고 확정할 수 없다. 오류 발생 위치와 배포 필요 여부는 인증된 응답 확인 전까지 보류한다.

운영 DB 원천과 현재 운영 프런트엔드의 표시 방식은 확인했다. 두 직원의 정상 추가수당은 각각 519,231₫ / 576,923₫이다. 최신 운영 프런트엔드는 이 금액을 별도로 재계산하지 않고 API의 숫자를 포맷해 표시한다.

## 1. 운영 DB 원천 — 읽기 전용 재조회

| 구분 | Quân (user #4) | Linh (user #6) |
|---|---|---|
| 급여 계약 | #5 revision 1 | #12 revision 1 |
| 계약 유효기간 | 2026-08-01부터, 종료 없음 | 2026-08-01부터, 종료 없음 |
| pay_type / calculation_basis | monthly / minute | monthly / minute |
| 원계약급 | 11,000,000₫ | 10,000,000₫ |
| 고정 인상 | 1,000,000₫ | 4,000,000₫ |
| 레벨 설정 | #9 revision 1, enabled | #26 revision 2, enabled |
| 레벨 설정 유효기간 | 2026-07-01부터, 종료 없음 | 2026-08-01부터, 종료 없음 |
| 레벨 기준일 | override 2025-10-01 | override 2026-01-03 |
| 9월 2일 유효 레벨 인상 | 3회 × 500,000 = 1,500,000₫ | 2회 × 500,000 = 1,000,000₫ |
| 합산 월급 | 13,500,000₫ | 15,000,000₫ |
| 기준 근무일 | 26 | 26 |
| 정상 일급 / 공휴일 추가 100% | 519,231₫ | 576,923₫ |
| 신고된 기존 금액 | 423,077₫ | 384,615₫ |

공휴일 #6, NATIONAL_DAY, 2026-09-02의 운영 정책 `internal_pay_multiplier=2` 확인. 해당 연도 그룹 크기는 2일이며 9월 2일에 200%가 선택되어 있다. 이는 이미 기본 근무급여에 포함된 100%에 **추가 100%만 더하는 정책**이다.

급여 지급 배치는 8월 #1 completed만 존재했고 9월 배치는 없었다. 따라서 현재 DB의 9월 확정 지급 스냅샷에서 신고 금액이 나온 것으로 볼 근거는 없다. 과거 응답·캐시·다른 배포에서 생성된 값까지 배제한다는 의미는 아니다. T9 수동 공휴일수당은 이번 검증에도 사용하지 않았다.

DB 증거: `.tmp/holiday-payroll-readonly.json`, `.tmp/holiday-runtime-db-refresh.txt` (인증정보 없음).

## 2. 운영 API 호출 결과

운영 origin: `https://baba-staff-app.vercel.app`

| 조회 경로 | 실제 HTTP 응답 | 금액 확인 |
|---|---|---|
| `/api/admin/payroll/overview?month=2026-09` | 401, `{"ok":false,"code":"RELOGIN_REQUIRED"}` | 미확인 |
| `/api/admin/payroll/source-export?month=2026-09` | 동일 401 | 미확인 |
| `/api/admin/payroll/runs/1` | 동일 401 | 미확인; #1은 8월 배치 |
| `/api/attendance/payroll-summary?month=2026-09` | 동일 401 | 미확인 |

401 응답의 `Cache-Control`은 `no-store`. 인증을 우회하거나 다른 직원의 세션을 만들지 않았다. 인증된 브라우저 연결/응답 전달을 사용자에게 요청했다.

## 3. 급여 목록·상세 API 경로

현 로컬 소스의 조회 흐름:

`admin/payroll/page.tsx` → `GET /api/admin/payroll/overview?month=2026-09` → `loadPayrollOverview` → `loadPayrollMonthSnapshot` → `calculatePayrollBatch` → 일자별 `base_work` 및 `holiday_work_premium` → `buildPayrollOverviewEmployee`의 `holidayWorkPremiumAmount` 합계.

직원별 펼침 상세는 **별도의 급여 상세 계산 API를 호출하지 않는다**. 같은 overview 응답의 직원 객체를 `CompensationCard`로 넘기고 `employee.amounts.holidayWorkPremiumAmount`를 표시한다. `GET /api/admin/payroll/runs/[runId]`는 지급 이력 상세이며 현재 9월 배치가 없어 9월 직원 상세의 원천이 아니다. `source-export`는 일자별 공휴일 기준금액·수당과 계약/레벨 정보를 교차 검증할 수 있는 읽기 전용 경로다.

이 서버 흐름은 로컬 소스에서 확인했다. 운영 서버 함수 파일을 확보하지 못했으므로 모든 서버 코드가 동일하다고 단정하지 않는다.

## 4. 실제 운영 프런트엔드 증거

2026-10-09 09:39:57 UTC에 공개 운영 `/admin/payroll` HTML 및 script 14개를 GET으로 내려받았다.

현재 운영 배포: `dpl_7tcL8zVfm4zBCyVxM4r6fKwxm7Nx`, 생성 2026-10-08 17:25:31.842 UTC, production READY. HTML의 실제 script URL에도 같은 배포 ID가 포함되어 있었다.

- 목록 번들: `/_next/static/chunks/0e0~zt9.xzj2n.js?dpl=dpl_7tcL8zVfm4zBCyVxM4r6fKwxm7Nx`
- 상세 컴포넌트 번들: `/_next/static/chunks/0_y8b5lyxd72x.js?dpl=dpl_7tcL8zVfm4zBCyVxM4r6fKwxm7Nx`

실제 번들에서 확인한 내용:

```js
fetch(`/api/admin/payroll/overview?month=${v}`, {cache:"no-store", signal:e})
e.amounts.holidayWorkPremiumAmount > 0
formatSignedVnd(e.amounts.holidayWorkPremiumAmount, "+")
```

이는 로컬의 목록/상세 처리와 같은 방식이다. 상세에서 원계약급을 나누어 공휴일수당을 다시 계산하는 경로는 발견하지 않았다. 운영 HTML 응답도 `private, no-cache, no-store, max-age=0, must-revalidate`였다. 이 관찰은 최신 페이지의 별도 계산/일반 HTTP 캐시 가능성을 낮추지만, 신고 당시 열려 있던 오래된 탭·과거 응답을 배제하지 않는다. 현재 코드의 급여 금액을 저장하는 localStorage/service worker 경로도 찾지 못했다.

증거: `.tmp/holiday-runtime-public/evidence.json`, `payroll.html`, `chunk-*.js`. 공개 JavaScript 확보는 공개 정적 리소스 GET이며 인증된 급여 데이터 조회를 대체하지 않는다.

Vercel 메타데이터 조회는 성공했다. 서버 파일 트리/파일 내용은 404로 확보하지 못했고 CLI 읽기 전용 목록 fallback은 workspace 밖 업데이트 캐시 파일 접근 EPERM으로 실패했다. 그러므로 운영 서버 계산 엔진이 v11인지, 다른 버전인지 아직 증명하지 못했다.

## 5. 수정 전후 차액 0₫의 이유

수정 전 저장한 로컬 v11 소스는 이미 다음 순서를 사용했다:

1. 일자의 유효 계약 선택.
2. `calculateCombinedSalary`로 계약급 + 고정 인상 + 레벨 인상 합산.
3. 합산 급여를 `calculatePayrollRates(dailyContract, compensation.combinedSalary)`에 명시적으로 전달.
4. 반올림된 `baseWorkItem.amount`에 `(effectiveMultiplier - 1)`을 곱해 추가수당 생성.

v12 보완은 공통 함수·유효 레벨 선택·감사 증거를 명시했지만 해당 두 직원의 기존 계산 입력과 결과를 바꾸지 않았다. 따라서 Quân 519,231→519,231₫, Linh 576,923→576,923₫, 차액 각 0₫이다.

신고값은 원계약급÷26의 반올림과 일치한다. 이는 인상 누락 **산식의 증거**이며, 현재 운영 서버가 그 산식을 실행한다는 증거는 아니다. 앞서 산출한 576,924₫은 그 구산식을 모든 직원에게 적용한 비교값으로 실제 미지급액으로 확정하면 안 된다.

## 6. 인증 응답 확보 후 판단

읽기 전용 확인 스크립트: `.tmp/holiday-runtime-browser-readonly.js`.

관리자로 로그인한 운영 APP의 DevTools Sources → Snippets에서 실행하면 최대 두 GET 요청을 보내고 9월 2일 근무자 12명의 overview 금액과 source-export 일자별 공휴일 항목·계약/레벨 revision을 출력한다. 9월 2일 정상 기준금액과 실제 수당의 차액을 별도로 제공하며, 인증 거절 시 재시도 없이 중단한다. 비밀번호·쿠키·인증 토큰을 출력하거나 전달할 필요가 없다. 지급/저장 API를 호출하지 않는다. 현재 작업 환경에서는 실행 중인 로그인 브라우저에 연결할 자동화 도구·디버깅 연결이 없어 직접 실행하지 못했다. 스크립트의 GET 전용 요청, 인증 거절 중단, 차액 비교는 가상 응답으로 오프라인 검증했다.

- overview와 export가 모두 정상: 현재 서버 계산 오류는 확인되지 않음. 신고 당시 탭/응답/배포를 비교하고 이번 이유만으로 v12 배포하지 않음.
- overview/export 모두 원계약급 수준: 운영 서버 계산에서 계약/레벨 인상 반영 여부와 실행 파일을 대조한 후 필요한 최소 변경 결정.
- export는 정상이고 overview가 잘못됨: 합계·응답 가공 경로 조사.
- JSON은 정상이고 동일 직원 화면만 잘못됨: 현재 탭의 실제 로드 번들·상태·표시 경로 조사.

**현재는 실제 인증 응답이 없으므로 배포 필요 판단을 보류한다.** 기본 100%는 이미 근무급여에 포함되어 있으므로 전체 200%를 추가수당으로 더하지 않는다.
