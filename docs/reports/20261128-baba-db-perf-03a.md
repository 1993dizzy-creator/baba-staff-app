# BABA-DB-PERF-03A — 테이블현황 반복 조회 성능 최적화

## 1. 작업 위치·Git 기준·승인 경계

- 시작·종료 위치: `C:\workspace\baba-wt-codex`
- 유지한 독립 브랜치: `codex/pos-sync-1700-tables-stability-20261117`
- 시작 HEAD: `258f3249fd5e5f1b013a3ca96454db4c4288670f`, CLEAN. main에 미통합된 고유 커밋 없음.
- 작업 기준: 기존 브랜치만 `git merge --ff-only main`으로 `abb159f091171e0f55f29f3d3df7745c788b3212`까지 전진. DB-PERF-02 병합 결과와 보고서 삭제 결과를 모두 포함한다. 신규 Worktree·이력 재작성 없음.
- 시작 main: `C:\workspace\baba-staff-app`, `main`, `abb159f0`. 다른 세션의 알림 Migration 미커밋 변경이 있었다. 해당 파일 내용에 접근하거나 수정하지 않았다.
- 시작 Claude: `C:\workspace\baba-wt-claude`, `claude/legacy-cleanup-p1-20261117`, `b1ef6e2016784d2fe6b4e259bc7d200e4af8067c`, CLEAN. main에 미통합된 고유 커밋 없음.
- 조사 중 main은 `0578c3f95368557389c120fb959cfa64454e2048`로 전진했다. 알림 후속 변경이며 이번 검증 기준에 임의로 합치지 않는다. 다른 세션 작업은 보존한다.
- 이번 승인 범위: 조사·개발·격리 검증·보고서·Codex Worktree 로컬 Commit. 최종 SHA/CLEAN 및 커밋 기준 실제 충돌 검사 결과는 Commit 후 최종 응답에 기록한다.

## 2. 실제 중복 경로와 적용한 개선

### 목록의 동일 기준시각 설정 재사용

기존 `readTableOverview(now)`는 청소 컨텍스트에서 `loadBusinessTimeAdapter(now)`를 호출하고, DB 기능 OFF 또는 컨텍스트 오류 후 목록 Fallback에서 같은 `now`로 다시 호출했다. 설정 한 번에 영업일 RPC와 설정 RPC가 각각 1회 실행되어 Fallback에서는 합계 4회였다. context timeout으로 snapshot Fallback을 생략할 때도 설정 두 RPC는 다시 실행했다.

목록 요청의 설정 로더를 `readCleaningState`의 선택적 네 번째 인자로 전달한다. 성공한 전체 영업일·설정 쌍만 요청 지역 변수에 보관하고 Fallback도 재사용한다. 설정 조회 자체가 일반 오류로 실패하면 기존 Fallback 재시도를 허용하며 실패한 Promise를 캐시하지 않는다. 요청 간 캐시·TTL·인증 캐시는 없다. 다음 HTTP 요청은 다시 DB에서 설정을 조회한다.

원자적 컨텍스트가 영업일 불일치 `40001`을 반환하면 설정 revision/cutoff가 달라졌을 수 있으므로 재조회한다. 이 조회는 의도적인 재검증이며 제거하지 않는다. 영업일이 달라지는 격리 사례에서 기존 응답과 동일함을 확인했다. 같은 영업일에서 설정이 바뀌어도 한 목록 요청은 최초에 읽은 설정 스냅샷을 일관되게 사용하고 다음 요청에서 갱신한다. 이는 정상 컨텍스트 경로의 기존 방식과 같으며 요청 간 오래된 정보 재사용이 아니다.

### 기존 12초 요청 예산을 설정 단계에도 전달

기존 설정 두 RPC는 목록 요청 예산의 abort signal을 받지 않았다. `loadBusinessTimeAdapter`에 선택적 signal만 추가하여 목록 호출의 두 RPC가 같은 deadline을 공유하게 했다. 기존 signal 없는 호출, 날짜 전용 조회, 날짜별 설정 조회는 동작을 유지한다. 첫 설정 RPC 후 signal이 중단되면 다음 설정 RPC를 시작하지 않는다. 설정 조회 후 남은 예산이 1초 미만이면 컨텍스트·snapshot·영수증 조회를 시작하지 않고 기존 `read_failed` 경로를 사용한다. 설정 자체가 실패하면 기존 API 오류 경로로 실패하며 성공으로 위장하지 않는다.

### Promise reject timeout도 기존 guard 사용

격리 전후 실행에서 context RPC가 `{error}`를 반환하지 않고 Promise를 timeout으로 reject하면 기존 `cleaningReadError` 판별을 우회하여 snapshot Fallback이 시작되는 것을 확인했다. 두 context RPC의 reject도 기존 로그·오류 판별 함수를 통과하도록 보완했다. 자동 context timeout 뒤 수동 context 또는 snapshot을 반복하지 않는다. 수동 context timeout도 snapshot을 반복하지 않는다. 일반 오류의 기존 Fallback과 자동 실패 시 수동 청소 유지 분기는 보존한다.

이 timeout 경로에서는 기존의 불필요한 Fallback이 성공 응답을 만들 수 있었으나 이제 명시적 `read_failed`로 처리한다. 이 사례는 응답 동등성을 주장하지 않는다. 직전 정상 화면 유지 정책을 사용하는 보수적 실패이며 새 상태 판정이나 재시도 정책을 도입하지 않는다.

### 상세 판매행 분류

기존에는 현재 영수증마다 전체 판매행을 filter했다. 판매행을 `receipt_id` Map으로 한 번 분류하고 각 영수증의 행만 사용한다. 표시 필드, 판매행 순서, 취소 표시와 숫자 변환은 유지한다. 1,201개 증빙·1,201개 판매행 fixture에서 실제 상세에 해당하는 19개 영수증/1,141개 판매행의 분류 키 접근이 21,679회에서 1,141회로 감소했다. 전체 상세 응답과 페이징 결과는 일치했다.

## 3. 안전을 위해 유지·보류한 조회

- 상세 후반 `decorateCleaningDetail()`의 최신 설정·컨텍스트 재조회는 유지한다. 최초 상세의 `now`와 후반의 현재 시각은 다르며, 그 사이 영업일·설정 revision·신규 주문·증빙 버전이 바뀔 수 있다. 이를 같은 시점의 단순 중복으로 취급하지 않았다.
- 최초 상세 snapshot·증빙과 후반 atomic context의 snapshot·증빙을 합치지 않는다. SQL의 `context_v1`/`auto_context_v1`는 statement 시각의 실제 영업일을 확인하고 하나의 MVCC statement에서 주문·증빙·키·관측을 반환한다. 상세의 `status_changed_at`와 context 증빙의 `version`도 서로 다른 계약이다.
- 실제 Migration SQL을 확인했다. 현재 context GET은 STABLE 읽기이며 관측 저장은 별도 `tables_observe_payments_v1`이 담당한다. 이를 일반 조회로 대체하거나 observer와 결합하지 않았다.
- `confirmTableCleaning`의 저장 전 fresh context, DB의 snapshot/receipts/evidenceKey 재검증, 저장 후 재조회, 저장 성공 후 조회 실패 시 saved 결과 보존을 유지한다.
- 영수증의 현재 영업일+다음날 범위, raw JSON의 필요한 두 필드 추출, exact count, ID 정렬, 전체 페이지 수집·완전성 확인, 증빙 버전 구성은 유지한다. 테이블명만으로 선별하지 않는다.
- 상세 정상 경로의 DB 요청 수 감소는 적용하지 못했다. 상세는 서버 계산의 반복만 줄였으며 작은 fixture의 지연 감소를 주장하지 않는다.

## 4. 정식 변경 파일 — 전체 Windows 경로

1. `C:\workspace\baba-wt-codex\lib\sales\table-overview-server.ts` — 요청 내 설정 재사용, Fallback·stale-day·예산 처리.
2. `C:\workspace\baba-wt-codex\lib\sales\table-cleaning-server.ts` — 선택적 동일 요청 설정 로더 전달, rejected timeout 정규화. 저장 로직 변경 없음.
3. `C:\workspace\baba-wt-codex\lib\sales\table-detail-server.ts` — 판매행 Map 분류.
4. `C:\workspace\baba-wt-codex\lib\store-settings\business-time-adapter.ts` — 선택적 abort signal. 기존 date-only 및 batch API 유지.
5. `C:\workspace\baba-wt-codex\tests\admin-sales-business-date-rpc-scope.test.ts` — 선택적 취소 인자를 반영하되 두 RPC/날짜 전용 계약 검사 유지.
6. `C:\workspace\baba-wt-codex\tests\tables-read-performance.test.mjs` — 실제 모듈의 전후 실행, 요청·반환량·시간·전체 응답·페이지·deadline 검사와 PGlite 비교.
7. `C:\workspace\baba-wt-codex\docs\reports\20261128-baba-db-perf-03a.md` — 이 보고서.

## 5. 동일 격리 조건 전후 비교

기준 소스는 `abb159f0`의 실제 파일을 Git에서 읽는다. 변경 버전과 같은 fixture·시각·기능 플래그로 실제 adapter/service/페이징/상태 판정 모듈을 실행한다. 인증은 서비스 밖이므로 아래 요청 수에 포함하지 않는다. 인증 결과는 캐시하지 않으며 기존 API 인증 검사를 별도로 실행했다.

### 메모리 Data API 대역

시간은 두 버전 예열 후 순서를 번갈아 9회 실행한 중앙값이다. 실제 PostgreSQL/PostgREST/운영 지연이 아니다. 반환 행은 transport가 반환한 최상위 records(스칼라/객체 RPC=1, 배열=길이)이며 context 내부 DB 스캔 행 수는 아니다. byte는 data JSON만 계측하며 헤더·count 메타데이터는 제외한다.

| 경로 | 요청 수 전→후 | 영업일·설정 RPC 전→후 | 반환 records 전→후 | JSON byte 전→후 | 핸들러 ms 전→후 |
|---|---:|---:|---:|---:|---:|
| 목록, 두 기능 OFF | 4→4 | 2→2 | 6→6 | 3,700→3,700 | 0.858→0.852 |
| 목록, 수동 ON 정상 | 3→3 | 2→2 | 3→3 | 4,079→4,079 | 0.980→0.941 |
| 목록, 자동 ON 정상 | 3→3 | 2→2 | 3→3 | 4,079→4,079 | 0.855→0.863 |
| 목록, 자동·수동 ON 정상 | 3→3 | 2→2 | 3→3 | 4,079→4,079 | 1.304→1.514 |
| 목록, DB 기능 OFF Fallback | 7→5 | 4→2 | 9→7 | 4,365→3,717 | 1.059→0.908 |
| 목록, 일반 오류 Fallback | 7→5 | 4→2 | 8→6 | 4,352→3,704 | 0.959→0.827 |
| 목록, 자동 실패→수동 정상 | 4→4 | 2→2 | 3→3 | 4,083→4,083 | 1.092→1.084 |
| 목록, 두 context 오류 | 8→6 | 4→2 | 8→6 | 4,356→3,708 | 1.629→1.465 |
| 목록, statement timeout 응답 | 5→3 | 4→2 | 4→2 | 1,300→652 | 0.591→0.478 |
| 목록, pool timeout 응답 | 5→3 | 4→2 | 4→2 | 1,300→652 | 0.881→0.711 |
| 상세, 기능 OFF | 5→5 | 2→2 | 14→14 | 4,526→4,526 | 1.146→1.101 |
| 상세, 수동 ON | 8→8 | 4→4 | 17→17 | 8,605→8,605 | 2.312→2.312 |
| 상세, 자동·수동 ON | 8→8 | 4→4 | 17→17 | 8,605→8,605 | 1.941→1.975 |

전체 20개 목록·상세 플래그/오류 조합의 응답은 전후 deep equality PASS다. 나머지 상세 실패 조합의 전체 수치는 보존한 measurements.json에 있다. 정상 경로와 상세 지연은 작은 fixture에서 일부 증가도 관측되므로 일반적인 응답시간 개선율을 제시하지 않는다. 확실한 개선은 목록 예외 경로의 두 설정 RPC 제거와 판매행 분류 횟수 감소다.

별도 rejected timeout 사례는 자동 context 7→3회, 수동 context 8→4회다. 새 결과는 read_failed이며 snapshot/영수증 Fallback을 실행하지 않는다. 이 사례는 정상 응답 동등성 표에서 제외한다.

1,000행 초과 검사는 1,201개 증빙과 1,201개 판매행, 서버 cap 137로 수행했다. 현재 상세에 해당하는 판매행 1,141개를 누락 없이 받았고 두 버전 모두 요청 21회, 반환 records 2,345개, JSON 428,525byte였다. 분류 키 접근만 21,679→1,141회로 줄었다. 다음날 영수증은 증빙으로 계속 조회하되 현재 상세 판매행 대상에서는 기존 계약대로 제외한다.

### 격리 PostgreSQL 엔진 — PGlite

기존 Migration의 실제 청소 context SQL과 fixture용 날짜·설정 SQL을 실행했다. Fallback 영수증 transport는 대역이다. 동일 DB·데이터·고정 요청 시각에서 예열 후 전후 순서를 번갈아 5회 측정했다. 아래 SQL 수는 최상위 SQL 실행 횟수이며 함수 내부 statement 수나 실제 운영 요청 수가 아니다.

| 조건 | 서비스 요청 전→후 | 실제 SQL 실행 전→후 | 설정 RPC 전→후 | 반환 records 전→후 | JSON byte 전→후 | 핸들러 ms 전→후 |
|---|---:|---:|---:|---:|---:|---:|
| 수동 context 정상 | 3→3 | 3→3 | 2→2 | 3→3 | 695→695 | 7.685→8.184 |
| DB 기능 OFF Fallback | 7→5 | 6→4 | 4→2 | 6→4 | 292→264 | 4.975→4.400 |

응답 동등성 PASS이며 이 비교가 청소 이벤트를 생성하지 않았음을 확인했다. PGlite는 실제 PostgreSQL 엔진 기반 격리 실행이나 서버 PostgreSQL/PostgREST의 네트워크·인덱스 플랜·운영 부하를 재현하지 않는다. 운영 성능 수치로 환산하지 않는다.

## 6. 검증·계약 보존 결과

- 수정 전 핵심 회귀 46건 PASS 확보.
- 테이블 상태·목록/상세·청소/자동 전환·API 인증·영업시간·설정·기존 date-only 개선 관련 확장 회귀 304건 PASS, 실패/skip 없음.
- 새 전후/성능 검사 31건 PASS. 최종 요청 지역 로더·오류 보완 후 관련 기존 46건과 새 31건을 합친 영향 검사 77건 PASS, 실패/skip 없음.
- 판매행 분류 키 접근 계측과 설정의 일반 오류 Fallback 재시도 동등성 검사도 최종 영향 검사에 포함했다. 다른 유효한 검증은 재사용했다.
- 변경 TS 파일과 실제 의존성의 TypeScript 검사 PASS, 변경 코드/테스트 ESLint PASS, git diff --check PASS. 무관한 전체 Build/전체 TypeScript는 실행하지 않았다.
- 일반/사용 중/결제완료/미확인, 합치기·자리이동, 미확인 격리 후 신규 주문, 결제 중 테이블 분리, 영수증 ID 중복 제거, 부분 실패 후 정상 테이블 유지 검사를 기존 상태 테스트로 확인했다.
- 실제 PGlite Migration/RPC 검사로 30분 경계·자동 관측·수동 청소 우선순위·저장 직전 신규 주문·수정/취소 증빙 무효화·저장 성공 후 조회 실패의 saved 보존을 확인했다.
- 새 검사에서 초기 상세 후 최신 atomic context에 신규 주문이 생겨도 current 영수증과 판매행을 잃지 않고 occupied/청소 불가로 바뀌는 것을 확인했다.
- 03:00 경계에서 후반 상세가 새 영업일을 조회하는 기존 동작, 설정 revision 변경 및 stale-day 40001의 설정 재검증, 두 설정 RPC의 공통 signal, 요청 예산 소진, statement/pool/rejected timeout, 다음 단계 미실행을 확인했다.
- 직전 정상 화면 유지·재진입 회복·상세 실패와 목록 실패 분리·5개 역할 및 인증/활성 상태 재검증은 기존 회귀 PASS. UI와 인증 코드는 수정하지 않았다.
- 기존 영업일 전용 매출·재고 조회, 급여·근태 조회 재사용, Keg 개선은 재개발하지 않았다. 공유 adapter의 signal 없는 기존 호출과 date-only 계약 검사만 재사용·확인했다.

검증 증거는 `C:\workspace\baba-wt-codex\.local\db-perf-03a\`에 보존한다: `baseline-tests.log`, `affected-tests.log`, `regression-tests.log`, `performance-tests.log`(초기 테스트 조건 수정 전 실패 포함), `performance-tests-2.log`, `final-affected-tests.log`, `final-request-scope-tests.log`, `settings-fallback-tests.log`, `rejected-timeout-tests.log`, `line-grouping-test.log`, `measurements.json`, `pglite-measurements.json`, `line-grouping.json`, `typecheck.log`, `lint.log`, `lint-final.log`. 테스트 실패를 숨기거나 이전 로그를 삭제하지 않는다.

## 7. Migration·인덱스·운영 경계

신규 Migration·RPC·인덱스는 불필요하다. 운영 영수증·판매행 쿼리의 필터/정렬/범위/count를 변경하지 않았으므로 기존 인덱스 활용 조건도 유지한다. 운영 실행계획 또는 실제 인덱스 사용률은 확인하지 않았다. PGlite fixture에서만 설정 함수를 작성했으며 운영 DB 또는 정식 Migration 변경은 없다.

Asia/Ho_Chi_Minh, 영업일 cutoff, 영업·주문 시작시간, 예약 revision, 인증/권한, KO/VI 응답/화면, 중앙 POS 수집·Cron, POS 재고차감 HOLD, Shadow BLOCKED, P0/P0-B 정책을 변경하지 않았다. 공통 알림, 장부·급여, 운영 청소 이벤트·결제 관측도 변경하지 않았다.

## 8. Commit·main 대비와 남은 한계

정식 변경 7개 파일만 기존 Codex 브랜치에 로컬 Commit한다. 시작 기준의 DB-PERF-02 관련 커밋은 main에 이미 포함되어 있으므로 다시 병합할 고유 커밋이 아니다. 최종 Commit 후 현재 main과의 실제 소스 충돌 및 전체 커밋 범위를 확인한다. 최신 main의 알림 후속 작업은 별도이며 main 담당 종료·CLEAN·Owner 승인 없이 이번 작업을 main에 통합하지 않는다.

상세의 초기 조회와 최종 청소 context 중복 제거, exact count 축소, 증빙 공유, 신규 인덱스는 안전 계약과 효과를 뒷받침할 근거가 부족해 보류했다. 실제 운영 성능·SQL 실행계획·I/O·statement timeout 빈도는 미측정이다. 네트워크가 있는 PostgreSQL/PostgREST와 native 다중 연결 lock/concurrency 검사는 이번에 실행하지 않았다. 단일 PGlite 엔진과 기존 안전 회귀 범위를 넘어선 동시성 보장은 주장하지 않는다.

공유 adapter의 새 signal 옵션은 목록에서만 사용한다. 상세/observer/청소 저장의 설정 조회 예산은 기존 동작을 유지한다. 기존 offset+count 완전성 보호와 mutable source에서 여러 HTTP 페이지 사이에 생길 수 있는 경합 한계도 유지한다.

## 9. 종료·정리 및 미실행 확인

PGlite는 메모리에서 실행하고 모두 close했다. 테스트 패키지·브라우저·Docker·빌드 캐시·임시 원본 복사·새 Worktree는 만들지 않았다. 생성한 .local 항목은 검사 설정과 보존할 로그/측정 증거뿐이다. 루트 node_modules, 기존 .next, 타 세션 파일은 유지한다.

운영 DB DDL/DML/Migration/Repair·운영 청소/결제 관측 테스트·POS 강제 호출·Cron·DB 파라미터/통계/exporter·알림·Shadow 변경 없음. 이번 작업의 main 병합·Push·Production 배포는 미실행이다.
