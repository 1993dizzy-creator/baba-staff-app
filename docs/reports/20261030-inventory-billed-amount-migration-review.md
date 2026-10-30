# 품목별 실청구금액 v1 — Migration 적용 전 검토 (2026-10-30)

- 대상 파일: `supabase/migrations/20261030150000_inventory_purchase_billed_amount.sql`, 후속 `supabase/migrations/20261030170000_inventory_create_with_receipt.sql`
- 상태: **로컬 작성·격리 테스트 완료, 운영 미적용.** 운영 SQL 실행·이력 등록·Push·배포 없음.
- 데이터 변경: **없음** (backfill 없음). 기존 `inventory_logs` 13,855행(2026-10-30 조회)은 모두 `billed_amount_mode = NULL` = 자동계산으로 해석되어 장부 금액·스냅샷·fingerprint가 바뀌지 않는다.

## 변경 객체 — 20261030150000

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

권한: 기존과 동일(공개 RPC는 `service_role`만 실행, private 함수·트리거 함수는 전부 revoke). private helper를 호출하는 함수는 모두 `SECURITY DEFINER`(운영 읽기 조회로 확인).

## 적용 안전장치

- 시작 시 운영 본문 md5(줄바꿈 무시) 확인: receipt-edit `aa26ade1…`, update_with_audit `f793ac06…`, inspect `72725a6d…`, economics `ae74601e…`. 2026-10-30 운영 읽기 조회(재확인 포함)와 로컬 fixture가 모두 일치했다.
- 프로젝터·inspect 앵커는 운영 본문에서 각각 정확히 1회 존재함을 읽기 전용으로 확인했다(CRLF·display-sync 패치 포함 본문).
- 재적용·본문 불일치 시 예외로 전체 롤백(부분 적용 없음) — 테스트로 확인.

## 후속 Migration — 20261030170000 신규 품목 원자 등록

- 신규 함수 2개만 추가한다: `public.inventory_create_with_receipt_v1(jsonb,text,date,bigint)`(`service_role` 실행만), `inventory_ledger_private.inventory_name_key_v1(text)`(전부 revoke). 테이블·기존 함수·데이터 변경 없음.
- `POST /api/inventory/items`가 품목·최초 로그(`action/source=create`)·최초 단가 이력·구매입고 장부 반영을 이 RPC 한 번으로 저장한다. 어느 쓰기가 실패해도 전부 롤백되어 품목만 남지 않는다. 구매입고는 numeric(10,2) 반올림 후 수량이 0보다 커야 한다.
- **중복 방지**: 앱의 사전 검사는 유지하고, RPC가 트랜잭션 잠금(`pg_advisory_xact_lock(hashtext('inventory_item_create'))`) 아래에서 같은 정책(같은 코드 + 한국어명 또는 베트남어명 동일, 비활성 포함, 공백·대소문자·성조 무시)을 다시 검사해 `duplicate`를 돌려준다. 실제 PostgreSQL에서 동시 이중 요청·응답 유실 후 재시도 모두 품목 1·입고 1·장부 후보 1로 끝났다(수정 전에는 두 번째 품목·입고·자동 확정 미지급금이 생성됨). 새 품목만 검사하므로 운영의 기존 중복 품목(한국어명 2그룹·베트남어명 1그룹)과 충돌하지 않으며, 전역 UNIQUE 제약은 추가하지 않는다. 정규화 결과는 `lib/inventory/normalize.ts`와 같음을 운영 DB(en_US.UTF-8)에서 읽기 전용으로 확인했다.
- 실청구금액 Migration이 없으면 `INVENTORY_CREATE_REQUIRES_BILLED_AMOUNT_MIGRATION`, 재적용이면 `INVENTORY_CREATE_WITH_RECEIPT_ALREADY_APPLIED`로 아무것도 남기지 않고 중단한다.

## 적용 순서

1. 적용 직전 기준값 기록(읽기 전용): 아래 Postflight 5) 쿼리.
2. 사용자 승인 후 Supabase SQL Editor에서 `20261030150000_inventory_purchase_billed_amount.sql` 실행(단일 트랜잭션).
3. 이어서 `20261030170000_inventory_create_with_receipt.sql` 실행(단일 트랜잭션). 순서가 바뀌면 아무것도 바꾸지 않고 중단된다.
4. GPT 읽기 전용 Postflight(아래) 통과 후 두 신규 Migration 이력만 확인·등록.
5. 그 다음 앱 배포. **앱을 먼저 배포하면 안 된다**: 새 앱은 `billed_amount_mode` 키를 보내 구 RPC가 입고 저장을 거부하고, 신규 품목 등록은 없는 RPC 때문에 실패한다(쓰기는 일어나지 않음). DB를 먼저 적용하면 현재 배포된 앱은 그대로 동작한다(테스트로 확인: 직접 로그 등록·빠른저장·입고 수정·일일 동기화).

## Postflight (GPT, 읽기 전용)

```sql
-- 1) 객체·본문(줄바꿈 무시 md5는 로컬 적용 결과와 같아야 한다)·권한
select p.oid::regprocedure::text as fn, md5(replace(p.prosrc,chr(13),'')) as md5, p.prosecdef as definer,
  has_function_privilege('service_role',p.oid,'execute') as service_role,
  has_function_privilege('authenticated',p.oid,'execute') as authenticated, has_function_privilege('anon',p.oid,'execute') as anon
from pg_proc p where p.oid in (
  'public.inventory_apply_purchase_receipt_edit_v1(bigint,bigint,numeric,jsonb,jsonb,date,bigint)'::regprocedure, -- 87d5c97cf52e735ff81a09e6de3f334e, service_role only
  'public.inventory_update_with_audit_v1(bigint,jsonb,jsonb,date,bigint,text,text,date)'::regprocedure,           -- 19de5bc743adfa590a2ac051dd53f757, service_role only
  'public.inventory_create_with_receipt_v1(jsonb,text,date,bigint)'::regprocedure,                                 -- a5d3399b2fa2223836266c53e0663c17, service_role only
  'inventory_ledger_private.inspect_purchase_repair(bigint,bigint)'::regprocedure,                                 -- a6c499a6baf0aaf7b38916dfdb4d6aa3, none
  'inventory_ledger_private.economics(jsonb)'::regprocedure,                                                       -- eae0756c5e2832383d3efad765e67fd2, none
  'inventory_ledger_private.purchase_billed_amount_v1(bigint,bigint)'::regprocedure,                               -- da2eebc3811e2ff3d1c99fd6a72c92fa, none
  'inventory_ledger_private.inventory_name_key_v1(text)'::regprocedure,                                            -- d6244c4e8230b7037f074cb7d1aeb35e, none
  'public.inventory_purchase_billed_amount_guard_v1()'::regprocedure,                                              -- 32b048bb1e2c460bd7561cc90315d9da, none
  'public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'::regprocedure)                                  -- 본문은 2)로 확인, service_role only
order by 1;

-- 2) 프로젝터: 표지 존재, display-sync 유지, 줄바꿈 형식 유지, 실청구 조회 1회
select position('baba.billed_amount_v1' in d)>0 as marker, position('v_display_sync jsonb' in d)>0 as display_sync,
  position(chr(13) in d)>0 as crlf,
  (length(d)-length(replace(d,'purchase_billed_amount_v1(v_log.id,null)','')))/length('purchase_billed_amount_v1(v_log.id,null)') as billed_lookup_count
from (select pg_get_functiondef('public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'::regprocedure) d) x; -- true, true, true, 1

-- 3) 테이블·제약·트리거
select column_name, data_type, numeric_precision, numeric_scale from information_schema.columns
 where table_schema='public' and table_name='inventory_logs' and column_name like 'billed_amount%' order by 1;  -- 2행: numeric(16,3), text
select conname, convalidated, pg_get_constraintdef(oid) from pg_constraint where conrelid='public.inventory_logs'::regclass and conname like 'inventory_logs_billed_amount%' order by 1;
-- 2행, true. purchase_check 정의는 "billed_amount_mode IS NULL OR reason IS NOT DISTINCT FROM 'purchase'" (reason NULL + 모드 차단)
select tgname, tgenabled from pg_trigger where tgrelid='public.inventory_logs'::regclass and not tgisinternal order by 1;
-- inventory_purchase_correction_guard, inventory_purchase_correction_guard_billed_amount (둘 다 O)

-- 4) 데이터: 소급 변경 없음(적용 직후)
select count(*) filter (where billed_amount_mode is not null) as moded, count(*) filter (where billed_amount is not null) as billed, count(*) as logs from public.inventory_logs; -- 0, 0

-- 5) 장부·재고 기준값: 적용 직전과 직후가 같아야 한다
select (select count(*) from public.ledger_transactions) tx_count, (select sum(amount*economic_effect_sign) from public.ledger_transactions) tx_net,
  (select count(*) from public.ledger_payables) payable_count, (select sum(original_amount) from public.ledger_payables) payable_sum,
  (select count(*) from public.ledger_candidates) candidate_count, (select count(*) from public.ledger_inventory_projection_status) projection_status_count,
  (select count(*) from public.inventory) item_count, (select count(*) from public.inventory_price_logs) price_log_count;

-- 6) 정규화(앱과 동일): nuoc ep nho | da vien | 로쿠 진
select inventory_ledger_private.inventory_name_key_v1(v) from unnest(array['  Nước ép nho ','Đá  viên','로쿠  진 ']) v;

-- 7) private helper 호출자는 모두 SECURITY DEFINER여야 한다
select p.oid::regprocedure, p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','inventory_ledger_private') and p.prokind='f'
   and (p.prosrc ~ 'inspect_purchase_repair\(' or p.prosrc ~ 'purchase_billed_amount_v1\(' or p.prosrc ~ 'inventory_name_key_v1\(')
   and p.proname not in ('inspect_purchase_repair','purchase_billed_amount_v1','inventory_name_key_v1') order by 1;
```

## Rollback

- 스크립트: `docs/reports/20261030-inventory-billed-amount-rollback.sql` (Migration 아님, 승인 시에만 SQL Editor에서 단일 트랜잭션으로 실행). 원본 Migration 파일에서 생성한 적용 전 본문으로 5개 함수를 복원하고, 신규 함수·트리거·helper·제약·컬럼을 제거한다.
- 테스트로 확인: 두 Migration 적용 후 실행하면 함수 본문(md5, LF와 운영형 CRLF+display-sync 모두)·권한·컬럼·트리거가 적용 전과 **동일**하고, 복원된 입고 수정이 정상 동작한다. 미적용 상태·재실행은 아무것도 바꾸지 않고 중단한다.
- **수동 실청구금액이 한 건이라도 생긴 뒤에는 실행을 거부한다**(`BILLED_AMOUNT_ROLLBACK_BLOCKED_MANUAL_AMOUNTS_EXIST`). 그 금액은 이미 장부에 기장되어 있어 컬럼 삭제가 재고와 장부를 어긋나게 하므로, 그때는 후속 Migration으로 수정한다.
- 각 Migration 실행 중 오류는 해당 트랜잭션 전체가 롤백되어 부분 적용이 남지 않는다.
