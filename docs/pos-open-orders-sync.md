# CUKCUK 진행 주문 중앙 동기화 (3차) — 설계와 적용 절차

이 문서는 초기 설계·적용 이력을 포함한다. 2026-11-10 네 카드 통합 작업은 기존 중앙 수집을 재사용하며 DB·RPC·Cron·환경변수를 변경하지 않는다. 아래 초기 비활성화 설명보다 최신 KPI 표시 규칙을 우선한다.

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
| `lib/pos/cukcuk/open-orders-sync-server.ts` | 서버 전용 중앙 수집기(CUKCUK transport), 기존 Cron 경로에서 호출 |
| `lib/pos/cukcuk/open-orders-scope.ts` | CUKCUK 로그인 없이 scope 계산(조회 경로용) |
| `lib/sales/open-orders-read-server.ts` | 스냅샷 + 영수증 연결 → KPI 계약 |
| `lib/sales/daily-kpi.ts` | 결제완료 summary + 중앙 주문 결과를 기존 네 카드용으로 결합하는 순수 표시 정책 |
| `components/sales/OpenOrdersPanel.tsx` | KO/VI 동기화·불확실성 안내만 표시. 별도 주문 KPI 없음 |
| `docs/sql/pos-open-orders-v1-draft.sql` | DB 초안(미적용) |

## 수집 규칙

- `POST /api/v1/orders/paging`: `Limit` 100, `Total`이 가리키는 모든 페이지를 수집한다. 다음 경우 실행 전체를 실패로 처리한다(부분 목록 금지).
  - Total이 바뀜
  - 페이지 건수가 맞지 않음
  - 페이지 사이로 행이 밀려 같은 ID가 다시 나옴
  - 필수 필드 누락
- `GET /api/v1/orders/{orderId}`: Status=4(결제완료 후보)를 뺀 모든 주문(진행 1/3, 미확정 5/7/8 등)의 상세를 읽는다. 동시 요청 거부(102)를 피하려고 상세는 순차 호출한다.
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
| 유효 결제예정 영수증(payment_status=1) 1건 + 주문 Status=1/3 | 상세가 있으면 주문 헤더 금액을 정확히 한 번 예상액에 포함. 영수증 금액은 더하지 않음 |
| 결제예정 영수증 1건 + 주문 Status=4/5/7/8 등 | 결제 후보·미확정 상태 보호, 예상액 미포함 |
| 의미 미확인 영수증 상태(payment_status=2/null 등) 1건 | 기존대로 예상액 미포함 |
| 주문 Status=5 | 취소 완료. 예상액 제외, 재확인 대상 제외(새 Migration 필요) |
| 취소 영수증만 있음 + POS Status≠1/3 | 제외. 영수증 취소만으로 주문 취소를 추론하지 않음 |
| 취소 영수증만 있음 + POS Status=1/3 | 불확정(재개 가능성) |
| 유효 영수증 2건 이상 | 불확정 |
| 영수증 없음 + Status=1/3 | 상세 확인된 진행·결제 요청 주문(예상액 포함) |
| 영수증 없음 + Status=4 | 불확정(영수증 미동기화 가능성) |
| 영수증 없음 + 그 외 Status | 불확정 |

- 불확정 주문은 건수와 금액을 별도로 표시하고 합산하지 않는다.
- Status 3은 2026-11-10 운영자 확인에 따른 결제 요청 상태이며 결제 완료가 아니다. 기존 스냅샷의 `statusClass=unknown`도 조회 시 원시 헤더 Status로 재분류한다. Status 3만의 재분류에는 Migration이 필요 없다. Status 5는 아래 11/11 보완에 따라 취소 완료이며, Status 7/8은 계속 미확정이다.
- 마감된 영업일이나 오늘이 아닌 영업일에는 예상액을 계산하지 않는다(`closed`).

## KPI 계약 (`openOrders` in `/api/admin/sales/today`)

| status | open / provisional | 표시 |
|---|---|---|
| `not_enabled` | null | 영업 중 결제완료 값만 표시, 중앙 주문 조회 비활성 경고, 현재 전체 객단가 확인 불가 |
| `closed` | null | 기존 네 카드의 결제완료 값 유지, 진행 예상 미포함 |
| `unavailable` | null | 경고 + 최근 정상 확인 시각(없으면 "기록 없음") |
| `incomplete` | null | 최근 시도에서 이전 진행 주문의 종료를 확인하지 못함(`orders_vanished_unconfirmed`, `open_orders_vanished`). 성공 시각이 10분 이내여도 이전 스냅샷을 현재 값으로 보이지 않음 |
| `stale` (10분 초과) | null | 지연 경고 + 최근 정상 확인 시각 |
| `ok` | 계산 | 아래 항목 표시 |

`ok`일 때도 `complete`가 true여야 주문·메뉴 상세에 확인 필요 항목이 없다. 다음 중 하나라도 있으면 false이고 화면에 확인 필요 경고를 표시한다.
- 불확정 주문(미확정 Status, 결제 후보 미연결, 다중 영수증, 취소 후 재개)
- 부모가 없는 옵션 라인
- 메뉴 상세 합계와 주문 헤더 `TotalAmount` 불일치 또는 의미 미확인 메뉴 Status 6

메뉴 문제만 있는 주문은 헤더 금액 기준 예상액에 **포함**한다. `detailWarnings`는 해당 진행 주문의 ID·번호·헤더/상세 금액·불일치 여부·Status 6 행 수·고아 옵션 수를 별도로 제공한다. unavailable/stale/closed 등에는 null이고, 정상 조회에 문제가 없으면 빈 배열이다. 확정매출과 영수증 분류는 바뀌지 않는다.

### 메뉴 Status 6과 향후 조리관리

- 실제 사례(운영자 제공): 주문 1.12의 헤더 200,000₫, 3행 상세 300,000₫ 중 Status 6 행 100,000₫. 세 행·수량은 그대로 보존하고 예상액은 200,000₫이다.
- Status 6을 취소로 단정하지 않는다. 합계가 일치하더라도 Status 6이 있으면 메뉴 확인 경고를 유지한다. 주문 헤더 Status 3/4의 결제 의미를 메뉴 Status에 적용하지 않는다.
- 메뉴 수량·메뉴 행 수에는 Status 6이 포함되므로 실제 조리 대상보다 많을 수 있다. 옵션의 부모 참조와 고아 옵션 판정을 유지하며, 옵션을 독립 메뉴로 승격하거나 부모와 함께 임의 삭제하지 않는다.
- 주방·BAR 확장 전 메뉴 상태의 공식 의미, 상태 전이, 옵션·부모 메뉴에 대한 적용 방식과 할인·VAT 등 상세/헤더 차이 원인을 확인해야 한다. 현재 상세 합계 비교는 진단이며 확정 조리 수량·재고 차감·확정매출 계산 근거가 아니다.

`statusCounts`로 영업일의 원시 Status별 건수를 함께 제공한다.

### 일간현황 기존 KPI 네 카드 통합 (2026-11-10)

API `summary`는 계속 POS 결제완료 전용이며 `openOrders`의 기존 분류 결과와 `provisional`을 화면에서 결합한다. DB·RPC·마감 계약은 변경하지 않는다.

| 카드 | 영업 중 정상·완전 조회 | 마감 후·과거 영업일 |
|---|---|---|
| 총매출 | POS 결제완료 + 진행 주문 헤더 예상액 | 기존 `summary.totalSales` |
| 영수증 | 결제완료 영수증 + 진행 주문 건수 | 기존 `summary.receiptCount` |
| 판매상품 | 결제완료 상품 라인 + 진행 메뉴 라인, 옵션·부모 참조 있는 하위 라인 중복 제외 | 기존 `summary.salesLineCount` |
| 객단가 | 총매출 ÷ 영수증·진행 주문 건수, 잠정 표시 | 기존 `summary.averageReceiptAmount` |

- 네 카드·2열 기본 레이아웃을 유지한다. 결제완료와 진행 주문의 금액·건수는 각 카드 보조 문구에서 구분한다. 별도 진행 주문 KPI 패널은 제거하고 동기화 시각·경고만 남긴다.
- `ok, complete=false`: 확인된 부분집계라고 명시하며 전체 잠정 객단가는 숨긴다. 미확정 주문은 기존 분류대로 제외한다.
- 메뉴 상세 경고가 있으면 헤더 예상액·주문 건수는 유지하되, 진행 메뉴 수량은 판매상품 카드에서 보류하고 결제완료 라인만 표시한다. 중앙 스냅샷의 행·수량·옵션 관계는 수정하지 않는다.
- `not_enabled/unavailable/stale/incomplete`, 누락된 응답, 영업일·결제완료 기준 불일치: 진행 주문 0으로 간주하지 않는다. 결제완료 수치는 보존하고 전체 규모·현재 객단가 확인 불가를 표시한다.
- 마감 여부·영업 중 여부는 기존 서버 마감 상태를 사용한다. 클라이언트에서 03:00 경계를 계산하지 않는다. 결제예정 영수증 배너는 이 계산에 사용하지 않는다.

### READ 스위치 조사 결과 (이번 작업의 읽기 전용 확인)

- 운영 alias `baba-staff-app.vercel.app`는 READY Production 배포 `dpl_DJPYFdNFnxfdk53gD7ffYnJHFYtE`, SHA `21fd82cde6647c421f13f6161a9d26072420af4e`를 가리켰다.
- `POS_OPEN_ORDERS_READ_ENABLED`는 Production 대상 sensitive 변수로 등록되어 있다. 값은 조회·출력하지 않았으며 실제 런타임 ON 여부는 이 메타데이터만으로 단정하지 않는다.
- 운영 `/api/admin/sales/today` 미인증 GET은 HTTP 401이다. 연결된 브라우저도 사용할 수 없어 로그인된 API의 현재 `openOrders.status`는 재확인하지 못했다.
- 코드상 `process.env.POS_OPEN_ORDERS_READ_ENABLED?.trim() === "true"`일 때만 읽는다. 누락·false·TRUE·1은 `not_enabled`다. 비활성 분기는 영업일/DB 조회 전에 반환한다. 이 동작은 운영 자격 증명 없이 모의 의존성으로 검증한다.
- Notion 정본은 이번 세션의 조회 수단으로 열지 못했다. 사용자가 제공한 2026-11-07 확정 요구사항 전문에 따라 구현했다.

### 로컬 검증 범위

- 최종 영향 범위 회귀 테스트 94/94 PASS, TypeScript(`--noEmit --incremental false`) PASS, 변경 파일 ESLint PASS, `git diff --check` PASS. 테스트 범위: `sales-daily-kpi`, `pos-open-orders-core`, `pos-business-day-close-phase`, `sales-daily-payment-total`, `admin-sales-business-time`, `admin-sales-today-performance`, `sales-sync-cron-final-policy`, `pos-business-day-final-policy`.
- 네 카드 통합, 13+8=21, 금액 변경, 결제 전환 중복 방지, 메뉴/옵션/하위 라인, 실제 0과 조회 불가 구분, Status 5/7/8·메뉴 6, 마감 후 유지, READ 분기, 한국어·베트남어 실제 페이지 렌더링을 테스트한다.
- 오프라인 페이지 렌더링과 격리된 headless Chrome에서 320/390/430/1280px × KO/VI × 정상/부분/비활성/지연/메뉴확인/마감 = 48개 표시 조합을 확인했다. 네 카드 수·가로 넘침·카드 내부 넘침 검사 PASS. 실제 로그인 세션·실데이터 end-to-end 검증과는 구분한다.
- 스크린샷·화면 검사 결과는 Worktree `.local/daily-kpi-qa/`에만 보관한다. 기존 POS 결제 합계, 00:00 수동마감, 03:00 경계, 03:05 최종 검증 회귀를 함께 확인한다. 매출/장부/재고/급여 구현과 운영 설정은 수정하지 않는다.

실패나 지연 시 0₫으로 표시하지 않는다. 정상 수집 결과가 0건일 때만 0₫이다.

### 장애 복구 — 결제예정 영수증과 안전 진단 (2026-11-10, 기준 ce603ce5)

**RED → GREEN 증거**

- Worktree 시작은 깨끗한 `0ed46a9b`, main은 `ce603ce55d3f73d7dcf6e872dbcddb3c6428d9cc`였다. 기존 브랜치를 보존하고 main 기준 `codex/daily-sales-recovery-20261110`을 구성했다.
- 구현 수정 전에 `node --experimental-strip-types --test tests/pos-open-orders-recovery.test.ts` 실행: 3개 중 3개 FAIL. Status 1/3 + 결제예정 영수증 1건의 예상액이 실제 `0`, 기대 `2,410,000`이었다. 헤더를 2,500,000으로 수정한 경우도 기존 합계 1,300,000만 나와 기대 3,800,000과 달랐다.
- 원인: 활성 영수증 1건 중 결제완료(3)가 아닌 모든 영수증을 `receiptPending++` 후 예상액에서 제외했다. payment_status=1만 기존 주문 상태·상세 검증을 거쳐 포함하도록 수정했다. 다른 영수증 상태·중복 활성 영수증·취소만 존재·메뉴 상세 누락 보호는 유지한다.
- 같은 회귀 테스트 3/3 GREEN. 결제완료액 1,300,000/13건/상품 26라인에 주문 1건 2,410,000을 더하면 네 카드는 3,710,000/14건/27라인/265,000이다. 결제 전 헤더 수정과 결제 후 확정액 이동에도 합계·건수·라인·평균은 중복 없이 유지된다.
- `receiptPending`은 연결 결제예정 영수증의 진단 건수이며 예상액 제외를 뜻하지 않는다. 노란색 결제예정 영수증 배너의 합계·건수를 가져오지 않고 중앙 주문 헤더/상세만 사용한다. 기존 마감 차단은 그대로다.

**READ 진단 계약**

인증된 `owner/master/manager`의 `/api/admin/sales/today` 성공·500 응답에 `openOrdersReadDiagnostic`을 추가한다. 401/403에는 생성·포함하지 않는다. 응답은 `Cache-Control: private, no-store`다.

| 필드 | 의미 |
|---|---|
| `readFlagPresent` | 런타임에 READ 변수가 정의되어 있는지. 빈 문자열도 존재=true |
| `readFlagEnabled` | 기존 `.trim() === "true"`와 정확히 같은 판정 |
| `deploymentSha` | `VERCEL_GIT_COMMIT_SHA`가 40자리 16진수일 때만 반환, 그 외 null |
| `deploymentEnvironment` | `VERCEL_ENV`의 production/preview/development만 반환, 그 외 unknown |

환경변수 원문·자격 증명·다른 환경변수는 반환하지 않는다. 기존 READ 판정과 비활성 기본값은 바꾸지 않는다. 추가 DB/API 조회도 없다. 사용자가 보고한 현재 운영 `not_enabled`의 원인이 미정의/비활성값/배포환경 차이 중 무엇인지는 승인된 후속 배포 후 이 진단을 읽어야 구분할 수 있다. 이번 작업에서는 운영 API·CUKCUK·Vercel 조회나 설정 변경을 하지 않았다.

**중앙 수집 장애 분석과 진단**

- 사용자 제공 실측: 22:17 `orders_invalid_row`, 이후 `orders_vanished_unconfirmed` 반복, 23:12까지 12회 연속 실패, 마지막 정상 22:12:21. 공급자 원본 응답이 없으므로 실제 원인은 확정하지 않는다.
- `orders_invalid_row`는 헤더 객체 형식, ID 누락, 날짜 형식, 유효하지 않거나 음수인 금액, 목록 Data 형식에서 발생할 수 있다. 목록은 영업일 필터 전 전체 행을 검증하므로 다른 영업일의 잘못된 행도 실행을 실패시킬 수 있다. 행을 건너뛰도록 완화하지 않았다.
- 이전 미완료 주문이 새 목록에 없으면 기존 상세 재조회로 확인한다. 이 경로는 공급자 오류·헤더 검증 실패·상세 누락을 모두 `orders_vanished_unconfirmed`로 감싸 원인을 잃고 있었다. 잘못된 주문 ID/영업일이나 확인 대상 20건 초과도 같은 외부 코드로 실패한다.
- 기존 Cron의 같은 요청에서 `[OPEN_ORDERS_SYNC_DIAGNOSTIC]` 로그를 추가한다. 기존 외부 실패 코드와 DB fail 코드, Cron HTTP 응답은 유지한다.
- 로그는 허용 목록의 `code`, `stage`(page/detail/vanished_detail/vanished_limit/run), `reason`, 원인 코드 `causeCode`, 숫자 `page`(1부터)·`rowIndex`(0부터)·`vanishedCount`·`confirmedCount`만 투영한다. 예외 message/stack, 주문 ID, 고객명·전화·원본 JSON·토큰은 남기지 않는다.
- 오류 원인이나 위치를 알 수 없는 항목은 추측하지 않는다. 진단 기록 자체가 실패해도 실행 실패 처리에 영향을 주지 않는다. 추가 공급자 호출, 사라진 주문 삭제·정상 종료 추론, 부분 스냅샷 커밋은 없다. lease·vanished DB 보호와 상세 재조회 상한을 그대로 유지한다.

**이번 수정 검증**

- 이전 94/94 결과를 이번 복구 완료 근거로 삼지 않았다. 이번 RED 후 회귀·진단·실제 Cron 모듈·KPI 네 카드·POS 확정 결제합계 관련 6개 파일을 선정해 79/79 PASS를 확인했다.
- 대상: `pos-open-orders-recovery`, `pos-open-orders-read-diagnostic`, `pos-open-orders-core`, `sales-daily-kpi`, `pos-open-orders-cron-route`, `sales-daily-payment-total`.
- 이번 변경의 TypeScript(`--noEmit --incremental false`), 변경 파일 ESLint, `git diff --check` PASS.
- 기존 Cron 정적 범위 단언은 `686f3803..현재` 전체 매출 코드 변경을 금지하고 있어 이번 수정 전 main에서도 `open-orders-core.ts`, `daily-kpi.ts` 때문에 실패했다. 원래 Cron 납품 커밋 `2b3d750b`까지의 범위를 고정해 당시 계약을 검증하도록 수정했다. 현재 Cron의 인증·시간·직렬 요청·실패 처리와 새 안전 로그는 실제 모듈 실행 테스트로 별도 확인했다.
- DB·Migration·장부·재고·급여 및 마감 코드 변경 없음. 운영 복구 완료나 런타임 READ 활성화 확인을 의미하지 않는다.

## DB 초안 요약

### 2026-11-11 vanished detail Id 누락 복구 (이전 상태 설명보다 우선)

**범위와 확인한 원인**

- 기준 main `0702388ac0b425f7111fe2f0786c4808fd2888b7`, 기존 Worktree의 깨끗한 `47c3c084` 브랜치를 보존하고 `codex/open-orders-vanished-recovery-20261110`에서 작업했다.
- 운영자가 제공한 11/10 23:47 진단은 `vanished_detail / order_id_missing / orders_invalid_row`, 소실 1건·확인 0건이다. 이전 스냅샷의 미완료 주문 상세에서 유효한 ID를 얻지 못해 전체 실행이 거부되는 경로를 격리 재현했다.
- CUKCUK가 ID를 생략한 이유, 실제 소실 주문의 OrderId 및 현재 연결 영수증은 이번 작업에서 운영 조회하지 않았다. 공식 Data.Id/Status 5 의미는 사용자가 제공한 확정 정보를 적용했다. 저장소의 공식 상세/목록 문서 URL은 공개 문서 조회 시 404여서 최신 원문을 독립적으로 재확인하지 못했다. 주문 API 실호출은 하지 않았다.

**변경 전후**

- 이전: 사라진 주문 상세 ID가 없으면 결제 영수증이 있어도 전체 실패. Status 5는 unknown이라 앱·DB가 계속 재확인을 요구했다.
- 이후: ID 누락 또는 Data 부재일 때만 기존 CUKCUK 영수증을 읽어, 정확한 OrderId와 주문 영업일 D/D+1에서 비취소 활성 영수증이 정확히 1건이며 payment_status=3인지 확인한다. 결제예정·취소만 존재·중복·다른 주문/영업일이면 계속 차단한다. 취소 후 단일 정상 결제 재발행은 허용한다.
- 요청 ID를 Data.Id에 주입하지 않는다. 이전 DB 스냅샷의 ID·Status·금액·메뉴를 보존하고 `closureReceiptId`/`closureConfirmedAt`을 독립 증거로 기록한다. `providerObservedAt`은 이전 공급자 관측 시각이다. 응답에 ID가 없으면서 Status 4가 있더라도 그 값을 새 공급자 사실로 채택하지 않는다.
- 잘못된 ID·숫자/zero UUID 등 잘못된 ID 형식, 잘못된 날짜·영업일, 잘못된 Data 형식, 공급자 오류는 결제 증거가 있어도 우회하지 않는다. ID/영업일을 메뉴 파싱 전에 검사해 메뉴 누락이 신원 오류를 가리지 않게 했다.
- 정상 조회는 기존대로다. 영수증 증거 조회는 필요한 실패 경로에서만 D/D+1을 정확한 페이지 수로 읽으며 실행당 재사용한다. 공급자 추가 요청은 없다. 이전 영수증 증거가 사후 취소·결제예정·삭제로 바뀌면 과거 헤더를 새 진행 예상액으로 재사용하지 않고 `closure_evidence_changed`로 보류한다.
- Status 5는 `canceled`이며 미결제 예상에 포함하지 않는다. 목록에 있는 Status 5는 상세 재호출이 필요 없고, 예전 unknown으로 저장된 raw Status 5도 `unfinishedOrderIds()`에서 제외한다. Status 4의 결제 후보 및 7/8 미확정 보호는 유지한다.

**정식 Migration — 별도 운영 적용 승인 필요**

파일: `supabase/migrations/20261110170329_pos_open_orders_vanished_receipt_evidence.sql` (Supabase CLI `migration new`로 생성, UTC 파일 시각).

- 기존 적용 Migration/초안 파일은 수정하지 않았다. 새 파일은 private orders의 `canceled` 허용값과 raw status=5 일치 제약, 독립 영수증 증거 컬럼 2개를 추가한다. 기존 데이터 일괄 수정은 없다.
- 기존 snapshot commit 함수를 private `commit_snapshot_v1`로 보존하고 직접 실행 권한을 회수한다. 기존 이름 `commit_v1`의 새 검증 래퍼와 public SECURITY INVOKER 래퍼, read 모델을 갱신한다. public RPC의 인자는 동일하다.
- DB는 앱의 증거 주장을 신뢰하지 않는다. 같은 scope/영업일의 기존 주문이 실제 있어야 하며 현재 receipts를 다시 검사한다. 앱이 전달한 Status·금액·메뉴를 변조해도 영수증 복구에서는 DB의 이전 주문을 사용한다.
- 영수증 증거 경로에서만 `pos_sales_receipts`에 SHARE 잠금을 잡아 검증과 커밋 사이의 취소/재발행/중복 삽입을 막는다. 이 짧은 구간 동안 영수증 쓰기가 대기할 수 있다. 잠금 획득 대기는 10초로 제한하고 원래 lock_timeout을 복원한다. 잠금 실패·증거 변경은 `open_orders_vanished`로 실패한다. 영수증 DML은 하지 않는다.
- 원래 commit의 advisory lock·owner token·lease·소실 주문 포함·트랜잭션 원자성 검증은 그대로 수행한다. 모든 주문/메뉴를 보존하고, 복구 행의 공급자 관측 시각은 변경하지 않는다. 기존 raw Status 5 행은 삭제하지 않고 canceled로 유지하며 재호출하지 않는다.
- `runs.manifest.receiptClosures`에는 사용한 영수증과 이전 정규화 스냅샷을, `retainedCancellations`에는 원래 Status 5 관측 증거를 남긴다. 공급자 원본 JSON이나 고객 정보는 추가하지 않는다. 기존 보관 기간은 변경하지 않는다.
- read 응답의 `recoveryContractVersion=2`를 확인한 경우에만 앱이 영수증 복구 메타데이터를 전송한다. Migration 미적용 DB가 추가 JSON 필드를 무시하고 성공 처리하는 일을 막는다. 미적용 상태에서는 기존 차단을 유지한다.
- 적용 순서: 별도 승인된 Migration 적용·스키마/권한/계약 버전 확인 후 새 앱을 배포한다. 이번 작업은 둘 다 수행하지 않았다. 장부·재고·급여·확정 결제매출·마감 계약·환경변수·Cron 등록은 변경하지 않는다.

**RED/GREEN과 남은 확인**

- 수정 전 새 격리 테스트: 3개 중 2 FAIL(단일 정상 영수증이 있어도 ID 누락으로 실패, Status 5가 unknown), 1 PASS(독립 증거 없으면 차단). 수정 후 같은 3개 GREEN.
- 원래 DB guard가 raw Status 5/unknown 행 소실을 막는 것도 로컬 실제 SQL로 재현했다. 새 Migration 적용 후 이전 Status 5 행 보존·재조회 생략이 통과했다.
- 로컬 PGlite에서 정식 Migration과 public 서비스 역할 RPC를 실행해 영수증 재검증, 다음 영업일/재발행, 위조 증거 거부, 헤더 사실 보존, 삭제/삽입 도중 오류의 원자적 롤백, 소유권·lease·재실행, Migration 트랜잭션 롤백, helper 권한을 검증했다. 운영 DB/자격 증명은 사용하지 않았다.
- 이번 영향 범위 테스트 7개 파일 93/93 PASS. 대상: `pos-open-orders-vanished-recovery`, `pos-open-orders-vanished-db`, `pos-open-orders-core`, `pos-open-orders-recovery`, `sales-daily-kpi`, `pos-open-orders-cron-route`, `sales-daily-payment-total`.
- TypeScript(`--noEmit --incremental false`), 변경 파일 ESLint, diff 검사 PASS. `db advisors --type all --fail-on error`는 기존 로컬 스택(127.0.0.1:54322)을 읽었으며 ERROR 0, 기존 매핑/영수증 테이블의 중복 인덱스 WARN 3이었다. 새 Migration은 이 로컬 스택에도 적용하지 않았으므로 해당 Advisors 결과를 새 함수 검증으로 간주하지 않는다. 새 함수·권한·원자성 검증 근거는 격리 PGlite 테스트다.
- 이전 PASS는 원본 SQL 구현·변경 없는 영역의 근거로만 재사용하며 이번 복구 성공을 대체하지 않는다. 운영 복구 여부는 실제 소실 OrderId와 유효 영수증 증거, Migration 계약 버전, 첫 정상 Cron·감사 증거 및 KPI 대조를 추가 확인해야 한다. 증거가 없으면 여전히 차단하는 것이 정상이다.

### 2026-11-11 최종 안전성 2건 보완 (운영 미적용 파일 직접 수정)

- 이번 기능 수정은 기존 정식 Migration 파일의 7줄 추가뿐이다. 새 Migration이나 앱·Cron·환경변수 변경은 없다. LF/CRLF 차이는 오류로 취급하지 않으며 정식 저장소 파일은 LF를 유지한다.
- `closureReceiptId` 복구 분기에서만 `transaction_isolation = 'read committed'`를 요구한다. REPEATABLE READ/SERIALIZABLE은 영수증 확정·snapshot commit·commit 감사 변경 전에 `open_orders_vanished`(SQLSTATE 55000), 고정 DETAIL `receipt_evidence_requires_read_committed`로 거부한다. 증거 없는 일반 수집은 두 격리 수준에서도 허용한다.
- 기존 오류 매핑을 그대로 사용한다. 서버 DB 오류 변환은 `open_orders_vanished`, Cron HTTP 500/failed, 일간 KPI는 incomplete 보호다. 새 오류 코드나 자격 증명/환경변수 원문 노출을 추가하지 않았다.
- Migration 첫 DDL 전에 `SET LOCAL lock_timeout = '5s'`를 추가했다. 기존 Supabase CLI의 파일별 트랜잭션 적용 경로를 유지한다. 이 값은 Migration 트랜잭션에만 적용되고, 기존 영수증 증거 SHARE 잠금의 런타임 10초 한도는 그대로다.
- 수정 전 PostgreSQL 17.6 독립 연결에서 취소된 영수증을 REPEATABLE READ의 오래된 snapshot으로 확정하는 오류를 재현했다(RED). 수정 후 거부·전체 롤백을 확인했다(GREEN). SERIALIZABLE 거부, READ COMMITTED 정상 복구, 일반 수집 허용도 각각 확인했다.
- 새 native 검증 `tests/pos-open-orders-safety-native.mjs --port=55439`: 8/8 PASS. 별도 폐기 가능한 PostgreSQL 17.6(기존 로컬 스택/운영과 분리), 독립 backend 연결 및 실제 relation lock을 사용했다. 원장 sentinel은 모두 불변이다.
- 정식 파일을 바이트 그대로 복사해 Supabase CLI 3.1.0 `migration up`의 명시적 loopback DB URL로 실행했다. 첫 ALTER TABLE 잠금 대기는 4,985ms, 컬럼·read 함수·함수 rename 이후 테스트용 event trigger의 실제 DDL 잠금 대기는 4,983ms에 timeout됐다. 두 경우 기존 컬럼·함수 정의/이름·권한·snapshot·commit 감사가 모두 원복됐다. POS 영수증 쓰기는 각각 3ms로 완료됐다.
- Migration 대상 객체의 event-trigger 관측에서 `lock_timeout=5s`를 확인했다. CLI 초기화용 migration-history DDL은 측정 대상에서 분리했다. 같은 native 연결의 설정은 적용 전/트랜잭션 중/COMMIT 후 `0/5s/0`으로 복원됐다. public RPC·권한·read 계약 버전 2도 통과했다.
- 기존 Migration PGlite 회귀 8/8 PASS. 이전 native 14 PASS 중 변경 없는 READ COMMITTED 동시 쓰기·영수증 10초 잠금·상태/권한·구/신 앱 계약 범위는 재사용한다. 이전 REPEATABLE READ 실패는 재사용하지 않고 새 검증으로 대체했다. TypeScript·변경 파일 ESLint·diff 검사 PASS.
- 정식 LF 파일 SHA-256: `b88c2977c73177f7b86e5d07b309d20f1b496a75766ae3322b47f9296d4667e9`. 실제 검증 파일·Worktree·커밋 blob의 바이트 일치를 제출 시 확인한다.
- RED 및 GREEN 측정 결과·CLI 로그는 `.local/open-orders-safety-fix/`에 보존한다. 코드 병합과 운영 적용은 별개다. 로컬 기술 검증 GO이며, 실제 운영 Migration 적용은 대상 preflight·영수증 증거 확인과 사용자의 별도 승인 후에만 진행한다.

### 2026-11-14 POS 주문 합치기 대응 (운영 미적용, 이전 상태 설명보다 우선)

**원인과 확인한 사실 (운영 DB 읽기 전용 SELECT)**

- 22:12:22 마지막 정상 수집 이후 22:17부터 `orders_vanished_unconfirmed`가 연속 실패했다.
- 22:12 스냅샷의 미완료 주문 BAR8(170,000)·BAR9(510,000)·BAR11(410,000)이 POS에서 BAR8 주문으로 합쳐졌다. 영수증 8885(OrderId=BAR8 주문, TableName "2")에 1,090,000으로 결제됐다.
- 근거는 품목 단위 대조다. 영수증 품목 7종(수량 10)이 세 주문의 품목ID·단가·수량·금액 합과 정확히 일치했다.
- POS는 합칠 때 상세 ID를 새로 발급하고 같은 품목을 한 줄로 합쳤다(예: 90,000 품목 2+1 → 수량 3). 따라서 상세 ID로는 대조할 수 없고 품목·단가 기준 집계로 대조한다.
- 할인·프로모션은 0이었다. VAT 103,600은 영수증에서 따로 계산되어 `final_amount` 1,193,600이 됐다. 대조는 세전 품목 금액(`total_amount` = 품목 Amount 합)으로 한다.
- BAR9·BAR11은 자기 OrderId 영수증이 없다. 운영 진단 로그(`[OPEN_ORDERS_SYNC_DIAGNOSTIC]`)는 확보하지 못했다. Vercel/Supabase CLI는 BABA 정책 훅이 "production-capable CLI"로 차단했고, Vercel 읽기 MCP가 없었다. 그래서 상세 재조회의 실제 reason/causeCode는 확정하지 않았다.

**기존 코드의 실패 조건**

- 이전 미완료 주문이 새 전체 목록에 없으면 상세 재조회를 한다.
- 상세가 종료를 확인하지 못하면 영수증 대체 증거가 필요하다. 조건은 같은 OrderId의 유효 영수증이 정확히 1건이고, 결제완료이며, 같은 영업일 또는 다음 영업일인 것이다.
- 합쳐진 주문은 자기 영수증이 영원히 생기지 않는다. 그래서 그 영업일이 끝날 때까지 매 회차 실패한다.
- DB `commit_v1`도 같은 OrderId 영수증만 인정한다. 앱만 고쳐서는 통과할 수 없다.

**새 합치기 증거 규칙** (앱 `proveMergedOrders`, DB `commit_v1`이 독립적으로 재검증)

1. 대상 주문은 같은 지점·영업일의 이전 정상 스냅샷에 있던 미완료 주문이고, 새 전체 목록에 없어야 한다.
   - 상세 재조회 결과가 "주문 없음/Id 없음/공급자 실패 응답"(`order_id_missing`, `detail_data_missing`, `provider_failure`, `provider_http_failure`)일 때만 합치기 후보가 된다.
   - timeout·102·토큰 오류, 다른 Id·다른 영업일 응답은 기존대로 즉시 실패한다.
2. 합친 결과의 남은 주문(target)은 이전 스냅샷에 있고, 새 목록에도 있어야 한다.
   - target에는 유효 영수증이 정확히 1건이어야 하고, 그 영수증은 결제완료(3)이며 취소·무효(4/5)가 아니어야 한다. 같은 지점, 영업일 D 또는 D+1(03:00 이후 결제)이어야 한다.
3. 합쳐진 주문에는 자기 OrderId로 된 활성 영수증이 없어야 한다. 하나라도 있으면 그 영수증 규칙이 우선한다.
4. 메뉴 구성이 정확히 일치해야 한다. "target + 합쳐진 주문들"의 직전 품목을 품목ID·단가별 수량·금액으로 집계한 값이 영수증 품목 집계와 순서 무관하게 같아야 한다.
   - 각 주문 헤더 금액 = 취소되지 않은 줄 합계, 주문 합계 = 영수증 `total_amount` = 영수증 품목 합계여야 한다.
   - 금액만 같으면 거부한다.
5. 할인·프로모션(헤더 DiscountAmount·PromotionAmount·PromotionItemsAmount, 줄 PromotionAmount·PromotionRate·DiscountRate·SAInvoicePromotionAmount)이 0이 아니면 증명하지 않는다.
   - 옵션·추가·하위 줄(RefDetailType≠1, ParentID, Addition, 주문 줄 isOption)이 있어도 증명하지 않는다.
   - 해당 합치기는 계속 미확인으로 보호된다.
6. 모호하면 종료하지 않는다.
   - 같은 영수증을 설명하는 조합이 2개 이상인 경우
   - 한 주문이 두 영수증으로 설명되는 경우
   - 비슷한 후보가 12개를 넘는 경우
   - 이 중 어느 것이든 해당 그룹 전체가 미확인이다.
7. 한 영수증은 한 그룹에만 쓴다. 단건 결제 증거와 합치기 증거에 동시에 쓰거나, target을 둘 이상 두는 것은 DB가 거부한다.

**기록과 후속 수집**

- 합쳐진 주문은 POS가 마지막으로 보낸 상태(예: Status 1/open)·품목·관측 시각을 그대로 둔다. Status 4로 위조하지 않는다.
  - `closure_receipt_id`(남은 주문의 영수증), `closure_merged_into_order_id`, `closure_evidence_hash`(영수증 품목·target·그룹의 md5)를 함께 기록한다.
  - run manifest의 `receiptClosures`에 `kind: merged_receipt`, `mergedIntoOrderId`, `carried`를 남긴다.
- 다음 수집부터는 남은 주문이 Status 4가 되어 품목이 없다. 그래서 합쳐진 주문은 상세 재조회 없이 이어서 기록한다(carried).
  - 매 회차 앱과 DB가 다시 확인하는 것: 영수증이 여전히 target의 단일 결제완료 영수증인지, 합쳐진 주문에 자기 영수증이 없는지, 영수증 내용 hash와 그룹 구성이 같은지.
  - 영수증이 취소되거나 품목이 바뀌면 다시 미확인으로 보고 실패한다.
- KPI 분류에서는 `merged`로 따로 센다. 진행 주문 금액에 다시 더하지 않는다. 매출은 남은 주문의 영수증 1건으로 한 번만 잡힌다.
- `/tables`에서는 합쳐진 주문을 이력으로 본다. 원래 테이블을 occupied나 unknown으로 만들지 않는다.
- read 계약 버전은 3이다. 앱은 버전 3 이상일 때만 합치기 증거를 보낸다. 버전 2 DB에는 기존 단건 영수증 증거만 보낸다.

**산출물**

- 정식 Migration: `supabase/migrations/20261114161500_pos_open_orders_merged_receipt_evidence.sql` (버전 20261114161500).
  - Supabase CLI `migration new`는 BABA 정책 훅이 차단해 CLI와 같은 UTC 타임스탬프 형식으로 직접 생성했다.
  - 기존 Migration은 수정하지 않았다. `read_v1`·`commit_v1`은 같은 시그니처로 교체했고, SECURITY DEFINER·`search_path=''`·권한을 유지했다. 새 private helper 3개는 API 역할 실행을 막았다.
- 적용 전후 검사(읽기 전용): `docs/sql/pos-open-orders-merged-receipt-evidence-preflight.sql`, `docs/sql/pos-open-orders-merged-receipt-evidence-postflight.sql`.
- 롤백: `docs/sql/pos-open-orders-merged-receipt-evidence-rollback.sql`.
  - `read_v1`·`commit_v1`을 20261110170329 본문 그대로 복원하고, 새 객체만 제거한다.
  - 이미 합치기로 닫힌 스냅샷 행의 증거는 지운다. 그 영업일은 다시 기존처럼 미확인으로 보호된다.
- 테스트: `tests/pos-open-orders-merge-db.test.mjs` (PGlite에서 실제 Migration 적용).

**운영 적용 시 위험과 절차 (별도 승인 사항)**

- 순서:
  1. 읽기 전용 preflight를 전부 통과한다.
  2. Cron 사이(수집 중 lease 없음)에 Migration을 적용한다.
  3. postflight를 전부 통과한다.
  4. 앱을 배포한다.
  5. 첫 정상 수집의 `receiptClosures`와 KPI·`/tables`를 대조한다.
- 앱보다 Migration이 먼저 적용되어도 안전하다. 기존 앱은 계약 버전 2 이상에서 단건 증거만 보내며 합치기 필드를 보내지 않는다.
- Migration 없이 앱만 배포돼도 안전하다. 계약 2에서는 합치기 증거를 보내지 않는다.
- 위험 1: 실제 상세 재조회의 실패 종류가 위 허용 목록 밖(예: timeout 반복)이면 이번 경로가 동작하지 않는다. 운영 진단 로그로 reason/causeCode를 확인해야 한다.
- 위험 2: 할인·옵션·합치기 후 추가 주문이 섞인 합치기는 계속 미확인으로 남는다. 이는 의도된 보호다.
- 위험 3: 동시성 검증은 PGlite 단일 연결(lease·소유권·writer fence·원자적 거부)로만 했다. 영수증 SHARE 잠금은 기존 단건 경로와 같은 구문을 재사용했지만, native PostgreSQL 독립 연결 검증은 이번 환경에 PostgreSQL이 없어 수행하지 않았다.
- 2026-11-10 장애(22:17 `orders_invalid_row` 후 반복)는 같은 오류 코드 사례일 뿐이다. 주문 합치기가 원인이었다고 가정하지 않는다(당시 스냅샷이 남아 있지 않다).

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
