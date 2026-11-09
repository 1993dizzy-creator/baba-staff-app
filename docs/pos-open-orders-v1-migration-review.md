# pos_open_orders_v1 — 운영 DB Migration 최종 승인 검토 패키지

작성 2026-11-09 · 상태: **미적용(승인 대기)** · 운영 DB 실행, Cron, 기능 스위치, Push·배포는 하지 않았다.

## 1. 대상 파일과 동일성

| 항목 | 값 |
|---|---|
| Migration | `supabase/migrations/20261109210000_pos_open_orders_v1.sql` |
| 검토 원본 | `docs/sql/pos-open-orders-v1-draft.sql` (`c7e355a2` 이후 변경 없음) |
| SHA-256 (두 파일 동일) | `570331478253b760be480e7236e854cba43a1acf03c25cb4ce5259e8176f3988` |
| 크기 | 18,434 bytes · 286줄 · LF |
| 버전 순서 | 운영 최신 적용 `20261108170000` 다음 |

동일성은 바이트 비교로 확인했다(`tests/pos-open-orders-migration-package.test.mjs`). 파일 첫 줄의 `DRAFT — NOT APPLIED` 주석도 동일성 유지를 위해 그대로 둔다.

## 2. 생성 객체 (기존 객체 변경·삭제 없음)

| 종류 | 이름 | 보안 |
|---|---|---|
| 스키마 | `pos_open_orders_private` | Data API 노출 스키마에 추가하지 않음 |
| 테이블 | `runs`, `sync_state`, `orders`, `order_lines`(→ `orders` FK, on delete cascade) | RLS 켬, 모든 API 역할 권한 없음 |
| 인덱스 | `pos_open_orders_active_scope` (`runs(scope) where status='collecting'` unique), `pos_open_orders_runs_recent` | — |
| 내부 함수 | `claim_v1(uuid,uuid,text,text,date,integer default 60)`, `commit_v1(uuid,uuid,jsonb,jsonb)`, `fail_v1(uuid,uuid,text)`, `read_v1(text,date)` | SECURITY DEFINER · `search_path=''` · 소유자 postgres · read만 STABLE |
| public 래퍼 | `pos_open_orders_claim`, `pos_open_orders_commit`, `pos_open_orders_fail`, `pos_open_orders_read` (내부 함수와 인자 동일, jsonb 반환) | SECURITY INVOKER · `search_path=''` · read만 STABLE |

Migration 본문 범위:
- `drop`과 `truncate`가 없다.
- `insert`, `update`, `delete`, `alter`의 대상은 모두 `pos_open_orders_private.*`다(테스트로 확인).
- `pos_sales_receipts`, 원장, 재고 테이블은 참조하지 않는다.

## 3. 권한

| 대상 | service_role | anon / authenticated | PUBLIC |
|---|---|---|---|
| 스키마 USAGE | O | X | X |
| 스키마 CREATE | X | X | X |
| 내부 함수 4개 EXECUTE | O | X | X |
| public 래퍼 4개 EXECUTE | O | X | X |
| 테이블 4개 (7개 권한 전부) | X | X | X |

- service_role에는 BYPASSRLS가 있지만 테이블 권한이 없어서 직접 접근할 수 없다. 테이블은 소유자(postgres) 권한으로 실행되는 내부 함수만 다룬다.

## 4. 적용 순서 (각 단계 별도 승인)

1. **설치 전 점검(읽기 전용):** `supabase/pos_open_orders_v1_preflight.sql`. 8개 행이 모두 `pass=true`여야 한다.
   - 신규 스키마 없음
   - public RPC 이름 충돌 없음
   - 역할 4개 있음
   - 실행 계정이 postgres 멤버
   - 버전 미기록
   - 직전 버전 `20261108170000`
   - 노출 스키마 설정
2. **Migration 적용:** `20261109210000_pos_open_orders_v1.sql`. 단일 Migration으로 기존 Migration 도구 경로를 사용한다. 운영 DDL 승인이 필요하다.
3. **설치 후 점검(읽기 전용):** `supabase/pos_open_orders_v1_postflight.sql`. 16개 행이 모두 `pass=true`여야 한다.
   - 객체 존재
   - DEFINER/INVOKER
   - `search_path=""`
   - 소유자
   - 볼래틸리티(STABLE 여부)
   - 역할별 EXECUTE
   - PUBLIC 권한 0
   - 스키마 USAGE/CREATE
   - 테이블 권한 0
   - RLS
   - 행 0건
   - 객체 수
   - 노출 스키마
4. **RPC 동작 점검:** `supabase/pos_open_orders_v1_rpc_smoke.sql`. NOTICE `smoke A: PASS`, `smoke B: PASS (rolled back)`가 나와야 한다.
   - A: service_role read 결과 형식, service_role의 테이블 직접 조회 거부, anon/authenticated의 래퍼·내부 함수·테이블 거부 6건
   - B(선택): claim → busy → fail → 늦은 commit 차단 → read. 트랜잭션 rollback으로 데이터가 남지 않는다.
5. **Dashboard 확인:** API > Exposed schemas에 `pos_open_orders_private`가 없어야 한다.
6. **이후 단계(각각 별도 승인):**
   - Cron route 추가(`maxDuration >= 180`)와 `vercel.json` 등록, 배포
   - `POS_OPEN_ORDERS_SYNC_ENABLED`를 켜고 관찰
   - `POS_OPEN_ORDERS_READ_ENABLED`를 켬

## 5. 취소·중지·복구 절차 (구분)

### 5-1. 데이터 적재 전 설치 취소
- **적용 시점:** Migration을 적용했지만 수집기가 한 번도 쓰지 않은 상태
- **SQL:** `supabase/pos_open_orders_v1_rollback_before_data.sql`
  - 테이블 4개 중 하나라도 행이 있으면 예외를 내고 아무것도 지우지 않는다.
  - 신규 객체만 이름을 지정해 삭제한다(CASCADE 없음). 래퍼 4개 → 내부 함수 4개 → 테이블 4개 → 스키마 순서다.
- **Migration 이력 행은 지우지 않는다.** 다시 설치할 때는 새 버전 번호를 쓴다.
- 실행 후 설치 전 점검 SQL이 다시 전부 통과해야 한다.

### 5-2. 데이터 적재 후 운영 중지
1. **앱 중지(DB 변경 없음):**
   - `POS_OPEN_ORDERS_READ_ENABLED`를 끈다. 화면은 2차 KPI로 돌아간다.
   - `POS_OPEN_ORDERS_SYNC_ENABLED`를 끈다.
   - Cron 항목을 제거하고 배포한다.
2. **DB 차단(필요할 때만):**
   - `supabase/pos_open_orders_v1_suspend.sql`: service_role의 래퍼 실행 권한을 회수한다. 행은 그대로 둔다.
   - 앱의 읽기는 `unavailable`이 된다. 결제완료 KPI에는 영향이 없다.
3. **재개:**
   - `supabase/pos_open_orders_v1_resume.sql`로 권한을 원래대로 돌린다.
   - 설치 후 점검을 실행한다. 이때는 '행 0건' 항목만 실패하는 것이 정상이다.
4. **데이터 삭제:**
   - 이 패키지에 포함하지 않는다.
   - 꼭 필요하면 `runs`, `sync_state`, `orders`, `order_lines`를 먼저 내보내 보관한 뒤 별도 승인을 받아 진행한다.

### 5-3. 데이터 적재 후 복구 (스키마 변경 없이 자동 복구)
| 상황 | 동작 |
|---|---|
| 수집기 중단(잠금 남음) | 3분 후 다음 claim이 `expired` 처리하고 새 실행을 시작한다 |
| 수집 실패, 시간 초과(150초) | `fail`이 기록되고 이전 스냅샷을 유지한다. 10분이 지나면 `stale`로 보인다 |
| 진행 주문 소실 확인 불가 | 커밋이 거부(`open_orders_vanished` / `orders_vanished_unconfirmed`)되고 `incomplete`로 보인다. 영업일이 바뀌면 새로 시작한다 |
| 늦은 이전 실행 | 커밋이 `open_orders_lease_lost`로 거부되고 새 스냅샷을 보존한다 |
| 오래된 데이터 | 커밋할 때 7영업일 지난 스냅샷과 30일 지난 실행 이력을 정리한다 |

## 6. 위험과 대응

| 위험 | 대응 |
|---|---|
| Supabase GitHub 연동이 main push 때 Migration을 자동 적용할 가능성 | 저장소에는 CI 워크플로가 없고 build는 `next build`뿐이다. Dashboard의 GitHub 연동과 Branching 자동 배포 설정은 저장소에서 확인할 수 없으므로 **Push 전에 꺼져 있는지 확인**한다 |
| 실행 계정이 postgres가 아니어서 `owner to postgres` 실패 | 설치 전 점검 5번 항목. Migration은 한 트랜잭션이라 실패하면 전체가 적용되지 않는다 |
| Data API 노출 스키마에 private 스키마가 추가됨 | 설치 전·후 점검 항목과 Dashboard 확인 |
| Supabase 기본 권한 부여로 anon이 public 함수를 실행할 수 있게 됨 | Migration에서 회수하고 설치 후 점검 9번 항목으로 확인한다. 권한을 잘못 다시 주면 점검이 실패하는 것을 테스트로 확인했다 |
| `query_to_xml` 미지원 환경 | PostgreSQL 기본 함수다. 설치 전 점검의 Migration 이력 확인에만 쓴다 |
| 주문 Status 1·3·7·8, 옵션, 취소 주문 실표본 미확보 | Migration과는 무관하다. 기능 ON 전에 확인할 항목이다(`docs/pos-open-orders-sync.md`) |

## 7. 검증 결과

| 범위 | 결과 |
|---|---|
| SQL 동작·권한·잠금·시간 제한 (`c7e355a2`/`44ad1973`) | 54/54 PASS 재사용. SQL이 변경되지 않아 다시 실행하지 않음 |
| 패키지 테스트 `tests/pos-open-orders-migration-package.test.mjs` (PGlite) | 아래 참고 |

패키지 테스트 항목:
- 바이트·SHA 동일성
- 객체 정의 목록
- 설치 전 점검 → 적용 → 설치 전 점검 재실행 시 설치 감지 → 설치 후 점검 16/16 → RPC 점검 A·B
- 권한을 잘못 부여하면 설치 후 점검이 감지
- 데이터 적재 전 설치 취소와 데이터 존재 시 거부
- 중지·재개 및 행 보존
