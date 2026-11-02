# P1-2E — 전체 수량 Writer 공통 원장 및 Shadow 시간순 정산

기준 `48a3cafc90a1c85ba2d5558c14693378afb43d7f`, 원본 main 직렬 작업. [P1-2C Writer 목록](20261102-pos-shadow-p1-2c-readiness.md)과 [P1-2D 수집 계약](20261102-pos-reliable-ingestion-p1-2d.md)을 재사용했다.

**로컬 공통 기록·잠금·원자성·Shadow 연결 검증 PASS. 운영 자동 정산/기존 엔진 교체는 BLOCKED.** 기존 재고 수량을 새 signed balance로 덮어쓰는 활성 엔진은 만들지 않았다. Shadow는 실제 재고를 쓰지 않으며, 기존 Writer가 수행한 정상 수량 변경을 DB에서 포착하고 예상 정산과 비교한다. 공급자 완전성 미확인, Shadow 기본 비활성, P0 보호를 유지한다.

운영 DB/POS 조회·수정, 운영 Migration 적용, Push·배포는 하지 않았다. 기존 Migration 파일·감사 데이터의 정리/일괄 재작성도 없다. P0 제거 Migration은 작성하지 않았다.

## 1. 단계별 구현

1. `feb19667cfc6e672aec7cbd06d32864afb41c390` — [공통 원장 SQL](../../supabase/migrations/20261102120035_inventory_writer_event_journal.sql), 원자적 필수 감사 및 우회 방지 기반, native 8 PASS.
2. 이 보고서와 함께 커밋하는 후속 단계 — [Writer/Shadow 통합 SQL](../../supabase/migrations/20261102120303_inventory_writer_shadow_integration.sql), 요청 replay, 기존 RPC 잠금 진입부, 앱 연결, Shadow 전달·비교 및 source gate. 최종 로컬 SHA는 완료 응답에 기재한다.

새 Migration 두 개는 CLI로 생성했고, 폐기 가능한 로컬 PostgreSQL에서 파일 SQL만 실행했다. Migration 이력에 적용하지 않았다. 기존 RPC 전체를 다른 구현으로 교체하지 않고 설치된 본문에 공통 잠금 진입부를 추가한다. 설치 전 본문/정의를 private 계약 테이블에 보존한다. PostgreSQL 소유자, definer, JSONB 반환, 알려진 인자 수와 본문 형태가 맞지 않으면 중단한다. 운영의 정확한 설치 정의 검토는 여전히 별도 선행조건이다.

기존 RPC의 OID·owner·ACL·인자/default·반환형·설정은 native 비교로 보존을 확인했다. 4인자 SQL `replace_inventory_keg` 위임 함수만 같은 OID의 PL/pgSQL 위임으로 바꾸어 동일한 잠금 진입부를 실행한다. P0 함수·트리거는 변경하지 않았다.

## 2. 통합된 Writer와 남은 의미 검증

| Writer / 진입 경로 | 이번 구현 | 남은 조건 |
|---|---|---|
| POS 최초 판매차감 / apply batch / unified·cron | 기존 apply RPC에 공통 잠금, 실제 변경과 로그 원자 검증, `sale_posting` 이벤트 | 신뢰 가능한 판매 버전·물리 시각 필요. posting 로그를 물리 이동으로 중복 등록하지 않음 |
| 수정 영수증 / P1-1 prepare·reprocess / cron | 두 진입점 모두 공통 잠금. 복구·새 차감 각각 감사 연결. P1-1 의존성별 중복 방지 유지 | 실제 CUKCUK source는 미확인. 기존 부족 재고 해소 후 재처리도 native 회복 확인 |
| 판매취소 / rollback RPC | 같은 원장·잠금, `sale_posting`으로 구분 | **구형 RPC의 수량 복구 동작은 호환을 위해 남아 있다. 이를 현물 반환이라고 간주하지 않는다.** 신형 취소는 경제 취소만으로 물리 소비를 되돌리지 않음 |
| 실제 반품 | 기존 양수 조정 Writer + `inventoryEvent.kind=physical_return`·물리 시각/근거·physicalEventRef | 현물 접수 근거가 필요. 환불 금액/취소 상태에서 자동 생성하지 않음 |
| 빠른 저장 / 실물확인 | update RPC 진입부, CAS, 로그, 공통 이벤트. 수량 불변 실사도 count 이벤트 | 기존 UI에 측정시각이 없으면 null/보류. 저장시각으로 대체하지 않음 |
| 일반 품목 수정 / 수동 관리자 수량 변경 | 같은 update RPC와 요청 인터페이스. 직접 quantity DML 차단 | unit/package 변경은 이전/이후 정의를 추가 기록하고 `unit_or_package_contract_changed`로 보류 |
| 신규 품목 / 최초 입고·실사 | create RPC 진입부, 최초 수량/감사/가격·기존 Ledger 원자성 유지 | create를 무조건 stock_check로 승격하지 않음. 등록 사유와 물리 시각 근거 사용 |
| 일반 매입·입고 | 기존 purchase 증가 Writer + 이벤트/감사/Shadow 전달 | 입고의 businessDate와 실제 물리 도착시각은 별개 |
| 입고정정 v3→v2→v1 및 직접 v1/v2 | **세 버전 모두** 공통 진입부. 신규 정정 로그를 같은 txn에서 완성하는 동작 허용 | root/단위/기존 실사 경계 제약 유지. 과거 물리 시각은 입증해야 함 |
| 입고 영수증 수정 / billed amount | receipt-edit RPC + 필수 감사. 원래 입고/회계 감사 보존. 수량 0의 가격·금액 정정은 물리 이동에서 제외 | 수량 정정의 effective_at 근거는 필요. 경제 정정과 물리 이동을 합치지 않음 |
| 케그 교체 / safety RPC / replace 4·5인자 | 모두 공통 진입부, -1 Keg 로그와 safety UUID 연결, replay 보존 | expected quantity도 request ID도 없는 legacy replace는 거부. ml 소비를 다시 -1 이동으로 등록하지 않음 |
| 케그 시작시각 정정 | 기존 safety audit를 원본으로 `keg_timing` 이벤트 추가. 직접 session 시간/상태 DML 차단 | 수량 0이지만 과거 경계를 바꿀 수 있어 시간 재정산 전 보류. 기존 movement 시각을 덮어쓰지 않음 |
| 자동 배치·보정 | 기존 POS 배치가 위 RPC를 사용하면 동일 계약. 등록되지 않은 수량 직접 쓰기는 DB에서 거부 | 저장소 밖 batch/caller는 운영 catalog와 대조 필요. 새 정식 진입점 등록 없이 우회 허용하지 않음 |
| 품목/원본 로그 hard delete·감사 재분류 | DB DELETE/TRUNCATE·기존 로그 UPDATE 차단. API 이력 purge는 첫 쓰기 전 409. journal 모드의 로그 수정/삭제와 품목 삭제도 409 | 품목 비활성화와 append-only 정정 사용. journal 모드에서 기존 감사 직접 편집 기능은 의도적으로 허용하지 않음 |
| 사진·활성 상태·supplier alias·보고/재고 snapshot·Ledger 재투영 | 수량 Writer로 재분류하지 않음. 들어오는 수량 0 로그는 기록 후 물리 이동에서 제외 | 별도 메타데이터 기능 유지. 단위/패키지 의미 변화는 위 별도 보호 대상 |

수량 Writer의 알려진 RPC 이름은 12개, replace overload를 포함하면 13개 signature다. native fixture를 합쳐 각 계열의 실제 함수를 실행했다. POS·전체 Shadow fixture와 회계 정정 fixture를 용도에 맞게 분리했으며, 가짜 재고 Writer로 바꾸어 검증하지 않았다. 운영에 그 목록이 그대로 설치되어 있다는 주장은 하지 않는다. `inventory_writer_inspect`는 설치된 signature·drift·누락 이름을 반환한다.

## 3. 공통 이벤트·시간·감사 계약

`inventory_writer_private`의 private 테이블은 RLS 및 직접 권한 차단을 적용했다. 새 public RPC는 service_role만 호출할 수 있다. 이벤트/연결/정의 변화/확인 증거/전달 시도는 append-only이고, requests/outbox의 현재 상태만 갱신한다.

- **events:** 고유 UUID, 로컬 ordinal, 품목·변경 유형·수량·전후 수량/단위, effective_at, 관측시각, DB 원장 기록시각, 원본 log ID/hash/snapshot, receipt/deduction/correction root 참조, request UUID/멱등성 키, 근거와 보류 이유를 기록한다. 케그 시각 정정은 inventory log가 없으므로 기존 safety request/audit를 원본으로 연결한다.
- **changes/links:** 실제 inventory 수량·단위/패키지 변경과 해당 감사 이벤트를 연결한다. 기록된 declared quantity와 실제 저장 전후 수량을 구분한다. 기존 numeric 정밀도를 새 엔진을 위해 임의로 바꾸지 않는다.
- **기준점:** 이벤트를 기록할 때 이미 입증된 실사 기준점이 있으면 연결한다. 없으면 null을 유지한다. Shadow 전달 결과와 계산 결과에는 사용한 boundary log ID를 남긴다. 최종 계산은 최신 검증 실사 기준점을 다시 선택한다.
- **시간:** physical effective_at은 명시적 offset과 근거가 있어야 한다. 관측/DB 기록시각은 별도다. recorded_at은 트랜잭션 안의 원장 확정 처리시각이며 외부 응답 도착시각이나 실제 물리 이동시각이 아니다.
- **케그의 알려진 시간:** journal 모드의 실제 교체는 기존 operator-selected `replacementAt`, request UUID, preview, before/after safety audit를 근거로 재사용한다. 서버 저장시각을 추정한 값이 아니다. edit-start는 새로운 물리 이동으로 취급하지 않는다.
- **알 수 없는 시간:** 일반 저장·실사·입고에서 기존 요청에 물리 시각이 없다면 `physical_effective_at_unproven` 등으로 남긴다. 현재 시각을 만들어 넣지 않는다. 필요한 경우 `inventoryEvent` 또는 owner/master의 append-only attest로 근거를 보완한다.

inventory 변경과 필수 로그는 deferred 검증으로 같은 commit에 확정한다. 로그가 없거나 전후 수량이 대응하지 않으면 `23514 INVENTORY_QUANTITY_AUDIT_REQUIRED`로 전체 txn을 취소한다. 로그를 먼저 쓰거나 나중에 쓰는 순서도 txn 끝의 완성된 자료로 검증한다. 같은 txn에서 새 정정 로그의 root/사유를 완성하는 기존 RPC는 허용하지만 commit된 원본 로그를 다시 수정하지 못한다. 트리거의 오류가 원래 변경과 함께 롤백되는 PostgreSQL [트리거 계약](https://www.postgresql.org/docs/current/trigger-definition.html)을 사용한다.

불변 실사 로그는 실제 감사 삽입 당시 수량과 대조한다. 수량 변경이 없는 정상 실사는 허용하면서, 다른 수량을 적은 unpaired count를 자동 물리 기준점으로 넘기지 않는다. 검증 쿼리에는 transaction/item/event 인덱스를 추가해 전체 감사 이력을 매 변경마다 순회하지 않게 했다.

## 4. 잠금·멱등성·우회 방지

기존 RPC는 업무 잠금을 얻기 **전에** 공통 transaction advisory gate를 획득한다. 기존 source/month/payable/receipt/session 잠금과 품목 ID 정렬은 유지한다. 이 단계에서는 서로 다른 계열의 기존 잠금 순서를 대규모 재작성하는 대신, 공통 gate로 Writer 간 순환 대기를 차단한다. 따라서 **모든 품목에 걸쳐 보수적으로 직렬화**한다. HTTP·POS 요청은 이 잠금 안에서 하지 않는다. 운영 처리량 SLA는 아직 측정하지 않았다.

이미 xid/이전 잠금을 가진 미등록 외부 txn은 gate가 바쁘면 대기하지 않고 `40001 INVENTORY_WRITER_RETRY_LOCK_ORDER`로 전체 재시도를 요구한다. 등록되지 않은 quantity/unit/package 직접 쓰기는 `42501 INVENTORY_WRITER_REGISTERED_REQUEST_REQUIRED`로 차단한다. 트리거를 임의로 비활성화할 수 있는 DB owner/superuser는 이 보호의 신뢰 경계 밖이다. 실제 운영 role/ACL·실행 목록 확인 없이 우회가 절대 없다고 주장하지 않는다.

[공통 앱 어댑터](../../lib/inventory/writer-rpc.ts)와 `inventory_writer_apply_v1`은 UUID + 동일 intent로 결과를 재사용한다. 기본 UUID는 intent hash이며 공급자 버전/순번이 아니다. CAS snapshot은 키에 포함하고 서버가 만든 outgoing updated_at만 제외한다. 다른 payload로 같은 UUID를 쓰면 거부한다. 수량/감사 effect가 발생했거나 정상 완료한 결과만 cache한다. 부족/실패는 시도 이력을 추가하고 기존 P1-1 의존성 재시도가 회복될 수 있게 한다.

items의 create/update/correction/receipt-edit 및 keg save는 `INVENTORY_WRITER_MODE=journal`에서 이 인터페이스를 선택한다. **기본은 기존 경로이며 환경 설정을 추가하지 않았다.** POS는 기존 P1-1 멱등성 키를 재사용하며 모든 기존 DB 진입점에 공통 잠금/저널이 적용된다. 중복 전달 자체는 log/source event 키로 한 번만 기록한다.

원시 공통 RPC는 응답 유실 재전송에 최초 결과를 반환한다. 기존 items HTTP API는 RPC 전에 CAS를 검사하므로, 응답 유실 후 동일 HTTP 요청이 stale 409를 반환할 수 있다. 이 경우도 두 번째 변경은 발생하지 않지만 HTTP 전체 응답을 별도 cache하는 구현은 아니다. 화면은 재조회하여 저장 결과를 확인해야 한다. 기존 stale 보호를 replay 목적으로 우회하지 않았다.

## 5. Signed balance와 Shadow 전달

기존 P1-2의 `item_book`, sale-version/settlement/item_effects 및 P1-2C 결정적 경계 선택을 재사용한다. 실사 수량 + 이후 물리 이동 - 각 판매의 최신 물리 소비 목표를 계산한다. 이전 실사보다 과거인 수정은 경제 차이만 남기며 현재 delta는 0이다. 이후 수정은 이전 반영 목표와의 차액이다. 취소는 경제 목표를 취소하지만 실제 반품 증거 없이는 물리 소비를 되돌리지 않는다.

계산상 -6/shortage 6은 별도 원장에 보존한다. 실제 재고를 음수로 만들거나 부족을 0으로 덮지 않는다. 실제 입고 +10 이후 book은 4가 되고, 과거 판매를 다시 차감하지 않는다. signed 잔액의 표시 가능 수량과 실제 inventory.quantity는 분리된다. Shadow에는 inventory 수량 UPDATE가 없다.

모든 commit된 Writer 이벤트는 같은 txn의 outbox로 들어간다. `inventory_writer_shadow_drain`은 짧은 SQL txn과 SKIP LOCKED로 선택·기록·상태 갱신을 원자 처리한다. 외부 대기 구간이 없어 별도 HTTP lease를 두지 않는다. 실패 시 txn 전체가 롤백된다. 새 근거 없는 held 이벤트는 다시 돌지 않으며, append-only attest가 추가되면 새 dependency 시도로 회복한다. 각 시도에 원래 이유·retryCondition·결과를 보존한다.

POS posting은 `pos_ingest_shadow_evidence`를 조회해 보류하며 물리 movement로 보내지 않는다. [기존 Shadow capture 앱 경로](../../lib/sales/inventory-shadow.ts)도 CUKCUK이면 caller가 sourceComplete=true/revision=999를 보내도 P1-2D의 false/null 계약을 적용한다. 검증되지 않은 원본 순번을 새로 생성하지 않는다.

[Writer 관리 API](../../app/api/admin/sales/inventory-shadow/writers/route.ts)는 owner/master + `POS_INVENTORY_SHADOW_MODE=shadow`에서만 inspect/drain/attest/compare를 제공한다. 기본 off이며 live 입력을 거부한다. compare는 항상 sourceComplete=false, automaticConfirmation=false, replacementAllowed=false다.

이미 등록된 movement의 다른 시각이 나중에 제시되면 원본을 덮지 않는다. 새 증거와 구체적인 보류 이유를 남긴다. 단위 epoch 전환, 케그 시간 정정, 등록 movement의 시각 변경을 수치적으로 다시 투영하는 엔진은 **이번에 완료되지 않았다**. `verified_unit_epoch_reconciliation` / `versioned_movement_timing_reconciliation` 후속 작업이 필요하다. POS 보류 재개는 `verified_source_contract_release` 이후 별도 검토된 코드/queue 전환이 필요하며 현재 타이머만으로 확정하지 않는다.

## 6. 검증 결과와 PASS 재사용

유효한 변경 영향 검증 **135 PASS / 0 FAIL / 0 SKIP**. 서로 다른 실행의 중복 PASS를 더하지 않았다. native 상위 테스트 2개를 포함한다.

| 파일/범위 | 유효 PASS |
|---|---:|
| inventory-writer-journal-postgres — 단계 1 원자 감사/직접 DML/원본 불변/P0 | 8 |
| inventory-writer-integration-postgres — 단계 2 실제 Writer·정산·경합·권한 | 18 |
| inventory-writer-app — 요청 키/재시도/기본 off/owner 및 케그 명시 시각 | 3 |
| keg-safety-p0-api — 변경 진입점의 기존 정상·권한·검증 계약 | 4 |
| inventory-items-final-validation + inventory-ledger-projection-api + pos-shadow-app | 102 |

마지막 API 삭제 거부 보완은 해당 테스트 1개만 재실행했고, 나머지 영향 없는 PASS를 재사용했다. 변경 TS 8개 ESLint PASS, 이 파일들을 root로 한 좁은 의존 그래프 TypeScript semantic 진단 0개. 전체 Build/TypeScript/전체 테스트는 실행하지 않았다.

| 필수 시나리오 | 결과 |
|---|---|
| 실사 이전 지연 판매 수정 | PASS: 현재 delta=0 / count 기준 book=5 유지 |
| 실사 이후 판매 2→3 수정 | PASS: 현재 delta=-1, 기존 목표 중복 차감 없음 |
| 단순 취소 / 실물 반환 | PASS: 취소 current delta=0, 별도 물리 반환 +1로 book 증가 |
| 부족 + 지연 입고 | PASS: book=-6/shortage=6, 실제 재고 5 유지. 실제 +10 입고 후 book=4, shortage=0 |
| 글렌피딕 0.0714→1 병, 부족·55회·실사/입고 후 지연 재처리 | PASS: 실제 기존 RPC 실행, 반복 preview batch 증가 없음. 실사 0.20→입고 1→지연 재처리는 P0 review로 실제 1.20 보존 |
| 부족 해소 후 기존 재처리 회복 | PASS: 실사 경계 없는 별도 사례에서 입고 후 reprocess 성공, 원래 실패/복구 감사 유지 |
| 동일 품목 동시 저장 | PASS: CAS로 하나 성공/하나 충돌, 추가 이벤트 없음 |
| POS↔실사/입고, 케그↔POS | PASS: 실제 RPC + 다중 PG 세션. pg_stat_activity/pg_blocking_pids로 DB Lock 대기 확인 |
| 입고 영수증 정정↔차감 | PASS: 실제 회계 fixture에서 하나 성공/하나 CAS 충돌. 이후 정상 정정·v1/v2/v3 직접 경로 모두 성공 |
| 케그 교체·시각 정정 | PASS: -1 한 번, POS 차감과 직렬화, replay 불변. edit-start는 수량 불변/별도 timing 이벤트·보류 |
| 응답 유실·중복 실행 | PASS: 공통 RPC 최초 결과 재사용, 다른 intent 거부. 기존 API stale 요청도 재변경 없음 |
| 감사 누락·원본 불변 | PASS: actual change→event, 신규 quantity log→event 누락 0. 원래 입고 log/기존 Ledger audit 행 불변 |
| 수량 불변 실사 / 같은 시각 기준점 / 55회 재비교 | PASS: source log ID로 결정, 재실행 동일. 이는 실제 측정 선후의 증명은 아님 |
| 시각 수정·단위/패키지 변화·원본 불확실 | PASS(보호): 구체적 사유로 held, 원본/실제 수량 재작성 없음 |
| 실제 CUKCUK 공급자·운영 설치 목록·부하/정밀도 보장 | 미확인 / 운영 전환 BLOCKED |

주요 실행:

```powershell
$env:QA_POSTGRES_BIN=(Resolve-Path '.tmp/production-preflight/node_modules/@embedded-postgres/windows-x64/native/bin').Path
node --experimental-strip-types --test tests/inventory-writer-journal-postgres.test.mjs
node --experimental-strip-types --test tests/inventory-writer-integration-postgres.test.mjs
node --experimental-strip-types --test tests/inventory-writer-app.test.mjs tests/keg-safety-p0-api.test.mjs
node --experimental-strip-types --test tests/inventory-items-final-validation.test.mjs tests/inventory-ledger-projection-api.test.mjs tests/pos-shadow-app.test.mjs
```

단계 1 native 증거: `.qa-review/pg-native-logs/pg-native-test-9f11c7cd-ed8c-4f21-acbe-c380ae090c08-xstAnr`.
단계 2 최종 증거: `.qa-review/pg-native-logs/pg-native-test-dc83368f-74e2-4c3a-a573-4c1fcffcef3e-0w44cy` — `outcome.passed=true`, 임시 DB 정리 완료, 로그 보존. 운영 자격 증명을 테스트에 제공하지 않았다.

기존 P1-2/P1-2C의 변경하지 않은 시간순 계산·원본 계약 및 P1-2D 수집 PASS를 범위에 맞게 재사용했다. 잠금 진입부와 트리거가 추가된 기존 Writer의 실행 계약은 위 native로 새로 검증했다. 과거 전체 PASS를 새 엔진 전체의 PASS로 확대하거나 135건에 합산하지 않았다.

## 7. 활성화 차단 사항과 다음 조건

1. **공급자 완전성·원본 순서:** P1-2D의 false/null 유지. 실제 계정 snapshot/LastSyncDate/삭제·취소/시각 보장 또는 권위 있는 export와 전체 gap 대조가 필요하다.
2. **물리 시각·측정 경계:** 기존 일반 저장에는 물리 시각이 없다. 해당 UI/업무에서 명시적 시각·근거를 수집해야 한다. 같은 시각의 실사/이동은 측정 구간·포함 관계를 증명해야 하며 내부 log ID를 물리 발생순서로 간주하지 않는다.
3. **잔여 의미 전환:** 단위/패키지 epoch, 케그 timing 변경, 이미 등록한 movement 시각 정정의 버전별 재투영이 필요하다. 현재는 기록·차단까지 구현했다. 정밀도도 기존 inventory/log 2자리와 POS 목표 0.0714의 차이를 검증해야 하며 임의 반올림으로 부족을 없애지 않는다.
4. **구/신 엔진 교체:** legacy cancel은 여전히 기존 조건에서 quantity를 복구한다. 새 원장에서는 이를 physical_return으로 보내지 않는다. 실물 반환 없는 취소가 실제 수량 복구를 하지 않도록 바꾸는 live 전환은 signed projection/모든 reader 검증 후 별도 단계다. 현재 이 호환 동작이 남은 채 운영 교체가 가능하다고 판단하지 않는다.
5. **실제 설치와 우회:** 운영 pg_proc/trigger/role/table DML/실행 배치가 저장소 목록과 같은지 미확인이다. DB owner의 trigger disable/raw SQL은 별도 신뢰 경계다. registry 누락/drift, 미등록 batch, metadata 경로의 재시도 조건을 운영 전 확인해야 한다.
6. **처리량과 이행:** 공통 gate는 보수적 전역 직렬화다. 실제 거래량·Ledger 처리시간에서 짧은 잠금과 retry SLA를 측정해야 한다. metadata-only 경로와 기존 API의 40001/409 처리도 확인해야 한다.

후속 승인 시에는 Writer 정지/설치 정의·권한 검토 → 이력 purge 보호 API 먼저 제공 → 두 새 Migration의 별도 승인·적용 → normal 기능/원자성 확인 → 제한적으로 journal/Shadow 모드 선택 → 시간 근거/누락·보류·비교 결과 확인 순서가 필요하다. 과거 로그를 일괄 이벤트로 backfill하거나 기존 수량을 자동 복구하지 않는다. source 검증과 잔여 의미 전환이 끝나기 전에는 실제 재고에 signed 결과를 적용하지 않는다. P0 제거는 신형 엔진 운영 검증 이후 별도 승인 단계로 남긴다.
