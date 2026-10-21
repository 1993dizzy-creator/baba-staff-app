# 관리자 확정 영수증 차감 이력 INSERT 보호


?? ?? ??: [???? UPDATE/DELETE?FK ???55P03 ???](pos-resolution-deduction-guard-followup.md). ?? ?? ?? ??? 3? SQL? ????, ?? ?? PostgreSQL 9?? ????. ?? ?? ?? ??? ?? ?? ??? ????? NO-GO? ????.

2026-10-21. 로컬 수정·격리 PostgreSQL 검증 문서. 운영 미적용, 전체 운영 함수 원문 대조 미완료.

사용자 운영 SELECT 결과(차감 1,717건, 세 연결 컬럼 NULL 기록 0건, 컬럼 자체는 nullable, 사용자 trigger는 updated_at 갱신)를 참고했다. 이번 작업에서 운영 SELECT·DDL·DML·migration 적용·Git·배포·8건 복구는 실행하지 않았다. 네 기능 플래그는 기본 OFF를 유지했다.

## INSERT 경로 조사

| 경로 | 실제 쓰기 위치 | 연결/보호 |
| --- | --- | --- |
| 초기 preview/batch 후보 저장 | `lib/sales/inventory-deduction-batches.ts:215` | receipt_id, invoice_ref_id, batch_id, batch_receipt_id 포함 |
| 수정 영수증 reprocess 후보 저장 | `lib/sales/inventory-deduction-reprocess.ts:316` | 동일한 배치·영수증 연결 포함 |
| 재처리 보상 역분개 | `202607180005_fix_reprocess_modified_sales_inventory_deduction.sql:684` | 기존 원차감 연결을 복사하고 reversal_of_deduction_id 포함 |
| 취소 원복 보상 역분개 | `202607130001_complete_sales_receipt_inventory_deduction_lifecycle.sql:293` | 기존 원차감/영수증 연결 포함 |
| 관리자 전용 재고 승인 | `20261021081604_pos_resolution_corrections_inventory_review.sql:498` | 비공개 transaction inventory capability 안에서 후보 INSERT 후 기존 엔진 호출 |
| 구 재처리 정의 | `202607100002_reprocess_modified_sales_inventory_deduction.sql` | 07-18 hotfix로 대체된 과거 정의. 현재 함수 원문은 별도 검증 대상 |
| 초기 apply 엔진 | `apply_sales_inventory_deduction_batch` | 후보를 읽어 적용하고 상태/재고/로그를 갱신. 후보 INSERT는 위 batch 저장 경로 |
| CukCuk sync/refresh/재조회 큐 | `lib/pos/cukcuk/sales-receipt-sync.ts` 등 | 영수증·품목·결제와 재고 자격을 갱신하며 차감 후보 INSERT는 하지 않음 |
| 케그 교체 | `replace_inventory_keg`, `inventory_apply_keg_change` | inventory_logs와 keg session에 기록. pos_inventory_deductions INSERT 없음 |
| 직접 SQL/PostgREST/향후 RPC | 차감 테이블 자체 | 신규 BEFORE trigger가 공통 보안 경계. 앱 경로 사용을 가정하지 않음 |

app/lib/scripts/supabase의 TS/TSX/JS/MJS/CJS/SQL을 조사했다. 배치 조회·매핑/품목 삭제 API는 위 표의 후보 INSERT 경로와 구분했다. 운영에만 존재하는 추가 writer/함수는 전체 원문 및 ACL 대조가 미완료이므로 조사 완료로 간주하지 않는다.

## 수정 SQL과 잠금

후속 additive 파일: `supabase/migrations/20261021133856_pos_resolution_deduction_insert_guard.sql`. CLI의 로컬 `migration new`로 빈 파일만 생성한 후 작성했다. 1·2차 SQL과 기존 diff는 그대로 보존했다. 새 테이블·컬럼·데이터 백필·원본 변경은 없다. 명시적 BEGIN/COMMIT과 local timeout을 사용한다. 반복 실행은 기존 객체 충돌로 전체 롤백한다.

private 함수 3개(`deduction_links`, `deduction_receipt_ids`, `deduction_write_guard`)와 `pos_admin_resolution_deduction_write_guard` trigger를 추가한다. PUBLIC/anon/authenticated/service_role에 private 함수 직접 EXECUTE를 허용하지 않는다. trigger는 고정 search_path의 SECURITY DEFINER로 실행한다. 실제 stock/public 수정/마감/케그 RPC 정의는 바꾸지 않는다.

1. receipt_id, 정규화한 invoice_ref_id, batch receipt, receipt line, 원차감 reversal chain으로 연결 가능한 영수증의 합집합을 구한다. 한 식별자가 다른 보호 영수증을 가리지 못한다. batch receipt가 없거나 batch와 불일치하면 batch 전체 대상도 검사한다. 정확한 ref_no+business_date는 다른 직접 연결이 없는 경우에만 보조로 사용하고, 번호 접미사나 날짜 없는 번호로 추정하지 않는다.
2. 연결을 전혀 해석할 수 없는 신규 행은 LINK_REQUIRED로 거부한다. 기존 행을 자동 보정하거나 receipt_id를 채우지 않는다. INSERT 후 연결을 바꾸거나 지우는 UPDATE는 OLD와 NEW를 모두 검사하며 NEW의 연결도 필수다.
3. 알려진 FK 부모(batch, inventory, line)와 간접 provenance 행(batch receipt, reversal 원차감)을 NOWAIT로 먼저 보호한다. receipt에는 KEY SHARE NOWAIT를 취득한다. 이후 식별 결과를 다시 읽어 변경됐다면 거부한다. FK 검사가 나중에 batch 잠금을 기다리면서 receipt 잠금을 유지하는 순환도 방지한다.
4. 이미 관리자 확정된 대상은 해당 receipt의 현재 txid에 속한 `work_capabilities.purpose='inventory'`가 있어야만 허용한다. username·body role·GUC 값은 근거가 아니다. 현재 정상 preview 경로가 batch ID를 모두 채우더라도 보호된 영수증은 전용 승인 RPC로만 처리한다.
5. 이미 승인이 receipt/stock/관련 배치를 잠갔다면 INSERT는 55P03으로 즉시 실패한다. INSERT가 먼저 부모 KEY SHARE를 취득했다면 최초 판정의 FOR UPDATE가 INSERT 트랜잭션 종료를 기다린다. 이후 최초 판정은 새 이력을 포함한 상태에서 재고 보류를 유지한다. guard에서 역순 대기하지 않는다.

운영의 FK·추가 트리거 전체 대조는 적용 전 조건이다. 알려진 FK와 정상 엔진 잠금 순서를 격리 DB에서 검증했으나 운영에만 있는 다른 FK/trigger의 잠금까지 검증했다고 주장하지 않는다.

## 실제 PostgreSQL 증거

신규 전용 테스트 `tests/pos-resolution-deduction-guard-postgres.test.mjs` 실행: **하위 11개 + 부모 1개 = 12건 통과, 실패/skip 0**. 기존 292건 전체는 반복하지 않았다.

- receipt/batch 누락과 invoice-only, 대소문자/공백, batch-only, line-only, reversal-only, ref_no+date, 다른 receipt_id로 가린 invoice/batch 등 10가지 연결 조합을 거부했다.
- INSERT SELECT / ON CONFLICT / 식별자 UPDATE 우회, 해석 불가능한 연결, 정상 첫 행+보호 둘째 행의 multirow INSERT를 검사했다. 실패 후 첫 행·재고·로그가 남지 않았다.
- INSERT 권한을 가진 격리 service_role과 위조 GUC도 private capability를 만들거나 보호 INSERT를 실행하지 못했다. 운영 권한 자체를 검증한 것은 아니다.
- 승인 context 검증 뒤 엔진 실행 직전에 멈춰 기존 NULL 배치 INSERT counterexample을 재실행했다. receipt-only와 invoice-only INSERT 모두 55P03으로 거부됐다. 동시에 같은 requestId의 두 승인도 결과 하나·차감 하나·로그 하나로 끝났다.
- stock-first 역순 잠금 5회: INSERT가 NOWAIT로 거부돼 stock 잠금을 해제하고 승인은 완료됐다. 데드락 0. 별도 legacy batch-FK 부모 잠금도 즉시 거부돼 batch↔receipt 순환을 만들지 않았다.
- INSERT-first와 최초 관리자 판정을 경합시켜 부모 잠금의 직렬화를 확인했다. 판정 후 재고 보류 true, 재고 변화 0, 후속 비승인 INSERT 거부였다.
- 기존 실제 initial→수량 정정→reprocess→환불 취소→rollback 엔진의 INSERT/역분개가 성공하고 재고는 원수량으로 복귀했다. 같은 승인 재시도는 no-op이었다.
- 엔진 INSERT 뒤 감사 단계에 오류를 주입해 stock/차감/배치/로그/보류/감사 전체 롤백과 동일 requestId 재시도 성공을 확인했다.
- 보호되지 않은 영수증의 initial/기존 수정/reprocess/일마감/rollback 결과가 guard 전후 동일했고 실제 케그 교체도 성공했다.
- migration 마지막 단계 실패·재실행에 대해 부분 객체/기존 데이터 변경이 없고 기존 public 함수 원문이 동일함을 확인했다.

로그/지연 수치: `.qa-review/pos-resolution/insert-guard/postgres.log`, `guard-evidence.json`, `final-summary.json`. 재현 명령: `node --experimental-strip-types --test tests/pos-resolution-deduction-guard-postgres.test.mjs`. 격리 PostgreSQL 도구가 필요하다.

## 범위·잔여 위험·운영 순서

로컬 수정본에서는 확인된 NULL 배치/누락 receipt 이력 INSERT 공백을 차단했다. 운영에는 아직 적용하지 않았으므로 운영 보호가 바뀐 것은 아니다. 제3 migration은 앱 플래그와 무관하게 항상 동작한다. 정상적으로 연결된 비보호 경로의 업무 결과는 보존하지만, 불명확한 연결은 새로 거부하고 바쁜 부모는 대기 대신 55P03을 반환한다. 호출자는 최신 상태를 재조회해 재시도해야 하며 guard를 끄거나 강제 승인하면 안 된다. 정상 대량 후보 저장의 운영 규모 지연과 운영의 모든 trigger/FK/함수 대조는 미검증이다.

`docs/pos-resolution-deduction-guard-preflight.sql`은 SELECT-only이며 운영에서 실행하지 않았다. 사용자 확인의 1,717건/NULL 0건은 참고값이며 전체 schema 검증을 대신하지 않는다. 운영 함수 원문 전체 대조는 계속 별도 미완료다. 적용 가능 판정은 아직 NO-GO다.

향후 별도 승인 후 실제 FK/trigger/권한/함수 계약과 영향 경로 확인 → 사용자 SQL Editor에서 1차→2차→본 후속 SQL 순서로 수동 실행 → 정의/trigger/ACL·기존 차감/재고/로그 행 수/원본 hash 검증 → 별도 배포·활성화 승인 순서를 따른다. 이전 파일은 이미 설치됐으면 재실행하지 않는다. 롤백은 쓰기/재조회 OFF와 보류 유지가 우선이며, 보호 trigger를 임의 제거하거나 과거 이력을 지우지 않는다.
