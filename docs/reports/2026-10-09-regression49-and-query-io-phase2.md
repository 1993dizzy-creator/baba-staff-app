# 전체 회귀 정상화 및 DB I/O 2차 검토

로컬 소스·테스트만 작업했다. Production DB 조회·변경, Migration 적용, 통계 초기화, Git 명령, 배포는 수행하지 않았다. 운영 실행계획은 사용자가 제공한 결과를 기준으로 삼는다.

## Phase 1 — 기존 실패 49건

수정한 테스트 파일:

- `tests/ledger-deployed-qa.test.mjs`
- `tests/ledger-card-auto-fee-db.test.mjs`
- `tests/ledger-card-auto-fee.test.mjs`
- `tests/inventory-category-groups.test.ts`
- `tests/ledger-owner-settlements.test.ts`
- `tests/ledger-payroll-advance.test.ts`
- `tests/partner-subtype-emoji.test.ts`
- `tests/payroll-overview-waterfall-performance.test.ts`

| 기존 실패 | 원인 | 수정한 검증 |
|---|---|---|
| deployed QA 42건 | 실제 페이지의 `InventoryProjectionResolution` import를 mock loader가 지원하지 않음 | 실제 TSX를 transpile하여 연결하고 관련 계약·CSS·저장 조회 helper 의존성도 연결. 기존 UI·요청·금액 assertion 유지 |
| 카드 수수료 2건 | 존재하지 않는 `20261002120000_…` 파일 경로 | 실제 로컬 Migration `20261001193526_auto_finalize_closed_month_card_fees.sql` 참조. SQL 정책률 비교 및 격리 DB 실행 유지 |
| 재고 카테고리 1건 | 파일 전체 loop 정규식이 별도 가격 이력의 정상 페이지 조회까지 N+1로 오인 | AST로 두 bulk category loader의 loop를 찾아 DB 호출·await 없음 및 grouping loop 존재 확인 |
| 사장 정산 1건 | `confirmedUnpaid`를 최상위 소스 문자열에서 기대 | 현재 `owners.capacity`에 포함되는 RPC 연결과 SQL의 `confirmedUnpaidOwnerSettlements` 반환값을 확인. 기존 투자·회수 snapshot 필드 검사 유지 |
| 가불 1건 | 목록·상세가 동일 `EntryFlags` 컴포넌트라는 오래된 가정 | 현재 목록 `EntryListFlags`, 상세 `EntryFlags` 두 사용처 및 취소 badge 표시 조건 확인. 가불 취소 API·마감·원장 검증 유지 |
| 거래처 이모지 1건 | 옵션 렌더가 page 내부라는 오래된 가정 | `PartnerSelect` 연결과 그 실제 option의 거래처 emoji·name 확인. 기존 서버·상세 emoji 검사 유지 |
| 급여 개요 1건 | `staffCurrent` 옵션과 현재일·asOfDate 분기가 추가되기 전 정규식 | 현재 옵션과 관리자 fallback/직원 현재일 분기를 명시적으로 확인. 병렬 조회·공유 period 검사 유지 |

deployed QA 의존성 오류를 해소한 뒤에는 effect 순번 가정도 드러났다. 전체 lifecycle effect를 그대로 보존하고 테스트 대상 load/card effect를 내용으로 유일하게 식별하여 실행하도록 수정했다. 오래된 응답·실패 응답·loading 종료 assertion은 유지한다.

기존 Migration 파일은 수정·복원하지 않았다. 로컬 실제 파일과 SQL 함수·격리 실행 체인을 대조했다. 원격 `supabase_migrations.schema_migrations`는 로컬 작업 제한에 따라 조회하지 않았으므로 원격 적용 이력까지 확인했다는 의미는 아니다. 운영 적용 전에 원격 이력 대조가 필요하다.

실제 회계·급여 소스 결함을 테스트 기대값으로 숨긴 변경은 없다. skip 추가나 assertion 삭제로 우회하지 않았다.

검증: 집중 **155 통과 / 0 실패**, 전체 회귀 **3,716 통과 / 0 실패**. 변경 테스트 ESLint 오류 0 / 경고 0. 전체 소스 ESLint는 기존 오류 4 / 경고 4. Production build 성공(컴파일·TypeScript·72개 정적 페이지). 파일 로딩 실패로 실행되지 않았던 카드 수수료 DB 검증을 복구해 전체 테스트가 종전 3,700→3,716건으로 증가했다.

근거: `.tmp/regression49-focused-final.log`, `.tmp/regression49-full.log`, `.tmp/regression49-eslint-changed.log`, `.tmp/regression49-eslint-full.log`, `.tmp/regression49-build.log`.

## Phase 2 — 재고 로그 인덱스 검증

Phase 1 전체 회귀 0 실패를 확인한 뒤 시작했다. 앱 조회·저장 소스는 추가 변경하지 않았다.

추가 파일:

- `supabase/migrations/20261009161017_add_inventory_logs_created_at_id_read_index.sql`
- `tests/inventory-log-read-index.test.mjs` (10개 검증)
- `tests/helpers/inventory-log-read-index-fixture.mjs`
- 이 보고서 및 `.tmp/io-phase2-*` 로컬 검증 산출물

신규 SQL은 다음 인덱스 하나뿐이다. 데이터·함수·트리거·RLS·권한·기존 인덱스를 변경하지 않는다.

```sql
create index inventory_logs_created_at_id_read_idx
  on public.inventory_logs using btree (created_at desc nulls last, id desc);
```

사용자 제공 운영 계획: 최신 500행 조회에서 `Seq Scan → Sort(created_at DESC NULLS LAST,id DESC) → Limit`, 추정 11,890행. 운영 EXPLAIN을 다시 실행하거나 통계를 초기화하지 않았다.

로컬 기존 인덱스 이력은 다음과 같다.

| 대상 | 기존 인덱스 | 신규 인덱스와의 관계 |
|---|---|---|
| 재고 실사 | `(item_id,business_date DESC,created_at DESC) WHERE reason='stock_check'` | 일부 품목·사유 조회만 대상, NULL 정렬 및 id tie-break 다름 |
| 판매 차감 | 같은 키, `WHERE reason='sale_deduction'` | 공통 최신 이력 정렬을 대체하지 못함 |
| 입고 거래처·작성자·수정 연결·batch | 거래처/작성자 FK, `(correction_of_inventory_log_id,id)`, batch FK | 공통 시각 정렬 인덱스와 목적 다름 |
| POS 월별 상세 | `idx_pos_sales_receipt_lines_business_date_id (business_date ASC,id ASC)` | 실제 월별 범위·정렬과 일치, 추가 없음 |

전체 원격 pg_indexes 목록은 확인하지 않았다. 로컬 Migration에 없는 수동 인덱스가 존재할 수 있으므로 운영 적용 전 동등 인덱스 비교가 필수다. 단순 `created_at DESC` 인덱스는 기본 NULLS FIRST이고 id tie-break가 없어 이 요구와 동일하지 않다. `(created_at ASC NULLS FIRST,id ASC)`의 역방향 스캔은 동등하므로 그것도 중복 후보로 확인해야 한다.

### 조건·NULL 커서·누락 검증

실제 `LOG_CARD_COLUMNS` initializer를 읽어 카드 필드 전부를 합성 테이블에 구성했다. 11,890행, 같은 시각·마이크로초 차이·NULL 시각을 포함했다. 영업일·품목·사유·복합 조건·stock_check·sale_deduction을 매 페이지 유지하고, 인덱스 전후 모든 필드·전체 행 순서를 대조했다. 전체 이력은 동일 24회 조회, 중복·누락 0이다. 실제 API의 기존 500행 paging 및 다음 커서를 그대로 검증했다.

```sql
-- non-NULL cursor
created_at < :created_at
or (created_at = :created_at and id < :id)
or created_at is null
-- NULL cursor
created_at is null and id < :id
```

최신 페이지에서는 별도 Sort가 사라지고 새 Index Scan이 사용되었다. NULL 시각 커서도 새 인덱스 조건과 정렬을 사용했다. 깊은 non-NULL OR 커서는 `BitmapOr`와 Sort를 사용할 수 있으며, 모든 페이지가 단순 index seek가 되는 것은 아니다. 날짜·복합 조건은 격리 계획에서 Seq Scan/Sort가 유지되었다. stock_check·sale_deduction은 기존 partial index를 사용했다. 이런 필터를 위해 인덱스를 더 추가하지 않았다.

### 측정 결과

**운영 속도·물리 디스크 I/O 실측이 아니다.** 격리 PGlite에서 7회 워밍업 측정 중앙값이다. `enable_seqscan/indexscan/bitmapscan`을 모두 on으로 설정하여 index 선택을 강제하지 않았다. heap 약 11.62MiB의 합성 데이터이고 실제 운영 행 폭·통계·캐시·동시 요청은 다를 수 있다.

| 조회 | 기존 중앙값 | 인덱스 후 중앙값 | 계획/한계 |
|---|---:|---:|---|
| 최신 500행 | 28.112ms | 0.762ms | Seq Scan/Sort → Index Scan |
| 영업일 | 8.804ms | 9.070ms | 같은 Seq Scan/Sort, 개선 없음 |
| 품목 | 4.145ms | 1.590ms | Index Scan + filter |
| purchase 사유 | 10.863ms | 0.815ms | Index Scan + filter |
| 영업일·품목·사유 복합 | 5.608ms | 9.648ms | 같은 Seq Scan/Sort; 이 수치는 개선 근거가 아님 |
| stock_check / sale_deduction | 1.263 / 1.093ms | 1.559 / 1.148ms | 기존 partial index, 추가 개선 없음 |
| 두 번째 페이지 커서 | 36.992ms | 0.726ms | 새 ordered index |
| 깊은 커서 | 4.939ms | 2.829ms | BitmapOr 및 Sort 가능 |
| NULL 시각 커서 | 3.412ms | 0.313ms | 새 index 조건 |
| 전체 11,890행 paging·디코딩 | 1,090.667ms | 755.692ms | 동일 24회·17,339,373 bytes |

최신 페이지 heap/index shared buffer hit는 1,487→68, 처리 대상은 11,890→500행이었다. 워밍업에서 shared read blocks는 0이므로 실제 디스크 read 감소량으로 해석하지 않는다. 단일 페이지 EXPLAIN 시간과 전체 paging의 JS 디코딩 포함 시간도 서로 다른 지표다. 인덱스 생성은 격리 환경 10.5ms, 인덱스 크기는 393,216 bytes(384KiB)였다. 운영 생성 시간·WAL 크기는 별도다.

근거: `.tmp/io-phase2-benchmark.mjs`, `.tmp/io-phase2-benchmark.json`. 동일 필드·행·정렬 유지 검증 결과: `.tmp/io-phase2-index-tests.log`, `.tmp/io-phase2-focused-final.log`.

### POS 검토

월별 `fetchMonthlyLines`는 business_date 범위와 `(business_date ASC,id ASC)` 및 1,000행 단위 OFFSET을 사용한다. 실제 VAT 계산에 필요한 raw_json은 유지한다. 기존 날짜 복합 인덱스만 사용한 합성 월별 실행계획에서 Index Scan을 확인했다. OFFSET이 깊으면 건너뛸 행이 증가하지만 같은 인덱스를 추가해 해결되지 않는다.

`saveLines` 호출 경로는 POS sync-to-sales와 관리자 단일 영수증 refresh-pos다. 입력 영수증 reference로 저장 전 `getExistingLines` 및 저장 후 `excludeStaleLines`를 조회한다. reference 100개씩 분할하고 ID 순서로 500행 paging한다. 한 reference가 1,505행인 로컬 runtime 검증에서는 각 상세 조회가 4회이고, 저장 후 재조회는 raw_json을 제외한다. 반복 saveLines에서 insert/update/exclude 0을 확인했다. 날짜 변경 영수증의 과거 상세를 찾아야 하므로 이 조회에 날짜 범위를 강제로 추가하면 안 된다.

로컬 `vercel.json` 설정상 정상 sync cron은 UTC 10~18시의 5분 간격(108 슬롯/일), final sync는 UTC 20시 1회로 총 109 예약 슬롯/일이다. 이는 운영에서 실제 DB 조회가 발생한 횟수가 아니다. `force=false` 상태의 sync-to-sales에는 cooldown skip 분기가 있어 상세 조회 전에 반환할 수 있으며, 수동 refresh·재시도는 별도로 발생한다. 설정된 빈도와 실제 호출 빈도를 구분했고 스케줄·03:00 영업일 경계는 변경하지 않았다.

이번 단계의 POS 요청 횟수·payload·UPDATE 순서는 변경되지 않았다. 운영 호출 빈도 및 실제 POS 인덱스 전체 목록은 읽지 않았으므로 source/receipt/id 인덱스의 필요성은 확정하지 않는다. 실제 빈도 증거 없이 POS 인덱스를 추가하지 않았다. 기존 월별 1,000행 경계·이전 단계 누락/멱등성 테스트도 재실행했다.

### 쓰기 부하와 운영 적용 전 확인

인덱스는 좁은 시각+ID 두 키만 포함하고 raw_json·메모 같은 INCLUDE payload는 없다. INSERT마다 B-tree 한 개의 유지 비용과 WAL·저장 공간이 추가된다. 키 UPDATE 또는 HOT이 불가능한 heap UPDATE에도 index 유지가 발생할 수 있다. 기존 인덱스를 삭제하지 않으므로 그 비용은 그대로 남는다. 운영 쓰기 지연은 측정하지 않았고 합성 환경의 384KiB를 운영 크기라고 단정하지 않는다.

Migration은 기본 transactional runner에 맞춰 일반 CREATE INDEX로 작성했다. 생성 중 쓰기 잠금이 필요하므로 승인된 저부하 시간·짧은 lock timeout·statement timeout을 적용한 실행 절차와 모니터링이 필요하다. 무중단 쓰기가 필수라면 CONCURRENTLY 및 비트랜잭션 실행·실패 후 invalid index 처리 절차를 별도로 검토한다. 이 파일을 그대로 transaction 안에서 CONCURRENTLY로 바꿔 실행하지 않는다. [PostgreSQL CREATE INDEX 문서](https://www.postgresql.org/docs/current/sql-createindex.html).

운영 적용 전 읽기 전용으로 원격 Migration 이력과 pg_indexes의 키 방향·NULL ordering·predicate·validity를 확인하고, 동등 인덱스가 이미 있으면 중복 생성하지 않는다. 운영 통계를 reset하지 않고 bounded pg_stat_statements의 calls/rows/평균시간 및 관련 EXPLAIN으로 날짜·품목·사유·NULL/깊은 커서별 계획을 확인해야 한다. POS 실제 호출 빈도도 그때 확인한다. 별도 승인 전에는 Migration 적용·운영 데이터 변경·배포를 진행하지 않는다. rollback은 승인된 절차로 신규 인덱스만 제거하며 원본 데이터 복구는 필요하지 않다. [인덱스 정렬과 LIMIT](https://www.postgresql.org/docs/current/indexes-ordering.html).

다음은 승인된 읽기 전용 조사에서 사용할 수 있는 사전 확인 예시이며 **실행하지 않았다**. `pg_stat_statements`가 설치된 경우에만 마지막 조회를 사용한다. 통계 reset은 하지 않는다.

```sql
select version, name from supabase_migrations.schema_migrations
where version in ('20261001193526', '20261002120000', '20261009161017')
order by version;

select indexname, indexdef from pg_indexes
where schemaname='public'
  and tablename in ('inventory_logs','pos_sales_receipt_lines')
order by tablename,indexname;

select c.relname, i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid)
from pg_index i join pg_class c on c.oid=i.indexrelid
where i.indrelid in ('public.inventory_logs'::regclass,
                    'public.pos_sales_receipt_lines'::regclass);

select calls, rows, mean_exec_time, shared_blks_hit, shared_blks_read, query
from extensions.pg_stat_statements
where query ilike '%inventory_logs%'
   or query ilike '%pos_sales_receipt_lines%'
order by calls desc limit 20;
```

`pg_stat_statements`의 실제 schema는 먼저 확인해야 한다. 제시한 통계는 마지막 reset 이후 누적값이며 매일 호출 횟수와 같지 않다. 두 시점의 제한된 조회 결과를 비교해야 관측 구간의 빈도를 계산할 수 있다.

Phase 2 집중 **34 통과 / 0 실패**(신규 index 검증 10건 포함). Phase 2를 포함한 최종 전체 회귀는 **3,726 통과 / 0 실패 / skip 0**이다. 변경 테스트·helper ESLint는 오류·경고 0, 전체 소스 ESLint는 기존 오류 4 / 경고 4로 동일하다. 앱 소스를 바꾸지 않았으므로 Phase 1의 성공한 Production build가 최종 앱 소스에 그대로 해당한다.

기존 ESLint 오류 위치는 `app/(protected)/mypage/page.tsx`의 effect setState, `lib/language-context.tsx`의 any와 effect setState, `tests/ledger-manual-amount-edit-db.test.mjs`의 module 변수이다. 경고는 기존 payroll attendance hook, layout/root 이미지, mypage hook이다. 무관한 파일은 변경하지 않았다.

검증 명령:

```powershell
node --loader ./.tmp/query-io-test-loader.mjs --test --test-concurrency=1 tests/*.test.ts tests/*.test.mjs
node --loader ./.tmp/query-io-test-loader.mjs --test --test-concurrency=1 tests/inventory-log-read-index.test.mjs tests/query-io-regression.test.mjs tests/inventory-logs-performance.test.ts tests/pos-sales-monthly-pagination.test.mjs
npx.cmd eslint app components lib tests scripts
npm.cmd run build
```

최종 로그: `.tmp/io-phase2-full-final.log`, `.tmp/io-phase2-focused-final.log`, `.tmp/io-phase2-eslint-final.log`. Production build 로그는 `.tmp/regression49-build.log`다.
