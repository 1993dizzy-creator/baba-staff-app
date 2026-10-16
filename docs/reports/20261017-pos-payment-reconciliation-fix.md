# POS 결제 스냅샷 대조 수정 및 검증 — 2026-10-17

상태: 로컬 구현·격리 검증 완료. 운영 적용·복구·마감·배포·commit/push는 실행하지 않았다.
최초 조사 당시 운영 SELECT는 차단됐으나, 후속으로 사용자가 운영 DB 교차검증에서 핵심 교체 로직·함수 권한·인덱스 호환성이 정상임을 확인했다. 아래 추가 안전장치에는 그 운영 함수 정의 MD5를 고정했다.

> 최신 실행기·트랜잭션 검증: [Migration 실행기 최종 보고서](20261017-pos-payment-migration-runner-verification.md). 파일 내부 BEGIN/COMMIT은 제거했고 Supabase CLI 2.81.3이 SQL과 Migration 이력을 함께 원자적으로 기록한다.

## 결함과 수정 결정

외부 결제 ID로 기존 행을 찾으면서, 결제수단 복합 UNIQUE 키와 충돌하는 기존 행은 INSERT 이후 삭제하던 순서가 결함이다. 따라서 정상적인 POS 결제 정정으로 외부 ID가 변경되면 동일 VISA 행이 남아 INSERT가 실패한다. 날짜 전체 결제가 단일 RPC에 묶여 있어 이후 19건의 결제 반영도 롤백됐다. 영수증/상품 저장은 앞선 별도 요청이므로 그대로 남을 수 있다.

새 함수는 btrim 정규화된 영수증 RefID 정렬 → 기존 receipt FOR UPDATE → 관리자 수정 보호 → 결제 스냅샷 전체 검증 → 유지/교체 계획 계산 → 선택적 DELETE → UPDATE/INSERT 순서다. RPC 시그니처와 반환 카운트 계약은 유지한다.

- 외부 ID와 결제수단 복합 키가 유지되면 기존 행 ID를 보존하며 UPDATE한다. 금액과 card_id가 바뀌어도 외부 ID로 식별되는 경우 이 경로를 사용한다.
- 외부 ID가 새로 생기거나 바뀌면, 완전한 스냅샷에서 제외된 기존 행을 교체 대상으로 판단한다. 단순히 VISA라는 이유로 기존 ID를 덮어쓰지 않는다.
- 동일 외부 ID라도 수단 복합 키가 바뀌면 교체 대상으로 계획한다. 두 결제의 수단 키가 서로 바뀌어도 기존 UNIQUE 인덱스를 유지하면서 안전하게 처리한다.
- 유지 대상 ID를 먼저 확정하고 그 밖의 stale/교체 행만 삭제한다. 매번 모든 행을 삭제하고 재생성하지 않는다. 변경 없는 분할결제의 행 ID도 보존한다.
- 결제완료·미취소 영수증은 스냅샷 합계가 잠근 영수증의 final_amount와 일치해야 한다. 불일치·누락·음수·타입 오류·RefID 모순은 쓰기 전에 거부한다.
- 새 ID가 누락됐는데 기존의 식별된 결제가 스냅샷에서 사라지는 경우는 `payment_external_id_missing`으로 차단한다. 임의로 다른 결제에 연결하지 않는다.
- 양쪽 ID가 없는 경우 기존 수단 fallback을 유지한다. 단, 양쪽에 서로 다른 card_id가 있으면 모호하므로 차단한다.
- 같은 외부 ID 중복, 같은 수단 조합 중복, 기존 데이터의 외부 ID 중복은 차단한다. 동일 수단 다중결제를 지원하도록 인덱스를 완화하지 않았다.
- 자동 동기화 대상에 수동 결제 source가 섞여 있으면 별도로 차단한다. is_modified=true 영수증은 기존처럼 잠금 이후 건너뛴다.

수단이 바뀌는 행까지 무조건 UPDATE하는 방식은 키 교환 시 중간 상태에서 UNIQUE 충돌을 만들 수 있다. 반대로 전체 재생성은 정상 행 ID도 바꾼다. 따라서 안정된 행은 UPDATE하고 검증된 교체 행만 먼저 삭제하는 방식이 가장 작은 안전한 변경이다.

## 수정 파일

| 파일 | 변경 |
|---|---|
| `supabase/migrations/20261016170140_fix_pos_payment_snapshot_replacement.sql` | 후속 Migration: 기존 RPC 교체, 검증·계획·선택적 삭제 및 진단 |
| `lib/pos/cukcuk/payment-snapshot.ts` | 잘못된 배열 원소·금액·타입·ID 별칭 및 모순된 결제 배열 별칭을 unavailable 처리 |
| `lib/pos/cukcuk/sales-receipt-sync.ts` | 실행 ID 전달 지원, RPC 오류의 허용된 진단 필드만 노출 |
| `app/api/pos/cukcuk/sainvoices/sync-to-sales/route.ts` | 실행 ID 연결, 누락 스냅샷 진단 보강, 불완전 결과 partial 표시 |
| `tests/helpers/pos-payment-reconciliation-fixture.mjs` | 운영 인증정보를 읽지 않는 격리 DB fixture와 UNIQUE 인덱스 |
| `tests/pos-payment-reconciliation-postgres.test.mjs` | 실제 PostgreSQL 회귀·동시성·복구 모형 |
| `tests/sales-payment-snapshot-reconciliation.test.ts` | 최신 Migration 계약 및 잘못된 입력 검사 |
| `tests/pos-sales-sync-payment-completeness.test.mjs` | 실제 route/savePayments의 실패 상태·진단·개인정보 비노출·마감 차단 계약 |
| 이 보고서 | 적용·복구·롤백 절차와 검증 한계 |

기존 적용 Migration은 수정하지 않았다. 원본 `202609030001_reconcile_sales_receipt_payments.sql` SHA256:
`4d999ce52a2910bbd6adf889eb8dd356aa2e3024e2b7eacaceafe0d026201a96`.
신규 파일은 로컬 Supabase CLI의 `migration new fix_pos_payment_snapshot_replacement`로 생성했다. 파일명의 UTC 날짜는 생성 당시 2026-10-16이며, 현지 보고일은 2026-10-17이다.

## 호환성과 보안

변경 대상은 `public.reconcile_sales_receipt_payments_v1(p_snapshots jsonb) returns jsonb` 하나다. CREATE OR REPLACE로 교체하며 owner=postgres, SECURITY INVOKER, search_path=pg_catalog,public, service_role/postgres 실행 권한, PUBLIC/anon/authenticated 실행 금지를 유지한다. 테이블·인덱스·마감 함수·장부 함수·RLS 정책을 변경하는 DDL은 없다. Migration 자체의 데이터 backfill도 없다.

기존 RefID 검증, 영수증 정렬과 receipt lock, 날짜별 동기화 실행 잠금, 관리자 수정 보호, 마감 source_complete 판정은 유지했다. 실패는 RPC 전체를 롤백시키고 sync_run을 failed/source_complete=false로 남긴다. unavailable 응답은 결제 RPC에 전달하지 않고 기존 결제를 보존하며 source_complete=false, partial=true로 표시한다.

진단은 영업일, 영수증 RefID/번호, failureType, identityEvent, UNIQUE 충돌 여부, SQLSTATE, syncRunId를 포함한다. DB의 실패 행 DETAIL, 원본 payload, 고객·카드/계좌 상세·인증정보는 서버 오류에 그대로 전달하지 않는다. 구버전 함수의 비JSON DETAIL도 폐기한다.

운영 정의 대조의 한계: `pg_get_functiondef` 및 `pg_indexes`를 조회하는 SELECT를 요청했으나 MCP가 `MCP tool call requires approval, but approval policy is never`로 차단했다. 따라서 사용자 제공 운영 확인 내용과 기존 로컬 Migration에 대한 호환성은 검증했지만, 이번 실행에서 Production 본문·인덱스·FK/trigger를 독립적으로 재확인했다고 주장하지 않는다. 적용 전 이 검증은 필수다.

격리 인덱스는 `(source, receipt_ref_id, coalesce(payment_type,-1), coalesce(payment_name,''), coalesce(card_name,''))`의 실제 UNIQUE 인덱스다. 단순 JS 모킹으로 UNIQUE 동작을 대체하지 않았다. 운영 인덱스의 정확한 DDL과는 적용 전에 대조해야 한다.

## 검증 결과

- Windows 네이티브 PostgreSQL 17.6을 새 디렉터리·임의 포트·127.0.0.1에서 실행했다. 기존 클러스터, `.env.local`, 운영 DB URL/자격증명을 테스트에 사용하지 않았다. 종료 시 소유한 클러스터를 정지했다.
- 기존 함수에서 사고 입력의 PostgreSQL `23505` 오류를 재현했다. 동일 DB에 후속 Migration 적용 후 2,074,200₫ 1건으로 정상 교체되고, 같은 입력 반복 시 데이터·행 ID·시각·카운트가 불변이다.
- ID 유지/변경, 금액 변경, 카드 ID 변경, legacy ID 전환, ID 소실 차단, 외부 ID/수단 중복, 수단 키 교환, 분할결제 보존을 검증했다.
- 현금/계좌이체/VISA의 양방향 6가지 전환을 검증했다.
- 의도적으로 잘못된 뒤쪽 영수증 또는 뒤쪽 결제 INSERT를 실패시켜 앞선 UPDATE/DELETE/INSERT까지 롤백됨을 확인했다.
- 두 세션이 실제 receipt lock에서 대기하는 것을 pg_blocking_pids로 확인했다. 동일 스냅샷 동시 실행 멱등성, 역순 입력에서도 같은 정렬 잠금 순서, 동시 관리자 수정 후 is_modified 재확인을 검증했다.
- 관리자 수정·수동 결제·수정 이력 및 관련 없는 이전 영업일·월마감 sentinel, 장부·카드정산 sentinel이 바뀌지 않음을 확인했다.
- 10/14 `2601006894`의 정상 VISA ID 유지 UPDATE와 다른 영수증 보존을 포함했다. 당시 응답 이력을 새로 확보한 것은 아니며 알려진 정상 패턴의 회귀 fixture다.
- 기존 source/마감 회귀검사로 금액 불일치·누락·취소·미완료·알 수 없는 결제 bucket에 대한 차단이 유지됨을 검증했다.

검증 실행 요약:

| 항목 | 결과 |
|---|---|
| 네이티브 PostgreSQL 최종 검사 | 46개 시나리오 + 상위 1개, 총 47/47 통과; skip 0 |
| 실제 Supabase CLI 실행기 검사 | 5개 시나리오 + 상위 1개, 총 6/6 통과 |
| 스냅샷 단위·계약 | 26/26 통과 |
| 동기화·진단·마감 전달 계약 | 28/28 통과 |
| 나머지 매출·수동 수정·분할결제·장부·마감 회귀 | 100/100 통과 |
| 변경 TS/MJS 8개 파일 ESLint | 오류·경고 0 |
| 전체 `tsc --noEmit --incremental false` | 기존 테스트 오류 40개; 수정 전/후 동일, 신규 오류 0 |
| Next.js Production build | 성공: 컴파일·빌드 TypeScript·72개 정적 페이지 생성 완료 |
| `git diff --check` | 통과 |

후속 안전장치 포함 최종 전체 묶음 207/207건이 통과했고 실패·skip은 0건이다. 네이티브 검사 47건 및 실제 CLI 검사 6건도 이 실행에 포함된다. build 설정이나 TypeScript 설정을 바꿔 오류를 우회하지 않았다.

기존 TypeScript 오류는 `.ts` import 확장자(TS5097), 기존 ledger 테스트 타입 불일치 및 possibly undefined 등이다. TypeScript Compiler API로 같은 설정에서 변경 전 tracked 파일을 `git show HEAD:<path>`로 메모리 공급해 비교했다. baseline 40, current 40, introduced 0이다. 관련 없는 기존 오류를 이번 변경에 섞어 수정하지 않았다.

검증 로그는 Git 제외 경로 `.tmp/pos-payment-regression.log`, `.tmp/pos-payment-native-final.log`, `.tmp/pos-payment-eslint.log`, `.tmp/pos-payment-typescript.json`, `.tmp/pos-payment-build.log`에 있다.

재실행 예시(PowerShell):

```powershell
# 설치된 로컬 PostgreSQL 17+ bin 경로 지정. 운영 URL은 설정하지 않는다.
$env:QA_POSTGRES_BIN = 'C:/path/to/local/postgresql/bin'
node --experimental-strip-types --test tests/pos-payment-reconciliation-postgres.test.mjs
node --experimental-strip-types --test tests/sales-payment-snapshot-reconciliation.test.ts tests/pos-sales-sync-payment-completeness.test.mjs tests/pos-sales-sync-completeness.test.ts tests/sales-receipt-financials.test.ts tests/sales-receipt-financial-migration-static.test.ts tests/sales-receipt-split-payment.test.ts tests/sales-receipt-split-payment-db.test.mjs tests/ledger-pos-sales.test.ts tests/pos-business-day-close-db.test.mjs tests/pos-business-day-close-service.test.mjs tests/pos-canceled-payment-close-db.test.mjs tests/pos-business-day-close-view.test.mjs
```

## 10월 15일 복구 사전검증

격리 DB에 제공된 장애 구조를 모형화했다. 32건 중 13건에 결제 행이 있고, 그중 관리자 수정 3건은 수동 결제·수정 이력을 가진다. 대상 VISA는 1,900,000₫, 나머지 19건은 결제 행이 없는 상태다.

새 RPC 적용 후 대상 VISA 2,074,200₫, 누락 19건 반영, 관리자 수정 3건의 행·이력 완전 보존, 총 32개 결제 행/34,646,700₫ 일치, 반복 적용 불변을 확인했다. 기존 실제 `buildPosBusinessDaySource`도 영수증별 정합성과 bucket 합계를 통과했다. 영수증·상품·장부·정산 sentinel은 바뀌지 않았다.

이것은 합성 fixture의 절차 검증이다. 운영 복구, 최신 CUKCUK 조회 또는 실제 운영 마감 가능성의 확정이 아니다. 일부 기존 영수증 데이터는 합성했다. 알려진 합계에 맞추기 위해 운영 데이터를 강제 보정해서는 안 된다.

## 운영 적용 순서 — 별도 승인 후에만

1. 운영 함수 본문/owner/인자/proacl/search_path, 전체 결제 UNIQUE 인덱스, 결제 테이블 FK/DELETE trigger, Migration 이력을 SELECT로 확보·대조한다. 예상과 다르면 적용을 중단한다. 원격/로컬 Migration 버전 차이가 있으면 원인 확인 전 `db push`하지 않는다.
2. 기존 함수·권한 정의 및 복구 대상 결제의 안전한 백업/기준값을 접근 제한 위치에 확보한다. 개인정보/원본 전체를 공개 로그·Git·이 보고서에 넣지 않는다. 현재 마감/월마감/카드정산 상태와 대상 영수증 수·취소 수·관리자 수정 3건의 행/이력을 기록한다.
3. 신규 Migration의 대상은 위 RPC 1개이며, 테이블/인덱스 변경·backfill 없음이라고 사전 보고한 뒤 Migration 적용 승인을 받는다. 이 작업에서는 적용하지 않았다.
4. 검토된 후속 Migration만 관리된 경로로 적용하고 Migration history·함수 정의/인자·owner·PUBLIC/anon/authenticated/service_role 권한·보안/성능 Advisor를 재확인한다. SQL Editor 수동 실행은 history가 자동 등록되지 않으므로 별도 관리한다.
5. 수정 앱을 별도 배포 승인 후 배포한다. 함수 시그니처는 기존 앱과 호환되므로 Migration 먼저 적용할 수 있다. 새 앱은 구버전 함수 오류도 개인정보 없이 실패 처리한다.
6. 이후 10월 15일 복구를 위한 별도 실행 승인을 받는다. Migration 적용 승인과 데이터 복구/마감 승인을 혼동하지 않는다.

운영 preflight에 필요한 SELECT 예시:

```sql
select pg_get_functiondef(p.oid), pg_get_userbyid(p.proowner) as owner,
       pg_get_function_identity_arguments(p.oid) as arguments,
       p.prosecdef, p.proconfig, p.proacl
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname='reconcile_sales_receipt_payments_v1';

select indexname,indexdef from pg_indexes
where schemaname='public' and tablename='pos_sales_receipt_payments';

select conname,contype,pg_get_constraintdef(oid)
from pg_constraint
where conrelid='public.pos_sales_receipt_payments'::regclass
   or confrelid='public.pos_sales_receipt_payments'::regclass;

select tgname,pg_get_triggerdef(oid) from pg_trigger
where tgrelid='public.pos_sales_receipt_payments'::regclass and not tgisinternal;
```

## 운영 복구·마감 절차 — 이번에는 실행하지 않음

1. 최신 CUKCUK 상세를 기존 조회 모듈로 읽고 실제 RefID, 결제 배열 가용성, ID/카드/수단/금액/건수/ModifiedDate를 재확인한다. 인증이 필요하면 별도 허용 범위를 따른다. 현재 응답을 과거 응답이라고 취급하지 않는다.
2. 현재 DB와 최신 원본으로 영수증별 dry-run 비교표를 만든다. 관리자 수정 3건은 POS 원본과 달라도 덮어쓰지 않는다. 결제 ID 소실/중복/동일 수단 복수/금액 불일치가 있으면 강제 보정 없이 중단한다.
3. 대상 1건과 `2601006922`~`2601006940`의 예상 변경 행 수·금액·보존 행을 보고하고, 복구 범위와 rollback 방법에 대한 명시적 승인을 받는다.
4. 승인된 10월 15일 범위만 통제된 방식으로 동기화한다. 이미 정상 마감된 다른 영업일 전체를 재동기화하지 않는다. 동시에 수동 refresh/자동 작업이 경합하지 않도록 운영 순서를 관리한다.
5. 대상 1건의 최신 원본 금액(현재 알려진 값 2,074,200₫), 19건 결제 존재, 관리자 3건 보존을 확인한다. 영수증 수·취소 수, 상품 행, 원본/수정 이력의 예상 외 변화가 없어야 한다.
6. 영수증별 최종금액과 유효 결제 합계 및 bucket 합계를 검증한다. 34,646,700₫는 기준값이지 강제 목표가 아니다. 최신 원본이 다르면 차이의 근거를 먼저 검토한다.
7. source_complete=true와 최신 동기화 실행 상태를 확인하고, 장부 transaction/카드정산/감사 로그 중복이 없는지 대조한다. 실제 마감은 별도 승인 후 기존 마감 경로로 실행한다. 이미 존재하는 마감 revision이 발견되면 자동 재마감하지 않는다.
8. 마감 후 snapshot/fingerprint/합계, 카드정산 잔액과 중복 여부를 다시 확인한다. 동일 복구를 반복해도 데이터 변화가 없어야 한다.

## 롤백과 남은 위험

- 로컬 변경은 아직 미적용이다. 운영에 복구할 변경은 없다.
- 운영 적용 이후 문제가 생기면 먼저 자동/수동 결제 동기화를 통제하고 실패 상태를 유지한다. 오류를 정상 성공으로 숨기거나 마감 차단을 해제하지 않는다.
- 별도 승인 후 사전에 저장한 기존 함수 정의와 권한으로 되돌릴 수 있다. 기존 적용 Migration 파일을 수정·삭제하거나 원격 history를 임의 repair하지 않는다. 되돌림도 후속 변경으로 기록한다. 기존 함수 복원 DDL의 트랜잭션 롤백은 격리 DB에서 검증했다.
- 앱은 이전 배포로 되돌릴 수 있다. 함수 롤백은 원래의 ID 변경 결함을 재도입하므로 안전한 동기화 중단이 우선이다.
- 복구된 정상 결제를 자동으로 예전 금액/ID로 되돌리지 않는다. 데이터 복구 후 rollback은 백업과 최신 원본을 비교해 승인된 대상 행만 처리해야 한다. 마감·장부·카드정산이 진행됐다면 일반 DELETE로 역전하지 말고 기존 재마감/취소·보정 절차를 별도 승인받는다.
- 동일 수단 조합 다중결제는 여전히 명확히 거부한다. 별도 식별체계/인덱스/조회 정책 재설계가 필요하다.
- receipt/line 저장과 결제 RPC의 전체 일괄 원자화는 이번 범위에서 바꾸지 않았다. 결제 실패 시 영수증/상품은 먼저 저장돼 있을 수 있으며 source_complete/마감 검증으로 차단한다.
- 서로 다른 시점에 조회한 유효 POS 응답의 역사적 선후를 판정하는 버전 정책은 추가하지 않았다. 기존 날짜별 실행 잠금과 DB receipt lock은 유지했고 같은 스냅샷의 동시 실행을 검증했다. 서로 다른 시점의 응답 경합까지 원본 버전 순으로 해결한다고 주장하지 않는다.
- 운영 FK/trigger 및 정확한 인덱스 DDL 재대조가 끝나기 전에는 배포 승인 가능 상태로 간주하지 않는다. 이 보고서는 운영 적용을 실행하거나 승인한 것이 아니다.


## 후속 안전장치 보완 — 운영 적용 전 검토 반영

추가 변경 범위는 미적용 신규 Migration과 그 테스트/이 보고서다. 결제 교체 알고리즘, 수단 UNIQUE 정책, 관리자 보호와 RPC 반환 계약은 변경하지 않았다.

1. receiptRefId 중복은 처리 시 사용하는 것과 같은 `nullif(btrim(...), '')`로 정규화한 뒤 판정한다. 같은 ID의 앞뒤 공백만 다른 두 스냅샷을 전달하면 `duplicate_payment_snapshot_receipt` / SQLSTATE 22023으로 전체를 거부한다. 기존 결제와 보호 대상 테이블이 그대로 유지되는 것을 실제 PostgreSQL에서 검증했다.
2. Migration 시작 시 `md5(pg_get_functiondef(to_regprocedure('public.reconcile_sales_receipt_payments_v1(jsonb)')))`를 검사한다. 운영에서 교차검증된 기대값은 `e6f024dfeda8366453100e60bb023670`이며, Migration에 상수로 고정했다. 환경변수·설정 등으로 우회하지 않는다.
3. 해시 불일치 또는 함수 부재는 `pos_payment_reconciliation_definition_mismatch` / SQLSTATE 55000으로 중단한다. 최종 검토에서 파일 내부 BEGIN/COMMIT은 제거했다. Supabase CLI 2.81.3의 트랜잭션 배치가 사전검사·함수 교체·권한 설정·Migration 이력 INSERT를 함께 원자적으로 처리하며, 실패 시 기존 함수·ACL·인덱스·데이터·이력이 보존됨을 실제 CLI로 검증했다.
4. 성공 후 파일 SQL 자체를 직접 재실행하면 정의가 바뀌어 사전검사에서 거부한다. 정상 CLI 재실행은 이미 기록된 이력을 보고 이 파일을 건너뛰며 변경이 없다. Migration 적용 멱등성을 위해 검사값을 바꾸거나 없애서는 안 된다. 결제 RPC의 동일 스냅샷 반복 동기화 멱등성과는 별개의 정책이다.

해시 검증의 테스트 범위:

- 원본 로컬 과거 Migration으로 격리 DB에 만든 함수의 MD5는 `603f09fdec509f4d48331774899274e5`이다. 이 바이트 정의는 운영에서 검토된 정의와 다르므로, 운영용 신규 Migration을 그대로 실행하면 거부되는 것이 올바르다.
- 운영용 파일을 수정 없이 실행해 그 불일치 거부와 함수 본문/owner/ACL/search_path/인덱스/데이터 보존을 확인했다.
- 성공 경로와 기존 결제 회귀는 테스트 fixture에서만 기대 해시를 해당 격리 DB의 초기 기준 MD5로 치환한 SQL로 실행한다. 이 값은 fixture 생성 시 한 번 캡처하며 변경된 본문을 다시 승인하지 않는다. 수정/배포용 Migration의 운영 기대 MD5는 바꾸지 않았다.
- 기준 해시가 맞으면 적용이 성공하고, 기존 본문에 주석만 추가해도 실패하며, 원래 정의를 복구하면 성공함을 실제 PostgreSQL에서 확인했다. 함수 부재, 적용 후 재실행 거부 및 분리된 후속 DDL의 트랜잭션 중단도 검증했다.
- 실제 운영 MD5에 대한 일치 확인은 사용자의 운영 교차검증 결과를 근거로 한다. 이번 작업에서 운영 DB에 접속하거나 Migration을 적용한 것은 아니다.

후속 최종 로그: `.tmp/pos-payment-runner-final.log`. 실제 CLI 이력 원자성 검사와 공백 ID 잠금 검사를 추가했고, 변경 테스트 파일 ESLint와 `git diff --check`도 재검증했다. 앱 TS 소스는 이번 보완에서 바뀌지 않아 앞서 완료한 Production build·TypeScript 기준 비교를 재실행하지 않았다.

운영 적용 전에는 동일 기대 MD5로 읽기 전용 대조를 한 번 더 수행하고, 실제 적용 시 Migration 내부 사전검사를 그대로 유지한다. 불일치 시 중단한 뒤 정의를 재검토한다. 기존 복구·마감 별도 승인 및 롤백 절차는 그대로 적용한다. 이번 보완에서도 Production 적용·동기화·복구·마감·배포·commit/push는 수행하지 않았다.

