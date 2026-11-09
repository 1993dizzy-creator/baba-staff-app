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
- RPC 4개는 security definer이며, `service_role`만 실행할 수 있다.
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

## 운영 적용 전 필요한 승인·확인 (별도 승인 사항)

1. **CUKCUK 읽기 전용 확인**(사용자 승인 후 실행). orders/paging과 orders/{id}를 각 1회 호출해 다음을 확인한다.
   - `Status` 값의 의미(1·4 외의 값)
   - 오류 7의 의미
   - `Total` 포함 여부
   - 날짜 형식
   - 상세 `OrderDetails` 필드명
2. **운영 DB Migration**: `docs/sql/pos-open-orders-v1-draft.sql`을 `supabase/migrations/`로 옮겨 적용한다. 운영 DDL 승인이 따로 필요하다.
3. **Cron 활성화**: `/api/cron/pos-open-orders` route를 추가한다(`authorizeCron` 재사용, `runCentralOpenOrderSync` 호출).
   - `vercel.json`에 영업시간대 일정을 등록한다. 예: 16:00~03:00(+07) = 09:00~20:00 UTC, 2분 간격.
   - Cron·배포 승인이 필요하다.
4. **환경변수**: `POS_OPEN_ORDERS_SYNC_ENABLED=true`(수집), `POS_OPEN_ORDERS_READ_ENABLED=true`(화면 표시).
   - `CUKCUK_BRANCH_ID`는 선택이다. 기본값은 기존 지점 ID다.
   - 수집을 먼저 켜고 데이터를 확인한 뒤 표시를 켠다.
