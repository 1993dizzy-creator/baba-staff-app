# Entries 서버 GET 세부 계측과 개선 설계 — 2026-10-22

## 결과와 범위

기준 HEAD는 `a00832559ab397e4d064f687496ef37cdd525e0e`이며 착수 당시 작업 트리는 깨끗했다. 제품 소스는 수정하지 않았다. 이번 작업은 읽기 전용 계측과 개선안 설계까지다. commit/push, 배포, 운영 DB/Migration 변경을 하지 않았다.

현재 표본의 우선 병목은 다음 두 가지다.

1. `withInventoryDisplay`가 7~10개 Data API 읽기를 직렬 실행한다. `loadPurchaseCases`와 병렬인 구간이지만, 실제 대기를 지배한 쪽은 withInventoryDisplay였다.
2. `base_reads`는 이미 대부분 병렬이다. 그 안에서는 당월 상세 원장 페이지 수집과 후속 식대 정정 조회가 가장 늦게 끝났다. 1,000행 이후 페이지나 정정 조회를 단순히 없앨 수 없다.

`loadPurchaseCases`는 운영 8/9/10월의 최종 이슈가 모두 0개여서 최초 상태 조회 뒤 종료됐다. 이슈가 있는 전체 경로는 합성 fixture로 의존관계만 추가 추적했다. 그 경로의 실제 운영 소요시간을 측정한 것으로 확대하지 않는다.

## 계측 방법과 한계

계측 코드는 `.tmp/entries-server-get-20261022/` 아래에만 만들었다. 원본 TS를 메모리에서 transpile하여 span/쿼리 계측을 삽입했고 원본 파일에는 쓰지 않았다.

- 운영 Vercel: 기존 로그인된 CDP Chrome에서 8/9/10월 `scope=entries` GET과 기존 Server-Timing을 읽었다. 제품에 새로운 로그를 배포하지 않았다.
- 상세 계측: 로컬 Node에서 현재 GET과 helper를 실행하고 실제 운영 Supabase Data API의 읽기를 기록했다. 운영 세션 API로 확인된 UID를 메모리에서 전달하되, 현재 users 행과 role/is_active/app_login_enabled 검증은 원래 서버 인증 코드가 다시 수행했다. signed-cookie 파싱 부분은 로컬 하네스에서 세션 UID 전달로 대체했으므로 로컬 auth span을 운영 인증 시간으로 보지 않는다.
- 네트워크 guard는 지정 Supabase 호스트의 REST GET/HEAD만 허용하고 INSERT/UPDATE/UPSERT/DELETE와 임의 RPC를 차단했다. advisory preview가 필요할 때도 GET RPC만 허용하도록 했지만 실제 운영 표본에서는 RPC가 0회였다.
- 저장한 값은 테이블/열 이름, 필터 열·연산자·배열 길이, offset/limit, 시작/완료/왕복 시간, 행 수, byte 수, 오류 코드, 재무 응답의 hash뿐이다. ID 목록·이름·계좌·영수증 원문·쿼리 원문 URL·키/쿠키는 저장하지 않았다.
- 로컬 왕복은 로컬↔Supabase이며 Vercel↔Supabase와 다르다. 소수 표본이며 서버 부하도 통제하지 않았다. 아래 상세 시간은 순수 PostgreSQL 실행시간이 아니다.
- HTTP 헤더 수신·본문 읽기·쿼리 전체 시간을 구분했다. 개별 SQL executor, pool queue, PostgREST 처리시간을 완전히 분리하지는 못했다.
- 원시 SQL 도구의 함수 정의 SELECT는 별도 승인이 필요하다는 이유로 실행이 거절됐다. 이 세션은 승인을 받을 수 없어 실행하지 않았다. pg_stat_statements/EXPLAIN/함수 정의를 다른 경로로 우회 실행하지 않았다.

## 새 배포의 운영 확인

아래는 보존한 마지막 운영 GET 표본 각 1회다. 브라우저 렌더가 아닌 API 측정이다. 동일 데이터/서버 상태를 고정한 전후 비교가 아니다.

| 월 | 브라우저 헤더 수신까지 | 본문 완료까지 | 서버 전체 | base_reads | inventory_display |
|---|---:|---:|---:|---:|---:|
| 10월 | 4,491ms | 4,738ms | 4,368ms | 2,296ms | 1,090ms |
| 9월 | 2,159ms | 2,280ms | 2,048ms | 809ms | 717ms |
| 8월 | 1,387ms | 1,525ms | 1,284ms | 531ms | 474ms |

이전 첫 번째 운영 확인에서도 9월 API 본문 완료가 약 6.04초로 관찰됐다. 서버/네트워크 변동이 커 첫 요청과 후속 요청을 개선 전후처럼 비교하면 안 된다.

## 1. scope=entries 기본 조회

최종 보존한 로컬 실데이터 표본:

| 월 | 전체 읽기 요청 | base_reads 요청 | base_reads 벽시계 | 당월 상세+연결 정정 경로 |
|---|---:|---:|---:|---:|
| 10월 | 35 | 21 | 482ms | 481ms |
| 9월 | 38 | 21 | 954ms | 952ms |
| 8월 | 36 | 20 | 656ms | 656ms |

각 요청 시간을 더한 값이 base_reads 시간은 아니다. 여러 읽기는 동시에 진행되며, 마지막 필수 경로 완료가 구간을 결정한다. `.tmp/.../profile-월.json`의 start/end로 실제 겹침을 확인했다.

`loadMonthTransactions` 상세:

| 월 | 당월 본문 페이지 | 연결 식대 정정 조회 | 후처리 후 transaction 수 |
|---|---|---|---:|
| 10월 | 800행 / 약 1.20MB / 380ms | 0행 / 100ms | 800 |
| 9월 | 1,000행 / 1.50MB / 577ms → 117행 / 0.18MB / 226ms | 38행 / 37KB / 147ms | 1,118 |
| 8월 | 1,000행 / 1.58MB / 364ms → 13행 / 17KB / 152ms | 41행 / 82KB / 138ms | 1,013 |

당월 수집 뒤 해당 식대 원본 ID의 정정을 조회하고 ID로 합친다. 정정에는 이미 당월에 포함된 행과 다른 월에 기록된 행이 섞일 수 있다. 9월/8월의 단순 행 수 합계가 최종 transaction 수가 아닌 이유다.

- 1,000행 이후 페이지는 실제 존재한다. 삭제/병렬 추측 페이지 읽기/불완전 결과 반환을 하지 않는다.
- 화면 entry 366/457/464건보다 원본 transaction이 많다. 그룹화·반전·취소·원금/지급 등 여러 원장행이 화면행 하나에 관여하므로 화면행 수만큼만 원장을 읽는 방식은 안전하지 않다.
- `recognition_month` 집계, `business_date` 상세, 누적 movements, prior movements는 기간/목적이 다르다. 같은 테이블을 읽는다는 이유로 중복으로 판정하지 않는다.
- 상세 `source_snapshot`, 지급 연결 및 정정 필드를 임의로 줄이면 편집·미납·회계 계약에 영향을 줄 수 있어 첫 개선안에서 제외한다.

추가 직렬 대기: prior movements는 당월 opening이 없다는 사실을 안 뒤에만 필요하다. 현재는 다른 base_reads까지 모두 끝난 다음에 시작한다.

| 월 | opening 반환 행 | 후속 prior 읽기 | 구간 시간 | 다른 base 읽기와 겹칠 수 있는 시간 모델 |
|---|---:|---:|---:|---:|
| 10월 | 0 | 1,000+123행, 2페이지 | 219ms | 최대 약 219ms |
| 9월 | 0 | 549행, 1페이지 | 110ms | 최대 약 110ms |
| 8월 | 4 | 생략 | 0ms | 0ms |

개선 후보는 opening 결과 직후 조건부 prior promise를 시작하는 것이다. 조회 결과를 다른 movements에서 추측해 재구성하지 않고, 현재와 동일한 쿼리를 실행해 기초 잔액 계약을 보존한다. 오류 처리와 rejected promise 관리가 필요하다. 첫 패치와 분리하는 2순위다.

## 2. withInventoryDisplay

원장 transaction ID를 200개씩 끊은 overlay 읽기 전체가 끝나야, source snapshot의 inventory log ID를 200개씩 끊은 공급처 읽기가 시작된다. 두 입력 ID 집합은 처음부터 rows에서 계산 가능하다.

| 월 | 입력 transaction | overlay 읽기 | 공급처 읽기 | 직렬 전체 | 쿼리 대기 합계 | 나머지 처리/계측 |
|---|---:|---:|---:|---:|---:|---:|
| 10월 | 800 | 4회 | 3회 | 3,015ms | 3,010ms | 약 5ms |
| 9월 | 1,118 | 6회 | 4회 | 1,247ms | 1,241ms | 약 6ms |
| 8월 | 1,013 | 6회 | 4회 | 955ms | 948ms | 약 7ms |

10월의 7개 왕복은 약 111/130/150/554/394/1,103/568ms였다. 단일 쿼리 지연이 다음 모든 읽기의 시작을 늦춘다. 첫 로컬 10월 표본에서는 같은 7개 읽기가 약 1.33초였으므로 절대 시간의 변동은 크다. 직렬 구조 자체는 두 표본에서 같다.

이 구간에는 추가 순수 회계 계산보다 네트워크/API 대기가 대부분이다. 우선 개선 후보는 조회 제거가 아닌 **Entries 호출에서만 최대 2개 동시 읽기**다.

공용 helper는 미납 월 이력 및 거래처 미납 상세 GET에서도 사용된다. 그러므로 기본 실행은 현재 직렬 동작을 유지하고, scope=entries가 내부 옵션으로 제한된 병렬화를 선택하도록 설계한다. 외부 query parameter로 동시성 값을 받지 않는다.

지켜야 할 구현 조건:

- chunk 200, 필터, select, 모든 입력 행과 현재 source/display snapshot 계약 유지.
- 전체 입력의 원래 chunk 순서대로 merge. 응답 도착 순서로 Map의 최종 값을 바꾸지 않는다.
- 한 요청의 읽기가 실패하면 전체 GET을 실패 처리. 부분 결과나 빈 overlay로 성공하지 않는다.
- row/source_snapshot을 수정하지 않고 현재처럼 새 표시 객체 생성.
- supplier 조회를 생략하거나 source_snapshot의 과거 supplier로 대체하지 않는다.
- 다른 helper 호출자는 기존 기본값을 유지. 미납/투자금/급여/카드/POS/마감 계산을 바꾸지 않는다.

## 3. loadPurchaseCases

| 월 | 최초 projection 상태 조회 반환 행 | 반환 case | 함수 벽시계 |
|---|---:|---:|---:|
| 10월 | 1 | 0 | 244ms |
| 9월 | 17 | 0 | 112ms |
| 8월 | 0 | 0 | 90ms |

상태 조회에서 일부 synced/NOT_A_PURCHASE 행을 받은 뒤 JS의 정당한 조건 검사에서 제외한다. 반환 case가 0이라는 이유로 이 읽기를 제거하면 다음 요청에서 생긴 실패/정정 이슈를 놓칠 수 있다.

현재 운영 표본에서 root/정정/audit/preview의 후속 읽기는 실행되지 않았다. 따라서 inventory_display의 1초 이상 비용을 이 후속 audit 경로 탓으로 판단할 수 없다.

이슈가 있는 경우의 실제 코드 의존성:

1. 상태 페이지를 전부 읽고 대상 root ID 확정.
2. 각 root chunk의 원본 log, 명시적 correction log, 후보 조회.
3. root/정정에서 얻은 item/date로 chronology 문맥 조회.
4. inventory/candidate audit을 모아 관련 transaction ID 수집.
5. 명시적 correction_of_id 연결을 frontier별로 따라가며 관련 transaction 확장.
6. transaction 상세·audit·actor를 완성한 뒤 case 조립.
7. 필요한 case에 한해 advisory preview, 현재 batch 10개 제한 및 실패 시 경고 유지.

원본/정정/후보 읽기와 두 audit 종류에는 같은 준비 입력에서 시작 가능한 독립성이 있다. 반면 상태 페이지 완성, 각 correction frontier, actor 및 case/preview는 의존성이 있어 일괄 Promise.all로 평탄화하면 안 된다.

기존 합성 fixture로 전체 분기를 추가 추적했다. 사례 1개에서 상태 2페이지를 포함한 mock 읽기 11회와 preview 1회, 이미 처리된 사례에서는 읽기 7회와 preview 0회였다. 각 mock 읽기에 10ms 지연을 넣은 것으로 운영 성능 수치가 아니다. 운영 데이터를 만들어 이 분기를 시험하지 않았다.

이 파일은 첫 구현에서 수정하지 않는 것이 타당하다. 이슈가 존재하는 실제 표본에서 해당 분기가 지연을 지배하는지 확인한 후 별도 개선한다.

## 반복 계산

`calculatePurchaseSettlement`는 로컬 GET 한 번에 10월 1,696회, 9월 2,355회, 8월 2,102회 호출됐다. 계측된 inclusive 시간 합계는 약 3~12ms였다. 계측 자체 비용도 포함된다.

동일 row에서 같은 인자로 호출하는 결과를 지역 변수로 재사용할 여지는 있으나, 현재 초 단위 지연의 주원인은 아니다. 계산식·캐시·급여/월마감 helper를 바꾸지 않는 3순위 후보다.

## 예상 효과: 실제 개선 측정이 아닌 모델

관측한 개별 왕복 시간을 고정한 채 job을 2개 worker에 배치해 재생한 계산이다. 병렬 실행에 따른 Supabase 부하·queue 변화는 반영하지 않았다. API 요청 수는 줄어들지 않는다.

| 월 | 현 withInventoryDisplay | 2개 worker 모델 | 해당 구간 절감 여지 |
|---|---:|---:|---:|
| 10월 | 3,015ms | 1,758ms | 약 1,258ms |
| 9월 | 1,247ms | 665ms | 약 582ms |
| 8월 | 955ms | 477ms | 약 478ms |

loadPurchaseCases와 합친 inventory_display의 벽시계는 두 함수의 합이 아니라 max이다. 현재 case 조회는 모델상 병렬 display보다 짧아 위 절감 모델을 제한하지 않지만, 이슈가 많아지면 달라질 수 있다.

이 표를 Vercel 운영에서 보장되는 0.48~1.26초 단축으로 해석하면 안 된다. 적용 후 동일 조건의 운영 측정이 필요하다. 초기 2~3초 목표 달성을 아직 보장하지 않는다.

## 첫 구현의 변경 예정 파일

| 파일 | 예정 변경 |
|---|---|
| app/api/admin/ledger/route.ts | scope=entries에만 내부 동시성 옵션 전달. POST·다른 scope·계산식 유지 |
| lib/ledger/inventory-display.ts | 최대 2개 읽기 pool, 입력 순서 merge, 기본 직렬 동작 유지 |
| tests/ledger-inventory-supplier-display.test.mjs | 다중 chunk·역순 완료·오류·원본 보존 및 기본값 테스트 확장 |
| tests/ledger-entries-get-query-scheduling.test.mjs | 신규 후보: Entries만 opt-in, 다른 scope/미납 호출자 불변 및 동시성 상한 검증 |

purchase-case-loader.ts는 첫 패치의 변경 대상이 아니다. prior movements 조기 시작과 로컬 중복 계산 제거도 첫 패치의 효과를 분리 측정한 후 진행한다.

공용/TTL 캐시는 이번 안에 사용하지 않는다. supplier 수정, 정정 재반영, candidate status/drift, audit, 미납/마감 등 여러 변경 경로의 완전한 무효화 정책이 확인되지 않았다. 권한 조회 캐싱도 하지 않는다.

## 보존·기준 테스트·남은 검증

- 대상 서버 파일 3개는 조사 시작 SHA256과 종료 SHA256을 대조한다. 제품 구현은 미수정이다.
- 기준 회귀 테스트 29개 통과: purchase-case loader/cases, supplier display, Entries scope 및 fund-account-as-of. 모의 읽기와 순수 계산만 사용했다.
- 제품 코드 변경이 없어 전체 TypeScript/ESLint/Build는 이번 설계 단계에서 실행하지 않았다. 향후 구현 검증을 통과한 것으로 보고하지 않는다.
- 첫 패치 검증 시 8/9/10월 동일 fixture의 전체 JSON 응답을 비교하고, 200/201/1,000+행·빈 입력·중복 ID·supplier null·정정·감사·미납·에러·역순 완료·다른 호출자 기본값을 검사해야 한다.
- 살아 있는 운영 데이터 대신 고정 fixture/메모리 replay로 결과 동일성을 먼저 검증하고, 이후 승인된 배포에서 실제 Server-Timing/TTFB를 반복 측정해야 한다.
- 로그의 origin/upstream 시간은 부수 증거로만 사용했다. 제한 시간대에 해당 table endpoint의 지연 편차를 확인했지만 다른 트래픽과 섞여 있고 순수 SQL executor 시간도 아니므로 개별 SQL 원인으로 단정하지 않았다.
- Advisor 조회만으로 인덱스 변경을 설계하지 않았다. DB DDL, 통계 reset, SQL logging 변경, 운영 backfill은 하지 않았다.

착수 후 새로 관찰된 변경 파일은 아래 4개이며 이 작업에서 수정/복원/스테이징하지 않았다.
- components/sales/PosBusinessDayClosePanel.tsx
- lib/text/sales-close.ts
- tests/pos-business-day-close-view.test.mjs
- tests/pos-pending-payment-browser.test.mjs

관련 근거는 `.tmp/entries-server-get-20261022/`의 live-baseline.json, profile-2026-08/09/10.json, stage-query-summary.json, analysis-model.json, purchase-fixture-trace.json 및 계측 스크립트다. 모든 제품 수정은 현재 설계 보고 이후 단계로 남겨 두었다.
