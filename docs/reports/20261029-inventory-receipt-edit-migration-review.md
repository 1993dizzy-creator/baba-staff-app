# 입고 수정 RPC Migration 적용 전 검토 — 2026-10-29

대상: `supabase/migrations/20261029220000_inventory_purchase_receipt_edit.sql` (로컬 작성·검증 완료, **운영 미적용**)
관련 커밋: `06332ea`(최초) → `9cf23a0`(검토 반영: 장부 확인 대기 중 재수정 차단) → SQL 원문 검토 3건 반영(아래 7절)

이 보고서는 정적 검토와 격리 테스트 결과다. 운영 DB 조회·실행, Migration history 변경은 하지 않았다.

## 1. 변경 내용

| 구분 | 내용 |
|---|---|
| 신규 함수 | `public.inventory_apply_purchase_receipt_edit_v1(bigint,bigint,numeric,jsonb,jsonb,date,bigint) returns jsonb` |
| 기존 함수 | 변경 없음 (`create or replace` 없음, 기존 함수 호출만) |
| 테이블·컬럼·제약·인덱스·트리거 | 변경 없음 |
| 데이터 | 적용 시 변경 없음 (backfill·재실행 없음). 함수가 호출될 때만 아래 행이 생긴다 |
| 권한 | `revoke all ... from public, anon, authenticated, service_role` 후 `grant execute ... to service_role` |
| 속성 | `security definer`, `set search_path=pg_catalog,public`, owner `postgres` |

최상위 문은 `begin; create function; alter function owner; revoke; grant; commit;` 뿐이다.

## 2. 함수 동작 (호출 시)

- 입력: 대상 원입고 1건의 새 유효 수량, 단가, 거래처(이름·partner id), 수정 사유(필수, 200자), 메모(500자). 허용 키 외 입력, NaN/Infinity, 음수 수량, 0 이하 단가는 잠금 전에 `invalid_payload`.
- 품목(`inventory`)은 **수량만** `현재 + (새 유효 수량 − 기존 유효 수량)`으로 바뀐다. 단가·거래처·메모 등 마스터 정보는 쓰지 않는다. `inventory_price_logs`도 쓰지 않는다.
- 원입고 행과 기존 로그는 수정하지 않는다. `correction_of_inventory_log_id = 원입고`, `action = 'receipt_edit'`인 정정 로그 1건을 추가한다(새 단가·거래처, `new_note = 사유 · 메모`).
- 장부는 기존 `ledger_project_inventory_purchase_log_v1`(원입고 계열의 최신 로그 기준)과 `inspect_purchase_repair`를 그대로 사용한다.
  - 당일·미지급·미배분·미마감·수동수정 없음 → 같은 트랜잭션에서 재기장. v3와 같은 증거 검사(역분개, 기존 payable 취소, 재기장 감사, 새 후보 금액) 실패 시 전체 롤백.
  - 과거 날짜 원입고(그 외 조건은 안전) → 재고와 정정 로그는 커밋되고 장부는 `review_required`. 대표가 기존 장부 확인 화면(`ledger_resolve_inventory_purchase_correction_v2`)에서 처리한다. 앱은 이 상태를 정상 완료로 표시하지 않는다.
  - 지급·부분지급·배분, 월마감(원입고·인식월·거래월), 수동 금액 수정, 제외된 후보, 장부 상대방 미연결·다중 연결 거래처, 원입고 이후 재고확인(수량 변경 시), 품목 단위와 원입고 단위 불일치 → 쓰기 없이 차단, `blockReason` 반환.
  - 원입고 계열에 `review_required`/`failed` 장부 상태가 남아 있으면 새 수정 차단(`ledger_review_pending`). 확인 대기 건이 겹치지 않는다.
- 거래처 변경은 owner/master만 가능. 비활성 품목은 leader 이상.
- 감사: `ledger_audit_logs` `inventory_purchase_receipt_edited`(이전·이후 수량/단가/거래처, 사유, 메모, 장부 결과). 누락 시 롤백.

## 3. 보호 항목 검토

| 항목 | 근거 | 검증 |
|---|---|---|
| 원본 데이터 불변 | 원입고·기존 로그 update 없음. 품목은 quantity·updated_at·updated_by만 | PGlite: 원입고 행 byte 동일, 마스터 필드 불변 |
| 트랜잭션 롤백 | 쓰기 전체가 하나의 `begin … exception` 블록. 예외 시 모든 쓰기 취소 후 차단 코드 반환 | inventory_logs/ledger_transactions/ledger_payables/감사 로그 강제 실패 5종, 감사 누락 1종 → 상태 전체 동일 |
| 중복 실행(요청) | 절대값 입력이라 같은 요청 재시도는 `no_change`. 다른 버전은 수량·전체 품목 버전 비교로 `quantity_conflict`/`inventory_conflict` | 재시도·stale 버전·동시 2건 테스트 |
| 중복 실행(Migration) | `create function`(replace 아님). 재실행 시 "already exists"로 트랜잭션 전체 롤백 | 정적 확인 |
| 동시 수정 | source advisory lock → payable `for update` → item `for update` → 원입고 행. v3와 같은 순서 | native PostgreSQL 17.6: 수정·지급·배분·월마감 선행 시 대기 후 차단, deadlock 0 |
| 지급·마감 보호 | `inspect_purchase_repair` + projector 결제·마감 게이트 + 잠금 후 재검사 | PGlite 차단 9종, native 지급·배분·마감 경합 |
| 권한 | service_role 전용 EXECUTE, definer, 고정 search_path | anon/authenticated 거부, service_role 허용, `prosecdef`·`proconfig` 확인 |
| 동적 SQL | 컬럼 목록은 함수 내부 고정 키와 `pg_attribute` 교집합. 사용자 입력은 값으로만 바인딩 | 정적 확인 |

## 4. 적용 순서와 의존성

1. 사용자가 SQL Editor에서 이 파일을 실행한다(AGENTS.md 수동 절차).
2. 아래 읽기 전용 확인 후 해당 버전의 Migration history를 기존 절차로 대조·등록한다.
3. 그 다음 앱을 배포한다. **함수 없이 앱이 먼저 배포되면 입고 수정 저장은 500으로 실패한다**(대체 경로로 우회하지 않음). 다른 화면 영향은 없다.

선행 의존: `inventory_ledger_private.lock_sources(text[],date[])`, `inventory_ledger_private.item_matches_expected_v1`, `inventory_ledger_private.inspect_purchase_repair`, `ledger_project_inventory_purchase_log_v1`, `store_business_date_for_timestamp_v1`, `inventory_purchase_correction_guard_v1` 트리거, `ledger_inventory_projection_status`. 모두 기존 Migration(20260914…, 20261007…, 20261009…, 20261010…, 20261011…)으로 존재해야 한다.

## 5. 적용 후 읽기 전용 확인

```sql
select p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner
  from pg_proc p where p.oid = 'public.inventory_apply_purchase_receipt_edit_v1(bigint,bigint,numeric,jsonb,jsonb,date,bigint)'::regprocedure;
select r.rolname, has_function_privilege(r.rolname,
  'public.inventory_apply_purchase_receipt_edit_v1(bigint,bigint,numeric,jsonb,jsonb,date,bigint)','execute') as can_execute
  from pg_roles r where r.rolname in ('anon','authenticated','service_role');
-- 기대: security definer, search_path=pg_catalog, public, owner postgres; anon/authenticated false, service_role true
select count(*) from public.inventory_logs where action = 'receipt_edit';            -- 적용 직후 0
select count(*) from public.ledger_audit_logs where action = 'inventory_purchase_receipt_edited'; -- 적용 직후 0
```

## 6. 되돌리기

- 앱을 이전 버전으로 되돌린 뒤 `drop function public.inventory_apply_purchase_receipt_edit_v1(bigint,bigint,numeric,jsonb,jsonb,date,bigint);`
- 이미 함수로 생성된 정정 로그·감사·재기장은 회계 이력이므로 삭제하지 않는다(기존 정정과 동일 정책).

## 7. SQL 원문 검토 반영 (2026-10-29)

| 지적 | 수정 | 격리 테스트 |
|---|---|---|
| 메모·사유만 바꾸면 `no_change`로 저장 안 됨 | `new_note`(`사유 · 메모`)가 최신 계열 로그와 다르면 수량 0 정정 로그로 저장. 수량·단가·거래처·문구가 모두 같으면 `no_change` | 메모 저장 → 장부 불변(재기장 없음), 동일 재시도 `no_change`·상태 불변, 사유만/메모 삭제도 저장 |
| 거래처 권한 검사가 이름만 같으면 partner ID 변경을 놓침 | 양쪽 ID가 있으면 ID로 판정(같은 ID의 이름 변경은 기록 이름 유지). 그 외에는 ID 변화(null↔ID) 또는 이름 변화를 변경으로 판정 → owner/master만. API는 이름 전용 거래처를 resolver로 다시 해석하지 않고 그대로 전달 | 이름 전용 원입고에 ID 연결: staff 거부·owner 허용, ID 제거 staff 거부, 대소문자·공백 차이는 변경 아님(기록 이름 유지), 같은 ID 이름 변경은 변경 아님 |
| projector `pending`을 명시적으로 처리하지 않음 | 결과 `completion` 추가: `complete` / `ledger_pending`(미확정 후보에 새 금액 반영, 수정 전 후보가 없거나 pending일 때만) / `ledger_review`(과거 날짜). 수정 전 확정 후보인데 `pending`이면 `LEDGER_PENDING_UNEXPECTED`로 전체 롤백. 확정 후보의 금액 변경이 재기장 없이 `synced`로 오면 `INVENTORY_LEDGER_ATOMIC_FAILED`로 롤백(거래처만 바뀐 같은 상대방 보강 `METADATA_SYNCED`는 허용). 앱은 `complete`만 정상 완료로 표시 | 미매핑 거래처 미확정 입고 → `ledger_pending`, 후보 금액 갱신·거래 없음, owner의 미매핑 거래처 변경도 `ledger_pending`; 확정 후보에 강제 `pending`·`UNCHANGED` 응답 → 차단·상태 불변 |

| 확정 입고의 메모·사유만 수정은 projector가 `METADATA_SYNCED`로 처리해 지급·배분·마감·수동 정정 검사를 거치지 않음 | 확정 후보가 있는 입고는 모든 수정 전에 장부 거래·payable·배분·월마감(관련 월 advisory lock 후)·수동 금액/상대방 변경을 검사하고, 해당하면 쓰기 없이 `CONFIRMED_RECEIPT_PROTECTED`로 차단 | 수정 전 SQL(`8413c26`)에서 지급·배분·마감·수동 금액 상태의 메모 수정이 `ok/complete`로 저장됨을 재현. 수정 후 7개 상태 모두 차단·상태 불변. native: 지급·배분·월마감 선행 시 메모 수정 대기 후 차단, deadlock 0 |

검증: PGlite 입고 수정 DB 37건, native PostgreSQL 17.6 22건 통과. 재고·장부 회귀 792건 중 실패 31건은 기존과 동일 파일·건수.

## 8. 남은 위험

- 과거 날짜 수정은 대표의 장부 확인 전까지 재고와 장부가 다르다. 앱은 카드에 "장부 관리자 확인 대기"를 표시하고 같은 입고의 재수정을 막는다.
- 이미 `review_required`/`failed` 장부 상태가 남아 있는 기존 원입고는 관리자 처리 전까지 입고 수정이 차단된다(보수적 동작).
- 거래처 변경 후 과거 날짜 확인은 기존 장부 화면의 거래처 변경 확인(fingerprint) 절차를 거친다.
- `ledger_pending`은 원래 미확정이던 입고에만 생긴다. 대표가 기존 후보 확정 절차로 마무리해야 하며, 앱은 확정 대기 안내를 표시한다.
- 10/9 배 #12848·장부 #2485/#1161은 대상이 아니며 변경하지 않았다.
