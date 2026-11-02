# POS 지연 재고차감 P1-1 구현

기준: main `b7e52a7c`. 설계 정본: [지연 재고차감 설계](20261102-pos-delayed-inventory-design.md). 원본 main 직렬 작업. 이번 변경은 후속 SQL 파일·서버 호출부·로컬 테스트이며 운영 DB 조회/변경, Migration 적용/이력 변경, Push, 배포, 기존 데이터 자동 복구를 하지 않았다.

## 구현 결과

1. 재처리 RPC의 실패 UPDATE 14곳에서 같은 문장으로 `status='failed'`, `selected_for_apply=false`, 기존 `error_message`를 저장한다. 선택 CHECK를 완화하지 않는다. 기존 반환 result와 batch의 failed/canceled 구분을 유지한다.
2. 새 `reprocess_result`에 최초 결과를 보관한다. 실패 후보 직접 재호출은 최초 결과를 반환하고 행·실패 사유를 덮어쓰지 않는다. 과거 failed 행은 기록된 error_message로 호환 반환하며 기존 행을 backfill하지 않는다.
3. 서버의 batch→receipt→후보 chunk 저장→apply 여러 요청을 `prepare_and_apply_sales_inventory_reprocess` 한 RPC로 교체했다. 후보 생성과 재고 적용이 같은 트랜잭션에 있으므로 SQL 오류는 후보·재고·감사 변경을 모두 rollback한다.
4. 영수증 행 잠금으로 자동/수동 요청을 직렬화한다. 동일 요청/의존성은 고유 request key로 기존 결과를 반환한다. 동시 요청도 같은 실패 후보를 받는다. 성공 후에는 재고 상태가 바뀌어도 already_processed를 반환한다.
5. 관련 재고·입고 로그·매핑/레시피·활성 차감 또는 판매 계획이 바뀌면 새 시도를 허용한다. 이전 failed 행을 ready로 되돌리지 않으며, 실패 후보와 성공 시도를 별도로 보존한다. 재고 부족을 영구 차단하지 않는다.
6. RPC 오류 응답의 appliedDeductionCount를 후보 개수로 잘못 반환하던 부분을 0으로 고쳤다. 통신 오류로 commit 여부가 불명인 경우 이 값은 확인된 적용 건수이며, 다음 호출의 성공 조회/고유 키로 중복을 방지한다.

후속 SQL: [20261102101859_pos_reprocess_failure_persistence_and_dedup.sql](../../supabase/migrations/20261102101859_pos_reprocess_failure_persistence_and_dedup.sql). CLI 2.122.0의 `migration new`로 파일만 생성했다. 로컬 검증은 폐기 가능한 native PostgreSQL에 SQL을 직접 실행했으며 Supabase Migration 이력을 만들지 않았다.

## 요청 식별과 회복 규칙

현재 P1-1 식별은 `receipt_id + expected updated_at + content fingerprint + inventory hash + candidate plan + dependency snapshot`이다. 이를 SHA-256 request key로 저장한다. P1-2의 독립 sale_version을 선행 구현한 것은 아니다.

| 입력 | 내용 |
|---|---|
| 판매 검증 | receipt ID, 기대 updated_at, fingerprint, inventory hash. 잠금 후 timestamp·결제·취소 상태 재검증 |
| 후보 계획 | 기존 후보 수량/단위·매핑 스냅샷·품목/라인 ID. 표시용 current/after quantity는 request key에서 제외. 배열 순서는 정렬해 식별 |
| 재고 의존성 | 기존 활성 차감과 신규 후보의 대상 품목만 포함. quantity, updated_at, 최신 inventory log ID |
| 매핑 의존성 | 대상 mapping/recipe의 현재 저장 값. 누락된 객체는 snapshot 차이로 구분 |
| 활성 이력 | 미복구 성공 차감 ID, 품목, 차감 수량. 이미 복구된 차감은 제외 |
| 저장 | deduction receipt의 reprocess_request_key, reprocess_dependency_snapshot, reprocess_result |

`(receipt_id, reprocess_request_key)` partial unique index는 새 P1-1 행에만 적용한다. 기존 55개 후보 등 과거 key=NULL 행은 변경하지 않는다. 새 후보의 idempotency key는 receipt ID·request key·후보 순번을 사용한다. batch ID가 달라질 때마다 동일 요청 키가 바뀌는 기존 문제를 제거했다.

동일 부족 상태에서 cron이 55번 호출돼도 DB에는 실패 후보 1개만 남는다. 관련 입고 후 snapshot이 달라지면 새 후보 1개가 생성되고 정상 재처리된다. 관련 없는 품목 재고 변경과 표시 스냅샷 수치 변화는 새 후보를 만들지 않는다. 매핑 변경 실패도 매핑/계획 갱신 후 회복된다. 새 판매 수정 버전은 별도 요청으로 처리한다.

결정적 실패를 저장한 뒤 다음 호출에서 새 의존성을 평가하는 방식이다. 작업 스케줄러·outbox·lease를 새로 만들지 않았으며 기존 cron 재선정과 manual 실행을 재사용한다. 의존성 변화가 없으면 비싼 후보 저장/재처리는 생략하지만 미리보기 조회와 RPC 요청 자체는 계속 일어날 수 있다.

## P0·감사·권한

- 기존 적용 Migration은 수정하지 않았다. 후속 SQL에는 legacy processed_line 참조 제거 후 재처리 함수와 현재 P0 handler를 포함한 명시적 정의를 담았다. 동적 문자열 치환으로 설치하지 않는다.
- 설치 전 기존 함수 prosrc를 LF로 정규화한 MD5 `2c1c389e352d91c7b3632fcc713c81bd`와 P0 트리거 활성 상태를 확인한다. 이 값은 운영 계약 픽스처와 main P0 SQL로 재현·검증한 값이며 이번에 운영에서 채집한 해시는 아니다. 다른 정의면 `POS_REPROCESS_P1_ENGINE_DEFINITION_MISMATCH`로 전체 설치를 중단한다.
- 기존 재처리 함수의 OID·owner·ACL·security definer·search_path 불변을 설치 중 검사한다. 기존 최초 처리·취소 RPC와 P0 트리거/트리거 함수는 변경하지 않는다. 기존 엔진의 핵심 재고 계산·복구 순서도 유지한다.
- P0 예외는 기존 외곽 subtransaction에서 재고·복구·로그를 rollback하고 검토 상태를 저장한다. wrapper의 후보 저장은 그 바깥에 있어 실패 후보와 검토 사유를 정상 보존한다. P0 검토 대기 영수증은 새 후보를 만들지 않는다.
- 새 RPC는 service_role만 실행 가능하고 owner/master/manager 활성 actor를 검사한다. public/anon/authenticated 실행은 revoke한다. 새 테이블·클라이언트 키·RLS 완화는 없다. 사용자 권한 검증은 기존 서버 경로를 유지한다.
- 기존 완료 차감·복구/입고/실사 로그를 수정하거나 삭제하는 설치 DML이 없다. 회복 시 원본 성공 차감은 그대로 두고 기존 엔진의 reversal와 새 차감을 추가한다. 신규 실패 후보의 상태와 결과만 갱신한다.

SQL은 수동/자동 실행의 재처리용 원자 진입점이다. cached 결과 경로에서는 기존 batch/candidate를 잠그거나 다시 실행하지 않는다. 신규 경로는 새로 만든 batch/candidate만 엔진에 전달한다. 기존 재처리 직접 호출은 계속 지원하되 failed 후보는 재사용하지 않는다.

## 검증

테스트: [pos-reprocess-p1-postgres.test.mjs](../../tests/pos-reprocess-p1-postgres.test.mjs). 운영 자격 증명·`.env` 로딩 없이 loopback 전용 PostgreSQL 17.6 클러스터, 독립 DB/세션과 기존 native lifecycle을 사용했다.

```powershell
$env:QA_POSTGRES_BIN=(Resolve-Path '.tmp/production-preflight/node_modules/@embedded-postgres/windows-x64/native/bin').Path
node --test tests/pos-reprocess-p1-postgres.test.mjs
node --experimental-strip-types --test tests/sales-inventory-reprocess-migration-policy.test.ts
node --experimental-strip-types --test tests/inventory-deduction-partial-skip-static.test.ts tests/legacy-pos-cleanup-migration-policy.test.ts
node node_modules/eslint/bin/eslint.js lib/sales/inventory-deduction-reprocess.ts
```

| 검증 | 범위 |
|---|---|
| 55회 수정 전후 비교 | 수정 전 b7e52a7c의 합성 재현 PASS 증거 재사용. 55개 ready 잔존/23514 → 수정 후 같은 합성 수량에서 실패 후보 1개/23514 0, 입고 후 새 성공 1개 |
| 직접 실패 저장 | not_reprocess_batch_receipt, receipt_not_found, canceled_after_applied_not_supported, stale_preview, already_processed, legacy_metadata_missing, no_inventory_movement, initial_apply_required_or_not_reprocess, candidate_changed, candidate_metadata_missing, mapping_changed, recipe_changed, inventory_item_missing, insufficient_stock_after_reversal 전부 실행 |
| 실패 불변 | failed/selected=false/사유·반환 JSON 저장, batch 오류 일치, 직접 재호출 결과 보존. candidate_changed는 실제 두 세션 row lock 대기로 재현 |
| 회복/중복 | 동일 요청 55회·두 세션 동시 실패 1개, 입고 후 동시 성공/중복 응답 각 1개, 재고 1.10, 기존 실패와 원본 성공 차감 행 불변 |
| 원자성 | 잘못된 numeric 후보 저장 오류, 재고 로그 강제 SQL 오류에서 부분 후보·재고·로그 0. 원인 제거 후 정상 재시도 |
| P0 | 실사 후 재처리 전체 rollback, 검토 사유·선택 해제 보존, 반복 요청에 후보 추가 0 |
| 앱→DB | 실제 TS 호출부를 로컬 DB RPC에 연결. 55회 동일 요청/입고 회복/성공 재호출, busy·CHECK·연결 오류 응답의 적용 수와 상태 확인 |
| 설치/권한 | 엔진 OID/owner/ACL/config 유지, service-only ACL·권한 없는 actor의 생성 0, 정의 drift 시 새 column 추가 전 전체 설치 중단 |

최종 결과: native PostgreSQL **23 PASS / 0 FAIL / 0 SKIP** (상위 테스트 1 포함), RPC 정책 **5 PASS**, 관련 partial-skip/legacy 정책 **13 PASS**, 합계 **41 PASS / 0 FAIL / 0 SKIP**. 변경 TS 파일 ESLint 통과. native 최종 증거는 `.qa-review/pg-native-logs/pg-native-test-9b956194-ea9e-46eb-995b-964ab6681d6f-R5Ah0C/`의 result/diagnostics/commands/server log이며 소유 클러스터 정상 종료·임시 데이터 정리를 확인했다.

중간 실행 한 번은 모든 기능 하위 테스트가 통과했으나 Windows 종료 체크포인트가 7.565초 걸려 기존 lifecycle의 5초 종료 제한에서 실패했다. 이를 PASS에 포함하지 않았다. 해당 데이터/증거(`9f8e0deb-c847-488d-8207-f2c3aba7d46a-oz15hP`)는 보존했고, 이후 서버 정상 종료와 pid 파일 소멸을 확인했다. 테스트 끝에 자기 소유 클러스터의 CHECKPOINT를 수행해 종료 전 flush하도록 조정한 최종 실행은 정상 정리까지 통과했다. 공용 lifecycle 코드와 시스템 PostgreSQL 설정은 변경하지 않았다.

소실/무결성 분기는 폐기 가능한 DB에서 FK 제거·메타데이터 변형으로 fault injection한 것이며 실제 운영에 그러한 무결성 오류가 있다는 주장이 아니다. HTTP·POS 서비스 자체는 실행하지 않았다. 이번 변경과 무관한 전체 TypeScript·Build·전체 회귀는 실행하지 않았다. 변경 전 원인 재현과 변경하지 않은 P0 최초 처리·취소 계약의 기존 PASS는 재사용하고, 변경된 재처리 경로는 새로 검증했다. 원격 Supabase advisors는 운영 접근 범위 밖이므로 실행하지 않았고 새 RPC의 권한·설치 계약은 로컬 catalog에서 검증했다.

## P1-2에 넘기는 인터페이스와 잔여 위험

1. **원자 진입점:** `prepare_and_apply_sales_inventory_reprocess(bigint,text,timestamptz,text,text,jsonb,jsonb) → jsonb`. 서버 TS의 기존 결과 타입을 유지한다. 새 job worker는 기대 판매 정보·후보 계획을 이 RPC에 넘길 수 있다. actor 권한과 preview freshness를 생략하면 안 된다. 향후 lease token/sale_version 검증은 별도 인터페이스로 추가해야 한다.
2. **감사 연결:** 기존 batch ID/deduction receipt ID, request key, dependency snapshot, 최초 결과 JSON을 새 job/attempt와 연결한다. 기존 failed를 ready로 되돌리거나 완료된 차감을 다시 실행하지 않는다. 새 엔진 버전으로 실패 판단 기준이 바뀌면 protocol/key 버전도 전환해야 한다.
3. **판매 버전:** P1-1은 content fingerprint와 expected updated_at을 조합한다. 독립된 단조 증가 sale_version과 원본 버전 원장은 아직 없다. 기존 성공 fingerprint 유일성에 따른 A→B→A 재수정 제약도 남는다. P1-2에서 버전 계약과 성공 키를 함께 전환해야 한다.
4. **재시도 비용/감사:** 변화 없는 실패는 재적용하지 않지만 cron의 15분 재조회는 남는다. durable claim/lease/backoff/outbox·결과 불명 시도 기록은 미구현이다. 예상하지 못한 SQL/통신 오류는 원자 트랜잭션 밖 worker 감사가 필요하며, 이번 RPC 안에서 오류를 삼켜 성공으로 저장하지 않는다.
5. **부족과 실사:** 관련 재고 변화 때 새 시도를 허용하는 단기 회복이다. 부족이 계속되면 판매 재고차감은 아직 완료되지 않는다. 판매 사실과 재고 정산 분리, signed 부족 잔액, effective_at/count_epoch·고정밀 잔액·실사 이전 delta=0 정산은 P1-2 과제다. P0는 계속 유지한다.
6. **의존성 관찰:** snapshot은 관련 객체의 현재 상태·최신 로그를 담는다. 완전한 inventory_revision/epoch CAS가 아니다. snapshot 읽기와 엔진 재고 잠금 사이에 입고가 끼면 추가 재평가가 생길 수 있으며, 재고 적용은 기존 잠금과 P0로 보호한다. P1-2는 모든 수량 writer의 공통 revision/잠금 계약을 확정해야 한다.
7. **대상/예외:** 이번 중복 방지는 재처리 경로에 적용된다. 최초 처리·취소의 후보 생성과 예외 작업 대기열은 이 변경으로 통일되지 않는다. 과거 55/150개 미적용 미리보기와 기존 P0 검토 작업은 원본 그대로이며 자동 복구/정리하지 않았다.
8. **배포 순서:** 새 TS는 새 RPC를 요구한다. 향후 별도 승인 후 SQL 계약 검증/설치 → 앱 배포 순서가 필요하다. Migration 없는 앱 단독 배포를 하면 새 RPC가 없어 실패하며, 기존 비원자 저장으로 자동 fallback하지 않는다. 이번에는 둘 다 배포·적용하지 않았다.

P1-1의 완료는 실패 저장과 반복 후보 누적 문제의 수정이다. P0 제거 조건은 설계 정본의 9절을 그대로 유지하며, 이번 검증을 신형 정산 엔진 전체의 PASS로 확대하지 않는다.
