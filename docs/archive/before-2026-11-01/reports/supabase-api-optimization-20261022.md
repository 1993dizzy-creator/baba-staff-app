# Supabase API 호출 및 Log Ingestion 최적화 조사 — 2026-10-22

현재 로컬 작업 트리 기준 조사다. 운영 로그의 13,300건/일, users 36회/분 등은 사용자가 제공한 사전 조사 수치이며, 이번 작업에서 운영 측정을 다시 수행하지 않았다. 운영 DB 연결·수정, Migration 파일 변경, commit/push, 배포는 하지 않았다.

## 조사 범위와 호출 지도

app, lib, components의 TS/TSX 579개 파일을 AST로 조사했다. 187개 파일에서 createClient 17곳, .from 634곳, .rpc 117곳을 찾았다. .from에는 Storage bucket 접근 5곳도 포함된다. 이는 정적 호출 위치이며 실제 요청 횟수가 아니다. 동적 테이블 이름, 반복문, pagination, 조건부 실행은 런타임 횟수를 바꾼다. 전체 위치는 `supabase-call-sites-20261022.json`에 파일·행·대상·receiver로 기록했다. auth/storage/realtime 사용은 텍스트 검색으로 추가 점검했다. 모든 업무 흐름을 브라우저에서 실행한 결과는 아니다.

- 공통 서버 client: `lib/supabase/server.ts:14`. 별도 서버 client는 inventory snapshot/items/bootstrap/monthly/keg API, login, POS products sync 등에 있다. client 생성 자체가 DB 요청은 아니다.
- 브라우저 client: `lib/supabase/client.ts:3`; mypage와 일부 기존 화면 조회가 이 경로를 사용한다.
- users 직접 접근 60곳: 인증용 단일 사용자 조회, 직원 목록/상세, 급여·근태 대상 사용자, 과거 작성자 이름 복원, cron actor 조회가 혼재한다. 동일 테이블이라는 이유로 합칠 수 없다.
- inventory 직접 접근 38곳: bootstrap 목록, POS 매핑/레시피 검증, 재고 수정 전 상태·중복 검사, 월간·스냅샷·BAR 조회가 혼재한다.
- 날짜 RPC 직접 호출 4곳: business-time-adapter의 날짜 전용/전체 context 경로, store-settings overview, payroll monthly-run.
- 설정 overview RPC 직접 호출 4곳: business-time-adapter의 현재 context/날짜별 snapshot, store-settings overview, 근태 정책 계산.

## 확인한 원인과 수정 판단

| 구간 | 호출 주체와 의존관계 | 판단 |
| --- | --- | --- |
| users | `lib/auth/server-auth.ts:40` → signed cookie 확인 → users 현재 행의 role/is_active/app_login_enabled 검증. 각 API의 requireRole/getAuthenticatedActor가 요청마다 실행 | 별도 요청의 인증 조회는 유지. 공용/TTL 캐싱하지 않음 |
| users/session | `components/UserSessionRefresher.tsx`가 경로 변경 시 force 갱신. focus/visibility는 60초 throttle | 경로 이동 시 권한 갱신 의미가 있어 유지. 분당 36건의 실제 비중은 요청 추적 없이는 확정 불가 |
| 영수증 초기 목록 | `app/(protected)/admin/sales/receipts/page.tsx:2076`에서 빈 businessDate로 조회한 뒤 서버 날짜를 setBusinessDate하면 effect가 다시 실행 | 같은 날짜 목록 재조회 경로 확인. 진행 중인 POS 작업 파일이므로 수정하지 않음. 날짜가 URL에 있는 진입은 해당 조건에 들지 않음 |
| 영수증 상세/preview | 같은 화면의 상세 GET, deduction preview, 저장/상태변경 후 authoritative 재조회가 별도 실행. `app/api/admin/sales/receipts/[id]/route.ts:538`은 auth→receipt→lines/payments | 상세 조회는 상태·금액·재고 계획 확인 목적. 저장 이후 재조회까지 중복으로 취급하지 않음 |
| 5분 sync | `app/api/cron/sales-sync/route.ts` → sync-to-sales → 영업일/context → 최근 성공/lock → CUKCUK 목록/상세 → receipts/lines/payment snapshot → 완료 증거 | 주기와 처리 로직 보존. CUKCUK 상세 호출은 외부 POS API이며 그 자체는 Supabase 요청이 아님 |
| 변경 없는 sync | sync-to-sales에는 3분 내 완전 성공 건 재사용이 이미 있음. 불완전 결과는 완료 증거 검사 대상. saveReceipts/saveLines는 기존 행과 비교하며 결제 snapshot은 authoritative reconcile | 단순히 목록이 같다는 이유로 상세·복구·누락 검사를 생략하지 않음. 현재 변경 중인 파일도 보존 |
| inventory 목록 | `lib/inventory/bootstrap-server.ts`는 목록 1회와 mappings 공유, 상태·keg enrichment를 연결. InventoryPageContent에 요청 dedupe/Strict Mode guard가 이미 있음 | 분당 11회만으로 불필요 판정 불가. POS 매핑/검증/수정 경로는 서로 다른 목적일 수 있어 유지 |
| 재고 영업일 | `lib/inventory/inventory-business-time.ts:24`가 전체 adapter에서 databaseBusinessDate만 사용. 전체 adapter는 날짜 RPC 후 overview RPC를 직렬 호출 | 소비하지 않는 overview 요청 1회 제거. 기존 날짜 전용 resolver 사용 |
| 설정/영업일 반복 | inventory 상태/bootstrap, monthly, snapshot list, 로그/사진 변경, Keg 안전 처리 등이 재고 날짜 helper 호출. POS close는 현재 context와 대상 날짜 snapshot을 별도로 사용 | 재고 날짜 이외의 context/snapshot 제거는 하지 않음. 특히 close는 현재 시각과 대상 영업일이 다를 수 있음 |
| 근태 설정 | `lib/attendance/policy-resolution-adapter.ts:42`에서 workDate의 설정과 직원 스케줄/override로 정책 계산 | 날짜별 정책 계산 의존성이 있어 유지 |

영수증 목록은 receipt/line-count/payment 표시용 조회를 묶고, 상세는 편집·재고 검토에 필요한 내용을 다시 읽는다. 두 API의 users 조회는 각각 현재 권한 확인에 필요하다. 모든 반복을 하나의 캐시로 합치지 않았다. 분당 최대치와 로컬 경로 사이의 정확한 인과관계는 request ID/사용자·화면별 운영 추적 없이는 확정하지 않았다.

## 변경 파일

- `lib/inventory/inventory-business-time.ts`: loadBusinessTimeAdapter 대신 기존 resolveConfiguredBusinessDate 사용. 날짜 RPC 인자와 반환 날짜는 동일하며 overview만 생략한다. 각 호출은 계속 새로 조회한다. fallback, error 로그, previous day 계산은 유지한다.
- `tests/inventory-business-date-requests.test.mjs`: 실제 helper/adapter/스냅샷 목록 GET을 transpile해 모의 Supabase로 전후 비교. 이전 동작은 원래 full-adapter 호출을 메모리에서 재구성한다. 네트워크는 사용하지 않는다.
- 이 조사 문서와 정적 호출 지도 JSON.

정상 응답에서 변경되는 업무 데이터는 없다. 날짜 RPC는 성공했지만 overview만 실패하는 상황에서는, 이제 무관한 overview 장애로 legacy fallback에 진입하지 않고 DB가 반환한 configured 영업일을 그대로 사용한다. 제거한 요청에서만 발생하던 오류는 더 이상 발생하지 않지만, 기존 오류/감사 로깅 코드를 삭제하거나 억제하지 않았다.

## 전후 비교

| 동일 시나리오 | 수정 전 | 수정 후 |
| --- | ---: | ---: |
| 재고 날짜 helper 정상 호출 1회 | 날짜 RPC 1 + overview RPC 1 = 2 | 날짜 RPC 1 = 1 |
| snapshot/list GET 1회, month 생략, 성공 | auth users 1 + 날짜 1 + overview 1 + batches 1 + purchase logs 1 = 5 | 4 |
| 같은 GET 5회 | 전체 25 / users 5 / 불필요 overview 5 | 전체 20 / users 5 / 불필요 overview 0 |
| 각 GET 내부 완전히 같은 쿼리의 중복 | 0 | 0 |
| 날짜 RPC 오류 또는 잘못된 응답 | 날짜 호출 1 + 기존 fallback/error log | 동일 |
| 권한 거부 GET | auth 1, 이후 조회 없음 | 동일 |

이 수정은 동일 쿼리를 캐싱하는 방식이 아니라 사용하지 않는 후속 조회를 제거한다. GET을 여러 번 실행할 때 필요한 인증/업무 조회는 계속 실행한다. 새 테스트의 인증은 mock이며, 실제 권한 정책은 기존 session/role/POS 정책 테스트로 추가 확인했다.

실제 GET handler를 5회씩 실행하고 모의 I/O마다 20ms 지연을 줬다. 첫 실행 중앙값은 117.5→94.7ms, 재실행은 111.5→100.1ms였다. 타이머·스케줄링 변동이 있는 합성 측정이며 HTTP 서버/브라우저/운영 Supabase 왕복시간을 포함하지 않는다. 운영 API의 응답속도 개선률로 해석할 수 없다. 직렬 overview 왕복 1회가 줄어든다는 점이 확실한 성능 근거다.

## 회귀 검사 및 한계

- 신규 전후 비교 테스트 4개 통과: 03:00 전후·월말·연말, fallback/error log, 매 호출 재조회, previous day/explicit month, GET 응답 동등성, 권한 거부 후 후속 조회 차단.
- 관련 27개 테스트 파일 실행: 201개 통과, 4개 실패. 그중 3개는 기존 확장자 없는 TypeScript import의 Node 직접 실행 오류였다. 메모리 내 resolve hook으로 .ts 해석만 보완해 재실행한 17개는 모두 통과했다. 저장소 소스/설정은 바꾸지 않았다.
- 남은 실패 1개: `tests/inventory-date-policy.test.ts:34`. Keg route에서 직접 resolveInventoryBusinessDate(replacementAt)를 찾지만 현재 route는 runKegSafetyChange에 위임한다. 수정 전 helper 소스를 메모리에서 주입해도 같은 실패를 재현했다. 관련 없는 테스트/코드는 수정하지 않았다.
- POS 결제예정·완료, 재고 변경/취소/재적용, 수동/자동 마감 workflow와 동기화 완료 증거, session 재인증, cron 03:00/03:05 관련 기존 테스트를 포함했다.
- 전체 tsc는 통과하지 못했다. 기존 ledger/test의 TS5097 및 타입 오류와 작업 중인 pos-pending-payment-policy.test.ts의 statusChangedAt 타입 오류가 보고됐다. 이번에 변경한 실행 코드의 진단은 없었다. 전체 빌드 통과로 보고하지 않는다.
- 격리된 PGlite 메모리 DB에서 기존 결제예정/완료/취소 및 수동·자동 마감 회귀 테스트 50개 추가 통과. fixture SQL은 해당 메모리 DB에만 실행했고 운영 DB와 Migration 파일은 변경하지 않았다.
- 합계: 통과한 개별 테스트 272개, 수정 전에도 재현된 정적 검사 실패 1개. 최초 import 실행 실패 3건은 resolve hook을 적용한 재실행에서 해소됐다. 반복 실행한 테스트는 합계에 중복 산입하지 않았다.
- 변경 코드 및 신규 테스트 ESLint 통과.
- 운영 데이터로 결제·마감·차감·권한변경을 실행하지 않았고 실제 브라우저 E2E를 수행하지 않았다. 로컬 정책/모의 API 검사 통과를 운영 E2E 검증으로 확대하지 않는다.

## 로그 감소 기대 효과

성공한 재고 날짜 helper 호출당 Supabase API Gateway 요청 1건 감소가 예상된다. 이 helper가 N회/일 성공한다면 약 N건/일이다. 예를 들어 N=1,000이면 제공된 13,300건/일 대비 요청 수 약 7.5%에 해당하지만, N은 측정하지 않았으므로 이는 계산 예시다.

전체 0.91GB에 요청 수 감소율을 그대로 곱할 수 없다. 로그 종류별 크기, Gateway 외 로그, 사용량 집계 시점과 보존/과금 기준에 따라 달라진다. 이미 수집된 로그 사용량을 이번 로컬 변경이 줄이지는 않는다. 배포하지 않았으므로 현재 운영 감소량은 0이다.

## POS 작업과의 충돌 및 미처리 후보

진행 중이던 POS 파일, 결제예정 Migration/verification, 상태변경·동기화·마감 snapshot 로직을 수정하지 않았다. POS full adapter와 날짜별 snapshot API도 그대로다. 5분 sync, 03:05 최종 마감, 03:00 cutoff, 복구·누락 감지 및 감사 로그를 보존했다. 직접 파일 충돌 가능성은 낮지만 재고 helper의 호출자는 공통 영향을 받으므로 운영 E2E까지 확인됐다는 뜻은 아니다.

1. 영수증 화면의 초기 날짜 확정 후 목록 재조회 제거: POS 개발 완료 후 today 화면의 resolvedBusinessDateSkipRef 패턴처럼 처리할 후보. 사용자가 직접 날짜를 바꾸거나 저장 후 새로 읽는 경우는 구분해야 한다.
2. UserSessionRefresher의 경로 이동 force refresh: 권한 갱신/만료 정책을 명시한 뒤 화면 API와 연계할 후보. 단순 TTL 증가로 해결하지 않는다.
3. 전체 close context와 대상 snapshot이 같은 날짜인 경우의 조회 공유: 현재/과거 날짜, revision, fallback 의미를 먼저 검증해야 하므로 보류.
4. POS preview/레시피 validation의 inventory 조회 공유·batch화: 동일 검증 범위와 수정 직전 신선도 확인이 필요해 보류.
5. 요청별 상세 추적은 기본 상시 로그를 추가하지 않고 제한된 계측으로 진행할 후보. 현재 36/11/13회 분당 로그를 각 화면과 cron에 정확히 배분하려면 필요하다.
