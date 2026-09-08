# Inventory Ledger deadlock 수정 및 재검증

2026-09-07. **Deadlock blocker: 해소. Production Preflight: BLOCKED.** 운영 실시간 SELECT/미적용 history 확인, 최신 원격 Git 조회 및 인증된 비운영 브라우저 E2E는 여전히 검증하지 못했다. 운영 DDL/DML, 배포, commit/push는 수행하지 않았다.

## 1–2. 정확한 원인과 재현 graph

수정 전 PostgreSQL 17.6에서 이전 preflight와 동일한 순서로 다시 재현했다. 합성 log100은 confirmed, log101은 아직 미반영 상태였다.

1. B: BEGIN 후 `ledger_inventory_candidate:inventory-log:101` advisory xact lock 확보. 단건 RPC 첫 잠금 직후의 스케줄링을 재현한다.
2. A: 실제 `ledger_reconcile_inventory_month_v1('2026-09-01',2)` 호출. log100 처리를 마치고 log101에서 대기.
3. B: 실제 `ledger_project_inventory_purchase_log_v1(101,1)` 호출. month-close lock에서 대기.

```text
Session A: monthly sync (PID 24848)
holds X: Exclusive advisory transaction lock ledger_month_close:2026-09
holds:   Exclusive Source advisory lock ledger_inventory_candidate:inventory-log:100
         log100/candidate1/현재 transaction3의 FOR UPDATE 및 상태 기록의 행 잠금
waits Y: Exclusive Source advisory lock ledger_inventory_candidate:inventory-log:101

Session B: single-log projection (PID 21068)
holds Y: Exclusive Source advisory transaction lock inventory-log:101
holds:   inventory_logs log101 FOR UPDATE
waits X: Exclusive advisory transaction lock ledger_month_close:2026-09

cycle: A holds X → waits Y → B holds Y → waits X → A
```

PostgreSQL이 반환한 실제 detail:

```text
Process 24848 waits for ExclusiveLock on advisory lock [17313,0,374804879,1]; blocked by process 21068.
Process 21068 waits for ExclusiveLock on advisory lock [17313,0,265449934,1]; blocked by process 24848.
SQLSTATE: 40P01 — deadlock detected
```

`374804879`은 log101 Source key, `265449934`는 2026-09 month-close key다. A의 stack은 단건 함수의 Source advisory PERFORM → 월 함수 assignment였다. 이 graph의 직접 대기 자원은 **두 advisory transaction lock**이다. candidate advisory 별도 namespace는 없으며 `ledger_inventory_candidate:`가 SourceKey 잠금이다. candidate/transaction row lock과 log row lock은 보유됐지만 이 cycle의 직접 대기 edge가 아니다. log101에는 candidate/transaction/payable이 없어 B가 그 행들을 잠근 것은 아니다. payable row·movement row·rebook advisory·relation lock은 이 재현 cycle의 직접 edge가 아니다.

## 3–5. canonical lock order와 변경

새 private helper:

```sql
inventory_ledger_private.lock_sources(
  p_keys text[], p_extra_months date[] DEFAULT '{}'
) RETURNS void
```

실제 최초 취득 순서:

1. 해당 transaction의 **전체 Source 집합**을 확정하고 중복 제거, C collation SourceKey 순 advisory transaction lock.
2. 해당 inventory_logs만 ID 순 FOR UPDATE. 구매일을 안정화한다.
3. 로그·candidate·연결 transaction의 business/recognition month 및 legacy 입력 월의 합집합을 날짜순 month-close advisory transaction lock.
4. 연결 transaction ID 순 rebook advisory transaction lock.
5. 연결 transaction ID 순 FOR UPDATE.
6. Inventory candidate ID 순 FOR UPDATE.
7. 기존 회계 처리 안에서 해당 payable FOR UPDATE, movement/payable 생성 및 audit.

단건은 Source 1개를 예약한다. 월 RPC는 조회 결과 ID 배열을 한 번 확정하고 **같은 배열**의 잠금을 먼저 확보한 후 처리한다. v2와 legacy core bulk 경로도 전체 Source 집합을 먼저 확보한다. 처리 중 새 Source를 발견해 뒤늦게 추가하지 않는다. 같은 Source에 대한 직렬화는 유지되며, 전역/테이블 잠금 또는 월 배치 전용 대형 mutex는 추가하지 않았다. 기존 월 mutex도 제거하거나 약화하지 않았다. 월 작업은 결국 처리할 Source의 잠금을 기존보다 일찍 획득하므로 그 Source의 단건은 대기할 수 있다. 이것은 중복방지에 필요한 충돌이며 모든 Inventory 작업을 막는 전역 직렬화가 아니다.

기존 함수 안의 advisory/row lock 문장은 유지한다. preamble이 먼저 확보한 잠금의 재진입이므로 실제 최초 취득 순서는 공통 helper가 결정한다. 40P01 재시도나 성공 위장 로직은 추가하지 않았다. SourceKey, fingerprint, snapshot, metadata overlay, pending/auto-confirm, movement/payable, actor/audit, 회계 계산은 변경하지 않았다.

변경 파일:

- 미적용 `supabase/migrations/20260906114438_project_inventory_purchase_logs.sql`: helper, 단건/월/v2 예약, 기존 관리 RPC의 잠금 전처리.
- `tests/inventory-ledger-concurrency.mjs`: loopback PostgreSQL 17.6 실제 세션 반복 테스트.
- `tests/helpers/inventory-ledger-fixture.mjs`, `tests/inventory-ledger-projection-db.test.mjs`: 기존 fixture를 내용 변경 없이 공유 모듈로 추출.
- `package.json`, `package-lock.json`: native 테스트용 `pg@8.16.3` devDependency와 실행 스크립트.
- 검증 문서. 앱 UI/API/업무 기능에는 이번 blocker 수정으로 추가 변경하지 않았다.

## 6–8. 반복 동시성 결과

최종 native 테스트: **360회 경합 PASS**, deadlock **0**, 중복 candidate/transaction/movement/payable **각각 0**. 행 수·confirmed 중복·movement/payable 연결 중복·원본 snapshot·경제효과를 assertion으로 확인한다. 단순히 에러가 없다는 것만 검사하지 않는다.

| 시나리오 | 반복 |
|---|---:|
| 기존 월↔단건 재현 순서 그대로 | 40 |
| 단건↔동일 단건 | 40 |
| 월↔동일 월 | 40 |
| metadata↔단건 | 40 |
| 자동 confirmed correction↔월 | 40 |
| 자동 confirmed correction↔단건 | 40 |
| 기존 관리자 manual rebook↔월 | 40 |
| 기존 관리자 manual rebook↔단건 | 40 |
| 구매일 정정 후 서로 겹치는 두 recovery month | 20 |
| month-close mutex 보유 중 단건·월 동시 대기 | 20 |

앞 8종은 즉시결제와 외상 각각 20회다. 원본 40P01 재현에서는 수정 후 A가 log101에서 기다릴 때 **month lock을 보유하지 않음**도 pg_locks로 확인했다. B가 월 lock을 얻어 완료하고 A가 계속 진행한다. 월마감 케이스는 실제 namespace mutex를 보유하는 세션으로 경합을 검증하며, 전체 월마감 UI 실행이라고 주장하지 않는다.

실행 방법(별도 격리 PostgreSQL 17.6 필요):

```powershell
$env:INVENTORY_TEST_PG_PORT='55439'
$env:INVENTORY_TEST_ROUNDS='20'
npm run test:inventory-ledger:concurrency
```

테스트는 `.env`나 운영 URL을 읽지 않는다. 127.0.0.1만 연결하고 서버 버전 170006을 검증한 뒤 고유한 `inventory_lock_test_*` DB를 생성한다. pg 모듈은 고정 devDependency이며 `.tmp` 패키지를 import하지 않는다. 실행 로그와 JSON은 ignored `.tmp/deadlock-native-final.log`, `.tmp/production-preflight/concurrency-final.json`에 보존한다.

## 9. 기존 RPC와 동일 lock graph 검토

- **public manual rebook**: 기존 rebook advisory → transaction → candidate → month → payable 순서가 projection과 반대였으므로 첫 기존 잠금 전에 Source helper를 호출한다. 기존 인자·역할 검사·수동 금액·party/date/snapshot/fingerprint 유지 정책·회계 본문은 보존한다.
- **public candidate resolve**: candidate row를 먼저 잠그던 경로에 동일 Source preamble을 추가한다. private 자동 resolver는 상위 projection이 전체 잠금을 확보한 후 호출한다.
- **legacy core_v1**: 외부 service_role이 호출할 수 있어 bulk 입력 전체의 Source/월을 기존 loop 전에 확보한다. 기존 validation/회계 loop는 유지한다.
- **private source rebook**: 상위 helper가 rebook/transaction/candidate/month를 이미 확보한 상태로 실행한다. 기존 payable FOR UPDATE 및 지급/allocation 보호 유지.
- **month-close**: month mutex 이후 읽기 preflight와 closure/audit INSERT. Inventory Source나 기존 Inventory 회계 행을 역으로 기다리지 않아 graph의 반대 edge가 없다.
- **meal adjust**: 같은 month namespace를 사용하지만 employee_meal transaction/candidate만 잠근다. Inventory helper가 meal 행을 잠그지 않아 교차 row edge가 없고 기존 함수를 수정하지 않았다.
- **payable payment**: payable을 잠그고 별도 payment transaction/movement/allocation을 생성한다. Inventory Source/month/rebook mutex를 역으로 요청하지 않는다. 기존 payable row lock은 그대로 유지한다.
- **source drift/일반 correction**: 별도 source_drift candidate 및 원본 transaction 경로를 조사했다. Inventory Source/month mutex를 역으로 취득하지 않는 경로는 이번 수정에 포함하지 않았다.

미적용 migration의 DO 블록은 `pg_get_functiondef`의 **정확한 기존 잠금 위치에 preamble만 삽입**한다. 예상 anchor가 없으면 `INVENTORY_LOCK_CONTRACT_*_MISMATCH`로 전체 migration을 실패시킨다. 기존 적용 migration 파일은 수정하지 않았다. CREATE OR REPLACE는 기존 function OID/인자/owner/ACL/SECURITY/search_path를 보존한다.

native 검증에서는 기존 manual rebook/resolve/core의 삽입된 preamble만 제거하면 적용 전 본문과 **문자열 전체가 동일**함을 확인했다. 기존 함수 signature/반환/owner/SECURITY/search_path/ACL도 비교 통과했다. 새 helper는 owner postgres, SECURITY DEFINER, search_path `pg_catalog, public`; PUBLIC/anon/authenticated/service_role에 schema USAGE/함수 EXECUTE를 제공하지 않는다. 일반 Ledger owner/master 검사는 유지된다.

## 10–12. 회귀 및 검증

- 집중 테스트: **152/152 PASS**.
- 확장 관련 테스트: native Node **655개 중 654 PASS, 기존 실패 1**. extensionless import가 있는 5개 파일은 tsx@4.20.6으로 **28/28 PASS**. 중복 없이 합계 **683개 중 682 PASS, 기존 실패 1**(집중 테스트 포함).
- 기존 실패: inventory-category-groups의 `partner and candidate groups use active inventory from existing non-N+1 reads`. HEAD와 현재 `lib/partners/server.ts`가 동일하며 HEAD 코드에도 실패 정규식이 매칭된다. 이번 diff와 무관하고 수정하지 않았다.
- typecheck PASS, 변경 TS/TSX/MJS lint 오류·경고 0, build PASS, git diff --check PASS.
- 신규 migration 전체 BEGIN/apply/ROLLBACK 시 함수 metadata·신규 schema·Source 컬럼 원복 확인, 이어 BEGIN/apply/COMMIT PASS. 최소 Inventory/partner fixture와 실제 Ledger migration 기반이며 운영 전체 복제 검증은 아니다.

## 13–14. Production Preflight 및 적용 후보

**Production Preflight: BLOCKED.** 이번 deadlock과 로컬 기술 검증은 통과했지만, 전체 preflight를 PASS로 바꿀 수는 없다.

- 운영 history 조회 `SELECT version,name ... WHERE version='20260906114438'`가 승인 정책상 거절되어 **운영 미적용 여부를 이번 세션에서 실시간 확인하지 못했다**. 이전 미적용 작업 기록에 근거해 사용자 승인 범위 안에서 로컬 신규 파일만 수정했다.
- 운영 schema/function/grant 최신 비교도 같은 접근 제한으로 미검증.
- HEAD와 로컬 origin/main은 모두 `3c0b896e684cae82c207eb6a68d2a54ec5c33688`. 최신 원격 조회는 schannel SEC_E_NO_CREDENTIALS로 실패.
- 인증된 비운영 브라우저 세션/DB가 없어 신규 입고·수정 E2E는 미실행. 운영 DML 금지 준수.
- 기존 무관한 회귀 실패 1건도 따로 남긴다.

운영 적용 후보는 정확히 **`supabase/migrations/20260906114438_project_inventory_purchase_logs.sql` 1개**다. SHA-256: `50B7CE013244BE0888FC24518B14669547B400590361C76EC9C1719BF9C76099`. 차단 해소와 별도 운영 승인 후 전체 파일을 단일 transaction으로 적용하고, `docs/inventory-ledger-production-preflight.sql`로 history·권한·schema·무결성을 확인해야 한다. 기존 migration을 재적용하지 않는다. 함수 body의 의도된 변경 목록에는 이제 v2/drift 외에 **core_v1, resolve_v1, manual rebook_v1의 lock preamble**이 포함된다.

권한 SELECT 거절 사유: `MCP tool call requires approval, but approval policy is never`. 우회 접근은 하지 않았다.
