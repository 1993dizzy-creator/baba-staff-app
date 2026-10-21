> **상태: 폐기(superseded), 2026-10-22.** 2026-10-21 개발한 POS 결제예정 관리자 복구 V1·V2의 개발 기록입니다. 현재 운영 기능이 아니며, 코드와 DB에서 제거하기로 결정했습니다. 제거 이유와 현재 상태는 [V1·V2 제거 보고서](reports/20261022-pos-admin-resolution-v1-v2-retirement.md)를 기준으로 합니다. 아래 본문은 과거 기록으로만 보존합니다(일부 문서는 작성 당시 인코딩 손상으로 한글이 `?`로 남아 있습니다).

# 결제예정 관리자 확정: 로컬 개발 설계 및 적용 전 점검

2026-10-22 ??: [?? ???? ?? POS ??? ??](pos-pending-auto-recheck-removal.md). 4? ?? ??? ???? ?? ???? ????. ?? POS ?????? ????? 5? sync???/?????/??/?? ??? ????. ?? ?? ?? ??? ?? ??? ??? ?? ? ????.

?? ?? ??: [?? ?? ??? ?? ? Migration GO](pos-resolution-operating-contract-final.md). ??? ?? ?? ??? processed_line_id ?? ? ??? ?? PostgreSQL ???? ??? ?? ??? ?? NO-GO? ????. ?? ???? ?? ?? ???? OFF? ????.

?? ?? ??: [?? ?? ????? ?? ?? ?? ??](pos-resolution-final-deployment-review.md). ?? ??? PASS??, ?? NO-GO ??? ??? ??? ???? ?? ?? 4?? ?? ??? ?? ????? ????. ???? ?? ???Migration? ???? ???.


?? ?? ??: [???? UPDATE/DELETE?FK ???55P03 ???](pos-resolution-deduction-guard-followup.md). ?? ?? ?? ??? 3? SQL? ????, ?? ?? PostgreSQL 9?? ????. ?? ?? ?? ??? ?? ?? ??? ????? NO-GO? ????.

2026-10-21. 운영 적용/실제 영수증 복구 완료 문서가 아니다.

최신 P0 수정: [차감 이력 INSERT guard](pos-resolution-deduction-insert-guard.md). NULL 배치/누락 receipt 연결의 INSERT 공백에 후속 additive SQL과 실제 PostgreSQL 전용 12건 검증을 추가했다. 운영 미적용·기능 OFF이며 운영 함수 원문 전체 대조는 여전히 미완료다.

최신 잔여 위험 검증: [운영 적용 전 검증 보고서](pos-resolution-residual-risk-review.md). 기존 292건은 반복하지 않고 신규 PostgreSQL 7건을 실행했다. 운영 함수 SELECT 차단과 미연결 이력 INSERT 보호 범위 미확정으로 운영 판정은 NO-GO를 유지한다. 제품 SQL/코드는 변경하지 않았다.

## 2026-10-21 정밀감사 P0 보완 — 운영 NO-GO 유지

운영 함수 원문 전체는 제공받지 않았다. 사용자가 확인한 운영 CRLF anchor 위치(613/1017/732)를 참고하고, 저장소의 기존 재고 RPC 원문을 CRLF로 변환하여 격리 PostgreSQL 17에서 재현했다. **운영 원문과의 완전한 일치 검증을 완료한 것이 아니다.** 운영 SELECT·DDL·DML·migration·Git·배포·8건 복구는 실행하지 않았으며 환경 파일/기능 플래그도 변경하지 않았다.

### 세 차단 문제의 수정

- P0-1: 모든 2차 함수 정의 변환 전에 CRLF/CR을 LF로 정규화한다. 재고 RPC 삽입 anchor는 독립된 `begin` 행이 정확히 하나인지 확인한다. regprocedure 인자, PL/pgSQL/jsonb/SECURITY DEFINER, actor/row-lock/updated_at/inventory-log 계약도 검사한다. 누락·다중 anchor 또는 의미 계약 불일치이면 전체 migration을 롤백한다. 정상 재고 RPC는 보호 guard 한 줄 외 정규화한 원문이 동일한지 격리 DB에서 대조했다.
- P0-2: 보류 전환 UPDATE에 `RETURNING * INTO v_r`를 사용한다. 트리거가 설정한 최신 updated_at을 batch preview, initial 검증, reprocess, canceled rollback에 일관되게 전달한다. 기존 stale 검사는 삭제하지 않았다. 외부 트랜잭션에서는 보류 해제가 보이지 않으며 실패하면 원상 롤백한다.
- P0-3: **이미 닫힌 일자 + 최초 paid 판정 + 재무 불일치**는 관리자 판정/수금 증빙/감사/재고 보류를 저장하되 유효 receipt/line 상태를 1로 유지하는 staging이다. 정상 paid 영수증을 다시 1로 되돌리는 절차가 아니다. 초기 결과 `reclose.status=financial_correction_staged`로 구분하며, 기존 마감/장부 스냅샷은 변경하지 않는다. 관리자 판정 테이블과 동기화 보호는 즉시 유효하다. 정상 매출·지급·재고 자동차감에는 유입되지 않는다. 이후 expected revision/version/fingerprint와 공식 Owner/Master 재마감 승인·최신 closure fingerprint를 검증한 단일 정정 RPC에서만 유효 상태를 3으로 올리고 품목/수금 정정 및 공식 재마감을 함께 수행한다. 금액 불일치·월마감·카드 지급 잠금·stale source·감사 기록 실패이면 staging 상태까지 모두 복구된다. 다른 미마감 재무 불일치 건의 기존 보류/차단 정책은 유지한다.

1차 SQL에는 명시적 BEGIN/COMMIT 및 local lock_timeout 5초/statement_timeout 60초만 추가했다. 미배포 파일의 업무 로직은 변경하지 않았다. 1차 전체 SQL 마지막 단계에 강제 오류를 넣어 신규 schema/table/function이 남지 않고 기존 영수증 3행이 유지됨을 확인했다. 2차도 원래의 명시적 트랜잭션을 유지한다. 운영 적용은 여전히 금지다.

### 공통 재고 잠금과 지문

- `inventory`, 원차감/차감 receipt 이력의 SHARE ROW EXCLUSIVE 전역 잠금을 제거하고 대상 inventory ID/receipt 이력 행을 정렬하여 잠근다. 대상 재고는 현재 유효 품목의 매핑·레시피와 과거 원차감/역분개가 참조한 재고를 포함한다.
- inventory context에는 해당 품목 코드/ID, 관련 매핑·레시피, 관련 재고, 영수증 이력만 넣는다. 무관한 재고·상품·매핑 변화는 더 이상 stale을 만들지 않는다. 같은 코드의 새 매핑, 관련 재고·이력 변화는 stale이다.
- 매핑 INSERT phantom을 막기 위한 상품/매핑/레시피 SHARE 잠금과 기존 receipt/line/payment SHARE ROW EXCLUSIVE 잠금은 남아 있다. 이 보호를 검증 없이 제거하지 않았다. **POS sync 또는 catalog 편집 지연 위험은 해결 완료로 보고하지 않는다.** 케그의 무관한 재고 행 UPDATE와 별도 deduction INSERT 병렬 실험만 통과했으며, 전체 케그 기능과 운영 혼합 부하 검증은 별도 선행조건이다. 같은 재고 행은 의도대로 잠긴다.
- 사용자 감사와 같은 행 수(inventory 555, products 351, mappings 225, recipes 6, deductions 1717)를 합성한 격리 PostgreSQL에서 context 30회와 EXPLAIN ANALYZE를 기록했다. 수치는 `context-benchmark.json`에 있으며 운영 실행시간/SLO 증거가 아니다.

### 보완 후 검증과 산출물

최종 회귀 282건(기존 218 + 2차 45 + 추가 19)을 재실행하여 통과했다. 신규 실제 PostgreSQL 감사 테스트는 부모 1 + 하위 9 = 10건 통과, 실패/skip 0이다. 따라서 최종 테스트 집합 합계는 **292건 통과**다. 일부 TS 테스트는 최초 실행에서 기존 import 해석 hook 누락으로 실패했으며, 기존 hook을 사용한 해당 그룹 재실행은 모두 통과했다. 초기 실패 로그도 보존했다.

- 수정 전 2차 SQL의 CRLF 확정 실패와 partial DDL/원문 변경 0건, 수정 전체 SQL 적용, 다중 anchor·SECURITY INVOKER 계약 오류 시 롤백.
- 실제 `updated_at=now()` trigger로 initial/reprocess/rollback 각각 5회 성공, 각 단계 실행 후 강제 감사 오류 시 전체 행/로그/보류 롤백, 크론 직접 실행 차단, 동일 requestId 재시도 no-op. 총 15회 승인과 15회 강제 실패를 확인했다.
- 이미 일마감한 6982/7063/7064 staging→금액/품목 정정→공식 재마감→별도 initial 재고 승인. 미정정 단계의 매출 0/마감·장부 불변, 잘못된 정정과 카드 지급 잠금 실패 후 상태·감사·장부 불변.
- 기존 8건 fixture, 7072/7075, 서버 권한/플래그 OFF, KO/VI×PC/모바일, POS sync/refresh 보호 회귀. 실제 원본 파일 전체는 여전히 확보하지 못했으며 합성 단가·카탈로그 가정은 실주문 증빙을 대체하지 않는다.
- 갱신한 preflight 15 SELECT를 격리 DB read-only transaction에서 검증했다. 함수 원문/정규화 MD5/CRLF 위치/updated_at 트리거 정의를 함께 확인할 수 있다. 운영 실행은 하지 않았다.

수정 파일: 1·2차 SQL, 본 문서, `docs/pos-pending-admin-resolution-preflight.sql`, 테스트 helper 2개, `tests/pos-resolution-work-db.test.mjs`의 CB3 VAT fixture. 신규 파일: `tests/pos-resolution-audit-postgres.test.mjs`, 수정 전 2차 SQL 회귀 snapshot `tests/fixtures/pos-resolution-phase2-before-audit.sql`, 전체 SQL 변경 diff `docs/pos-resolution-p0-audit.diff`. 프로덕션 TS/API/UI는 이번 보완에서 변경하지 않았다. 이전 ESLint/production build/기존 TS 진단 대조 결과는 이전 실행 기록이며 이번에 재실행했다고 주장하지 않는다.

전체 수정 SQL은 migration 디렉터리의 두 원본 파일을 검토한다. 격리 DB에서 생성한 clone/guard 함수 전체는 `.qa-review/pos-resolution/p0-audit/generated-functions.sql`, 원문 기반 CRLF fixture는 같은 폴더의 `repository-crlf-*.sql`이다. 운영 원문으로 오인하지 않는다. 실행 manifest/최종 로그/성능·경합/읽기 전용 SQL 결과도 같은 폴더에 보존한다. 재현: `node --experimental-strip-types --test tests/pos-resolution-audit-postgres.test.mjs` (기존 격리 PostgreSQL 도구 필요).

운영 재검토 순서는 실제 함수·트리거·권한 SELECT-only 계약 대조 → 원문 기반 격리 회귀/전체 케그·sync 혼합 경합 → 증빙별 복구 계획 검토 → 사용자 SQL Editor 수동 적용 승인 순서다. 후속 배포·플래그 활성화·실제 8건 정정은 각각 별도 승인 사항이다. 현재 NO-GO를 운영 적용 승인으로 바꾸지 않는다. 적용 후 문제가 생기면 쓰기/재조회 OFF, schema readiness/감사/DB 보호 유지, 공식 보상 정정·재마감 절차를 따른다.

## 2차 로컬 구현 — 감사 보완을 포함한 계약

아래 2차 내용이 현재 로컬 구현 기준이다. 뒤의 1차 조사·검증 기록은 보존한다. 운영 DB/연결된 Supabase에 DDL·DML·migration을 실행하지 않았으며 Git 명령, 브랜치 생성, commit/push/PR, 배포, 운영 복구를 하지 않았다. 환경 파일의 기능 플래그도 변경하지 않았다. SQL 실행은 PGlite 및 워크스페이스의 격리 PostgreSQL 17 fixture에 한정했다.

### 확인한 충돌과 해결

1. 기존 `admin_update_paid_sales_receipt`는 수정 성공 시 재고 보류를 해제한다. 보호된 영수증에는 이 public RPC를 호출하지 않는다. 검증한 함수 정의에서 전용 private 정정 엔진을 만들되, 자동 자격 NULL·보류 true·재처리 필요를 유지한다. 정상 POS 결제완료 수정은 원래 public 함수를 그대로 사용한다. 기존 경로로 보호 영수증을 수정하면 DB source guard가 전체 요청을 거부한다.
2. 기존 취소 원복 RPC는 보류 true를 거부한다. 새 confirm RPC가 잠금과 비공개 transaction capability를 확보한 뒤 같은 트랜잭션 안에서만 보류를 전환하고 기존 원복 함수를 실행한다. 외부에서 관찰할 수 있는 선행 보류 해제 구간은 없다. 실패하면 보류·재고·후보·로그·감사 전부 롤백된다.
3. 기존 재처리의 내용 지문만으로는 수량 `1→2→1→2`가 과거 중복 요청으로 오인될 수 있다. canonical 품목 지문을 `admin_resolution_content_fingerprint`에 보존하고, 엔진 실행 지문은 canonical 지문·재고 지문·resolution ID·version으로 만든다. 기존 unique/idempotency 제약을 유지하면서 판정 버전마다 한 번 처리한다. unified preview는 새 canonical 필드가 있을 때 그것으로 이력을 대조한다.
4. 실제 수금액과 유효 품목·세금이 다르면 `needs_financial_correction` 전이로 보류한다. `admin_resolution_financial_review_required=true`인 건은 일간/월간 정상 집계에서 제외하고 보류 건수를 표시한다. 미마감 paid 보류 건은 SQL 마감/TS 장부 확정을 차단한다. 이미 마감된 일자의 최초 불일치는 위 staging 계약을 따르며, 검증된 정정 후에만 유효 paid 상태와 공식 재마감을 반영한다. 가짜 영수증을 만들지 않는다.
5. 이전 버전에서 POS 대조가 matched였더라도 정정 후에는 그 결과를 재사용하지 않는다. 관측에 resolution version을 남기고, 오래된 matched는 unknown으로 표시하며 기존 bounded 큐가 새 버전을 다시 대조한다. 5분당 전역 3건, lease/backoff, 03:00 cutoff는 유지한다. 새 cron/Vercel 스케줄을 추가하지 않았다.

### 원자성·권한·마감

- 정정: 서버 서명 쿠키 → `requireRole(owner/master/manager)` → DB users 활성/로그인 허용/역할 재검증 → 기존 월/일 advisory 잠금 순서 → 소스 테이블 잠금 → receipt `FOR UPDATE` → requestId/revision/resolution ID/version/전체 snapshot 지문 검증 → 유효 품목·세금·수금·결제 교체 → 기존 modifications와 append-only version/history 기록을 한 트랜잭션으로 처리한다. username/role을 body에서 받아 권한으로 사용하지 않는다.
- 상품 정체성·parent 연결·기존 raw_json은 DB 행에서 읽는다. 새 상품은 활성 POS catalog ID를 검증해 파생 행으로 추가한다. 수량/단가/할인/세율은 명시 입력한다. 제외는 기존 행의 `is_excluded` 변경으로 남기며 원본 행을 삭제하지 않는다. 옵션의 유효 parent가 빠지면 정정을 거부한다. 제외했던 품목의 명시적 복원도 가능하다.
- 원본 결제행은 0원으로 보관하고 `admin_resolution_retired=true`로 현재 projection에서 제외한다. 원본 raw_json과 ID는 보존하고 감사 before snapshot에 원래 금액/결제 정보를 남긴다. 파생 결제는 실제 composite identity와 같은 행을 재사용하여 unique 충돌과 중복 집계를 막는다. 현재 버킷은 cash/transfer/card/other 각각 양의 정수 VND이며 합계가 확정 금액과 정확히 같아야 한다.
- 초기 v2 확정은 원본 금액/세금 summary를 보존한 뒤 유효 품목 기준 집계값을 만든다. 품목 필드 누락이나 수금 불일치는 정상 매출로 확정하지 않고 재무 보류한다. 재고 보류는 재무 보류 해제 후에도 별도로 유지된다.
- 재고 preview는 보류를 풀지 않고 기존 mapping/recipe preview를 사용한다. 현재 품목, 금액, parent, OrderDetailID/RefDetailID 중복, 원차감·역분개·레거시 연결을 확인한다. 내용/재고/매핑/catalog/최신 POS 관측을 묶은 DB context 지문과 15분 review token을 저장한다. token·현재 version·전체 context를 confirm 안에서 다시 검증한다.
- 재고 confirm은 Owner/Master만 가능하다. 한 번도 적용되지 않은 건은 기존 initial apply, 과거 차감이 있으면 기존 reprocess, 취소된 활성 차감은 기존 rollback canceled를 호출한다. 취소됐고 실제 활성 차감이 없으면 명시적 no-stock 확인만 남긴다. 한 번 승인한 version은 새 review로 재실행할 수 없다. 동일 requestId 재시도는 기존 성공 결과를 반환한다.
- 기존 세 재고 public RPC는 보호 영수증에 대해 private inventory capability가 없으면 엔진 잠금을 잡기 전에 거부한다. 원차감과 inventory_logs를 삭제하지 않고 기존 역분개 + 재차감으로 최종 차이만 반영한다.
- 일마감 후 정정은 Owner/Master가 해당 마감 fingerprint와 공식 재마감 승인을 명시해야 한다. 무관한 source drift 또는 변경되는 카드 소스의 정산 잠금이 있으면 전체 롤백한다. 재고 승인도 같은 명시 승인과 소스 대조가 필요하다. 운영의 무조건 updated_at 갱신 트리거 때문에 금액이 같아도 재고 승인 후 소스 fingerprint가 바뀔 수 있으므로 같은 트랜잭션 안에서 공식 재마감을 수행한다. 이 과정도 카드 소스 잠금에 걸리면 롤백한다. Manager는 마감 후 직접 변경할 수 없다. 월마감은 모든 새 쓰기를 차단하고 기존 공식 월마감 해제/정정 절차가 선행돼야 한다.
- Leader의 월간 접근은 유지하고 일간/영수증/새 work API 접근은 서버에서 거부한다. Staff는 관리자 매출 접근이 없다. Manager는 정정·preview만 가능하고 실제 재고 승인은 불가하다.

### DB 오브젝트와 적용 파일

후속 파일: `supabase/migrations/20261021081604_pos_resolution_corrections_inventory_review.sql`. 최초 2차 개발에서는 1차 파일을 수정하지 않았으며, 이번 감사 보완에서 미배포 1차 파일에 명시적 트랜잭션 경계와 timeout만 추가했다.

| 구분 | 2차 내용 |
| --- | --- |
| 신규 public 테이블 | `pos_sales_receipt_resolution_versions`, `pos_sales_receipt_inventory_reviews`, `pos_sales_receipt_inventory_approvals` — RLS, 직접 쓰기 차단, append-only |
| 신규 private 테이블 | transaction별 `work_capabilities` — service_role 직접 접근 불가 |
| additive 컬럼 | receipts: `admin_resolution_version`, `admin_resolution_financial_review_required`; payments: `admin_resolution_retired`; POS observations: `resolution_version`; deduction receipts: `admin_resolution_content_fingerprint` |
| 신규 public RPC | `sales_resolve_pending_receipt_v2`, `sales_get_admin_resolution_work_v2`, `sales_correct_admin_resolution_v2`, `sales_preview_admin_resolution_inventory_v2`, `sales_confirm_admin_resolution_inventory_v2` |
| 기존 함수의 안전 확장 | initial apply/reprocess/rollback에 보호 가드, POS observe/get/claim에 version 대조, private close build_source에 재무 보류·retired payment 처리 |
| 보존 | public `admin_update_paid_sales_receipt` 본체, 정상 POS 흐름, 과거 원본 JSON/상품/차감 로그, 기존 수정 이력 |

후속 SQL은 명시적 BEGIN/COMMIT과 lock_timeout 5초/statement_timeout 60초를 사용한다. 과거 데이터 backfill/재분류 DML은 없다. 기존 함수 정의의 필수 anchor나 ID 타입이 다르면 적용을 중단한다. 이미 적용한 파일의 재실행은 최초 신규 객체 충돌에서 실패하도록 설계했으며 ROLLBACK 후 기존 데이터/오브젝트가 유지되는 것을 검증했다. 이는 반복 실행으로 덮어쓰는 migration이 아니다. SQL Editor 수동 적용용 트랜잭션이므로 향후 CLI runner로 실행 방식을 바꾸려면 history 기록 경계부터 별도 검토해야 한다.

### UI와 API

- `/api/admin/sales/receipts/[id]/resolution/work` GET, POST action `correct/preview/confirm`. 모든 요청은 서버 세션을 확인하고, flag OFF이면 새 데이터/작업 경로를 차단한다. 상품 검색도 같은 보호 API를 사용한다. confirm body의 deduction plan은 받지 않으며 서버가 저장한 review만 실행한다.
- `ResolvedReceiptWork.tsx`: KO/VI, 현재 판정/수금/결제 내역, 명시적 상품 추가·제외·복원과 수량/금액/세율, 환불 증빙 취소, 독립 재고 preview/승인, revision/version/fingerprint, 실행 담당자, 사유·최근 50건 감사 요약을 표시한다. 전체 before/after 감사 원본은 DB에 계속 보존한다.
- 미저장 정정이 있으면 재고 검증/승인을 막는다. 중복 클릭은 in-flight ref로 막고, 응답 유실 후 재시도는 동일 payload/requestId를 재사용한다. 상태 반영은 성공 응답 후 새 조회로만 한다. 이미 취소한 영수증을 단순 paid로 다시 쓰는 우회는 제공하지 않는다.
- 새 정정 컴포넌트는 판정이 있는 영수증에서만 lazy load한다. 정상 영수증/30분 이전에 새 inventory context 조회를 추가하지 않는다. 일간/월간 재무 보류 배너는 해당 건이 있을 때만 표시하며 Leader에게 영수증 접근 링크를 추가하지 않는다.

### 변경 파일

구현:

- `components/ResolvedReceiptWork.tsx` (신규), `components/PendingReceiptResolution.tsx`
- `app/api/admin/sales/receipts/[id]/resolution/work/route.ts` (신규), `.../resolution/route.ts`, `.../[id]/route.ts`
- `app/api/admin/sales/today/route.ts`, `app/api/admin/sales/monthly/route.ts`
- `app/(protected)/admin/sales/page.tsx`, `app/(protected)/admin/sales/monthly/page.tsx`
- `lib/sales/admin-resolution-work.ts` (신규), `admin-resolution-server.ts`, `inventory-deduction-preview.ts`, `inventory-deduction-unified-preview.ts`
- `lib/ledger/pos-sales.ts`, `lib/ledger/pos-sales-source.ts`
- 위 후속 migration, 본 문서, `docs/pos-pending-admin-resolution-preflight.sql` (신규)

검증:

- `tests/pos-resolution-work-{auth,db,service,projection,incidents,browser,postgres}.test.mjs` (7개 신규)
- `tests/helpers/pos-resolution-work-fixture.mjs`, `tests/fixtures/pos-resolution-work-cases.mjs` (신규)
- `tests/helpers/pos-pending-resolution-fixture.mjs`: 최신 close 함수 추출 delimiter 오류 수정. 함수 추출이 비어 있던 1차 harness를 바로잡았다. 운영 함수나 기존 migration을 수정한 것은 아니다.

### 로컬 검증 결과와 범위

| 검사 | 결과 | 범위 |
| --- | --- | --- |
| 기존 218건 | 23 + 107 + 88 통과 | 기존 auth/30분/KO·VI/sync/queue/매출/마감/장부/재고 계약 |
| 2차 신규 | 45건 통과, 실패/skip 0 | 8건 조건 fixture, 금액·VAT·4버킷, catalog 추가·제외·복원, 7072/7075, 마감/정산/월마감, 원복·중복·실패 롤백·권한 |
| 추가 회귀 | 19건 통과 | canonical inventory fingerprint 및 급여 가불 장부/취소 원복 |
| 합계 | 282건 통과 | 중복 실행 횟수가 아니라 각 최종 테스트 집합의 합계 |
| 실제 PostgreSQL 17 | 5회 경합 통과 | 두 관리자 정정, stale sync, 중복 재고 승인, 미커밋 보류 상태 비노출, 차감/승인 1회 |
| Chrome 브라우저 | KO/VI × PC/390px 모바일 통과 | 서명 세션 → 실제 신규 route/service/RPC → PGlite → reload, 응답 유실 재시도·중복 클릭, 정정 후 보류와 별도 승인 |
| SELECT-only preflight | 격리 DB read-only transaction에서 15문 검증 | 운영 실행 아님 |
| ESLint | 변경 구현 파일 오류/경고 0 | 최종 로그 참고 |
| production build | 성공 | flag OFF, Next 16.2.1 production build/타입 검사/정적 생성 |
| 전체 tsc | 기존 테스트 진단 40, 신규 구현 진단 0 | 1차 기준과 파일/오류 코드/메시지를 대조하여 추가·제거 진단 모두 0. Next build는 자체 테스트 파일 진단 필터를 사용하므로 전체 tsc 결과와 구분 |

브라우저 검증은 새 컴포넌트와 실제 auth/route/service/DB 엔진을 연결한 로컬 하네스다. mapping preview 입력은 격리 catalog fixture로 공급한다. 실제 POS, 운영 전체 앱 환경/기기, 운영 스키마의 완전한 동등성, 운영 부하 및 실제 급여/다른 날짜 전체 데이터 hash 대조를 완료했다는 뜻이 아니다. 다른 날짜의 격리 ledger snapshot이 정정·재고 승인에 영향받지 않는 테스트와 별도 급여 회귀를 실행했다.

로그: `.qa-review/pos-resolution/phase2-{new-tests,supplementary-tests,typecheck,build}.log`, `phase2-baseline-{0,1,2}.log`, `phase2-eslint.log`. 화면: `work-{ko,vi}-{desktop,mobile}.png`. PostgreSQL 테스트는 127.0.0.1의 격리 클러스터만 사용하고 finally에서 종료한다.

### 8건 실복구 전 증빙

fixture의 6974/6981/7055/7059/7057 금액 100,000₫ 및 catalog/단가는 개발용 가정이다. 실제 원본 파일을 제공받거나 운영에서 추출한 것이 아니다. 다음 값만 지시서 사실관계로 사용했다:

- 6982: 원본 1,910,800₫ / 확인 수금 1,100,800₫, V6×3 V2×1 V3×1 B4×1 C5×1. 사용자 운영 감사에서 활성 CB3 750,000₫ + VAT 8% 60,000₫ = 차이 810,000₫임을 확인했다. 금액 차액은 설명되지만 CB3가 실제 주문이 아닌지는 고객 주문·결제 증빙을 별도로 확인해야 한다. fixture에도 CB3 VAT를 반영했으며, 다른 품목 단가 배분은 합계 검증용 가정이다. CB3는 자동 제외하지 않고 명시 정정 후에도 원본 행/raw를 보존한다.
- 7063: 결제 상세 220,000₫ / 원본 955,000₫. 실제 수금·환불·수단별 합계를 대조해야 한다.
- 7064: 2,682,000₫ / 원본 3,222,000₫. 차이 540,000₫의 품목·할인·세금 근거가 필요하다.
- 6981/7057 및 위 불일치 건: RefDetailID가 달라도 OrderDetailID 기준으로 동일 실주문인지 확인한다. 옵션/parent, 실수량, 레시피 및 재고 단위를 확인한다.
- 7055/7059: 출력 오류나 파일 누락만으로 수금을 인정하지 않는다. 현금 실사/이체 내역/카드 승인 등 실제 수금 증빙과 정상 실주문을 확인한다.
- 모든 건: 전체 ref_id/ref_no/영업일, 원본 JSON hash, 원본 결제 스냅샷, 현재 revision/판정 version, 실제 상품·수량·할인·세금·수금·환불, 활성 차감과 역분개, 마감·월마감·카드 정산 상태, 처리자와 사유를 한 건씩 확인한다. 7072/7075는 신규 결제예정 확정 대상이 아니며 기존 수정 이력을 보호한다.

### 운영 preflight·적용 순서·롤백

현재 운영 SELECT는 연결 도구 승인 정책으로 실행할 수 없었고 우회하지 않았다. 지시서의 2026-10-21 운영 함수 계약은 참고값이며 후속 migration과 완전히 동등하다는 증거가 아니다. 준비한 SELECT-only SQL에서 해당 신규 migration 두 버전과 관련 객체만 확인한다. 과거 전체 migration 정리, db push/reset/repair, 재실행·일괄 이력 등록은 요구하거나 실행하지 않는다.

1. **선행 검토**: read-only preflight로 실제 컬럼/ID 타입·unique/selection constraint·함수 본문/ACL/RLS·마감 보호·card settlement 의존성을 대조한다. clone anchor뿐 아니라 함수 의미도 검토한다. 비정수 mapping/recipe ID, 필수 객체/정의 충돌, 부정확한 권한이면 중단한다. 동적 clone을 운영에서 시험 삼아 적용하지 않는다.
2. **증빙 및 부하 검증**: 8건 원본과 실제 수금·실주문을 대조하고 운영 크기 catalog/inventory에 대한 수동 context 계산 및 잠금 시간을 측정한다. 승인 전까지 불명확한 중복·매핑은 보류한다. 감사 보완 후 context는 관련 품목·매핑·재고·이력으로 제한했으나 상품·매핑/영수증 소스의 보호 잠금이 남아 있으므로 운영 혼합 부하 검증은 여전히 필요하다.
3. **명시 SQL 승인 후 사용자 수동 실행**: 1차 `20261021070640` → 2차 `20261021081604` 순서. 각각 관련 객체와 데이터 변경 유무를 먼저 검토하고 사용자가 SQL Editor에서 직접 실행한다. 2차는 파일 자체 transaction을 사용한다. 오류 시 ROLLBACK과 객체/행 수를 확인하고 원인을 조사한다. Codex가 운영에 직접 실행하는 승인이 아니다.
4. **적용 검증**: 사용자가 완료를 알린 뒤 연결된 도구로 정의·인자·PUBLIC/anon/authenticated/service_role 권한·RLS/trigger·새 테이블 0건·기존 행 수/원본 hash·감사·Advisor를 확인한다. 실제 승인·실행 SQL과 해당 신규 버전을 대조하고 누락된 그 버전의 history만 안전하게 등록한다.
5. **별도 Git/배포 승인 후 코드**: 현재 금지 상태다. 승인 이후에도 기능 쓰기/재조회 플래그 OFF로 코드부터 검증한다. 실제 DDL 검증 후에만 `POS_ADMIN_RESOLUTION_SCHEMA_READY` 및 `POS_ADMIN_RESOLUTION_V2_SCHEMA_READY`를 사용한다. 기본값은 모두 OFF이며 `POS_ADMIN_RESOLUTION_ENABLED`/`POS_PENDING_RECHECK_ENABLED` 활성화는 별도 승인과 smoke test가 필요하다.
6. **개별 수동 처리**: 8건을 대량 승인하지 않는다. 각 건의 재무 정정·수금 대조 → 별도 재고 preview → Owner/Master 승인 → 매출/마감/장부/원차감·역분개를 확인한다. 이미 마감됐으면 공식 승인/재마감을 먼저 포함하고 월마감은 공식 해제 정책을 따른다.
7. **운영 롤백**: 우선 쓰기/재조회 플래그를 OFF로 중지한다. 이미 적용한 schema readiness와 DB 보호·append-only 감사·재무 보류 projection은 유지한다. 새 컬럼/트리거/판정 테이블을 제거하거나 보호를 모르는 구버전으로 단순 복귀하지 않는다. 이미 확정한 금전·재고는 직접 UPDATE/DELETE로 되돌리지 않고 공식 보상 정정/원복 및 마감 정책으로 처리한다. 현재는 미배포이므로 운영 rollback을 실행할 대상도 없다.

재고 승인은 manual/keg/combo mapping, 불명확한 중복, 누락된 parent, legacy/cross-receipt 차감 연결, 검증 후보 없음, 중복 활성 원차감, stale context를 우회하지 않는다. 이들은 안전한 복구/매핑 증빙 검토가 선행돼야 한다. 취소 후 paid 재개는 별도 보상 절차가 필요하므로 직접 재개 버튼은 없다.

2차 최초 완료 시 로컬 감사: 네 기능 플래그는 모두 미설정(기본 OFF)이었다. 당시 잔존 DB 디렉터리 12개와 TypeScript 기준 대조는 `.qa-review/pos-resolution/phase2-final-audit.json`에 기록했다. 이번 P0 보완 후 최신 잔존 경로·수량/플래그/테스트 요약은 `.qa-review/pos-resolution/p0-audit/final-summary.json`을 따른다. 정리 정책 차단 후 삭제를 재시도하지 않았으며 캐시·도구·증거 파일도 보존했다. 운영 데이터나 자격 증명은 fixture DB에 넣지 않았다.

## 조사 결과와 충돌 수정안

- receipts GET/detail GET/today/monthly는 서버 세션 검사가 없고, 영수증 생성/수정/refresh-pos는 body.actorUsername으로 users를 조회한다. 모든 경로를 requireRole로 통일한다. monthly만 leader를 허용한다.
- saveReceipts는 is_modified라도 상태를 갱신하고, saveLines/savePayments/재고 활성화는 독립 요청이다. 애플리케이션 사전 조회만으로는 경합을 막을 수 없다. 독립 관리자 판정 테이블과 DB 트리거를 보안 경계로 둔다.
- raw_json을 상태의 권위로 사용하지 않는다. 최초 판정 전 전체 receipt/lines/payments 스냅샷과 이후 POS 관측을 따로 보존한다. 유효 매출은 기존 receipt ID/기존 집계 경로를 사용한다.
- 영업일 마감은 pos_sales_close_private.build_source와 sales_close_business_day_v1의 fingerprint/카드 지급 보호를 이용한다. Owner/Master의 명시적 재마감 동의와 검토한 기존 closure fingerprint를 요구한다. 이 결합이 실패하면 판정 전체를 rollback한다. 월마감은 역할과 무관하게 차단한다.
- 재고 이력이 한 건이라도 있으면 보수적으로 확정을 차단한다. 자동 복구하지 않는다. 신규 수동 확정은 재고 자동차감을 보류한다.
- POS 이후 동일 상태/금액은 대조 완료로 표시하되 관리자 보호를 유지한다. 반대 상태/금액은 충돌이다. 품목 변경은 자동 승인하지 않는다.
- 기존 마감 이후 다른 영수증의 소스 drift가 이미 있으면 이번 확정에 섞어 재마감하지 않는다. Owner/Master의 기존 대조·재마감 절차를 먼저 요구한다. 늦게 도착한 옛 POS 응답은 최신 충돌을 가리지 못하도록 관측 시각 순으로 판단한다.
- 수정된 품목과 원본 raw_json의 중복 의심 그룹을 별도로 진단한다. 수정 이력이 있어도 원본 중복 경고가 유지된다.
- 기존 영수증 수정 RPC를 통해 관리자 판정을 우회하는 변경도 DB에서 차단한다. 관리자 확정 후 품목/결제 정정의 전용 감사 연동은 별도 검토가 필요하다. 그 전에는 해당 변경을 열지 않는다.

## 영향 범위

인증: lib/auth/server-auth.ts를 이용하는 sales API들. UI: receipts/page.tsx와 별도 KO/VI 판정 패널. helper: UTC instant 자격/중복 의심 진단. DB: additive 관리자 판정, append-only 감사/POS 관측, 재조회 작업 상태 및 service_role 전용 RPC/보호 트리거. 동기화: sales-receipt-sync.ts와 기존 sales-sync cron. 마감/장부: 기존 build_source/close RPC 호출로 연결하며 과거 migration은 수정하지 않는다.

## 원자성

확정 RPC는 기존 마감 잠금 순서(월→일→소스)를 따른다. 월마감 직렬화 키도 취득하고 source 테이블 잠금 후 receipt FOR UPDATE, 현재 actor/30분/상태/revision/전체 스냅샷 fingerprint/closure/재고 이력을 재검사한다. requestId와 입력을 함께 저장하여 다른 입력의 재사용을 거부한다. 결제 snapshot 교체, receipt와 line의 유효 상태, 자동차감 보류, 감사, 선택적 일 재마감을 한 트랜잭션으로 묶는다. 권한 있는 RPC만 private transaction capability를 만들 수 있다. 사용자 설정 가능한 GUC는 권한 증표로 사용하지 않는다.

## 운영 경계

- Git 명령, 운영 DB DDL/DML, migration 적용, 배포 금지. 로컬 파일, 격리 PGlite 및 워크스페이스 내부 PostgreSQL 17만 사용한다.
- 기능은 서버 플래그 기본 OFF. 승인 전 환경변수를 설정하지 않는다. raw fixture가 없으므로 사례 fixture는 제시된 사실을 모델링한 것이며 실제 원본 대조를 대신하지 않는다.
- 기존 5분 cron 일정은 유지한다. 추가 재조회는 별도 opt-in 플래그, 최대 3건/실행, lease/backoff/실패 격리를 적용한다. Vercel 계정별 실시간 quota는 배포 전에 별도 확인한다.
- 기존 TypeScript baseline에는 테스트 파일 TS5097 및 ledger 테스트 타입 오류가 있다. 신규 오류와 구분한다.
- 운영 스키마 SELECT는 자동 승인 검토에서 거부되어 실행되지 않았다. 도구 사유: "MCP tool call requires approval, but approval policy is never". 운영 컬럼·제약·함수 정의·권한과 로컬 계약의 대조는 아직 완료되지 않았다.
- 6982의 제공된 두 금액을 제외한 사례 fixture 금액(100,000/90,000 등)은 합성 테스트 값이다. 실제 8건의 원본 payload를 확보한 fixture와 혼동하지 않는다.

## 로컬 구현 파일과 DB 오브젝트

- migration: `supabase/migrations/20261021070640_pos_pending_admin_resolutions.sql`. CLI로 신규 파일만 생성했으며 미적용이다. 기존 migration 내용은 수정하지 않았다.
- public 신규 테이블: `pos_sales_receipt_admin_resolutions`, `pos_sales_receipt_resolution_history`, `pos_sales_receipt_pos_observations`. private 신규 스키마/테이블: `pos_resolution_private.capabilities`, `pos_resolution_private.recheck_jobs`.
- service_role 전용 public RPC: `sales_get_pending_resolution_v1`, `sales_resolve_pending_receipt_v1`, `sales_observe_resolved_receipts_v1`, `sales_claim_pending_rechecks_v1`, `sales_finish_pending_recheck_v1`.
- 기존 receipt/line/payment 테이블에는 보호 트리거를 추가하고, 과거 결제예정 후보 탐색용 partial index를 추가한다. 신규 테이블은 RLS를 켜고 public/anon/authenticated의 권한과 service_role의 직접 쓰기 권한을 제거한다.
- preflight는 마감 함수·재고 테이블 존재 및 ref_date/created_at의 timestamptz 계약을 확인한다. 기존 객체와 충돌하거나 재실행하면 조용히 덮지 않고 실패한다. SQL Editor에서 적용할 때는 전체 파일을 한 트랜잭션으로 실행해야 한다.
- API: `app/api/admin/sales/{today,monthly,receipts}/...`, 새 `receipts/[id]/resolution` 및 `resolution/recheck`. helper: `lib/sales/{pending-resolution-policy,admin-resolution-server,pending-pos-recheck}.ts`.
- UI: `components/PendingReceiptResolution.tsx`, 기존 receipts 페이지. 동기화/재고: `lib/pos/cukcuk/{sales-receipt-sync,auth}.ts`, sync-to-sales API, sales-sync cron, `lib/sales/sales-deduction-cron-shared.ts`.
- 테스트: `tests/pos-pending-resolution-*`, `tests/helpers/pos-*resolution*`, 사례 fixture. 기존 payment snapshot 회귀 테스트의 존재하지 않는 migration 참조 경로를 실제 파일명으로 수정하고, 기존 sync completeness harness에 기본 OFF인 새 의존성을 추가했다.

## 기능 플래그와 재조회 부하

`POS_ADMIN_RESOLUTION_SCHEMA_READY`, `POS_ADMIN_RESOLUTION_ENABLED`, `POS_PENDING_RECHECK_ENABLED`는 모두 기본 OFF다. migration 검증 후 SCHEMA_READY를 켜고, 쓰기와 재조회는 각각 따로 승인하여 연다. 판정이 한 건이라도 생성된 뒤에는 쓰기를 꺼도 SCHEMA_READY와 DB 보호를 유지해야 한다.

기존 Vercel cron 일정/개수는 바꾸지 않았다. 재조회는 중복 실행을 포함하여 전역 5분 구간당 최대 3건, 각 로그인+상세 조회 합계 10초 timeout, 2분 lease, 최대 6시간 backoff를 사용한다. 최악의 추가 POS 호출은 실행당 로그인 3회 + 상세 3회다. 지금 일정에서 시간당 최대 72회, 하루 최대 648회의 추가 API 호출이므로 실제 CukCuk/Vercel 계정 quota와 함수 잔여 실행 시간을 승인 전에 확인해야 한다. 이전 영업일의 재조회는 관측만 저장하며 마감 소스를 자동 변경하지 않는다. POS가 최종 상태이면 관리자 신규 판정을 차단하고 기존 동기화/마감 대조를 요구한다.

## 로컬 검증과 남은 제한

신규 helper/API/DB/sync/큐/KO·VI PC·모바일 브라우저 테스트와 실제 PostgreSQL 17 다중 연결 경합 테스트를 실행했다. 재고 이력 차단, 실제 카드 지급 잠금으로 인한 전체 rollback, append-only/ACL, 원본 JSON 불변성, 원본 중복 경고, 다른 마감 소스 drift 차단도 포함한다. 자세한 최종 개수/로그는 아래 검증 결과에 기록한다.

브라우저 검증은 실제 컴포넌트와 route handler를 로컬 harness에 연결하고 서명 세션·PGlite를 사용했다. 운영 Next 배포나 실제 POS API를 호출하는 smoke test를 대신하지 않는다. PostgreSQL 17 테스트 프로세스는 종료했다. 운영 부하 측정과 quota 확인은 미실시다.

관리자 확정 후에는 원본 품목/결제 수정을 계속 차단하고 재고 보류를 유지한다. 보류 해제/확정 후 재정정은 현재 제공하지 않는다. 기존 안전한 품목 정정·재고 워크플로에 판정 감사까지 연결하는 후속 작업과 승인이 필요하다. 중복 품목이 있는 실제 8건의 재고 복구가 완료된 것으로 간주하면 안 된다. 월마감 건은 기존 Owner/Master 월 재개방·정정·재마감 절차를 먼저 거쳐야 한다.

테스트 도구는 루트 package.json/lockfile을 바꾸지 않고 `.qa-review/pos-tools`에 격리 설치했다. 재현용 설치:

```powershell
$env:npm_config_cache = 'C:\workspace\baba-membership\.cache\pos-tools'
npm.cmd install --prefix .qa-review/pos-tools --no-save --package-lock=false playwright@1.58.2 esbuild@0.25.12 @embedded-postgres/windows-x64@17.10.0-beta.17
node --experimental-strip-types --test tests/pos-pending-resolution-*.test.*
```

브라우저는 로컬 Chrome을 사용한다. 별도 도구가 없는 환경에서는 브라우저/Postgres 테스트가 skip되므로 완료 판정 시 반드시 skip 수를 확인한다.

### 최종 검증 결과

| 검사 | 결과 | 범위/제한 |
| --- | --- | --- |
| 신규 테스트 | 23 passed / 0 failed / 0 skipped | helper, 실제 서명 세션과 route handler, PGlite, sync 보호, 큐, KO/VI × PC/모바일, PostgreSQL 17 다중 연결 |
| 기존 회귀 1차 | 107 passed / 0 failed | 일간·월간 시간/성능 계약, 결제 snapshot, split payment, 마감/재마감·지급 잠금·장부, 재고 정책 |
| 기존 회귀 추가 | 88 passed / 0 failed | sync source completeness 및 오류 격리, 장부 소스/fingerprint, preview 성능 계약, 세금/재고 재처리 |
| ESLint 변경 구현 파일 | 오류 0 / 경고 0 | 기존 페이지와 변경 API/helper/cron 포함 |
| TypeScript 전체 | 실패: 기존 테스트 진단 40개 / 신규 구현 진단 0개 | TS5097 및 ledger 테스트 타입 오류. 전체 빌드 통과로 보고하지 않음 |
| 운영 스키마·실데이터·Advisor·quota | 미검증 | 읽기 전용 execute_sql도 승인 정책으로 차단. 실제 원본 fixture와 운영 부하 측정은 없음 |

로그: `.qa-review/pos-resolution/{new-tests,regression-tests,extra-regression-tests,typecheck-final,eslint-final}.txt`. KO/VI PC/모바일 스크린샷은 같은 디렉터리의 `*-form.png`다. PostgreSQL 테스트 프로세스는 종료했다. 종료된 클러스터의 `pg17-*` 데이터 디렉터리, `.local-npm-cache`, 임시 typecheck 파일의 정리 명령은 자동 실행 정책이 `blocked by policy`로 거부하여 실행되지 않았다. 이 임시 파일과 격리 테스트 도구는 현재 워크스페이스에 남아 있다. 운영 데이터/자격 증명은 넣지 않았다.

운영 미적용 상태에서 되돌릴 대상은 이 신규 로컬 파일 변경뿐이다. 운영 반영 후에는 SCHEMA_READY/DB 보호를 유지하면서 ENABLED/RECHECK만 끄고, 금융·재고 확정 데이터와 감사 이력은 보존한다. 특히 새 보호 테이블/트리거부터 삭제하거나 기존 is_modified 보호만 있는 코드로 되돌리는 방식은 허용하지 않는다. 드물게 동기화 경합이 DB 보호 트리거에 걸리면 해당 sync는 실패로 기록될 수 있으므로 재실행 후 매출·결제·재고 자격 상태를 함께 대조해야 한다.

## 실제 8건 확정 전 증빙

6974/6981/6982(10-17), 7055/7059/7057/7063/7064(10-20): 영수증 ref_id/영업일/원본 보관, 실제 수금 또는 취소 증빙, 담당자/사유, 수단별 합계, 재고/지급 이력, 마감 상태를 개별 확인한다. 6981/6982/7057/7063/7064는 중복 품목과 실제 수량을 별도 대조한다. 6982는 1,100,800 VND와 1,910,800 VND 차이의 증빙이 필요하다. 7063/7064는 불일치 금액 자체도 원본에서 확인한다. 7055/7059는 파일/인쇄 오류를 수금 증거로 간주하지 않는다. 7072는 이미 결제완료이므로 신규 판정 대상에서 제외한다.

## 승인 이후 적용 순서 및 rollback

1. 로컬 SQL/테스트/권한/배포 전 위험 검토를 승인한다. 사용자가 SQL Editor에서 해당 신규 SQL만 실행한다.
2. 연결된 Supabase 도구로 객체/함수/ACL/행 수/감사/Advisor와 신규 migration 이력을 검증하고 누락된 해당 버전만 등록한다.
3. 코드 배포(플래그 OFF), 권한 smoke test, 정상 영수증/동기화/마감 회귀 후 플래그를 승인하여 연다.
4. 8건은 증빙 확인 후 개별 수동 확정하며 자동 backfill하지 않는다.
5. 문제 발생 시 플래그를 끄고 재조회 큐를 중지한다. 관리자 판정과 감사/보호 트리거는 보존한다. 보호를 모르는 구버전 코드로 단순 rollback하지 않는다. 이미 확정한 금융/재고 데이터는 직접 UPDATE/DELETE로 되돌리지 않고 Owner/Master 정정 절차를 따른다.
