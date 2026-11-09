# CUKCUK 진행 주문 중앙 동기화 (3차) — 설계와 적용 절차

상태: **코드 준비 완료, 비활성.** 운영 DB, Cron, 환경변수는 아무것도 바꾸지 않았다.

## 흐름

```
Cron(서버, 1곳) ──► runCentralOpenOrderSync ──► CUKCUK orders/paging + orders/{id}
                         │ claim/commit/fail RPC (service_role)
                         ▼
               pos_open_orders_private (스냅샷)
                         ▲ pos_open_orders_read (service_role)
/api/admin/sales/today ──┘  (owner/master/manager 확인 후 서버에서만 읽음)
        │
        ▼
/admin/sales 페이지 (브라우저는 CUKCUK를 호출하지 않음)
```

| 파일 | 역할 |
|---|---|
| `lib/pos/cukcuk/open-orders-core.ts` | 순수 로직: 호출 정책, 페이지 검증, 상세 정규화, 주문/영수증 분류, KPI 계약 |
| `lib/pos/cukcuk/open-orders-sync-server.ts` | 서버 전용 수집기(CUKCUK transport). 아직 어떤 route·cron에서도 호출하지 않음 |
| `lib/pos/cukcuk/open-orders-scope.ts` | CUKCUK 로그인 없이 scope 계산(조회 경로용) |
| `lib/sales/open-orders-read-server.ts` | 스냅샷 + 영수증 연결 → KPI 계약 |
| `components/sales/OpenOrdersPanel.tsx` | KO/VI, 모바일 대응 패널. `not_enabled`이면 렌더링 안 함 |
| `docs/sql/pos-open-orders-v1-draft.sql` | DB 초안(미적용) |

## 수집 규칙

- `POST /api/v1/orders/paging`: `Limit` 100, `Total`이 가리키는 모든 페이지를 수집한다. 다음 경우 실행 전체를 실패로 처리한다(부분 목록 금지).
  - Total이 바뀜
  - 페이지 건수가 맞지 않음
  - 페이지 사이로 행이 밀려 같은 ID가 다시 나옴
  - 필수 필드 누락
- `GET /api/v1/orders/{orderId}`: Status=4(결제완료 후보)를 뺀 모든 주문(1, 3·7·8 등 미확정 상태 포함)의 상세를 읽는다. 동시 요청 거부(102)를 피하려고 상세는 순차 호출한다.
  - 미확정 상태 주문은 메뉴 라인까지 저장하지만 예상액에는 넣지 않는다. `unknown_status`로 보고하고 KPI `complete=false`로 표시한다.
  - 상태 의미가 확인되면 `ORDER_STATUS_OPEN` 매핑만 바꾸면 된다.
- 오류 처리:
  - 102: 최대 3회 순차 재시도.
  - 401 또는 7: 실행당 재로그인 1회 후 실패.
  - 타임아웃(15초), HTTP 오류: 즉시 실패.
  - 다음 Cron이 처음부터 다시 수집한다.
- `LastSyncDate`는 조회 하한(영업일 시작 24시간 전)으로만 쓴다. 매 실행마다 영업일 전체를 다시 읽고 스냅샷을 통째로 교체한다. 그래서 다음 변화는 다음 실행에 그대로 반영된다.
  - 수량 변경
  - 취소
  - 결제완료 전이
- 영업일 소속은 주문 `Date`와 매장 cutoff로 판단한다. cutoff 03:00 기준으로 00:00~02:59 주문은 전날 영업일이다.
- 상세 라인 처리:
  - 상세 ID로 중복을 제거한다. 내용이 같은 중복은 1건으로 합치고, 내용이 다른 중복은 실패로 처리한다.
  - `ParentId`나 `AdditionId`가 있으면 옵션으로 본다. 부모가 없는 옵션도 옵션으로 두고 표시만 한다.
  - 수량이 0 이하인 라인은 제외한다.
- 고객명·전화 등 원본 주문 JSON은 저장하지 않는다.

## 전체 수집과 증분 수집

| 구분 | 전체 수집 (사용) | 증분 수집 (사용 안 함) |
|---|---|---|
| 요청 | 영업일 시작 24시간 전 고정 `LastSyncDate`로 `Total` 전 페이지 | 직전 성공 시각 근처 `LastSyncDate`로 변경분만 |
| 근거 | 실검증: 11/8 영업일 주문 18건 전부 반환(영수증 OrderId 18건, 첫·마지막 주문시각 일치) | 실검증: 현재-5분 기준 `Total=0`. 변경분을 빠짐없이 준다는 보장 없음 |
| 상태 반영 | 매 실행 스냅샷 교체. 종료 주문도 Status=4로 목록에 남는 것을 확인 | — |
| 커서 | 없음. 직전 성공 시각을 요청에 쓰지 않음(테스트로 고정) | — |

운영 코드는 전체 수집만 사용한다. `LastSyncDate`는 조회 하한일 뿐 변경 검출 근거가 아니다.

### 빈 목록·부분 목록 보호

- **수집기:** 이전 스냅샷에서 끝나지 않은 주문(open, 미확정 상태)이 새 전체 목록에 없으면 `GET orders/{id}`로 다시 읽는다(최대 20건).
  - 같은 영업일 주문으로 확인되면 그 상태(예: 4)로 스냅샷에 넣는다.
  - 확인되지 않으면 `orders_vanished_unconfirmed`로 실행을 실패 처리한다. 이전 스냅샷을 정상 0건으로 덮지 않는다.
- **DB(commit):** 같은 영업일의 open/unknown 주문이 새 payload에 없으면 `open_orders_vanished`로 거부한다. 앱 로직과 별도로 이중 차단한다.
- **정상적인 0건 전환:**
  - 진행 주문이 모두 Status=4 등으로 끝났다고 확인되면 진행 0건으로 바뀐다.
  - 끝나지 않은 주문이 없는 상태에서는 빈 목록도 커밋된다.
- **응답 모순:** `Total=0`인데 Data가 있으면 페이지 건수 불일치로 실패한다.
- **영업일이 바뀌면** 새 영업일 스냅샷은 별도로 시작한다. 확인 불가 상태가 이어져도 그 영업일 안에서만 지속된다.

## 실검증 결과 (2026-11-09 17:42 베트남 시각, 읽기 전용, HTTP 4회)

| # | 요청 | 결과 |
|---|---|---|
| 1 | 로그인 | HTTP 200, Success, Code 200 |
| 2 | orders/paging, LastSyncDate=11/7 20:00Z | Total 18 = Data 18. 모두 11/8 18:40~23:00, Status 4, Type 1. 11/9 주문 0건(11/9 영수증도 0건) |
| 3 | orders/paging, LastSyncDate=현재-5분 | Total 0 = Data 0 |
| 4 | orders/{id} (Status 4 대표) | ID·Status·금액 840,000₫ 목록과 일치. 라인 5건 합계 840,000₫ |

- 목록 필드: `Id, Type, No, BranchId, Status, Date, EmployeeId, DeliveryAmount, DepositAmount, TotalAmount, TableName, NumberOfPeople`
  - 날짜 필드는 `Date`(+07:00)뿐이다. 수정 시각 필드는 없다.
- 상세 헤더에는 `EmployeeName`이 추가로 있다.
- 상세 라인 필드: `Id, ItemId, ItemName, UnitId, UnitName, Quantity, Status, Price, Amount, SortOrder`
  - 이 표본에는 `ParentId`·`AdditionId` 키가 없다(옵션 없는 주문).
- **헤더 Status와 라인 Status는 별개다.** 헤더 4인 주문의 라인이 모두 1이었다. 라인 Status는 원값으로만 저장하고 분류·취소 판정에 쓰지 않는다.
- `TableName`은 `BAR10` 형식으로 주문 테이블을 식별할 수 있다(앱 표기 `+bar10`과 형식이 다름).
- **검증 한계:**
  - Status 1·3·7·8 표본이 없다.
  - 옵션(ParentId/AdditionId)이 있는 주문, 취소 주문 표본도 없다.
  - Status=1만 진행으로 보는 매핑과 옵션 판정은 실표본으로 확인되지 않았다.
  - 오류 7의 의미는 여전히 미확인이다.

## 서버 호출 경로와 권한 (정적 검토)

| 함수 | 호출 위치 | 호출 주체 |
|---|---|---|
| `pos_open_orders_claim` / `_commit` / `_fail` | `runOpenOrderSync` ← `runCentralOpenOrderSync`(`open-orders-sync-server.ts`) | `supabaseServer`(service_role 키). **호출하는 route·cron 없음** |
| `pos_open_orders_read` | 수집기(이전 스냅샷 확인) / `loadOpenOrderKpi` ← `/api/admin/sales/today` | service_role. 조회 경로는 `requireRole(owner, master, manager)` 이후, `POS_OPEN_ORDERS_READ_ENABLED=true`일 때만 |

- 위 이름은 모두 `public`의 **SECURITY INVOKER 래퍼**다. 서버는 `OPEN_ORDERS_RPC` 상수에 있는 이 4개 이름만 호출한다.
- 래퍼는 호출자 권한으로 private 스키마의 **SECURITY DEFINER 내부 함수**(`claim_v1`/`commit_v1`/`fail_v1`/`read_v1`)를 부른다. 내부 함수는 소유자 postgres, `search_path = ''`이다.
- DB 실행 권한은 `service_role`에만 있다. 브라우저의 anon/authenticated 키로는 래퍼·내부 함수·테이블 어디에도 접근할 수 없다(PGlite 격리 테스트로 확인).
- `service_role`은 private 스키마 USAGE와 내부 함수 4개 EXECUTE만 갖는다. 테이블 권한이 없으므로 BYPASSRLS여도 테이블을 직접 조회·변경할 수 없다.
- private 스키마는 Data API 노출 스키마에 추가하지 않는다.
- 오류 처리:
  - 내부 함수의 오류 코드(`open_orders_*`)는 그대로 전달된다.
  - 권한 누락(42501)은 `open_orders_permission_denied`, 함수 미배포(PGRST202)는 `open_orders_rpc_missing`으로 바뀐다.
  - 그 밖의 DB 오류는 `open_orders_persistence_failed`로 숨긴다.
- 참고(기존 코드, 이번 범위 밖): `lib/supabase/server.ts`에는 `import "server-only"`가 없다. service_role 키는 `NEXT_PUBLIC_`가 아니어서 브라우저 번들에 들어가지 않지만, 명시적 보호는 별도로 검토할 수 있다.

## 기존 매출과의 분리

- `pos_sales_receipts`의 결제완료 매출은 정본으로 유지한다. KPI의 `paid`는 2차 값 그대로다.
- 주문 `Status`와 영수증 `payment_status`는 섞지 않는다. 연결은 영수증 `raw_json.OrderId` = 주문 `Id`로만 한다.
  - 운영 확인(2026-11-09, `business_date >= 2026-11-01` 전체 166건): CUKCUK 영수증 155건은 모두 OrderId가 있다. 나머지 11건은 앱 수동 영수증(`raw_json.source = manual-receipt-create`, OrderId 없음)이다.
  - 수동 영수증을 제외한 최근 166건(10/31~11/08)은 166건 모두 OrderId가 있다.
  - 전체 기간에 같은 OrderId에 취소 영수증(4)과 재발행 결제 영수증(3)이 함께 붙은 사례가 5건 있다. 판정은 취소되지 않은 영수증으로만 한다.
  - 수동 영수증은 주문과 연결할 수 없다. 수동 영수증을 발행한 주문이 POS에서 Status=1로 남으면 예상액에 이중 집계될 수 있다(운영 확인 대상).
- 영수증 연결 범위: 영업일 D와 D+1 영수증. cutoff 이후 결제된 주문까지 잡기 위해서다.
- 주문별 분류:

| 연결 상태 | 처리 |
|---|---|
| 유효(비취소) 결제완료 영수증 1건 | 이미 매출에 포함 → 예상액에서 제외. 취소 영수증이 함께 있어도 같음 |
| 유효 미결제 영수증 1건 | 미결제 흐름 담당 → 예상액에서 제외 |
| 취소 영수증만 있음 + POS Status≠1 | 제외 |
| 취소 영수증만 있음 + POS Status=1 | 불확정(재개 가능성) |
| 유효 영수증 2건 이상 | 불확정 |
| 영수증 없음 + Status=1 | 진행 주문(예상액 포함) |
| 영수증 없음 + Status=4 | 불확정(영수증 미동기화 가능성) |
| 영수증 없음 + 그 외 Status | 불확정 |

- 불확정 주문은 건수와 금액을 별도로 표시하고 합산하지 않는다.
- 마감된 영업일이나 오늘이 아닌 영업일에는 예상액을 계산하지 않는다(`closed`).

## KPI 계약 (`openOrders` in `/api/admin/sales/today`)

| status | open / provisional | 표시 |
|---|---|---|
| `not_enabled` | null | 패널 숨김. 2차 KPI 그대로 |
| `closed` | null | "마감된 영업일에는 표시하지 않음" |
| `unavailable` | null | 경고 + 최근 정상 확인 시각(없으면 "기록 없음") |
| `incomplete` | null | 최근 시도에서 이전 진행 주문의 종료를 확인하지 못함(`orders_vanished_unconfirmed`, `open_orders_vanished`). 성공 시각이 10분 이내여도 이전 스냅샷을 현재 값으로 보이지 않음 |
| `stale` (10분 초과) | null | 지연 경고 + 최근 정상 확인 시각 |
| `ok` | 계산 | 아래 항목 표시 |

`ok`일 때도 `complete`가 true여야 완전한 예상액이다. 다음 중 하나라도 있으면 false이고, 화면에 "확인되지 않은 주문은 제외" 경고를 표시한다.
- 불확정 주문(미확정 Status, 결제 후보 미연결, 다중 영수증, 취소 후 재개)
- 부모가 없는 옵션 라인

`statusCounts`로 영업일의 원시 Status별 건수를 함께 제공한다.

`ok`일 때 표시하는 항목:
- 진행 예상액
- 진행 주문 건수
- 주문 상품 라인
- 결제완료 + 진행 예상
- 잠정 객단가 = (결제 합계 + 진행 예상) ÷ (결제 영수증 + 진행 주문)

실패나 지연 시 0₫으로 표시하지 않는다. 정상 수집 결과가 0건일 때만 0₫이다.

## DB 초안 요약

- 스키마 `pos_open_orders_private`. 테이블은 `runs`, `sync_state`, `orders`, `order_lines`이다. 모두 RLS를 켜고 권한을 전부 회수한다.
- 로직은 private 스키마의 SECURITY DEFINER 함수 4개에 있다. Data API는 public의 SECURITY INVOKER 래퍼 4개로만 접근하며, 둘 다 `service_role`만 실행할 수 있다.
  - `claim`: advisory lock과 scope별 활성 run 1개 제한으로 단일 실행을 보장한다. lease는 3분이다.
    - 영업일은 베트남 날짜 -1~+1일만 받는다. 잘못된 먼 날짜로 커밋되면 보관 기한 삭제가 현재 스냅샷을 지울 수 있기 때문이다.
    - lease가 만료된 이전 수집기의 늦은 commit은 `lease_lost`로 거부되고, 늦은 fail은 `ignored`로 무시된다.
    - 다른 run의 소유 토큰으로 호출하면 `run_conflict`로 거부된다.
    - 겹치는 요청은 `busy`로 돌려보낸다.
    - 최근 성공이 `p_min_interval_seconds` 이내면 `fresh`로 돌려보내 CUKCUK를 호출하지 않는다.
    - 만료된 lease는 `expired` 처리하고 새 실행을 허용한다.
  - `commit`: 해당 영업일 스냅샷을 한 트랜잭션에서 교체한다. 보존 기한은 7영업일, run 이력은 30일이다.
  - `fail`: 오류를 기록한다. 이전 스냅샷은 유지하지만 성공 시각은 갱신하지 않으므로, 조회 쪽에서 `stale`로 보인다.
  - `read`: 동기화 상태와 주문·라인을 반환한다.

## 실행 시간과 lease

| 항목 | 값 | 위치 |
|---|---|---|
| DB lease | 3분 (claim 시점부터) | SQL `claim_v1` |
| 수집 예산 | claim 후 150초 | `OPEN_ORDERS_RUN_BUDGET_MS` |
| 요청 1건 상한 | 15초 (AbortSignal, 로그인은 `Promise.race`) | `OPEN_ORDERS_REQUEST_TIMEOUT_MS` |

- 요청, 102 재시도 대기, 재로그인은 끝까지 걸릴 최대 시간이 예산 안에 들어올 때만 시작한다. 들어오지 않으면 `run_deadline_exceeded`로 실패를 기록하고 lease를 해제한다.
- 따라서 수집은 claim 후 150초 안에 끝난다. 커밋에는 30초 이상의 lease가 남는다.
- 그래도 lease가 만료되면 늦은 commit은 `open_orders_lease_lost`로 막힌다(소유권 보호). 새 실행의 스냅샷은 보존된다.
- 향후 Cron route는 함수 실행 시간 제한을 180초 이상으로 둬야 한다(예: `maxDuration = 180`).
- 공통 `lib/pos/cukcuk/auth.ts` 로그인과 `lib/supabase/server.ts`는 수정하지 않았다.

## 운영 적용 승인 검토 패키지 (2026-11-09)

- **SQL 파일:** `docs/sql/pos-open-orders-v1-draft.sql`
  - 적용할 때 `supabase/migrations/<timestamp>_pos_open_orders_v1.sql`로 복사한다.
- **운영 읽기 전용 사전점검(사용자 확인 완료):**
  - 신규 private 스키마 없음
  - public 주문 RPC 이름 충돌 0건
  - `service_role`·`postgres` 역할 있음
  - 기존 영업마감 RPC가 service_role 전용으로 접근됨
- **생성 객체**

| 종류 | 이름 | 보안 |
|---|---|---|
| 스키마 | `pos_open_orders_private` | Data API 노출 스키마에 추가 금지 |
| 테이블 | `runs`, `sync_state`, `orders`, `order_lines` | RLS 켬, 모든 역할 권한 없음 |
| 인덱스 | `pos_open_orders_active_scope`(부분 unique: scope당 collecting 1건), `pos_open_orders_runs_recent` | — |
| 내부 함수 | `claim_v1(uuid,uuid,text,text,date,integer=60)`, `commit_v1(uuid,uuid,jsonb,jsonb)`, `fail_v1(uuid,uuid,text)`, `read_v1(text,date)` | SECURITY DEFINER, `search_path=''`, 소유자 postgres |
| public 래퍼 | `pos_open_orders_claim`, `_commit`, `_fail`, `_read` (내부 함수와 인자·반환값 동일, 모두 jsonb 반환) | SECURITY INVOKER, `search_path=''` |

- **권한**
  - `service_role`:
    - private 스키마 USAGE
    - 내부 함수 4개 EXECUTE
    - 래퍼 4개 EXECUTE
  - 그 밖의 권한:
    - `service_role`에 테이블·시퀀스 권한 없음
    - PUBLIC·anon·authenticated는 전부 없음
- **오류 코드**
  - DB가 내는 코드: `open_orders_lease_lost`, `_payload_invalid`, `_run_conflict`, `_scope_invalid`, `_business_date_out_of_range`, `_vanished`
  - 서버가 변환하는 코드: `open_orders_permission_denied`(42501), `open_orders_rpc_missing`(PGRST202/42883), `open_orders_persistence_failed`
  - 앱 수집 코드: `orders_vanished_unconfirmed`, `run_deadline_exceeded`, `provider_*`
- **적용 후 점검**
  - 함수 8개의 `prosecdef`, `proconfig`, 소유자
  - 역할 3개 × 래퍼·내부 함수·스키마·테이블 권한 매트릭스
  - PUBLIC 권한 0
  - 테이블 RLS 켬
  - 행 0건
  - private 스키마가 노출 스키마에 없음
  - 위 항목은 `tests/pos-open-orders-db.test.mjs` 카탈로그 테스트와 같은 내용이다.
- **되돌리기:** 래퍼 4개를 삭제하고 `drop schema pos_open_orders_private cascade`를 실행한다(새 객체만 해당).
- **적용 후에도 하지 않는 것:** Cron 등록, 기능 스위치 ON. 둘 다 별도 승인이 필요하다.

## 운영 적용 전 필요한 승인·확인 (별도 승인 사항)

1. **CUKCUK 읽기 전용 확인**(사용자 승인 후 실행). orders/paging과 orders/{id}를 각 1회 호출해 다음을 확인한다.
   - `Status` 값의 의미(1·4 외의 값)
   - 오류 7의 의미
   - `Total` 포함 여부
   - 날짜 형식
   - 상세 `OrderDetails` 필드명
2. **운영 DB Migration**: `docs/sql/pos-open-orders-v1-draft.sql`을 `supabase/migrations/`로 옮겨 적용한다. 운영 DDL 승인이 따로 필요하다.
   - 생성 객체:
     - 스키마 `pos_open_orders_private`
     - 테이블 4개 `runs`, `sync_state`, `orders`, `order_lines`
     - 인덱스 2개 `pos_open_orders_active_scope`(부분 unique), `pos_open_orders_runs_recent`
     - 내부 함수 4개 `claim_v1`, `commit_v1`, `fail_v1`, `read_v1`
     - public 래퍼 4개 `pos_open_orders_claim`, `pos_open_orders_commit`, `pos_open_orders_fail`, `pos_open_orders_read`
   - 권한:
     - RLS를 켜고 테이블 권한은 전부 회수한다.
     - `service_role`에는 private 스키마 USAGE, 내부 함수 4개 EXECUTE, 래퍼 4개 EXECUTE만 준다.
     - PUBLIC·anon·authenticated는 전부 회수한다.
   - 사전 점검(읽기 전용):
     - 위 이름의 객체가 아직 없는지
     - `postgres`·`service_role` 역할이 있는지
     - Data API 노출 스키마에 private 스키마가 없는지
   - 사후 점검:
     - `has_function_privilege`, `has_schema_privilege`, `has_table_privilege` 매트릭스(테스트와 같은 항목)
     - 래퍼는 `prosecdef=false`, 내부 함수는 `prosecdef=true`, `proconfig`가 `search_path=""`, 내부 함수 소유자가 postgres인지
   - 되돌리기: 래퍼 4개를 삭제하고 `drop schema pos_open_orders_private cascade`를 실행한다(새 객체만 해당).
3. **Cron 활성화**: `/api/cron/pos-open-orders` route를 추가한다(`authorizeCron` 재사용, `runCentralOpenOrderSync` 호출).
   - `vercel.json`에 영업시간대 일정을 등록한다. 예: 16:00~03:00(+07) = 09:00~20:00 UTC, 2분 간격.
   - Cron·배포 승인이 필요하다.
4. **환경변수**: `POS_OPEN_ORDERS_SYNC_ENABLED=true`(수집), `POS_OPEN_ORDERS_READ_ENABLED=true`(화면 표시).
   - `CUKCUK_BRANCH_ID`는 선택이다. 기본값은 기존 지점 ID다.
   - 수집을 먼저 켜고 데이터를 확인한 뒤 표시를 켠다.
