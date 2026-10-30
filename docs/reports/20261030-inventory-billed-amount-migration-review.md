# 품목별 실청구금액 v1 — Migration 적용 전 검토 (2026-10-30)

- 대상 파일: `supabase/migrations/20261030150000_inventory_purchase_billed_amount.sql`
- 상태: **로컬 작성·격리 테스트 완료, 운영 미적용.** 운영 SQL 실행·이력 등록·Push·배포 없음.
- 데이터 변경: **없음** (backfill 없음). 기존 `inventory_logs` 13,854행(2026-10-30 조회)은 모두 `billed_amount_mode = NULL` = 자동계산으로 해석되어 장부 금액·스냅샷·fingerprint가 바뀌지 않는다.

## 변경 객체

| 구분 | 객체 | 내용 |
| --- | --- | --- |
| 테이블 | `public.inventory_logs` | `billed_amount numeric(16,3)`, `billed_amount_mode text` 추가(기본값 없음, 재작성 없음). CHECK 2개: 모드·금액 조합, 구매 로그 전용 |
| 트리거 | `inventory_purchase_correction_guard_billed_amount` → `inventory_purchase_billed_amount_guard_v1()` | 실청구금액 값 불변, 수동 입고의 수량·단가 직접 수정 금지, 수동 입고에 모드 없는 정정(빠른저장 감소·레거시 연결) 거부 |
| 신규 함수 | `inventory_ledger_private.purchase_billed_amount_v1(bigint,bigint)` | 입고 계열의 유효 실청구 상태(가장 최근 명시 모드) |
| 교체 | `inventory_ledger_private.economics(jsonb)` | `billed_amount_mode`, `calculated_amount` 두 표시 키만 경제 비교에서 제외(기존 스냅샷에는 없는 키) |
| 앵커 수정 | `inventory_ledger_private.inspect_purchase_repair` | `newAmount`·`delta`가 유효 실청구금액 기준, `calculatedAmount`·`billedAmountMode` 추가 |
| 앵커 수정 | `public.ledger_project_inventory_purchase_log_v1` | 수동이면 금액 = 실청구금액, 스냅샷에 `billed_amount_mode`·`calculated_amount` 추가. 자동은 기존 바이트 그대로 |
| 교체 | `public.inventory_update_with_audit_v1` | 선택 키 `billed_amount(_mode)`(재고 컬럼 아님). 신규 입고에 모드가 있으면 같은 트랜잭션에서 장부 반영 |
| 교체 | `public.inventory_apply_purchase_receipt_edit_v1` | `p_edit.billed_amount(_mode)` 추가, 모든 정정 로그에 모드 기록, 금액 기준 재기장 판정 |

권한: 기존과 동일(공개 RPC는 `service_role`만 실행, private 함수·트리거 함수는 전부 revoke).

## 적용 안전장치

- 시작 시 운영 본문 md5(줄바꿈 무시) 확인: receipt-edit `aa26ade1…`, update_with_audit `f793ac06…`, inspect `72725a6d…`, economics `ae74601e…`. 2026-10-30 운영 읽기 조회와 로컬 fixture가 모두 일치했다.
- 프로젝터·inspect 앵커는 운영 본문에서 각각 정확히 1회 존재함을 읽기 전용으로 확인했다(CRLF·display-sync 패치 포함 본문).
- 재적용·본문 불일치 시 예외로 전체 롤백(부분 적용 없음) — 테스트로 확인.

## 적용 순서

1. 사용자 승인 후 Supabase SQL Editor에서 위 파일 1개 실행(단일 트랜잭션).
2. GPT 원격 postflight(아래) → 해당 신규 Migration 이력만 확인·등록.
3. 그 다음 앱 배포. **앱을 먼저 배포하면 안 된다**: 새 앱은 `billed_amount_mode` 키를 보내므로 구 RPC가 `invalid_payload`로 입고 저장을 거부하고, 신규 품목 등록은 없는 컬럼 때문에 실패한다. DB 먼저 적용하면 구 앱은 기존과 동일하게 동작한다.

## Postflight (읽기 전용)

```sql
select column_name, data_type, numeric_precision, numeric_scale from information_schema.columns
 where table_schema='public' and table_name='inventory_logs' and column_name like 'billed_amount%';
select count(*) filter (where billed_amount_mode is not null) as moded, count(*) from public.inventory_logs; -- moded = 0
select tgname from pg_trigger where tgrelid='public.inventory_logs'::regclass and not tgisinternal order by 1;
select position('baba.billed_amount_v1' in pg_get_functiondef('public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'::regprocedure))>0;
select p.oid::regprocedure, has_function_privilege('service_role',p.oid,'execute') s, has_function_privilege('authenticated',p.oid,'execute') a,
  has_function_privilege('anon',p.oid,'execute') n from pg_proc p
 where p.oid in ('public.inventory_apply_purchase_receipt_edit_v1(bigint,bigint,numeric,jsonb,jsonb,date,bigint)'::regprocedure,
  'public.inventory_update_with_audit_v1(bigint,jsonb,jsonb,date,bigint,text,text,date)'::regprocedure,
  'inventory_ledger_private.purchase_billed_amount_v1(bigint,bigint)'::regprocedure,
  'public.inventory_purchase_billed_amount_guard_v1()'::regprocedure);
-- 기존 장부·미지급금 행 수와 합계가 적용 전과 같은지(적용 전 값을 먼저 기록)
select count(*), sum(amount) from public.ledger_transactions; select count(*), sum(original_amount) from public.ledger_payables;
```

## Rollback

데이터 변경이 없으므로 적용 직후 rollback은 함수 본문 복원(20261029220000·20261010140729·20261009080243 본문과 프로젝터 추가분 제거), 트리거·helper 삭제, 두 컬럼 삭제로 가능하다. 단 **수동 실청구금액이 한 건이라도 입력된 뒤**에는 컬럼 삭제가 그 기록을 지우고 이미 실청구금액으로 기장된 장부와 불일치를 만들므로, 그때는 rollback 대신 후속 Migration으로 수정한다. 별도 rollback 스크립트 파일은 작성하지 않았다.
