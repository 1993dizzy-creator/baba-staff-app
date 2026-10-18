> 최신 점검: [V2 배포 전 호출자·428·불완전 기록·권한 검증](20261018-payable-v2-predeploy.md).

# 2026-10-18 10월 정합성 후속 검증 및 부분지급 멱등성

## 범위와 결론

운영 Supabase에는 SELECT 조회만 수행했다. 운영 DB 데이터/DDL/Migration, Google Sheets, 기존 전표/배분, Git 원격, 배포는 변경하지 않았다. 기존 원입고 중심 정산 조회 구현을 유지했다.

- 1,709₫은 누락된 미지급금이나 추가 비현금 차감 대상이 아니다. 기존 **현금성 잔액조정**을 제외하고 지급 전표만 비교한 데서 생긴 대사 차이다.
- 시트 행별 기존 지급 + 명시적으로 연결된 잔액조정의 실제 계좌 이동을 비교하면 **세 행 모두 차이 0₫**이다. 추가 운영 금액 조정은 필요하지 않다.
- V1 부분지급 반복 기록 위험을 격리 DB에서 재현했다. V1을 변경하지 않고 V2 RPC, 영구 요청 기록, UI 요청 키 보관/재확인으로 APP 지급 경로를 보강했다.
- 원입고 인정금액/실제 지급 배분과 시트 현금 대사를 분리한다. 1,709₫을 원입고에 임의 배분하거나 기존 비현금 조정 7,100₫에 합산하지 않는다.

## A. 세 행 원본 대조

자료: [(2026)BABA - Sổ dự án / 10월](https://docs.google.com/spreadsheets/d/1BRT2ul07GftjqVPwcIf35o3LDJ6RjPIdWL_YeiRqDx4/edit#gid=1631724291). 메타데이터 확인 후 A98:K100, A131:K133, A149:K151의 userEnteredValue/effectiveValue/formattedValue/numberFormat/note를 읽었다. 세 지급 셀은 모두 **직접 입력한 정수**이며 수식·표시 반올림으로 발생한 차이가 아니다. 통화 표시는 정수 ₫이고 원시 값과 일치한다.

| 시트 셀 / 영업일 | 품목·거래처 / 원입고·채무 | 시트 실제 출금 | APP 원금 | 기존 원입고 비현금 조정 | 최종 인정금액 | 원입고 배분 실제 지급 | 최종 미지급 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| K99 / 10-08 | 가스통 22kg · Cửa hàng gas petrolimex chính hãng / #1611·채무705 | 2,920,009 | 2,920,000 | 0 | 2,920,000 | 2,920,000 | 0 |
| G132 / 10-10 | 배·포도 · An Liên / #2475·채무1153, #2476·채무1154 | 121,000 | 33,900 + 87,000 | 0 | 120,900 | 33,900 + 87,000 | 0 |
| G150 / 10-11 | 로메인 상추 · Chợ / #2520·채무1189 | 34,000 | 32,400 | 0 | 32,400 | 32,400 | 0 |

가스 원입고 영업일은 **9월 5일**이고 지급일이 10월 8일이다. 이를 10월 신규 매입으로 바꾸지 않았다. 132행의 두 품목별 시트 지급액은 제공되지 않으므로 100₫을 임의로 나눠 배분하지 않는다.

| 행 | 기존 지급 | 기존 별도 잔액조정 | 실제 계좌 이동 합계 | 시트와 차이 |
| --- | --- | --- | ---: | ---: |
| 99 | #2488 · 법인계좌 -2,920,000 | #2489 · 법인계좌 -9 | -2,920,009 | 0 |
| 132 | #2883 · 매장 현금 -120,900 | #2891 · 매장 현금 -100 | -121,000 | 0 |
| 150 | #2886 · 매장 현금 -32,400 | #2892 · 매장 현금 -1,600 | -34,000 | 0 |

연결 근거는 다음 명시적 source_key와 지급 메모의 시트 행 번호, 영업일, 실제 계좌 이동이다. 금액 일치로 다른 매입을 연결하지 않았다.

- #2489: sheet:2026-10:row99:gas-difference
- #2891: sheet:2026-10:row132:fruit-cash-rounding-100
- #2892: sheet:2026-10:row150:lettuce-cash-rounding-1600

세 전표는 confirmed balance_adjustment이고 채무 배분 기록이 없다. **현금 이동이 있는 이 3건과 현금 이동이 없는 #2911~2919는 서로 다른 종류**다. 기존 source_key의 “rounding”만으로 경제적 원인이 반올림이었다고 확정하지 않는다. 특히 #2489 메모는 차액 성격 미확인·손익 제외 임시 조정임을 명시한다. 초과 출금의 최종 비용/선급금/기타 분류는 별도 증빙 없이는 변경하지 않는다. 현재 대사 오류를 해소하는 데는 금액 수정이 필요 없다.

감사 스크립트는 지급 배분 합계(amount), 기존 계좌조정(reconciliationAmount), 실제 출금 합계(cashTotal)를 별도로 출력한다. 원래 배분 차이(allocatedDifference)도 보존한다. 명시적으로 연결된 20개 지급 전표/19개 시트 행 모두 계좌별 일치한다. 모든 시트 행에 원입고 연결이 있는 것은 아니므로 19개 외 전체 시트 매칭을 완료했다고 주장하지 않는다.

근거: .qa-review/october-settlement/discrepancy-live.json, comparison.json, per-receipt.csv.

## B. 중복 위험과 구현

### 기존 위험 재현

격리 DB에서 잔액 40,000₫인 같은 채무에 V1 1,000₫ 요청을 두 번 실행하면 서로 다른 지급 전표·이동·배분이 생성되고 잔액은 38,000₫이 된다. V1의 행 잠금과 잔액 검사는 초과지급을 막지만 동일 논리 요청 재시도를 구분하지 못한다.

### 신규 V2

신규 Migration: [20261018105936_add_payable_payment_idempotency_v2.sql](../../supabase/migrations/20261018105936_add_payable_payment_idempotency_v2.sql)

- ledger_payable_payment_requests: UUID 요청 PK, actor, 정규화 요청 JSONB, 반환 결과, 지급 전표 FK/UNIQUE, 생성·완료 시각. 과거 전표 backfill/UPDATE/DELETE는 없다.
- ledger_pay_payables_v2: 기존 7개 인자에 p_request_id를 추가한 별도 이름의 함수. V1 정의·인자·권한·기존 트리거는 수정하지 않는다.
- 권한은 매 호출마다 active owner/master 검사. 동일 키여도 다른 사용자 또는 비활성 사용자에게 기존 결과를 노출하지 않는다.
- 같은 요청 키의 transaction advisory lock → 기존 기록 검사 → 거래처 lock → 기존 V1 지급/배분 실행 → 결과 기록 순서다. 요청 PK와 지급 전표 UNIQUE 제약이 보조한다.
- 같은 키·동일 내용이면 최초 결과를 그대로 반환한다. 잔액이 변했거나 지급월이 이후 마감돼도 성공 결과 재반환은 쓰기를 하지 않는다.
- 같은 키·다른 요청 내용/actor면 idempotency_conflict, API 409. 거래처·계좌·금액·시각·메모·배분을 모두 포함한다.
- 숫자 표현, UTC 기준 시각, 배분 순서, 메모 양끝 공백을 정규화한다. 서로 다른 키는 내용이 같아도 독립 지급이다.
- 요청 기록·전표·현금 이동·배분·채무 상태·감사 기록이 한 트랜잭션에 속한다. SQL/트리거 예외는 전체를 롤백한다.
- V1의 정상적인 검증 거절 결과도 키에 기록된다. 해당 요청은 같은 거절을 재반환하며 수정 지급은 새 키를 사용한다. SQL 예외는 요청 기록도 남기지 않는다.
- 테이블 RLS 활성화, PUBLIC/anon/authenticated/service_role 직접 접근 금지, V2 실행은 service_role만 허용. SECURITY DEFINER의 search_path 고정과 인자 actor 검증을 유지한다.
- 키 기록에 만료/자동 삭제를 두지 않아 오래된 성공 요청 재시도도 새 지급으로 바뀌지 않는다.

참고 설계 근거: [Supabase DB 함수 권한](https://supabase.com/docs/guides/database/functions), [PostgreSQL transaction advisory locks](https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS).

### API·UI 전환과 호환성

기존 HTTP 경로와 지급 필드를 유지하고 requestId 또는 Idempotency-Key 헤더를 추가한다. 서버는 인증 세션의 actor를 사용한다. 키 없는 호출은 RPC를 실행하지 않고 **428 IDEMPOTENCY_KEY_REQUIRED**로 거절한다. 무작위 키를 서버에서 대신 만들거나 V1으로 우회하지 않는다.

따라서 키 없는 구버전 클라이언트의 지급 동작까지 유지하는 전환은 아니다. 조용히 위험한 지급을 허용하는 대신 새로고침/클라이언트 업그레이드가 필요하다. V1 RPC 자체의 하위 호환성은 유지하며 직접 V1을 호출하는 service_role 외부 프로그램은 여전히 멱등성을 보장받지 못한다. 현재 소스의 APP 지급 호출 3곳(선택 일자·일반 부분지급·결제 미확인)은 모두 V2 API로 전환했다. 운영 적용 전 외부 V1 직접 호출자가 있는지 별도 확인해야 한다.

클라이언트는 사용자·거래처·탭별 sessionStorage에 **보내기 전** 키와 원 요청을 저장한다. 같은 탭의 중복 클릭은 진행 중 Promise를 공유한다. 네트워크/5xx/JSON 해석/잔액 새로고침 실패 시 키를 보존한다. 이전 커밋 후 권한이 일시 변경될 수 있으므로 인증403·API 거절400/428도 원 요청을 보존하고, V2가 명시적으로 거절한 업무 검증 코드에 한해서만 수정 요청을 허용한다. 새로고침으로 입력값이 달라져도 “기존 요청 결과 확인”으로 저장한 원문을 재전송할 수 있다. 새 내용으로 바꾸면 불확실한 기존 요청을 확인하기 전까지 보내지 않는다. 성공 확인과 화면 잔액 갱신이 끝난 뒤 새 지급은 새 UUID를 받는다. 저장소 사용 불가 시 전송하지 않는다.

보존 범위는 같은 탭의 새로고침/재마운트다. 탭 종료·브라우저 저장소 삭제로 키를 잃은 경우 자동 복구한다고 주장하지 않는다. 다른 탭에서 별도 발급한 서로 다른 키는 별도 논리 지급이다. 결과가 불확실한 상태에서 다른 기기로 새 지급을 입력하기보다 기존 장부 결과를 확인해야 한다.

## C. 데이터 및 경제적 효과

원본 스냅샷은 UTC 10:32:21, 최종 운영 조회는 UTC 11:10:32 기준이다. 최종 조회에서 원본 전표 2,838건·채무 1,367건·배분 1,086건·이동 1,388건 중 변경/삭제는 **0건**이었다.

검증 도중 UTC 11:00:07에 기존 식대 처리 경로(attendance_meal_daily_candidate, created_by=1)로 #2920 직원 식대 360,000₫ / 현금 이동 #1459 -360,000₫이 추가됐다. 이번 작업의 운영 요청은 SELECT뿐이다. 이 추가를 이번 변경 효과로 혼동하지 않도록 기준 스냅샷과 최신 스냅샷을 따로 보관했다.

| 최신 동일 스냅샷 기준 비교 | 변경 전 | 변경 후 |
| --- | ---: | ---: |
| 10월 전표 / 채무 / 유효 원입고 | 678 / 422 / 402 | 678 / 422 / 402 |
| 기존 9건 원매입 | 497,100 | 497,100 |
| 기존 9건 비현금 조정 | -7,100 | -7,100 |
| 기존 9건 인정금액 / 실제 지급 | 490,000 / 490,000 | 490,000 / 490,000 |
| 기존 9건 최종 미지급 | 0 | 0 |
| 10월 발생 채무 잔액(확인 대기 포함) | 71,755,950 | 71,755,950 |
| 일반 월말 채무(이월 포함, 확인 대기 제외) | 121,593,180 | 121,593,180 |
| 확인 대기 | 29건 / 8,404,650 | 29건 / 8,404,650 |
| 10월 비용 | 166,907,119 | 166,907,119 |
| 10월 매출·수입 | 439,341,420 | 439,341,420 |
| 10월 손익 | 272,434,301 | 272,434,301 |
| 매장 현금 | 46,313,406 | 46,313,406 |
| 법인계좌 | 286,990,544 | 286,990,544 |
| CHO | 26,405,081 | 26,405,081 |
| Vuong | 5,413,910 | 5,413,910 |
| 카드 정산대기 | 29,690,440 | 29,690,440 |

38개 비용 카테고리·거래처별 잔액도 동일하다. 계좌 수치는 스냅샷 장부 잔액이며 별도 예비비 차감 후 가용액과 구분한다.

- #2266·채무1023(10/5) 76,300₫, #2327·채무1077(10/7) 40,000₫ 유지.
- #2911~2919는 원입고에 한 번만 반영되고 결제 미확인에 재등장하지 않는다.
- 10/11 돼지고기 1,968,000₫(시트155행)은 보류 유지. 추정 연결/전표 생성 없음.
- 10/16 이후 정산·9월 급여·기존 마감·입고 정정 V3·승인/차단 조건은 변경하지 않았다.

최신 비교: .qa-review/october-settlement/current-audit/comparison.json, current-audit/per-receipt.csv, live-invariance.json.
이전 동일 스냅샷의 비용166,547,119 / 손익272,794,301 / 현금46,673,406과 최신 값 사이 360,000₫ 차이는 위 추가 식대 1건이다. 이번 구현의 전후 차이는 두 스냅샷 각각 0이다.

## D. 검증 결과

| 검증 | 결과 |
| --- | --- |
| 기존 정산/API/UI 단위·격리 SQL + 신규 키/API/클라이언트/네이티브 DB | **198/198 통과** |
| 지급 검증 DB·입고 정정 API·월마감·급여·시스템조정·식대 | **108/108 통과** |
| 합계(브라우저 제외) | **306/306 통과**, 실패·skip 0 |
| 전체 유효 10월 원입고 SQL 독립 비교 | **402건 전건 일치**, 원본 해시 동일 |
| 브라우저 | **2/2 테스트 통과**: 기존 통합 화면 4조합 + 신규 지급 흐름 8조합 |
| 변경 소스·신규 테스트·감사 스크립트 ESLint | **0 오류 / 0 경고** |
| TypeScript 전체 tsc --noEmit | **기존 테스트 오류 40건 유지**, 이전 로그와 동일, 새 앱 오류 없음 |
| Production Build | **통과**, Next 16.2.1, TypeScript 및 정적 페이지72개 생성 완료 |
| git diff --check | 통과 |

네이티브 DB는 **로컬 PostgreSQL 18.4**이며 운영17.6에서의 직접 실행 검증은 하지 않았다. 운영 자격증명이나 원격 URL을 허용하지 않는 loopback 전용 테스트다. 브라우저는 실제 페이지 컴포넌트 → 실제 API 핸들러(인증만 fixture) → PGlite의 실제 V1/V2 함수를 연결했다. 브라우저 API는 모두 가로채 운영 쓰기를 차단했다. 12세션 동시성은 별도 네이티브 DB로 검증했다.

필수 상황 대응:
- 연속 동일 키12회 및 동시 동일 키12세션: 전표·이동·배분·감사 각1개.
- 서로 다른 키 정상 부분지급12개 동시: 모두 독립 처리.
- 중복 클릭, 커밋 후 응답504, 재시도 중 인증403, 새로고침 후 같은 키 재시도: 브라우저8조합 전부 중복 없음.
- 동일 키의 금액/계좌/배분/거래처/시각/메모/actor 변경과 같은 키 다른 내용 동시 요청: 충돌.
- 잔액이0이 된 뒤 오래된 성공 키 재시도: 원 결과만 반환, 쓰기0.
- 전표 이후 이동/배분/감사 각각 강제 실패, RPC 직후 트랜잭션 abort: 모두 롤백.
- 서로 다른 키의 초과지급 경합, 음수/비정상 소수/NaN/Infinity, 중복 배분: 지급 차단.
- 기존 비현금 조정으로 정산 완료된 채무: 새 지급 차단.
- 권한/비활성 사용자/재사용 권한, RLS·함수 grants, 월마감: 통과.
- 키 없는 API: 428, V1 직접 호출 원 정의/인자는 유지됨을 테스트.

로그는 .qa-review/october-settlement/idempotency-regression-final.log, idempotency-protection.log, idempotency-final-new.log, idempotency-native-final.log, idempotency-client-final.log, idempotency-browser-last.log, idempotency-browser-final.log, idempotency-eslint.log, idempotency-types.txt, idempotency-build-final.log에 보존했다.

## E. 변경 파일

이번 후속 작업:
- app/api/admin/ledger/payables/pay/route.ts — V2 호출/키 검증/409/428 응답.
- lib/ledger/payable-payment-client.ts — 전송 전 키 보관·재시도·진행 중 요청 공유.
- components/ledger/PayablePaymentRecovery.tsx — KO/VI 기존 요청 재확인.
- app/(protected)/admin/ledger/entries/page.tsx — 선택 일자/부분지급 전환, 새로고침 실패 시 완료 처리 방지.
- app/(protected)/admin/ledger/entries/PaymentVerificationSection.tsx — 개별/묶음 지급 전환 및 재확인.
- scripts/audit-purchase-settlement.mjs — 시트 행별 기존 계좌조정 대사, 별도 출력 디렉터리.
- supabase/migrations/20261018105936_add_payable_payment_idempotency_v2.sql — 신규 테이블/V2/권한만 추가.
- tests/payable-payment-idempotency.test.mjs — 클라이언트/API/기존 시트 조정 근거.
- tests/payable-payment-idempotency-db.test.mjs — 네이티브 동시성/재시도/롤백/권한/마감.
- tests/payable-payment-idempotency-browser.test.mjs — 실제 지급 경로 KO/VI PC·모바일.
- tests/ledger-payable-payments.test.ts, tests/ledger-payables-entries-integration.test.ts, tests/ledger-payment-verification-ui.test.mjs — 새 공통 지급 클라이언트와 V2 호출 구조에 맞춰 회귀 검증 갱신.
- 이 보고서 및 이전 보고서 후속 안내.

이전 작업의 lib/ledger/payables.ts·entries.ts·payment-verification.ts, 조회 API, PurchaseSettlementDetails, 관련 테스트는 보존했다. 이미 적용된 Migration은 수정하지 않았다.

## F. 화면 캡처

응답 유실 후 기존 요청을 재확인하는 실제 화면이다. 샘플 지급은 격리 DB에만 존재한다.

| 언어·화면 | 일반 부분지급 | 결제 미확인 지급 |
| --- | --- | --- |
| KO PC | [보기](../../.qa-review/october-settlement/idempotency-screenshots/ko-desktop-partial.png) | [보기](../../.qa-review/october-settlement/idempotency-screenshots/ko-desktop-verification.png) |
| KO 모바일 | [보기](../../.qa-review/october-settlement/idempotency-screenshots/ko-mobile-partial.png) | [보기](../../.qa-review/october-settlement/idempotency-screenshots/ko-mobile-verification.png) |
| VI PC | [보기](../../.qa-review/october-settlement/idempotency-screenshots/vi-desktop-partial.png) | [보기](../../.qa-review/october-settlement/idempotency-screenshots/vi-desktop-verification.png) |
| VI 모바일 | [보기](../../.qa-review/october-settlement/idempotency-screenshots/vi-mobile-partial.png) | [보기](../../.qa-review/october-settlement/idempotency-screenshots/vi-mobile-verification.png) |

## G. 운영 적용 순서와 위험

아직 적용하지 않았다. 별도 승인 후 아래 순서가 필요하다.

1. 운영 Migration 이력과 V1 정의/권한·잠금 트리거가 로컬 전제와 일치하는지 재조회하고, APP 외부의 V1 직접 호출자를 점검한다. 데이터 backfill 대상은 **0행**이다.
2. 신규 Migration의 변경 대상(요청 기록 테이블·PK/FK/UNIQUE·RLS·V2 함수·grants)을 확인한 뒤 승인된 단일 Migration만 적용한다. 미적용 기존 로컬 Migration을 묶어 임의 push하지 않는다.
3. 기존 API가 V1을 사용하던 동안 발생한 응답 불확실 요청을 먼저 확인한다. 과거 V1 성공을 새 V2 키로 보내면 과거 기록을 자동 인식할 수 없다.
4. V2 준비 후 API와 모든 APP 지급 UI를 함께 반영한다. 열려 있던 키 없는 클라이언트는 428을 받고 새로고침해야 한다. 함수 미존재 시 V1 fallback은 없다.
5. 운영 적용 후 Migration 이력·함수 인자/정의·PUBLIC/anon/authenticated/service_role 권한·RLS·행 수·감사 로그·보안/성능 Advisor를 확인한다.
6. 장애 시 지급 기능을 우선 중지하고 결과를 확인한다. V2 기록을 삭제하거나 V1으로 즉시 되돌려 재시도하지 않는다. 롤백 시에도 이미 기록된 키/결과와 지급 전표는 보존하고 후속 수정 Migration으로 대응한다.

기존 1,709₫과 7,100₫, 원입고·지급·조정·마감에 대한 운영 데이터 수정은 계획하지 않는다. 장차 1,709₫의 비용 분류 변경이 필요하면 별도 증빙과 경제적 효과 비교 후 따로 승인받아야 한다.