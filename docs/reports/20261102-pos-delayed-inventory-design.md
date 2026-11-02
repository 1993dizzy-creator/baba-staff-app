# POS 지연 재고차감: 원인 재현과 단계별 설계

작성일: 2026-11-02. 조사 기준: main `a403bc33`. 이번 결과는 **조사·설계와 폐기 가능한 로컬 PostgreSQL 재현**이다. 앱·운영 함수·기존 Migration은 변경하지 않았다. 운영 조회·DDL·DML·복구·Migration 실행·Push·배포는 하지 않았다.

## 1. 결론과 증거 범위

직접 원인은 재처리 RPC가 `ready / selected_for_apply=true`인 후보를 `failed`로 바꾸면서 선택을 해제하지 않는 것이다. 선택 CHECK는 `selected_for_apply=false OR status IN ('ready','applied')`이므로 SQLSTATE `23514`가 발생한다. 실패 사유 저장 자체가 취소되고, RPC보다 먼저 별도 요청으로 저장된 미리보기는 남는다. cron의 15분 재시도와 batch마다 달라지는 후보 키가 같은 버전의 미리보기 누적을 허용한다.

이 CHECK만 고쳐도 지연 처리의 구조적 문제는 남는다. 판매 사실 저장을 가용 재고에 종속시키지 않고, 실사 이전 판매는 실사 기준점에 포함된 것으로 정산해야 한다. 실사 이후 판매의 장부 부족은 명시적인 부족 잔액으로 기록하고 판매 정산은 완료해야 한다.

사용자가 제공한 운영 조사 사실: 영수증 `2601006796` / ID `8111`, 수정 10-09 20:01, 재처리 완료 10-12 19:00, 후보 56회·미적용 55회·성공 1회, 수정 영수증 5건에 동일 유형 150건 집중. 이 수치와 시각은 이번에 운영에서 재조회하지 않았다. 각각의 실제 실패가 모두 `23514`였는지, 성공 직전 어떤 입고가 있었는지는 이 결과만으로 확정하지 않는다.

로컬 증거는 실제 운영 데이터 복제가 아닌 합성 데이터로 **같은 인과 메커니즘**을 검증한다. HTTP·POS 동기화·스케줄러를 실행한 종단간 재현은 아니다. 기존 TS 호출·분류·cron 코드의 연결은 소스 분석으로 확인했다.

## 2. 로컬 재현

테스트: [pos-delayed-reprocess-investigation-postgres.test.mjs](../../tests/pos-delayed-reprocess-investigation-postgres.test.mjs). 기존 native lifecycle과 POS 픽스처를 재사용했다. 운영 URL·자격 증명·`.env`를 읽지 않으며 loopback 전용 새 PostgreSQL 17.6 클러스터를 사용한다.

```powershell
$env:QA_POSTGRES_BIN=(Resolve-Path '.tmp/production-preflight/node_modules/@embedded-postgres/windows-x64/native/bin').Path
node --test tests/pos-delayed-reprocess-investigation-postgres.test.mjs
```

1. 실제 최초 처리 RPC로 시작 재고 `0.10`에서 잔술 `0.0714`를 차감한다. 기존 `numeric(10,2)` 계약에 따라 재고는 `0.03`이다. 기존 차감 기록은 `0.0714`를 유지한다.
2. 영수증 수정·자동처리 자격을 설정하고 같은 fingerprint의 병 판매 `1` 후보를 별도 commit으로 저장한다.
3. 재처리 계산은 `0.03 + 0.0714 - 1 = -0.8986`. 실패 저장 UPDATE에서 선택 CHECK의 `23514`가 난다. 실패 사유·batch 실패 변경은 저장되지 않는다.
4. 같은 버전으로 55번 반복하면 미리보기 55개 모두 `ready / selected=true / error=NULL`, batch는 `previewed`. 재고·기존 성공 차감·로그는 원본 그대로다. 현재 cron finalizer와 같은 last_checked 갱신 후에도 eligible 플래그가 남는 것을 확인한다.
5. 합성 입고 `+2` 후 56번째 후보는 성공한다. 기존 차감 복구와 병 차감 후 재고는 `1.10`. 같은 성공 후보 재호출은 `already_processed`, 추가 변동 0이다.
6. 로컬 함수 정의의 기존 실패 UPDATE 14곳에만 선택 해제를 추가하면 재고 부족을 포함한 실패 사유가 저장된다. 검사한 6개 사유 모두 재고·기존 차감·로그는 변하지 않는다.
7. 선택 해제만 고친 상태에서 실패 후보 재호출 시 `not_reprocess_batch_receipt`가 원래 사유를 덮어쓴다. 추가 terminal guard 실험에서는 원래 사유와 후보 행이 보존된다.

최종 실행: **3 PASS / 0 FAIL / 0 SKIP** (상위 테스트 1 + 하위 시나리오 2). 6개 실패 사유 검증은 두 번째 하위 시나리오 안에서 수행한다. 모든 14개 분기를 실행했다고 해석하면 안 된다.

native 증거: `.qa-review/pg-native-logs/pg-native-test-f82038ac-8497-4514-9163-acaace317f68-7CT5nO/`의 `commands.json`, `diagnostics.json`, `result.json`, `server.log`, `owner.json`. 소유 클러스터 정상 종료·임시 DB 데이터 정리 완료, 로그는 보존했다. 증거는 로컬 파일이며 Git 배포 산출물이 아니다.

PostgreSQL의 예외 시 블록 변경 rollback 규칙은 [공식 PL/pgSQL 문서](https://www.postgresql.org/docs/current/plpgsql-control-structures.html#PLPGSQL-ERROR-TRAPPING)와도 일치한다. P0는 `P0S01`만 잡기 때문에 `23514`를 처리하지 않는다.

## 3. 최초 처리부터 반복 미리보기까지

| 단계 | 현재 코드 / 계약 | 결과 |
|---|---|---|
| 최초 처리 | `apply_sales_inventory_deduction_batch` | 원장에 성공 차감·재고 로그 존재 |
| POS 수정 수집 | receipt updated_at, reprocess_required, eligible | 이전 성공 fingerprint와 현재 내용이 달라짐 |
| 작업 분류 | `inventory-deduction-unified-preview.ts`, `inventory-deduction-workflow-policy.ts` | 성공 차감·reprocess 필요 여부로 재처리 판정. 실패 후보는 성공 이력으로 취급하지 않음 |
| 후보 저장 | `inventory-deduction-reprocess.ts:saveReprocessBatch` | batch→receipt→후보 chunk를 여러 요청으로 commit. RPC 실패로 소급 rollback되지 않음 |
| 키 생성 | 같은 파일의 `idempotencyKey(['reprocess', batchId, ...])` | batch가 다르면 같은 수정 버전도 다른 키 |
| 재처리 | `202607180005...` + legacy 참조 제거 계약 + P0 handler | 복구/신규 차감 총액 검증 단계에서 부족, 실패 UPDATE가 CHECK 위반 |
| 서버 응답 | RPC error를 `failed`로 반환 | 저장 후보는 ready 그대로. 비 busy 오류에서 appliedDeductionCount를 candidateCount로 보고하는 부정확성도 있음 |
| 재선정 | `sales-deduction-cron-shared.ts` | eligible 유지, 15분 경과 후 다시 선정. 현재 P0 검토 사유만 별도 제외 |

후보 저장 도중 오류도 batch만 실패 처리하고 일부 receipt/candidate가 남을 수 있다. 이는 같은 RPC CHECK와 별개인 부분 저장 문제다. 고정된 cron executionId는 후보 생성의 DB 유일 키가 아니므로 중복을 막지 못한다.

영향은 재고 부족 1개 분기에 한정되지 않는다. 다만 아래 분기는 모두 **selected=true 상태로 진입하면** CHECK에 충돌할 수 있다는 뜻이며, 운영에서 각 분기가 실제 발생했다는 뜻은 아니다.

## 4. 재처리 RPC 실패 경로 전수 분류

기존 본문 `202607180005_fix_reprocess_modified_sales_inventory_deduction.sql`의 실패 receipt UPDATE는 14곳이다. P0 handler는 별도로 이미 선택을 해제한다.

| 사유 | 본문 줄 | 기존 반환 / batch 상태 | 필요한 후속 조치 |
|---|---:|---|---|
| not_reprocess_batch_receipt | 113 | needs_check / failed | 잘못된 workflow 거부. 기존 failed 재호출은 최초 결과 반환 |
| receipt_not_found | 143 | needs_check / failed | 무결성 예외, 동일 입력 자동 반복 금지 |
| canceled_after_applied_not_supported | 162 | needs_check / failed | 최신 취소 버전의 rollback 경로로 라우팅 |
| stale_preview | 192 | stale_preview / failed | 최신 판매 버전으로 전환, 이전 시도 보존 |
| already_processed | 223 | already_processed / canceled | 기존 성공 ID 연결, 정상 중복 종료 |
| legacy_metadata_missing | 316 | failed / failed | 기존 이력·매핑 정보 검증. 추정 복구 금지 |
| no_inventory_movement | 375 | needs_check / canceled | 검증된 무변동 정산으로 완료 가능하도록 후속 엔진에서 지원 |
| initial_apply_required_or_not_reprocess | 403 | needs_check / failed | 최초 처리 작업으로 전환 |
| candidate_changed | 444 | stale_preview / failed | 동시 후보 변경 감지, 최신 계획 재검증 |
| candidate_metadata_missing | 471 | needs_check / failed | 매핑/후보 수정 버전이 바뀔 때 재평가 |
| mapping_changed | 507 | stale_preview / failed | 매핑 버전 갱신 시 재계획 |
| recipe_changed | 542 | stale_preview / failed | 레시피 버전 갱신 시 재계획 |
| inventory_item_missing | 605 | failed / failed | 항목 무결성 예외 |
| insufficient_stock_after_reversal | 643 | failed / failed | 단기: 관련 재고 변화 때 재평가. 신형: 부족을 기록하고 판매 정산 완료 |

로컬 실행 검증 사유: not_reprocess_batch_receipt, stale_preview, canceled_after_applied_not_supported, candidate_metadata_missing, mapping_changed, insufficient_stock_after_reversal. 나머지는 소스 전수 검토이며 분기별 실행은 후속 구현 게이트다. candidate_changed는 임시 스냅샷을 만든 뒤 원본 후보를 잠그므로 별도 동시 세션 스케줄로 검증해야 한다.

그 외 반환/예외:

- `invalid_batch_receipt_id`, `permission_denied`, `batch_receipt_not_found`: 유효한 작업 행이 없거나 권한이 없으므로 대상 상태를 임의 변경하지 않는다. 호출 로그/인증 실패로 구분한다.
- `batch_not_found`: 정상 FK 계약상 도달 불가인지 운영 스키마와 대조할 무결성 실패. 존재하는 후보/작업에 실패를 기록하되 없는 batch를 만들지 않는다.
- 이미 applied인 후보: 성공 이력을 보존하고 already_processed 반환.
- P0 경계: 외곽 subtransaction rollback 후 failed/selected=false, review_reason, receipt 검토 상태를 저장한다. 변경하지 않는다.
- lock timeout·deadlock·serialization·통신 단절·예상하지 못한 SQL 오류: 함수가 오류를 던져 같은 트랜잭션 안에 실패를 영속화할 수 없다. worker가 rollback 뒤 별도 트랜잭션으로 attempt 결과를 저장해야 한다. 연결 단절은 lease 회수 시 idempotency를 조회해 결과 불명 상태를 해소한다. `WHEN OTHERS`로 오류를 삼켜 성공 처리하지 않는다.

## 5. 최소 수정안 (설계, 운영 적용 SQL 아님)

기존 Migration은 수정하지 않는다. 후속 Migration에서 현재 설치 함수의 legacy 정리·P0 handler를 포함한 명시적 전체 정의를 기반으로 변경한다. 인자·반환 필드·OID·owner·ACL·security definer·search_path를 유지한다. 검증한 정의 해시/객체 계약이 다르면 설치를 중단한다. 로컬 테스트의 문자열 치환은 원인 확인용이며 그 자체를 운영 Migration으로 사용하지 않는다.

14곳 모두 같은 UPDATE 문에서 아래 불변식을 지킨다. 사유와 기존 result 분류는 유지한다. already_processed/no_inventory_movement의 batch canceled 의미도 유지한다.

```sql
update public.pos_inventory_deduction_receipts
set status = 'failed',
    selected_for_apply = false,
    error_message = <해당 분기의 기존 사유>,
    updated_at = v_now
where id = v_batch_receipt.id;
```

추가로 인증·행 잠금·applied 확인 뒤 이미 failed이면 최초 실패 결과를 반환한다. 안정적인 재호출을 위해 최초 반환 JSON을 해당 attempt에 저장하고 재사용한다. selected=false를 다시 true로 올려 실패 후보를 재활용하지 않는다. 입력/의존성 버전이 바뀌면 같은 job의 새 attempt를 만든다. 기존 데이터의 error_message는 덮어쓰지 않는다.

batch/receipt 오류는 같은 트랜잭션으로 저장한다. 재고/기존 성공 차감/감사 로그 변경은 0이어야 한다. UI와 worker는 structured failureReason/result를 사용한다. RPC 실패 응답의 appliedDeductionCount는 확인된 적용 0, 전송 결과 불명이면 unknown으로 구분한다. 후보 수를 적용 수로 보고하지 않는다.

선택 CHECK를 완화하거나 실패 상태를 ready로 위장하지 않는다. 이 최소 수정만으로 판매 처리 지연이 근본 해결됐다고 배포 완료 판정하지 않는다.

## 6. 중복 생성과 재시도를 막는 대기열

기존 POS receipt·deduction batch·deduction receipt·deduction을 계속 사용한다. V1/V2 관리 승인 시스템이나 삭제된 recheck queue를 복원하지 않는다. 목적이 분명한 새 private job 테이블 1개와 append-only attempt 기록을 추가한다. 이미 있는 batch receipt를 attempt 상세로 연결하되, 후보 생성 전 실패/lease 결과도 기록할 수 있어야 한다.

### 식별과 상태

- job 유일성: `(receipt_id, sale_version, workflow_type)`. sale_version은 **수신된 판매 의미 변화마다 증가하는 로컬 버전**이다. updated_at이나 현재 재고량을 버전 키로 쓰지 않는다. A→B→A도 다른 버전이다. fingerprint는 내용 검증용이며 버전 순서/유일성의 대체물이 아니다.
- 원본 POS revision/수정시각이 신뢰 가능하면 보관하고, 역순 수신을 구분한다. 반복 동기화·처리 메타데이터 갱신은 새 판매 버전을 만들지 않는다.
- 실행 계획 버전은 판매 버전 + mapping/recipe 버전 + 대상별 count_epoch + engine_version. 실패 재평가 조건에는 관련 inventory_revision도 포함한다. 재고가 바뀔 때마다 판매 job을 새로 생성하지 않는다.
- 상태: queued → leased → completed 또는 waiting_dependency / retry_wait / needs_review / superseded. attempt마다 request_id, lease_token, 예상 버전, 후보 ID, 사유, SQLSTATE, 시작/종료, 계획 hash, 결과를 기록한다.
- 동일 job·동일 dependency signature의 결정적 실패는 새 preview를 만들지 않는다. 기존 attempt 반환. 관련 입고/매핑/실사/판매 버전 변화가 있을 때만 다시 계획한다. 부재한 알림은 주기적 dependency 비교로 보완하되 변화 없는 경우 attempt를 늘리지 않는다.
- timeout·deadlock·일시 네트워크 오류만 지수 backoff+jitter로 재시도한다. 예: 1/5/15/60분 후 최대 간격 유지. 예산 초과는 경보와 낮은 빈도 상태 확인으로 전환하며 판매 사실은 계속 보존한다. 구조적 부족은 신형 정산에서 완료하므로 무기한 입고 대기시키지 않는다.

### 원자적 작업 흐름

1. POS 수집 트랜잭션에서 의미상 새 sale_version과 outbox job을 함께 저장한다. POS HTTP 호출은 이 트랜잭션 밖에서 끝낸다.
2. 짧은 claim 트랜잭션의 `FOR UPDATE SKIP LOCKED`로 하나를 lease한다. lease 만료만으로 실행 완료 여부를 추정하지 않는다.
3. DB 처리 트랜잭션에서 토큰/최신 버전을 확인하고 receipt, 후보, 대상 재고를 잠근다. 모든 엔진과 입고·실사는 공통 순서를 사용한다. 현 재처리의 candidate→batch 순서와 최초 처리의 batch 순서 차이를 먼저 조사·통일하며 단순 wrapper 잠금 추가로 역전을 만들지 않는다.
4. batch/receipt/전체 후보 생성은 하나의 DB RPC로 commit한다. 부분 chunk 저장을 없애고 `(job_id, attempt_no)` 유일 키와 후보별 안정적인 키를 사용한다. attempt 후보 키에 batch ID만 의존하지 않는다.
5. 재고·정산·감사·job 완료는 같은 트랜잭션이다. 오래된 lease 토큰은 완료 갱신을 못 한다. 예외 rollback 후 failure 기록도 토큰과 sale_version의 CAS를 통과해야 한다.
6. claim 후 수정이 오면 구버전은 superseded. 이미 반영된 구버전은 삭제하지 않고 최신 버전에서 보상 정산한다. 응답 소실은 고유 settlement 키로 성공을 찾아 종료한다.

기존 55/150개 미리보기는 삭제·자동 재실행하지 않는다. 새 작업과 기존 후보의 연결 목록을 읽기 전용으로 먼저 산출한다. 별도 승인된 전환에서 과거 후보를 보존한 채 supersession 연결만 추가한다. 기존 fingerprint 성공 유일 키는 A→B→A의 정상 재수정을 차단할 수 있으므로 sale_version 기반 키 전환을 병행하고, 신형 완료를 기존 applied fingerprint에 억지로 끼워 넣지 않는다.

## 7. 판매 사실과 재고 정산 분리

### 원장과 정산 데이터

`pos_sales_receipts/lines/payments`를 현재 조회 모델로 재사용한다. 새 판매 버전의 원본 payload·수신 시각·POS revision·의미 hash·취소 상태·품목 수량을 append-only 버전 스냅샷으로 남긴다. 기존 modification 이력이 완전하면 확장하고, 불완전한 과거 버전을 재구성해 사실로 기록하지 않는다.

deduction의 매핑 스냅샷·reversal 연결·감사 로그는 유지한다. 새 정산 행은 `(receipt_id, sale_version, inventory_item_id, effect_key)` 유일 키, signed economic_quantity, current_stock_delta, previous_settlement_id, boundary_log_id/count_epoch, effective_at, received_at, precision_version, 판단 근거를 가진다. 한 줄이 여러 품목이면 품목별이다. 완료는 current_applied / absorbed_by_count / no_movement로 구분한다. legacy applied 차감과 새 정산을 함께 읽는 호환 조회를 먼저 만든다.

판매 매출/결제 원장은 이 정산 상태나 부족 여부와 독립적으로 수집·조회된다. 부족을 이유로 판매 사실 저장을 실패시키지 않는다. 재고 정산은 판매/회계 원거래 금액을 수정하지 않는다. 재고 금액 평가와 회계 투영은 기존 계약에 별도 대조하며, 과거 장부의 임의 재마감은 하지 않는다.

### 실사 기준점과 시간

실사는 품목별 `count_epoch`, 기준 수량 C, `effective_at`(실제 측정 기준시각), `recorded_at`, 기존 stock_check log ID, 로컬 inventory_revision을 원자적으로 저장한다. 현재 created_at만으로 측정 시점을 안다고 가정하지 않는다. 기존 실사는 시각의 신뢰도를 표시한 초기 기준점으로 연결하고, 누락/모호한 시각은 검토 예외로 남긴다.

실사 시각까지의 물리 변화가 C에 포함된다는 측정 계약이 있어야 한다. 미래 시각 실사 금지. 과거 시각 실사 입력은 그 이후 확인된 이동을 더해 현재 수량을 계산하는 별도 경로가 필요하다. 우선 실시간 측정/즉시 저장 흐름만 자동화하고 긴 지연 입력은 예외로 제한한다. 정확히 경계와 같은 시각은 실사 포함(`<=`)으로 정의하고 정밀도/현장 측정 계약이 불충분하면 검토한다.

계산식: `B_now = C_latest + Σ(기준점 이후로 확정된 signed 물리 이동)`. 판매는 음수, 입고는 양수다. 실사 이전 판매의 경제 수량을 기록하더라도 현재 재고 delta는 0이다. 과거 판매 수정/취소도 해당 기간이 실사에 흡수됐다면 현재 재고를 복구하거나 재차 차감하지 않는다. 실사 이후 정산은 새 버전의 목표 효과와 직전 정산의 효과 차이만 반영한다.

예: 잔술 0.0714 차감 → 실사 C=10 → 그 영수증이 과거 병 판매 1로 정정돼 뒤늦게 수신되면 경제 차이 -0.9286을 기록하고 current_stock_delta=0으로 완료한다. 현재 10에서 1을 다시 빼지 않는다. 새 실사 후 과거 영수증의 품목 A→B 변경도 **A와 B 각각의 실사**를 비교한다. 한 품목만 흡수될 수 있다.

ref_date는 현재 P0의 보수적인 판단 기준이다. 신형에서는 원거래 시각과 실제 재고 효과 시각을 구분한다. 과거 영수증에 실사 이후 실제 추가 판매가 붙었거나 취소 뒤 실제 반품이 발생하면 그 물리 이벤트 시각의 새 이동으로 기록한다. POS가 이를 구분할 증거를 주지 않으면 무조건 과거 거래로 흡수하지 않는다. 실제 물리 시각 불명, 단위/매핑 불명, 실사 측정 구간 불명만 관리자 예외로 남긴다. 취소 플래그만으로 실사 이후 반품을 만들어 재고를 늘리지 않는다.

### 부족과 입고 지연

실사 이후 확정 판매는 장부가 음수가 되어도 정산한다. 실물 재고가 음수라는 주장이 아니라 수집된 기록 간 부족 잔액이다. 권장 최소 호환 구조는 inventory 같은 행에 signed book_quantity와 count_epoch/inventory_revision을 추가하고, 기존 quantity는 비음수 가용 표시로 유지하는 것이다. `available=max(B,0)`, `shortage=max(-B,0)`를 함께 노출한다. **모든 수량 writer와 소비자가 B를 사용하도록 전환하기 전에는 이 모드를 켜지 않는다.** 기존 quantity만 보고 입고를 누적하면 부족을 지워 가짜 가용 재고를 만들기 때문이다.

예: B=0.03에서 정정 차이 -0.9286 → B=-0.8986, available=0, shortage=0.8986, 판매 정산 완료. 나중에 실사 이후 실제 입고 +2 → B=1.1014. 표시 시에만 1.10으로 반올림한다. 판매를 다시 차감하지 않는다. 실사가 오면 이전 부족도 C로 흡수하고 잔차는 별도 정산 감사 행으로 남긴다.

과거에 실제 입고됐지만 입력만 늦은 입고는 effective_at이 실사 이전이면 경제/매입 원장에 보존하고 현재 수량 delta=0이다. 같은 입고의 정정·취소도 원본 연결과 대상 epoch를 유지한다. 현 입고 자동 반영/정정 RPC도 전환 범위에 포함한다. POS만 바꾸고 입고 처리를 그대로 두어서는 안 된다.

고정밀 book_quantity(최소 기존 deduct_quantity_total 정밀도)를 사용하고 병/잔술 변환 스냅샷을 보존한다. 기존 2자리 재고·로그와 고정밀 차감 간 잔차는 opening reconciliation 행에 명시한다. 과거 로그를 다시 계산해 덮어쓰지 않는다.

전환 초기값은 임의로 현재 quantity를 새 실사로 선언하지 않는다. 신뢰 가능한 최근 실사 C와 이후 기존 이동을 읽어 shadow 잔액을 만들고, 이미 적용된 legacy 차감 ID마다 opening settlement 연결을 부여해 재적용을 막는다. 완전성을 증명할 수 없는 품목은 승인된 새 실물 확인을 기준점으로 시작한다. 전환 fence 시각·원본 로그 최대 ID·연결한 legacy ID 집합·고정밀 잔차를 저장하고, 전환 중 신규 이동은 같은 품목 잠금 안에서 이전/신형 중 정확히 한쪽에 귀속시킨다. 누락된 과거 사실을 추정 생성하거나 과거 재고를 자동 재작성하지 않는다.

### 동시 실사와 P0 공존

재고확인 RPC `inventory_update_with_audit_v1`와 입고 생성/수정/정정, 최초 판매·수정·취소는 같은 품목 행을 ID 순으로 잠그고 inventory_revision을 검사한다. quantity 값만 비교하면 ABA 변경을 놓치므로 revision도 CAS한다. 실사 수량·epoch·stock_check 로그·book_quantity 교체는 한 트랜잭션이다. POS worker는 잠금 후 최신 epoch를 읽고 계산한다.

실사 전에 판매가 commit되면 실사가 이를 포함한 C로 덮고 정산은 이전 epoch에 남는다. 실사가 먼저 commit되면 과거 판매는 absorbed_by_count, 이후 판매만 current_applied. rollback·재시도에서도 이 결과가 같아야 한다. READ COMMITTED를 지원 계약으로 정하고 더 강한 격리는 재시도/거부한다.

P0는 유지한다. 실사에 흡수되는 판매는 inventory_logs에 가짜 pos_sales 수량 로그를 쓰지 않고 별도 정산 행에 delta=0을 기록하므로 기존 트리거를 우회할 필요가 없다. 실제 현재 수량 이동만 기존 감사 로그에 쓴다. 신형 경계 판단이 불확실한 경우 P0 검토 상태를 유지한다.

## 8. 구현 순서와 검증 계획

| 단계 | 구현 범위 | 완료 게이트 |
|---|---|---|
| A | 14개 실패 저장 수정, 최초 실패 결과 보존, 응답 적용 수 정정 | 아래 F1~F4. P0·기존 이력 불변 |
| B | 판매 버전·private job/attempt, 원자적 후보 생성, dependency 재시도 | Q1~Q4. 중복 preview 0, 부분 저장 0 |
| C | 실사 effective_at/epoch/revision, 고정밀 book 잔액·정산 호환 조회 | S1~S5, P1~P3. 모든 재고 writer 목록과 잠금 순서 확정 |
| D | 기존 엔진 옆 shadow 계산만 수행, POS 복구 재수집 | 기존 재고 무변경. 차이·예외 전수 분류, 설명 불명 차이 0 |
| E | 승인된 품목/기간부터 신형 writer 전환,旧 writer 이중 차감 차단 | 전체 흐름 검증·관찰 통과. 부족/실사흡수 포함 자동 정산 |
| F | 별도 후속 Migration으로 P0 handler/trigger 제거 | 9절 모든 조건 충족 후 별도 승인 |

단계 A도 이번에는 구현/운영 적용하지 않았다. 로컬 함수 변형으로 최소 수정 가설만 검증했다. 실제 구현 시 기존 PASS는 같은 코드·같은 범위에만 재사용한다. 이번 앱/설정/의존성 변경이 없으므로 전체 TypeScript·Build·전체 회귀를 실행하지 않았다. 기존 P0 회귀는 수정하지 않았고 이번 새 테스트가 P0 설치 상태에서만 수행됐다. 기존 회귀 전체 PASS를 새로 주장하지 않는다.

| ID | 시나리오 / 핵심 검증 |
|---|---|
| F1 | 최초 잔술 성공→수정 부족→동일 버전 55회→입고. 23514 원인, 보존 및 반복 제어. 현재 로컬 인과 재현 PASS |
| F2 | 14개 실패 분기 각각. receipt failed/selected=false/정확한 최초 사유, batch 상태 일치, 재고·성공 이력 불변. 현재 6개 사유만 실행 PASS |
| F3 | invalid/권한/없는 객체, 이미 성공·이미 실패 재호출. 권한 없는 상태 변경 0. terminal 사유 보존은 로컬 실험 PASS |
| F4 | 후보/재고/로그 기록 중 강제 SQL 오류, CHECK·FK 오류. 전체 rollback, worker 별도 실패 감사, 오류 수량을 applied로 보고하지 않음 |
| Q1 | 두 worker/수동 실행/중복 POS 수집, 동일 판매 버전. job 1, 유효 attempt 1, 정산 1 |
| Q2 | claim 후 수정·취소, A→B→A, 역순 POS revision. 최신 버전 보호, 정상 재수정 차단 없음, stale 완료 CAS 실패 |
| Q3 | 후보 저장 중 프로세스 종료, commit 직후 응답 소실, lease 만료. orphan preview 0, 성공 조회 후 중복 이동 0 |
| Q4 | 재고 부족/매핑 오류에 cron 100회. 의존성 변화 전 후보 증가 0. 변화 후 정확히 1회 재평가, outbox 알림 소실 복구 |
| S1 | 지연 최초 판매·수정·취소, 실사 전/같은 시각/후. 전/동일은 흡수, 후는 정확한 차이. 판매 사실 누락 0 |
| S2 | 판매↔실사 양방향 세션 잠금, 저장 도중 오류, 다품목 역순 입력. 전체 원자성·교착·stale 수량/epoch 검증 |
| S3 | 실사 전 잔술→실사 후 과거 병 정정. current delta=0, 경제 차이 보존. A/B별 다른 기준점도 검증 |
| S4 | 취소 전후 실사와 실제 반품 유무. 취소만으로 현재 재고 복구 금지, 확인된 반품 1회만 반영 |
| S5 | 실사 시각 NULL·지연 입력·경계 timestamp 정밀도·POS 시간대 불일치. 잘못된 자동 흡수 0, 필요한 예외만 검토 |
| P1 | 부족 판매 즉시 정산→늦은 입고→입고 수정/취소. book/available/shortage 보존식, 판매 재차감 0 |
| P2 | 실제 입고가 실사 전/후이고 등록은 실사 후. 매입 사실 보존, 실사 전 중복 가산 0 |
| P3 | 0.0714 반복·레시피/콤보·여러 품목·반올림 경계. 고정밀 합계와 표시 잔차 분리, 감사 원본 불변 |
| R1 | POS 장애 수일 후 복구, 중복 페이지/부분 응답/취소 누락 후 재수집. durable cursor+overlap 재수집, 누락 검증 완료 전 watermark 전진 금지 |
| R2 | POS 무수정·연결 재시도·처리 상태만 변경. 새 판매 버전 0, 재고 중복 0. 장애 중 이미 수집된 판매는 독립 정산 |
| R3 | 기존 legacy 차감·취소 이력과 신형 정산 혼재. opening 기준·전환 fence 검증, 구/신 엔진 이중 처리 0 |

테스트는 로컬 PostgreSQL 독립 세션과 합성 POS 응답을 사용한다. 실제 RPC/API/UI 흐름은 후속 구현에서 해당 변경 범위로 검증한다. 단계별 수용 기준: 판매 버전별 정산 합계 일치, 현재 book 보존식 일치, 기존 감사 행 diff 0, 중복 이동 0, 결과 불명 작업의 lease 회수 후 수렴, 관리자 예외는 시간·매핑·물리 이벤트 증거 부족으로 사유가 설명돼야 한다.

## 9. P0 제거 조건과 Migration 전략

`20261101180623_pos_stock_check_boundary_guard.sql`은 유지한다. 신규 엔진이 실행된다는 이유만으로 제거하지 않는다. 제거 조건은 다음을 모두 만족하는 것이다.

1. 최초/수정/취소와 입고·입고 정정·실사·수동 수량 수정까지 writer 목록이 닫혀 있고, 모두 동일한 epoch/원자성/잠금 계약을 사용한다. legacy 엔진 호출 권한·라우팅 fence가 검증된다.
2. 지연 최초·수정·취소·두 세션 실사·입고 지연·장애 복구·고정밀 회귀가 통과하고, 실사 이전 current delta=0이 DB 불변식으로 강제된다. 애플리케이션 if문만으로 대체하지 않는다.
3. 실제 전체 영업주기와 최소 한 번 이상의 실사를 포함한 승인된 shadow/canary 관찰에서 설명 불명 잔액 차이·중복·미수렴 작업이 0이다. 기간 길이보다 커버한 사건과 증거를 기준으로 판단한다.
4. 기존 `stock_check_boundary_requires_review` 작업과 미적용 후보를 원본 보존 상태로 분류했다. 자동 판단 가능한 과거 판매는 흡수 정산 설계가 검증됐으며, 실제 처리/연결 DML은 별도 승인 대상이다. 해결 안 된 시간 모호성은 명시적 예외로 남는다.
5. 최소권한·security definer/search_path·함수 인자/응답 호환·감사 링크·중복 키를 검증한다. 기존 금액/판매/입고 감사와 복구 자료가 보존된다.

후속 Migration은 A(실패 계약), B(버전·작업), C(실사·정산·projection), E(호환 RPC/라우팅), F(P0 은퇴)로 나눈다. 파일은 구현 단계에서 CLI로 생성하고 기존 적용 파일/이력을 수정·재실행하지 않는다. 각 설치 전 대상 SQL·객체·권한·데이터 변경 범위와 정의 해시를 제시한다. 운영 적용은 코드 커밋 승인과 별도다.

F는 트랜잭션 안에서 현재 P0 handler가 정확한 예상 정의인지 확인한 뒤 **기존 handler와 트리거만** 제거하고 신형 DB 경계 제약은 남긴다. 현재 함수 OID/ACL/owner/서명 불변을 검증한다. 트리거 함수를 제거할 때 의존성을 확인하고 CASCADE를 사용하지 않는다. 과거 stock_check/pos_sales 로그·deduction·미리보기는 삭제하지 않는다.

문제 시 worker 신규 claim을 멈추고 신형 쓰기를 fence한다. 이미 정산된 신형 거래를 구형 엔진으로 다시 보내지 않는다. P0 재설치용 forward Migration과 정산 해석 호환 reader를 준비한다. signed 부족 잔액을 구형 writer가 해석하지 못하면 구형 쓰기를 재개하지 않고 수집만 계속한다. rollback 명목으로 과거 재고를 역산하거나 로그를 되돌리지 않는다.

이번 커밋은 재현 테스트와 이 설계 보고서만 포함한다. 운영 복구·신형 엔진·후속 Migration은 구현되지 않았으며 적용 승인도 요청하지 않는다.
