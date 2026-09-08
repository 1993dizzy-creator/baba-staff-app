# Inventory → Ledger projection 구현 보고

> 후속 잠금 수정: [inventory-ledger-deadlock-fix.md](inventory-ledger-deadlock-fix.md). 기존 core/resolve/manual rebook에는 회계 본문을 보존하는 lock preamble이 추가됐으며, 실제 PostgreSQL 동시성 검증 결과는 후속 보고서를 기준으로 한다.

기준 HEAD: `3c0b896e684cae82c207eb6a68d2a54ec5c33688` (`main`). 운영 DB 변경·migration 적용·배포·커밋은 실행하지 않았다.

## 1. 변경 파일

- `app/api/inventory/items/route.ts`: 생성된 로그 ID/실제 Source actor/구매별 partner 저장, Source 저장 후 projection.
- `app/api/inventory/logs/route.ts`: 표시정보 동기화와 명시적 구매정보 수정 분리, supplier binding 및 최신 구매 가격 이력, 후속 projection.
- `app/(protected)/inventory/page.tsx`, `app/(protected)/inventory/snapshots/page.tsx`: Inventory 성공과 Ledger 후속 상태를 구분하여 안내.
- `lib/inventory/ledger-sync-contract.ts`: 표시 필드 allowlist와 응답/안내 계약.
- `lib/ledger/inventory-projection.ts`: 실패를 밖으로 throw하지 않는 server-only 단건 호출.
- `lib/ledger/inventory-display.ts`: candidate drift에서 표시 필드만 추출, 관리자 미반영 목록 조회.
- `lib/ledger/entries.ts`: 표시 이름·베트남어명·재고 카테고리·단위 추가. 금액과 회계분류는 기존 값 유지.
- `app/api/admin/ledger/route.ts`, `app/api/admin/ledger/payables/[partyId]/route.ts`: 원본 snapshot을 보존하면서 `display_snapshot`을 추가.
- `app/(protected)/admin/ledger/entries/page.tsx`: 구매/미지급 표시 overlay, 실패·확인 필요 로그 목록.
- `app/api/admin/ledger/inventory-candidates/sync/route.ts`, `app/(protected)/admin/ledger/InventoryCandidatePanel.tsx`: 기존 월 sync를 공통 단건 처리로 연결하고 예외 결과 표시.
- `supabase/migrations/20260906114438_project_inventory_purchase_logs.sql`: 새 DB 계약. 기존 migration 파일은 변경하지 않음.
- 신규 테스트 3개: `tests/inventory-ledger-projection.test.ts`, `tests/inventory-ledger-projection-api.test.mjs`, `tests/inventory-ledger-projection-db.test.mjs`.
- `tests/ledger-inventory-auto-post.test.ts`: 새 recovery API 계약 반영. 과거 migration의 guard 검사는 유지.
- `tests/inventory-mutation-session-auth-policy.test.ts`: 기존에 이동된 권한 helper의 실제 파일에서 동일한 역할 정책 검사.
- `package.json`, `package-lock.json`: PGlite `0.3.14` 개발 의존성 및 재실행 스크립트. 앱 런타임 의존성 변경 없음.

## 2–4. DB object, signature, 권한

신규 Source 컬럼은 nullable이며 backfill하지 않는다.

- `inventory_logs.purchase_supplier_partner_id bigint`: 해당 구매의 partner FK.
- `inventory_logs.source_actor_user_id bigint`: 실제 Source 생성자 FK.
- `ledger_inventory_projection_status`: 로그별 `status`, `code`, fingerprint, 요청 actor, 갱신 시각. RLS 활성화, `service_role`은 SELECT만 가능.
- `inventory_ledger_private`: 자동화 내부 구현 전용 스키마. PUBLIC/anon/authenticated/service_role에 스키마 접근·함수 EXECUTE를 부여하지 않음.
- Source/candidate 조회와 신규 FK를 위한 인덱스 4개.

| 함수 | Signature / 반환 | 접근 |
|---|---|---|
| 신규 단건 진입점 | `public.ledger_project_inventory_purchase_log_v1(p_inventory_log_id bigint, p_request_actor_user_id bigint) returns jsonb` | postgres/service_role EXECUTE. 활성 사용자 검사. DB에서 Source 직접 읽음 |
| 신규 월 복구 | `public.ledger_reconcile_inventory_month_v1(p_month date, p_request_actor_user_id bigint) returns jsonb` | postgres/service_role EXECUTE + owner/master 검사 |
| 기존 v2 교체 | `public.ledger_sync_inventory_candidates_v2(p_rows jsonb, p_actor_user_id bigint) returns jsonb` | 기존 postgres/service_role + owner/master 유지. 입력 전체 검증 후 Source ID로 단건 진입점 호출 |
| 비공개 resolver | `inventory_ledger_private.resolve_candidate(p_candidate_id bigint, p_resolution text, p_category_id bigint, p_party_id bigint, p_fund_account_id bigint, p_due_date date, p_memo text, p_reason text, p_actor_user_id bigint) returns jsonb` | postgres만 |
| 비공개 candidate sync | `inventory_ledger_private.sync_candidate(p_rows jsonb, p_actor_user_id bigint) returns jsonb` | postgres만 |
| 비공개 Source rebook | `inventory_ledger_private.rebook_source(p_original_transaction_id bigint, p_payment_mode text, p_category_id bigint, p_fund_account_id bigint, p_due_date date, p_amount numeric, p_memo text, p_reason text, p_actor_user_id bigint, p_source_snapshot jsonb, p_source_fingerprint text, p_party_id bigint, p_business_date date) returns jsonb` | postgres만 |
| 비공개 비교 | `inventory_ledger_private.economics(p_snapshot jsonb) returns jsonb` | postgres만 |
| 기존 trigger 함수 교체 | `public.ledger_confirmed_candidate_drift_v1() returns trigger` | 기존 trigger 권한 유지. Inventory는 새 projection 상태/audit으로 처리하고 다른 Source 동작 유지 |

기존 `v1 → v2` wrapper, `core_v1`, 관리자 `resolve_v1` 및 `rebook_v1`의 signature·owner/master 제한을 보존한다. 내부 함수는 기존 회계 처리/검증을 바탕으로 별도로 구현했다. owner ID 대입이나 역할 위장은 하지 않는다.

## 5. 기존 contract

- Inventory `ok`, `data`, `mode` 유지. `ledgerSync`만 추가.
- `synced`, `pending`, `review_required`, `failed`를 구분하고 코드와 로그 ID를 반환.
- 기존 Ledger 월 sync의 카운터를 유지하고 review/failed/rebook 결과와 issues를 추가.
- `inventory-log:{id}` 식별자, SHA-256, 기존 transaction snapshot/fingerprint 증빙 유지.
- 신규 DB projection은 JSONB 직렬화 SHA-256을 사용한다. 이전 JS 직렬화 hash와 동일하다고 가정하지 않고 **실제 경제 필드 비교**로 legacy confirmed를 처리한다. 표시 필드 확장만으로 confirmed rebook하지 않는다. legacy dismissed도 직렬화 전환만으로 재개방하지 않는다.
- 기존 v1/v2 호출의 전달 amount/snapshot/fingerprint는 Ledger 작성 Source로 신뢰하지 않는다. 유효한 입력 형식을 확인한 뒤 해당 로그를 다시 읽는다.
- confirmed 경제 변경은 기존 `SOURCE_CHANGED_AFTER_POST` 전체 요청 실패 대신 단건 rebook 또는 review 상태가 된다. 이전 `core_v1` 자체의 legacy guard는 보존한다.

## 6–8. 신규 등록 / 추가입고 / existing_stock

신규 `new_purchase`: Inventory 저장 → 구매 로그 저장 → 가격 이력 처리 → 해당 로그 projection. Ledger 오류는 성공한 Inventory 요청을 실패로 바꾸지 않는다.

quick-save 구매: 수량 차이로 새 로그 생성. 같은 품목도 각 로그 ID가 독립 Source이며 이전 구매를 합치지 않는다. 기존 expectedQuantity 검사는 유지한다.

`existing_stock`은 기존대로 `stock_check`. 자동 projection 호출도 없고 지출도 생성하지 않는다. 일반 재고확인·판매차감·Keg 저장 경로에 projection을 추가하지 않았다.

## 9–10. 일간재고와 표시정보

이전에는 동기화가 현재 master의 supplier/purchase_price까지 과거 로그에 복사했다. 이제 master에서 읽는 값은 `item_name`, `item_name_vi`, `category`, `category_vi`, `unit`뿐이다. 과거 구매 거래처·단가·수량·구매일은 보존된다.

동기화 후 해당 로그를 Ledger 단건 projection한다. confirmed의 표시 변경은 candidate의 `source_drift_snapshot`에 기록한다. transaction의 원본 snapshot과 경제효과는 변경하지 않는다.

조회 응답의 `display_snapshot`은 원본에 **표시 allowlist만** 덮어 읽은 값이다. drift에 새 금액이나 거래처가 있어도 구매금액·supplier·회계 category_id 등을 overlay로 바꾸지 않는다. 재고 카테고리는 별도 표시 속성으로 내려준다. 구매 상세와 미지급 상세 모두 적용한다.

## 11–12. 단가 / 거래처 수정

`/api/inventory/logs`의 명시적 `new_purchase_price` / `new_supplier` 수정만 해당 구매 경제정보를 변경한다. 구매 partner는 기존 supplier resolver로 연결한다.

최신 구매 로그를 수정하는 경우에만 master에 반영한다. 최신 구매 단가 정정은 가격 이력에도 기록한다. 과거 구매를 수정해도 더 최근 구매의 master 값을 바꾸지 않는다.

기존 표시정보 동기화로 현재 거래처/단가를 과거 구매에 가져오지 않는다. 수량·구매일·결제방식 편집 UI는 새로 만들지 않았다.

## 13–16. Ledger 상태별 처리

| 상태 | 처리 |
|---|---|
| Ledger 없음 | 로그 Source로 candidate 생성. 매핑/결제 기본값이 충분하면 자동 확정 |
| pending | Source 변경 시 supersede. 표시정보 변경으로 기존 회계 카테고리를 재매핑하지 않음 |
| confirmed + 표시 변경 | drift overlay만 갱신. 금액·movement·payable·계좌·회계분류 보존 |
| confirmed + 단가/거래처 정정 | 기존 거래와 movement reversal → 미사용 payable 취소 → 최신 Source로 rebook. 원본 transaction은 UPDATE하지 않음 |
| 관리자 금액 override | `MANUAL_LEDGER_OVERRIDE` review. Source 자동화가 관리자 수동 금액을 덮어쓰지 않음 |
| closed month | 경제 변경은 `MONTH_CLOSED` review. 기존 월마감 lock/trigger와 함께 보호. 표시정보만의 변경은 가능 |
| paid / partially_paid | `PAYABLE_ALREADY_PAID` review. status가 unpaid여도 allocation이 있으면 보호 |
| 미완성 supplier/payment mapping | pending 또는 `SUPPLIER_PAYMENT_MAPPING_REQUIRED` review |
| 잘못된 원본 상태 | 해당 검증 코드와 review. 강제 변경하지 않음 |

단가 정정은 기존 거래의 회계분류·계좌·지급방식을 유지한다. 명시적 거래처 정정은 새 거래처의 유효한 결제 기본값을 검증한다. 같은 거래처의 master 결제 기본값 변경만으로 기존 confirmed 구매를 다시 쓰지 않는다.

## 17–18. 직원 권한과 audit

일반 Ledger 관리 API는 여전히 owner/master만 가능하다. 새 단건 RPC는 service-role 서버에서만 실행하며 활성 사용자 ID를 검사한다. 클라이언트에게 일반 Ledger 쓰기나 비공개 helper EXECUTE를 제공하지 않는다.

새 Source에는 실제 생성자 ID를 저장한다. 기존 Source는 생성자 username을 남기고 ID를 추정/backfill하지 않는다. audit에는 Source 생성자, 요청 actor, `automatic_inventory_projection`, Source ID/fingerprint/snapshot과 상태를 구분해 기록한다. Source rebook은 별도 `inventory_source_rebooked` audit에 이전 거래·movement·payable·candidate와 새 거래를 기록한다. 기존 관리자 수동 audit은 보존한다.

## 19–20. 재시도 / manual 일치

단건은 Source advisory lock 및 로그/후보/거래 row lock을 사용한다. 월마감 lock도 획득한다. 동일 Source 재시도는 추가 경제거래를 만들지 않는다. rebook 완료 후 candidate가 최신 Source와 replacement를 가리키므로 같은 변경으로 재차 reversal하지 않는다.

기존 Inventory HTTP 요청 전체에 새 idempotency key를 도입하지는 않았다. quick-save의 기존 expectedQuantity 충돌 응답과 신규 품목 중복 검사는 유지한다. 동시에 발생하는 입고 요청 전체의 원자성은 이번 변경으로 새로 보장하지 않는다.

신규 단건·월 recovery·기존 v1/v2 호환 호출 모두 동일한 Source-only projection을 사용한다. 월 복구는 해당 월 로그와 기존 candidate Source를 함께 조회하므로 구매일 변경/Source 사유 변경도 확인 대상으로 찾을 수 있다.

## 21. 검증

- `npm run test:inventory-ledger`: **152 통과**. HTTP/API 6개, 격리 PostgreSQL 7개와 기존 Inventory/Ledger 정책·표시·월마감·지급 테스트 포함.
- 확장 Inventory/Ledger/판매차감 회귀: native Node로 **625개 중 624 통과**, 확장자 없는 TS import를 사용하는 4개 파일은 `tsx@4.20.6`으로 **26 통과**. 중복 없이 합계 **651개 중 650 통과, 기존 실패 1개**. 새 API/DB 13개를 포함하면 **664개 중 663 통과, 기존 실패 1개**.
- 기존 실패: `tests/inventory-category-groups.test.ts`의 `partner and candidate groups use active inventory from existing non-N+1 reads`. 수정하지 않은 `lib/partners/server.ts`의 pagination loop를 N+1 금지 정규식이 검출한다. `git show HEAD:lib/partners/server.ts`에서도 동일한 패턴이 존재함을 확인했다. 이번 범위를 벗어난 구현/검사는 변경하지 않았다.
- `tsc --noEmit`: 통과.
- 변경된 TS/TSX/MJS ESLint: 오류/경고 없음.
- `next build`: 통과.
- `git diff --check`: 통과.

PGlite는 개발 의존성으로 고정했으며 테스트는 메모리 DB만 사용한다. 운영 환경변수나 자격 증명을 읽지 않는다. `.tmp` 의존성 없이 `npm ci` 후 테스트 스크립트를 재실행할 수 있다.

임시 migration 생성/수정 스크립트와 UI 수정 스크립트 5개는 삭제했다. `.tmp`의 검증 로그는 실행 증거로 남겼다. 불필요해진 `.tmp/inventory-projection` 중복 설치 폴더와 `.tmp/npm-cache` 삭제는 경로 확인 후 시도했으나 자동 승인 검토에서 `blocked by policy`로 거절됐다. 이 디렉터리와 로그는 Git ignore 대상이며 최종 산출물/테스트 의존성이 아니다.

## 22. 미검증 및 적용 전 조건

- 운영 Supabase에 migration을 적용하지 않았으므로 실제 배포 환경의 실행·Advisor·운영 데이터 결과는 검증하지 않았다.
- 격리 DB는 관련 실제 Ledger migration/guard와 최소 Inventory/partner fixture를 사용한다. 운영 DB 전체 복제 검증은 아니다.
- 인증된 브라우저의 실제 사용자 조작과 UI 시각 검증은 수행하지 않았다. API 함수 실행/타입 검사/빌드는 수행했다.
- PGlite 단일 실행 환경에서 진짜 동시 세션·네트워크 경합 부하를 재현하지 않았다. lock 계약과 중복 순차 재시도는 검증했다.
- 수량·구매일의 미래 Source 변경은 격리 DB에서 검사했지만 새 편집 API/UI를 제공하지 않는다. 결제방식을 개별 로그에서 직접 편집하는 계약은 향후 확장 대상이다.
- Inventory·로그·가격 이력의 기존 분리 저장 구조는 유지했다. Ledger 장애만은 그 저장 성공을 실패로 바꾸지 않는다. Ledger 호출 자체가 불가능한 장애는 서버 진단 로그와 응답으로 남고 월 recovery로 재시도한다.
- 실제 적용 시에는 신규 nullable Source 컬럼/RPC/상태 테이블을 먼저 준비한 뒤 앱을 배포해야 한다. 이번 보고는 운영 적용 승인이 아니며 별도 승인 후 진행한다.
