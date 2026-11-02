# P1-2C — Shadow 운영 전환 선행조건 검증

기준 SHA `7a17756a53e6d5f576a8ae6d1f4c2516bf3ebb8b`, 원본 main 직렬 작업. 정본 [P1-2 구현 결과](20261102-pos-shadow-p1-2-implementation.md)의 계산·lease·감사 계약을 기준으로 조사했다.

**판정: 기존 재고차감 엔진 교체는 BLOCKED.** 합성 입력에서의 계산/결정성 PASS와 실제 운영 입력의 신뢰성은 별개다. Shadow 기본 비활성·P0를 유지했다. 운영 DB는 확인된 영수증 8111 한 건만 읽기 전용 GET으로 조회했다. POS live API/login, 운영 데이터 수정, 운영 Migration 적용, Push·배포·자동 복구는 하지 않았다.

## 1. 조사 범위와 증거 한계

app/lib/components/scripts 및 supabase Migration의 직접·동적 inventory INSERT/UPDATE/DELETE, RPC 위임, 관련 audit/metadata 변경 경로를 검색·추적했다. 같은 함수의 과거 정의를 별도 현행 Writer로 중복 계산하지 않았고, overload·legacy service 진입점·원장 전용 작업을 구분했다. 실제 운영 pg_proc/ACL/트리거·비저장 외부 SQL·설치된 배치 목록은 이번에 조회하지 않았다. 따라서 아래 목록은 **저장소 전수 조사**이며 운영 DB 설치 목록까지 전수 일치한다고 주장하지 않는다.

새 검증: native PostgreSQL **8 PASS**, source/복구 계약 **5 PASS**, API **2 PASS**, 합계 **15 PASS / 0 FAIL / 0 SKIP** (native 상위 테스트 1 포함). 변경 TS 3개 ESLint 통과. P1-1 41 PASS와 P1-2 24 PASS는 유효한 범위에서 재사용하고 새 실행 수에 합산하지 않았다. 실제 CUKCUK 통신·전체 Build/TypeScript/전체 회귀는 실행하지 않았다. 운영 자격 증명을 테스트에 전달하지 않았다.

## 2. CUKCUK 원본 이벤트 신뢰성

공식 [영수증 paging 문서](https://graphapi.cukcuk.vn/document/api/sainvoices_paging.html)는 RefId/BranchId/RefNo/RefDate/PaymentStatus, LastSyncDate, Page/Limit 및 Total을 설명한다. [상세 문서](https://graphapi.cukcuk.vn/document/api/sainvoices_detail.html)는 RefDetailID와 품목/수량 상세를 설명한다. 확인한 문서에서 영수증의 **단조 증가 수정 순번·immutable 이벤트 ID·원자 snapshot token 계약은 확인하지 못했다.** 이는 실제 응답에 버전 필드가 절대 없다는 결론이 아니다. LastSyncDate의 정확한 변경/발생시각 기준과 경계·삭제/취소 보존 보장도 공급자 확인이 필요하다.

| 의미 | 현재 원본/로컬 필드 | 판단 |
|---|---|---|
| 원본 identity | RefId/RefID + BranchId/BranchID, 단일 설정 Company 범위 | 문서·파서 PASS. RefNo는 표시값이며 identity/버전 아님. 다중 Company 격리는 미확인 |
| 라인 identity | RefDetailID, 부모/옵션/품목 코드 | 문서·파서 PASS. 누락 시 로컬 fallback 매칭은 원본 identity 증명 아님 |
| 상태 | PaymentStatus 3=수금 완료, 4=취소, 5=임시 취소 | 문서·현재 파서 일치. 재고 반환 사실을 뜻하지 않음 |
| 영수증 발생시각 | RefDate, 현재 코드의 PostedDate fallback | 물품 제공/출고/반품 시각은 미확인. 공식 예시에는 offset 없는 시각도 있어 자동 UTC/방콕 추정 금지 |
| 취소·수정 메타데이터 | paging의 CancelDate 등, raw_json 내 ModifiedDate 계열 후보 | 취소/편집 메타데이터일 뿐 물리 반환·단조 순번 아님. 실제 계정 payload·정확한 의미는 미확인 |
| 원본 version/sequence | 현 코드에 신뢰할 수 있는 매핑 없음 | BLOCKED. 임의 EditVersion/Revision/Sequence 후보도 공급자 계약 검증 전 불신 |
| 로컬 revision | 관리자 수정 RPC의 revision +1, request UUID | 관리자 동시수정 보호용. POS 원본 revision으로 사용할 수 없음 |
| 수집/시스템 반영시각 | synced_at, updated_at = 동기화 시작 시 전달된 syncedAt | 원본 거래시각/순번 아님. 헤더·라인·결제의 원자 반영시각도 아님 |

운영 DB에 **저장된 raw snapshot** 표본 8111의 읽기 전용 대조 결과는 다음과 같다. 현재 CUKCUK 서버의 새 응답이나 과거 버전 전체를 조회한 것은 아니다.

- source=cukcuk, local revision=1, PaymentStatus=3, is_canceled=false. RefId/RefNo/OrderId/BranchId 키가 존재했고 라인 배열은 3개였다. 원본 GUID·고객 정보·raw payload 전체는 출력/저장하지 않았다.
- raw RefDate `2026-10-09T20:00:09.387+07:00`, OrderDate `17:38:03+07:00`, CreatedDate `19:06:16.047+07:00`, ModifiedDate `20:00:15.957+07:00` (모두 10/9). 이 표본의 RefDate에는 명시 offset이 있었다.
- synced_at `2026-10-09T13:00:20.339+00:00`, local updated_at `2026-10-12T12:00:27.89001+00:00`. 원본 시각·수집시각·로컬 갱신시각이 구분됨을 확인했다. 어느 시각도 별도 근거 없이 실제 출고시각으로 대체하지 않는다.
- 표본 header의 version/revision/sequence 이름 필드는 발견되지 않았고, 라인에는 시각·수정 버전 이름 필드가 없었다. 이 한 건으로 전체 계정의 공급자 계약 부재나 다른 모든 payload의 동일성을 단정하지 않는다. 수정 전후 raw 시계열·동일 시각 다중 수정의 순번은 여전히 미확인이다.

근거: [원본 파서·저장](../../lib/pos/cukcuk/sales-receipt-sync.ts), [volatile 비교 정책](../../lib/pos/cukcuk/sales-receipt-sync-compare.ts), `20260928210713_add_sales_receipt_split_payment.sql`. ModifiedDate-only 변화는 현재 비교에서 의도적으로 제외된다. 정상 수집에는 provider sequence CAS가 없으므로 오래된 paid/cancel snapshot의 역전 덮어쓰기를 원천 보장하지 못한다. 관리자 수정 보호와 일부 pending 상태 보호는 있지만 일반적인 POS 순번 검증의 대체가 아니다.

이번에 [source 계약 평가](../../lib/pos/cukcuk/shadow-source-contract.ts)를 구현했다. 원본/수집시각과 revision 후보를 분리하고 offset·달력 유효성을 확인한다. 임의의 높은 revision, 최신 수정시각, 로컬 revision을 넣어도 `providerSequenceVerified=false`, `automaticConfirmation=false`다. 현 CUKCUK 계약으로 자동 운영 확정을 허용하는 경로는 만들지 않았다.

## 3. 완전성·장애 복구 정책

### 현재 수집의 한계 — BLOCKED

[sync-to-sales](../../app/api/pos/cukcuk/sainvoices/sync-to-sales/route.ts)는 `Page:1`만 요청하고 `length >= limit`를 제한 도달로 표시한다. 원본 Total을 사용한 모든 페이지 ID 집합 대조는 하지 않는다. 이후 RefDate로 요청 기간을 client filtering한다. 정상 cron은 현재 영업일, final cron은 직전 영업일을 다루므로 여러 날 이전 수정/장애 구간을 자동 복구하는 보장은 없다.

헤더→라인→결제는 여러 HTTP/DB 요청으로 저장된다. 중간 실패·응답 유실에서 일부가 먼저 commit될 수 있다. 상세 RefId 불일치·실패와 결제 snapshot 누락을 탐지하는 기존 보호는 유지한다. 다만 라인 배열의 부재와 진짜 empty snapshot, 지점 혼합, pagination 중 원본 변화는 닫힌 재고 source 계약으로 더 검증해야 한다.

`isSalesSyncSourceComplete`와 `source_complete`의 기존 PASS는 해당 구현 범위에서 유효하다. 그러나 [loadPosBusinessDaySource](../../lib/ledger/pos-sales.ts)의 count/pagination은 **이미 수집된 BABA DB**의 영수증·결제 완전성 확인이다. CUKCUK 원본에서 누락된 동일 개수 거래나 아예 수집되지 않은 영수증까지 입증하지 못한다. 마감 원장 금액 일치도 재고 라인 수량 완전성 증명과 다르다.

### 확정한 탐지·복구 절차 — 실행은 하지 않음

1. Company/branch와 장애 시작 전 정상 관측까지 겹치는 고정 기간을 정한다. 현재·직전 영업일에 한정하지 않고 마지막 검증 지점 이후 관련 과거 영업일 전체를 재수집 대상으로 둔다. 검증 checkpoint가 없다면 기준점 이후 전체 구간/공급자 export부터 재구성한다.
2. Limit<=100으로 **원본 페이지 전체**를 먼저 나열하고 원본 Total·연속 페이지·중복 RefId·상세 RefId·상세 성공·의미 hash를 검증한다. 원본 API에 상한 시각 필터가 없으면 기간 밖 행을 먼저 버린 개수와 Total을 비교하면 안 된다. 전체 page-chain 증거와, offset가 검증된 RefDate/업무일 필터 결과를 별도로 남긴다.
3. 동일 조건으로 두 번째 전체 스캔을 하고 count뿐 아니라 ID 집합과 상세 의미 hash를 비교한다. 같아도 provider snapshot token 보장이 없는 한 관측 안정성일 뿐 원자 source 증명은 아니다. 삭제 tombstone/취소 유지·LastSyncDate 필터 의미·상한 포함 여부를 공급자 계약으로 확인한다.
4. 원본에만 있는 ID는 누락 후보로 상세 재조회한다. 로컬에만 있는 ID는 취소/삭제/날짜 이동/필터 차이를 재조회하고 **삭제하지 않는다**. 같은 개수라도 ID/hash 차이면 보류한다. 응답 유실은 같은 source identity/관측 키로 재조회·재시도하고 새 판매 순번을 만들지 않는다.
5. header/lines/payments를 닫힌 authoritative snapshot으로 한 번에 저장하는 수집 경계와 source ordering을 마련한 뒤 기존 원장/입고 감사와 연결한다. 이번 단계에서는 이 수집 전체를 재작성하거나 데이터 복구하지 않았다.
6. 미완료 페이지, count 불명, 상세 부재/불일치, 두 스캔 변화, 로컬 차이, source ordering/물리 시각 불명 중 하나라도 있으면 자동 확정·watermark 전진을 하지 않는다. 그 거래/기간은 증거 보완 대기다. 완전한 source 계약이 없으면 authoritative export/공급자 확인으로 범위를 닫는다.

새 `assessShadowRecovery`는 이 절차의 **읽기 전용 manifest 대조와 복구 대상 산출**이다. 150건 전체 paging과 누락 위험 5건(글렌피딕 식별자 + 나머지 합성 ID)을 검증했다. `enumerationStatus=PASS`도 공급자 기간/원자성 보장을 뜻하지 않으며 `providerWindowScopeVerified=false`, `transitionStatus=BLOCKED`다. 반환되는 재조회 ID와 고정 기간은 계획이고 실행 작업이 아니다. 재고 변경·로컬 삭제·watermark 전진은 항상 false다. 실제 전체-page 수집기/자동 장애 복구 scheduler는 미구현 차단 항목이다.

## 4. 전체 Writer 목록 — 저장소 기준

아래 Shadow 열의 ‘공통’은 이번 공통 계약/증거 전송 인터페이스를 **명시적으로 호출할 수 있음**을 뜻한다. 정상 Writer에 자동 hook을 연결하거나 signed balance writer로 바꿨다는 뜻이 아니다. 세부 감사/동시성의 운영 설치 상태는 미확인이다.

| Writer / 진입 경로 | 트랜잭션·잠금 / 중복 방지 | 기록 시각·원장 연결 | Shadow 및 전환 상태 |
|---|---|---|---|
| POS 최초 차감: apply RPC, 직접/저장 batch API, unified, sales-deductions/final cron | batch→선택 receipt→판매 receipt→후보→품목 ID 정렬 잠금, 한 RPC commit, deduction key·성공 이력 | 로그 created_at/적용시각, receipt/line/deduction/batch 링크 | 기존 판매 버전 원장 사용. 물리 이동으로 재등록 금지. 운영 source 신뢰성 BLOCKED |
| POS 수정: P1-1 prepare/apply→reprocess RPC, reprocess API/unified/cron | wrapper 판매 receipt 잠금 후 새 batch; 내부 batch receipt→batch→판매→활성 차감→품목 정렬. request+dependency key 및 reversal 연결 | 복구/새 차감 로그와 P1-1 최초 결과 보존 | P1-1 evidence 재사용, 공통 전송에서 제외. 통합 lock/revision 계약은 아직 없음 |
| POS 취소: rollback_canceled RPC / unified/cron | 판매 receipt→활성 deduction→품목 정렬, 기존 성공 fingerprint/복구 유일성 | 원거래 ref_date 기반 P0, 실제 반품 시각 아님 | 신형은 경제 취소와 물리 반환 분리. 구형 복구와의 writer fence BLOCKED |
| 빠른 저장·일반 관리자 수량 수정: items PATCH→inventory_update_with_audit_v1 | 품목 잠금 + expected item CAS, 품목/수량·로그·가격 이력 한 txn. UUID 요청키는 없음 | updated_at은 clock_timestamp와 이전+1ms, 로그 기본 시각은 실제 측정시각 아님. quick_save/edit_form | 공통 adjustment/purchase/count로 분류. 현재 quantity만 읽고 써 signed balance 전환 BLOCKED |
| 실물 확인: 같은 RPC의 stock_check 사유, 수량 불변 실사 포함 | 같은 품목 잠금, P0 count log publication 잠금 | 기준 수량 new_quantity, log ID. physical effective_at 별도 필드 없음 | 공통 count. 실제 실사 시각·측정 구간·완전성 증거 없으면 보류 |
| 신규 품목/초기 수량: items POST→inventory_create_with_receipt_v1 | inventory_item_create advisory→이름/코드 중복 검사, 품목+로그+가격·조건부 Ledger txn. source=create | 초기 수량 로그 prev=0, new=quantity, log ID, 실제 최초 입고/실사 의미는 별도 | 이번에 create 분류 추가. 초기 quantity를 임의 stock_check로 간주하지 않음 |
| 일반 입고: update_with_audit_v1의 purchase 증가, 신규 create purchase | 품목 CAS/잠금, 필수 로그; billed mode 등 조건부 Ledger 투영 | purchase log ID, supplier·billed 근거. business_date와 물리 입고시각 별개 | 공통 purchase. 입고 늦은 입력은 physical time 증거 필요 |
| 입고 정정 v3→v2→v1: items PATCH 정정 경로 | source/month advisory→payable→품목; v2 CAS→v1 감사·Ledger. 동시 family/수량 검사 | correction_of_inventory_log_id로 원입고 연결, signed delta | 공통 purchase_correction. root 부재·타 품목/잘못된 root는 차단. 과거 정정의 물리 시각은 추정하지 않음 |
| 입고 영수증 수정: inventory_apply_purchase_receipt_edit_v1 | source/month→payable→품목→원로그, qty/item CAS; 수량·정정/감사·Ledger rebook 한 txn | original+correction family, receipt-only 표시. 현 정의는 billed_amount Migration, supplier 권한은 20261030180000 패치 | 공통 signed purchase. 실사 경계·signed 현재 잔액을 사용하는 live 전환은 미완료 |
| legacy correction v1/v2 직접 service 진입점 | 현 앱은 v3 위임, v1/v2 자체 callable은 남아 있음 | 각 이전 계약의 audit/가격/투영 | 별도 Writer 우회 면으로 포함. 운영 caller/ACL 미확인, cutover fence 대상 |
| 케그 교체: inventory_apply_keg_change(replace)→replace_inventory_keg 5인자, 4인자 wrapper | request UUID advisory→품목→active/previous session, preview token·request payload replay. 직접 legacy replace는 UUID dedupe 없음 | -1 Keg, source=keg_replace; 실제 replacementAt은 session started/ended_at, log created_at과 다름 | 공통 adjustment로 물리 -1만 전달 가능. POS ml 소비와 중복 금지, Keg 재고/세션 통합 전환 BLOCKED |
| 케그 시작시각 정정 edit-start | 같은 request/품목/session 잠금, safety audit, sold/loss 재계산 | session time·audit request ID | inventory.quantity 변경 없음. timing dependency 면으로 별도 포함, 병/잔술 엔진에 ml 결과를 수량 이동으로 추가하지 않음 |
| 실제 반품·서비스/기타 물리 조정 | 현재 별도 stock return Writer 없음. 일반 save의 positive/negative signed log 이용 | 취소·cash ReturnAmount·재고 반환은 다른 사실 | 공통 physical_return은 양수 로그+physicalEventRef+시각/증거가 있어야 함. 취소에서 허위 입고 생성 금지 |
| hard DELETE: items DELETE, 선택적 POS references/재고·가격·snapshot history 삭제 | 여러 요청의 순차 삭제, 통합 qty lock/CAS/txn 아님. 승인 플래그 없으면 이력 존재를 거부 | 선택한 삭제가 최종 FK 오류 전에 일부 commit될 수 있음 | Shadow/legacy 감사 참조 보호·tombstone/전체 사전검사 정책 없이는 **전환 BLOCKED**. 이번에는 호출/수정하지 않음 |
| 원본 로그 수정: inventory/logs PATCH, metadata sync | 복수 HTTP update, 품목 supplier/가격 동기화. quantity 수치는 바꾸지 않지만 reason/unit/일자 재분류 가능 | 기존 audit 의미가 바뀔 수 있음 | 이번 fingerprint·quantity/unit drift 검사로 비교 보류. 변경을 감지할 뿐 역사 재작성/자동 복구하지 않음 |
| 품목 unit/package/활성 상태·사진·supplier alias/category metadata | unit/package는 item RPC, 활성/사진/alias 등 일부 direct UPDATE. qty 직접 변화 없음 | 일부는 로그·가격 이력, 일부 메타데이터 갱신 | 단위 변화는 기존 수량 의미를 바꿀 수 있어 live gate 필요. photo change=0은 공통에서 제외. soft inactive는 삭제 아님 |
| Ledger 입고 후보 sync/repair/rebook, snapshot/name-sync, 보관병(bar keeping), 보고 batch | 감사/회계/derived snapshot/보관병 세션만 갱신; inventory qty Writer로 확인되지 않음 | 관련 원장/일별·월별 projection | 재고에 다시 가산하지 않음. 이름에 inventory가 있어도 실제 qty Writer와 구분 |
| 과거 데이터 일회성 Migration·privileged service/raw SQL | 역사 Migration에는 category/supplier metadata 보정 등이 존재. 저장소 밖 실제 writer/배치 미확인 | 배포 시점/수동 SQL에 좌우 | 기존 Migration 재실행/운영 조사 없음. installed catalog·role/table DML fence 검증 전 BLOCKED |

주요 정의: `202606210001_add_purchase_price_to_sale_deduction_logs.sql`, `202607130001_complete_sales_receipt_inventory_deduction_lifecycle.sql`, `20261102101859_pos_reprocess_failure_persistence_and_dedup.sql`, `20261030150000_inventory_purchase_billed_amount.sql`, `20261030170000_inventory_create_with_receipt.sql`, `20260914161954_link_inventory_purchase_corrections.sql`, `20261010140729_atomic_inventory_edit_and_versioned_correction.sql`, `20261011165833_safe_same_day_inventory_correction.sql`, `202607230003_unify_keg_sales_calculation.sql`, `20261020120000_keg_safety_p0.sql`.

`apply_pos_direct_inventory_deductions`와 과거 bar keeping mutation RPC 등 제거된 경로는 현행 Writer로 계산하지 않았다. `inventory_latest_stock_checks_v1`, Keg 계산·미리보기, UI 조회·가격 로그·Ledger 마감 등도 수량 Writer가 아니다. 실제 운영 잔존 여부는 미확인이다.

## 5. 최소 구현과 시간 정렬 보완

[후속 SQL](../../supabase/migrations/20261102110828_pos_shadow_writer_contract_and_order.sql)은 파일만 작성했고 폐기 가능한 로컬 PostgreSQL에서 직접 검증했다. 운영 Migration 이력에 반영하지 않았다. 기존 Migration/Writer/트리거/앱 재고 저장 경로는 변경하지 않았다.

- `pos_shadow_inventory_writer_contract(logId, actor)`가 create/quick/edit/Keg/POS/metadata를 분류하고 원본 log hash·필요 근거를 반환한다.
- `pos_shadow_register_writer_movement`는 품목→원로그 share 잠금 후 hash CAS를 확인하고 기존 Shadow movement 등록을 재사용한다. POS는 판매 원장으로 보내 중복 물리 이동을 차단하고, root 없는 음수 입고·알 수 없는 source는 보류한다. 시각을 created_at으로 대체하지 않는다.
- 물리 반환은 명시적 양수 조정 로그와 physicalEventRef가 필요하다. 거래 취소를 반환으로 이름만 바꾸어 등록할 수 없다.
- 새로운 등록은 해석에 사용한 log ID/사유/source/수량/단위/시각/연결 ID의 hash를 보관한다. 나중에 원본 로그나 단위가 달라지면 `shadow_source_audit_changed`로 계산을 보류한다. 기존 fingerprint 없는 증거도 수량·사유·단위 불일치를 탐지하지만 완전한 provenance를 소급 증명하지는 못한다.
- dependency key에 단위와 source integrity 결과를 포함했다. 동일 수량·동일 log ID인 상태에서 증거가 정상 복원돼도 보류가 영구 유지되지 않으며, 같은 버전의 새 시도로 회복한다. 원래 실패 시도는 보존한다.
- 동시각 실사 정렬을 `(effective_at DESC, source log_id DESC)`로 변경했다. 기존 Shadow movement.id는 등록 순서라서 반대 순서 등록 시 기준점이 바뀔 수 있었다. 역순 등록과 55회 재비교로 수정 결과를 검증했다. 여러 물리 signed 이동은 정확한 numeric 합으로 계산하므로 합산 순서에 영향받지 않는다.
- 실사와 정확히 같은 시각 효과는 기존 inclusive 기준으로 흡수한다. 이는 결정적 계산 규칙이며 동일 초/불명확 측정 구간의 실제 선후를 증명하지 않는다. 그러한 입력은 경계 포함 계약/정밀도·측정 증거 없이는 운영 확정 보류다. 로그 ID 역시 임의 SQL 전체의 물리 발생순서 증명은 아니다.
- 기존 item_book의 검토된 정의 MD5 `27bbadcaa4c4ad61846b978d4f94895d`와 다르면 후속 설치를 중단한다. 새 private 함수는 직접 실행 revoke, public RPC는 service-only다. 운영 inventory·판매·로그 DML은 없다.

새 [readiness API](../../app/api/admin/sales/inventory-shadow/readiness/route.ts)는 owner/master + 기존 `POS_INVENTORY_SHADOW_MODE=shadow`에서만 동작한다. 기본 off이며 live 모드를 거부한다. source/writer/gate/recovery 평가와 명시적 증거 전송만 제공하며, 재수집·삭제·원본 수량 복구를 실행하지 않는다. `gate`는 현재 선행조건 미충족을 명시해 `replacementAllowed=false`를 반환한다.

## 6. 검증 판정

| 항목 | 판정 | 증거·범위 |
|---|---|---|
| 글렌피딕 실사 이전 정정→입고→지연 정산·55회 중복 | PASS | P1-2의 실제 구 엔진 비교 PASS 재사용. 이번 후속 함수에서 현재 delta=0, book=1.20·감사 불변·동일 관측 55회 추가 확인 |
| 실사 이후 판매 차액·부족/지연 입고·취소/실물 반품 | PASS (합성) | P1-2 유효 PASS 재사용. 이번 after-count 새 판매 delta=-1/book=0.20, 공통 signed purchase/correction/Keg/return/조정 합 검증 |
| 같은 품목 동시 수정·실사↔worker·lease 만료·중복 cron | PASS (기존 로컬 범위) | P1-2 실제 다중 세션 PASS 재사용. 기존 정상 Writer의 모든 조합 교착 안전성까지 확장하지 않음 |
| 동시각 실사·Shadow 재실행 결정성 | PASS | 원본 로그 ID 우선, 역순 등록·55회 재비교. 기존 ID 등록 순서 의존 결함 수정 |
| 원본 audit 변경·quantity/unit drift·과거 증거 보존 | PASS | source hash CAS/후속 변경 보류, 원본/Shadow 이력 diff 0 |
| POS 수정/취소 역전·응답 유실 | PASS (검증된 순번을 넣은 합성 조건), 실제 BLOCKED | 기존 lease/관측 중복·역순 거부 PASS 재사용. 실제 CUKCUK 순번·원자 응답 계약은 미입증 |
| 장애 후 누락 탐지·복구 계획 | PASS (manifest), 실행/완전성 BLOCKED | 150건/2page, 위험 5건 누락, 중복/상세 누락/같은 count의 다른 ID·hash 변화 검출. plan만 반환 |
| 모든 실제 운영 Writer 설치/ACL·배치 일치 | 미확인 | 저장소 조사만 수행. 운영 catalog/계정/실행 목록은 읽지 않음 |
| 실제 POS payload의 신뢰 버전/시각·변경 보존 | 표본 확인 / 계약 미확인·BLOCKED | 저장 raw 8111 한 건의 필드·시각 대조. 현재 provider 응답/버전 시계열·변경 보존 보장은 미확인 |
| 운영 재고 엔진 교체·P0 제거 | BLOCKED | 아래 우선순위 해소 전 승인 가능한 전환 근거가 없음 |

실행: `node --test tests/pos-shadow-writer-contract-postgres.test.mjs tests/pos-shadow-readiness-app.test.mjs`, `node --experimental-strip-types --test tests/pos-shadow-source-contract.test.ts`. 마지막 native 증거는 `.qa-review/pg-native-logs/pg-native-test-e114f86c-e3f8-4211-b3b3-5dd49d765e60-Fizxlx/`의 result/diagnostics/commands/server log다. 정상 종료·임시 데이터 정리 완료, 로그 보존. 기존 파일과 core 계산의 유효 PASS는 재사용했으며 변경된 분류·source integrity·복구 dependency·동시각 선택 범위만 재검증했다. 개발 중 실패 실행은 최종 PASS에 포함하지 않았다.

## 7. 차단 사항 우선순위 / 다음 작업

| 우선순위 | 차단 사유 | 해소 조건 |
|---|---|---|
| P0 | 신뢰 가능한 POS revision/snapshot/LastSyncDate 의미와 취소 보존 미입증 | 계정 raw 표본을 안전하게 비교하고 공급자 보장을 확인. 없으면 authoritative 기간별 manifest/export와 닫힌 관측 원장 계약을 마련. 로컬 시각·hash·관리자 revision을 순번으로 대체 금지 |
| P0 | single-page·다중 요청 저장·과거 영업일 자동 복구 부재 | 전체 원본 page-chain 및 범위/ID/hash 대조, 원자 header/lines/payments 수집 경계, 장애 구간 replay와 checkpoint 조건 구현·검증 |
| P0 | 실제 물리 시각·실사 측정 경계·모든 Writer signed balance 미연결 | 이벤트시각/수집시각/적용시각 분리 저장, 모든 수량 Writer·reader에 공통 revision/epoch·단위·signed book 계약과 구/신 이중 쓰기 fence 적용 |
| P0 | 감사 삭제/재분류와 직접 service/legacy DML 우회 | 운영 catalog·ACL·caller 인벤토리와 일치 확인, 감사 참조/삭제 정책 및 단위 변경 gate, legacy 진입점 단계적 fence. FK가 뒤늦게 막는 것만으로 사전 보호를 대체하지 않음 |
| P1 | 기존 legacy opening/정밀도 잔차·Keg session/반품 의미 | 기존 이력 보존 상태로 opening 연결을 증명하고 source 적응 범위를 닫음. 불명확한 과거 데이터를 일괄 재작성하지 않음 |
| P1 | 실제 영업 규모 관측·운영 입력·잠금 부하 미검증 | 승인된 read-only 자료→제한된 Shadow 비교→실제 실사 포함 관찰, 차이·예외·재시도 예산 검증 |

현재 허용 가능한 결과는 **로컬 합성 계산 신뢰성 검증과 명시적 자료 기반 Shadow 평가**다. `projectionComplete`나 기존 sync source_complete가 true라는 이유만으로 운영 교체를 확정하지 않는다. 이번 공통 인터페이스는 누락 Writer의 감사 전달 경계를 제공하지만 자동 hook·live writer를 만들지 않았다. 후속 운영 조사/설치/실제 복구·활성화는 각각 범위와 SQL·데이터 변경 계획을 검토해 별도 승인 후 진행한다. P0 제거는 그 뒤의 독립 단계다.

이번 로컬 커밋의 최종 SHA는 완료 응답에 기록한다.
