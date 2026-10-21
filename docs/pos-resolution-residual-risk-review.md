> **상태: 폐기(superseded), 2026-10-22.** 2026-10-21 개발한 POS 결제예정 관리자 복구 V1·V2의 개발 기록입니다. 현재 운영 기능이 아니며, 코드와 DB에서 제거하기로 결정했습니다. 제거 이유와 현재 상태는 [V1·V2 제거 보고서](reports/20261022-pos-admin-resolution-v1-v2-retirement.md)를 기준으로 합니다. 아래 본문은 과거 기록으로만 보존합니다(일부 문서는 작성 당시 인코딩 손상으로 한글이 `?`로 남아 있습니다).

# 관리자 결제확정 운영 적용 전 잔여 위험 검증

2026-10-21. 판정: **NO-GO — 운영 Migration 적용 가능 판정 보류**.

이번 작업은 검증만 수행했다. 제품 코드, 1·2차 migration, 기존 diff, 케그 코드는 변경하지 않았다. 두 migration SHA-256은 직전 P0 검토 결과와 동일하다. 운영 DDL/DML·migration 적용·Git·배포·8건 복구는 하지 않았다. 네 기능 플래그는 미설정(기본 OFF)이다. 기존 292건은 반복하지 않았다.

## 1. 운영 함수 정의 및 SHA-256

BABA 프로젝트를 조회한 뒤, 함수 원문/SHA-256/정규화 SHA-256/ACL·제약·트리거를 읽는 SELECT-only 요청을 한 번 실행하려 했으나 도구가 `MCP tool call requires approval, but approval policy is never`로 거부했다. 우회하거나 운영 접속 수단을 변경하지 않았다. 따라서 운영 RPC 3개·수정 RPC·마감 함수의 실제 원문/해시 비교 결과는 **없다**. 사용자 감사에서 확인한 CRLF 위치만으로 원문 일치를 인정하지 않는다.

준비한 조회: `.qa-review/pos-resolution/residual-review/production-contract-select.sql`. 운영 실행 여부는 미실행이다. 운영에서는 함수 원문뿐 아니라 실제 deduction FK/NULL 허용/트리거·writer 권한과 inventory/log의 연동 트리거도 대조해야 한다.

격리 DB에서만 migration 전후 원문과 SHA-256을 저장했다. 그 비교에서 차이가 있는 함수는 다음 4개다. 이 결과를 운영 함수 대조로 해석하면 안 된다.

- `apply_sales_inventory_deduction_batch`: 줄바꿈 정규화 및 관리자 판정 영수증의 재고 승인 guard.
- `reprocess_modified_sales_inventory_deduction_receipt`: 같은 보호 guard.
- `rollback_canceled_sales_inventory_deduction_receipt`: 같은 보호 guard.
- `pos_sales_close_private.build_source`: 재무 보류 paid 차단 및 retired payment 제외.

원문/해시는 `local-before-functions.json`, `local-after-functions.json`, 차이 요약은 `evidence.json`에 보존했다. 운영 객체와의 차이를 확인했다는 의미가 아니다.

## 2. PostgreSQL 공통 잠금 경합

로컬 PostgreSQL 17의 별도 연결에서 기존 케그 migration의 실제 `inventory_apply_keg_change`→`replace_inventory_keg`→판매량 계산 RPC를 실행했다. 케그 함수나 동작을 mock으로 대체하지 않았다. 테스트 테이블은 기존 POS fixture에 케그 schema 필드를 보완한 합성 데이터이며, 운영의 모든 트리거/권한을 복제한 것은 아니다.

- 5회: 재고 승인 트랜잭션을 열어 둔 동안 다른 정상 영수증의 POS receipt/line 저장 DML, 다른 재고의 실제 케그 교체, 별도 재고 UPDATE를 실행했다. 케그·재고 변경은 진행됐고 POS DML은 소스 테이블 잠금을 기다린 뒤 완료됐다. 데드락 0.
- POS DML 대기 포함 시간 약 49.9~71.3ms, 무관한 케그 교체 약 3.7~14.2ms. 승인 트랜잭션에 의도적으로 40ms 대기를 넣은 수치이며 운영 지연/SLO 측정이 아니다.
- 5회: 같은 재고의 케그 교체가 먼저 잠금을 잡으면 승인 RPC가 대기하다가 최신 context 불일치로 stale을 반환했다. 승인에 의한 재고 변경·보류 해제는 없고 데드락 0.
- 1회: 승인이 먼저 같은 재고를 잡으면 케그 교체가 대기한 후 `KEG_QUANTITY_CONFLICT`로 거부됐다. 이중 교체/차감과 데드락은 없었다.

POS는 실제 저장 DML을 사용했으나 외부 CukCuk HTTP→전체 route 전체 실행은 아니다. 운영 inventory/ledger 트리거 체인 및 운영 부하·timeout 설정은 미검증이다. SQL 파일의 `SET LOCAL lock_timeout/statement_timeout`은 migration 실행 중 설정이며 이후 모든 RPC 요청의 실행시간 상한을 보장하는 설정이 아니다. 정상 경로의 POS sync도 receipt/line/payment SHARE ROW EXCLUSIVE 잠금 때문에 대기할 수 있다는 사실은 유지된다.

## 3. 동일 영수증 이력 신규 INSERT

정상 배치 경로는 다음 FK와 행 잠금으로 보호됐다.

1. 새 `pos_inventory_deduction_receipts` INSERT는 `receipt_id` FK 확인을 위해 부모 receipt의 KEY SHARE 잠금이 필요하다. 승인 RPC의 receipt FOR UPDATE와 충돌하여 대기했다.
2. 기존 batch receipt를 참조하는 `pos_inventory_deductions` INSERT도 `batch_receipt_id` FK의 KEY SHARE가 필요하다. 승인 RPC가 해당 영수증의 기존 batch receipt 행을 FOR UPDATE로 잡으므로 대기했다. 두 경우 모두 테스트의 lock_timeout 250ms에서 55P03을 확인했다.
3. 현재 `inventory-deduction-batches.ts`와 `inventory-deduction-reprocess.ts`는 후보 생성 시 batch_id/batch_receipt_id를 채운다. 이 정상 경로를 미연결 INSERT와 혼동하면 안 된다.

그러나 격리 schema에서 deduction의 receipt_id 자체를 직접 보호하는 FK/INSERT guard는 없고 batch linkage는 NULL을 허용한다. 그 상태에서 권한 있는 DB writer가 batch_id/batch_receipt_id가 NULL인 같은 receipt_id/invoice_ref_id 이력을 INSERT하면 약 0.7ms에 성공했다.

더 강한 interleaving도 검증했다. fixture 전용 advisory gate로 **승인 context 및 activeCount 검증 뒤, 신규 후보 INSERT/legacy engine 실행 직전**을 멈추고, 다른 연결에서 미연결 preview 이력을 INSERT·COMMIT했다. gate 해제 후 승인도 성공했다. 기존 이력 행 잠금이 새로운 미연결 행의 추가까지 막는 것은 아니다.

이 실험은 fixture DB owner의 INSERT 권한으로 수행했다. 운영 service_role의 INSERT 권한·RLS·추가 trigger는 조회가 차단되어 미검증이다. 현재 정상 앱 경로에서 NULL linkage로 쓰는 경로를 발견했다거나 이중 차감을 재현했다고 보고하지 않는다. **운영의 모든 writer가 정상 배치 경로만 사용하거나 별도 INSERT guard가 있음을 확인하기 전에는, 동일 영수증의 모든 이력 INSERT가 차단된다고 보장할 수 없다.** 이번 요청은 검증 범위이므로 이를 수정하는 제품 SQL을 추가하지 않았다.

## 4. 기능 플래그 OFF의 기존 정상 경로

관리자 판정이 없는 정상 영수증으로 migration2 전/후 별도 DB에서 같은 순서를 실행했다: initial apply → 기존 public 수정 RPC → reprocess → 실제 일마감 → 취소 → canceled rollback.

최종 재고 100, 재고 로그 4개, 원차감/역분개 상태, 영수증 revision/금액/보류 상태, 매출 결제 버킷 및 장부 행이 전후 동일했다. 기존 public 수정 RPC와 public 일마감 RPC 정의도 전후 SHA-256이 동일했다. DB에는 앱 플래그를 확인하는 guard가 없으므로 이 테스트는 플래그 OFF 상태에도 설치되는 함수의 정상 경로를 직접 검증한 것이다. 실제 운영 정의와의 동일성 검증을 대체하지 않는다.

## 결과·변경 파일·운영 판정

- 신규 네이티브 검증: 하위 6개 + 부모 1개 = **7건 통과, 실패/skip 0**. 위험이 발견되지 않았다는 뜻이 아니라 위 counterexample까지 예상대로 재현했다는 뜻이다.
- 기존 292건 재실행 없음. 제품 TS/UI/SQL 변경이 없으므로 build/ESLint/전체 tsc도 반복하지 않았다.
- 신규 테스트: `tests/pos-resolution-residual-postgres.test.mjs`. 실행: `node --experimental-strip-types --test tests/pos-resolution-residual-postgres.test.mjs`.
- 보고서: 본 문서. 원문/해시·SQL·시험 결과·플래그/SQL 무변경 확인: `.qa-review/pos-resolution/residual-review/`의 `postgres.log`, `evidence.json`, `final-summary.json`.
- 임시 DB 디렉터리는 기존 것을 포함해 21개이며 postmaster.pid는 없다. 삭제를 재시도하지 않았다. 경로는 final-summary.json에 기록했다.

**NO-GO 근거:** 운영 함수 정의/SHA-256·권한/트리거 실계약 미대조, 미연결 이력 INSERT에 대한 운영 보호 범위 불명확, 운영 트리거 체인/전체 POS·케그 혼합 부하와 runtime timeout 미검증. 정상 배치 경로와 국소 경합 회귀는 통과했지만 운영 migration 적용 가능 판정에는 충분하지 않다. 플래그 OFF만으로 DB 함수 변경 위험을 제거할 수는 없다.
