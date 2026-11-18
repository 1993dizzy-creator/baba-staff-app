# 재고 로그·POS 조회 최적화 1차 (로컬 검증)

운영 DB 조회·수정, Migration 적용, 배포 및 Git 명령은 실행하지 않았다. 급여관리 소스와 Milan Food Migration·복구 로직은 수정하지 않았다. DB 테스트는 메모리 모의 Supabase와 격리 PGlite를 사용했다.

## 수정 파일

- `app/api/inventory/logs/route.ts`
- `app/(protected)/inventory/logs/page.tsx`
- `app/api/inventory/logs/recent/route.ts`
- `lib/pos/cukcuk/sales-receipt-sync.ts`
- `tests/query-io-regression.test.mjs` (신규)
- `tests/inventory-logs-performance.test.ts`
- `tests/keg-replacement-shadow.test.ts`
- 이 보고서

신규 Migration은 없다. 기존 Migration도 수정하지 않았다. `.tmp/query-io-test-loader.mjs`, `.tmp/query-io-benchmark.mjs`는 로컬 실행 보조 스크립트다.

## 재고 로그

기존 전체 조회는 `select('*')`, `created_at DESC`만 사용하고 페이지를 읽지 않아 Supabase 기본 응답 제한을 넘는 기록이 누락될 수 있었다. 화면은 목록 전체에서 검색·품목 그룹화를 수행하므로 임의의 기간 제한이나 최신 기록만 남기는 방식은 채택하지 않았다.

초기 `mode=page`와 삭제 후 `mode=logs&view=cards`는 이름·번역명·분류·코드·부서·단위·작업 종류·사유·출처·시각·작성자·수량 변화 및 화면에서 표시하는 이전/변경 필드를 명시적으로 선택한다. 현재 재고 메모는 별도 최소 필드 조회를 유지한다. 영업일별 스냅샷이 사용하는 기존 `mode=logs` 응답은 호환성을 위해 전체 필드를 유지한다.

로그는 서버에서 500행씩 커서로 읽어 하나의 완전한 응답으로 합친다. 정렬은 `created_at DESC NULLS LAST, id DESC`; 커서는 원문 타임스탬프와 ID를 사용하며 NULL 시각도 별도로 이어 읽는다. 날짜·사유·품목 조건은 모든 페이지에 적용한다. 재고 메모도 ID 커서로 전체 조회한다. 중간 페이지 실패 시 잘린 성공 응답을 반환하지 않는다.

화면 정렬은 PostgreSQL의 밀리초 미만 정밀도를 보존하고 같은 시각에서는 ID 내림차순을 사용한다. 검색·그룹화·삭제 후 로그만 갱신하는 방식과 기존 KO/VI 문자열·모바일 CSS는 유지한다. 실제 화면의 필터·그룹화 계산 블록을 실행해 KO/VI 이름 검색, 코드 검색, 부서·작업 필터, 그룹 최신 기록과 시각 정렬을 검증했다. 실제 모바일 브라우저 실측은 수행하지 않았다.

`next.config.ts`는 원래 `/api/inventory/logs/recent`를 메인 API의 `mode=recent`로 rewrite한다. 따라서 두 조회를 동시에 실행하던 구조는 아니다. 직접 route를 호출하는 경우도 같은 GET으로 위임하도록 통합했으며 인증은 공통 GET에서 한 번 수행한다. 최신 3건은 최소 화면 필드와 동일한 안정 정렬을 사용한다.

## POS

`getExistingLines`는 날짜가 아니라 입력 receipt reference로 조회한다. 영수증의 영업일이 변경되어도 이전 상세를 찾아야 하므로 새 날짜 제한을 넣지 않았다. 입력 reference는 중복 제거 후 100개씩 나누고, 상세는 ID 커서와 500행 limit으로 끝까지 읽는다. 기존 변경 판정의 `raw_json`과 금액·세금 필드는 유지한다.

`excludeStaleLines`의 저장 후 재조회는 32개 필드 대신 14개 필요한 필드만 읽는다. `raw_json`, 세금 상세, 갱신 시각 등을 이 재조회에서 제외했다. 저장 전 결과를 재사용하지 않고 실제 저장 후 다시 읽는 정책은 유지한다. 모호한 연결, 수동 수정 영수증, 취소, 재고 차감 연결, 옵션 및 합계 보호도 유지한다. 재고 차감 연결 조회 자체도 ID 페이지네이션을 적용해 1,000행 이후의 연결을 놓치지 않도록 했다.

업데이트는 기존처럼 변경 상세마다 순서대로 한 번씩 실행하고 오류가 발생하면 중단한다. 단순 병렬화나 upsert 일괄 변환은 부분 실패 시 저장 범위, 순서 및 기존 제외 상태를 바꿀 수 있어 적용하지 않았다. 요청 감소를 위한 별도 RPC 배치는 기존 원자성·오류 복구 계약을 먼저 정의해야 한다. 이번 변경에서 업데이트 요청 수는 줄지 않는다.

월별 날짜 범위와 `LIMIT/OFFSET` 경로는 `app/api/admin/sales/monthly/route.ts`의 `fetchMonthlyLines`에 있다. 이 경로는 이미 날짜 필터, `(business_date ASC, id ASC)` 정렬 및 전체 페이지 조회를 수행한다. 기존 `20260922130901_add_pos_sales_receipt_lines_business_date_id_index.sql`과 일치한다. 이 경로의 `raw_json`은 세금 집계에 필요하므로 유지했고, 해당 파일은 변경하지 않았다. 기존 월별 페이지 경계 테스트는 통과했다.

## 요청 수·조회량·속도

운영 성능이나 실제 디스크 I/O를 측정한 결과가 아니다. 운영 DB에 접근하지 않았으므로 운영 `EXPLAIN`도 실행하지 않았다. 신규 인덱스를 주장할 실행계획 근거가 없어 Migration을 추가하지 않았다. 재고 전체 이력의 커서 조회는 실제 인덱스·통계에 따라 반복 스캔 부담이 남을 수 있으므로 운영 적용 전 승인된 읽기 전용 실행계획 확인이 필요하다.

| 비교 | 변경 전 | 변경 후 |
|---|---|---|
| 재고 로그 1,505행, 메모/Keg 추가 조회 제외 | 1회, 최대 1,000행만 반환 | 4회, 1,505행 완전 반환 |
| POS 상세 1,505행 한 receipt, 한 조회 단계 | 1회, 최대 1,000행만 반환 | 4회, 1,505행 완전 반환 |
| 정상 상세 499행 이하, 100 receipt 이하 | 단계별 1회 | 단계별 1회 |
| 변경 상세 N개 UPDATE | N회 순차 실행 | N회 순차 실행 |
| 최근 재고 로그 | 최신 3행 조회 1회 | 최소 필드 최신 3행 조회 1회 |

한 receipt의 `saveLines` 읽기는 기존 6회(기존 상세, 영수증, 수동 수정 여부, 저장 후 상세, 차감 내역, 차감 영수증)다. 두 상세 조회가 각각 1,505행이면 변경 후 12회다. 기존 6회는 상세가 잘릴 수 있었으므로 완전한 조회와 동일한 성능 기준으로 비교할 수 없다. 새 코드는 요청 수 절감보다 누락 방지와 불필요한 원본 JSON 재조회 제거를 우선한다. ID/시각 커서는 OFFSET 누적 건너뛰기를 사용하지 않는다.

격리 PGlite에서 1,505행·행당 약 4KB 합성 `raw_json`을 사용해 **동일한 전체 행을 동일한 4회 페이지 조회로 읽는 조건**에서 필드 선택만 비교했다. 워밍업 후 7회 중앙값이며 행 디코딩·JSON 직렬화를 포함한다.

| POS 저장 후 재조회 | 전체 필드 | 필요한 14개 필드 |
|---|---:|---:|
| 직렬화 데이터 | 6,701,458 bytes | 422,598 bytes |
| 중앙값 | 79.96ms | 32.06ms |
| 조회 행 수 / 요청 수 | 1,505 / 4 | 1,505 / 4 |

합성 데이터에서 조회량은 93.69%, 시간은 59.91% 감소했다. 실제 원본 JSON 크기·DB 캐시·네트워크·인덱스에 따라 결과가 달라진다. 이는 POS 전체 동기화 속도 개선 비율이 아니다.

별도 모의 DB 재고 테스트에서는 임의의 1KB 미사용 필드를 제외해 1,995,786 → 380,924 bytes를 확인했다. 이 필드는 필드 제외를 검증하기 위한 합성 데이터이므로 실제 `inventory_logs` 절감률로 해석하지 않는다.

## 검증

- 집중 회귀: 131 통과 / 0 실패. 신규 런타임 테스트 16건 포함.
- 전체 회귀: 환경 중단 파일의 분리 재검을 합산하면 **3,634 통과 / 49 실패**. 전체 실행 원시 결과는 3,614 통과 / 50 실패였으며, `inventory-ledger-projection-db.test.mjs`가 3건 통과 후 V8의 `jit_page_->allocations_.erase(addr)` 오류로 중단됐다. 해당 파일을 분리 재실행해 **23 통과 / 0 실패**를 확인했다. 이미 통과한 3건을 중복 계산하지 않고 환경 중단 1건을 대체한 합산이다. `.tmp/query-io-all-final.log`, `.tmp/query-io-db-recheck.log`에 기록되어 있다. 최종 전체 단일 실행이 모두 통과한 상태는 아니다.
- 변경 7개 소스·테스트 파일 ESLint: 오류·경고 0.
- 전체 `app components lib tests` ESLint: 기존 오류 4 / 경고 4. `mypage` effect, `language-context` any/effect, 기존 `ledger-manual-amount-edit-db.test.mjs`의 module 변수 등이 원인이다.
- Production build: 성공. 컴파일·TypeScript·72개 정적 페이지 생성 통과. 배포하지 않았다.

신규 검증에는 1,000행 초과 및 정확히 1,000행, 동일 시각·NULL 시각·밀리초 미만 경계, 날짜/품목/사유 필터의 다중 페이지, 오래된 기록 접근, 인증 실패 무조회, 중간 페이지 오류, POS reference 분할·중복 제거, 이전 영업일 상세, 제외 상세, 1,000행 이후 차감 연결, 모호한 연결·수동 수정 보호, 정정 멱등성, 실제 `saveLines` 1,505행 반복 시 삽입·업데이트 0건 및 저장 후 재조회가 포함된다.

전체 회귀 실패는 이번 변경 범위 밖의 테스트/소스 정합성 문제로 별도 남긴다. 누락된 `20261002120000_auto_finalize_closed_month_card_fees.sql` 참조 2건, 장부 QA 모의 환경의 `InventoryProjectionResolution` 미지원 42건, 기존 inventory category source 정규식·owner settlement·payroll advance·partner emoji·payroll overview 테스트 각 1건이다. 급여·장부·Milan Food 소스나 Migration은 이를 해결하기 위해 수정하지 않았다.

실행 명령은 다음과 같다. 저장된 로컬 loader는 extension 없는 TS import 및 TSX를 지원하기 위한 실행 환경 보조이며 앱 소스를 바꾸지 않는다.

```text
node --loader ./.tmp/query-io-test-loader.mjs --test --test-concurrency=2 tests/*.test.ts tests/*.test.mjs
node --test tests/inventory-ledger-projection-db.test.mjs
npx.cmd eslint app components lib tests
npm.cmd run build
node .tmp/query-io-benchmark.mjs
```

## 운영 적용 전 확인

1. 전체 회귀 실패를 별도 작업에서 해결하거나 기준 상태로 분류하고 검토한다.
2. 승인된 읽기 전용 운영 조사에서 재고 커서 쿼리와 POS receipt reference 쿼리의 실행계획, 기존 인덱스, 반환 시간·조회량을 확인한다. `(business_date, id)` 인덱스는 월별 날짜 조회용이며 receipt reference 조회를 자동으로 대체하지 않는다.
3. 실제 로그 수가 많을 때 서버 메모리·응답 제한을 확인한다. 이번 단계는 전체 이력을 한 HTTP 응답으로 돌려주는 호환성을 유지하므로 이 비용이 남는다. 후속 화면 페이지네이션은 전역 검색과 그룹의 전체 이력을 함께 설계해야 한다.
4. 관리자 브라우저에서 KO/VI, 모바일, 과거 로그 검색, 삭제 후 갱신, 최근 3건 표시를 확인한다.
5. 사용자 검토 및 별도 운영 적용 승인이 있기 전에는 배포·Migration 적용을 수행하지 않는다.
