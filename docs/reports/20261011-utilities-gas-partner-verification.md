# 공과금 거래처·가스 구매 분류 구현 및 검증 — 2026-10-11

## 결과

소스에 utilities 대분류(공과금 / Điện nước & gas, ⚡)를 추가했다. 기존 중분류 #43의 utility_gas를 그대로 사용하며, #43을 생성하거나 삭제된 #38을 복구하는 SQL은 없다. 운영 거래처 #21은 변경하지 않았다.

신규 구매에만 품목 #342와 원입고 거래처 #21의 명시적인 식별자가 모두 일치할 때 category_id=23을 사용한다. 전체 기타 재고 매핑은 그대로다. 과거 구매, 기존 후보, 지급 및 월마감 데이터를 재분류하는 backfill은 없다.

## 수정 파일 전체 목록

### 애플리케이션 소스 5개

1. `lib/partners/policy.ts` — PartnerType, 허용 목록, 목록 그룹 순서에 utilities 추가.
2. `lib/partners/text.ts` — KO/VI 대분류 라벨 추가.
3. `lib/partners/emoji.ts` — utilities의 ⚡ 추가.
4. `lib/ledger/manual-entry-policy.ts` — 수동 장부 그룹과 라벨 추가, utilities + utility_gas → 가스비. 삭제된 other + gas 매핑 제거. 다른 수동 비용 매핑 유지.
5. `lib/ledger/inventory-candidates.ts` — 기존 배치 로더에서도 원입고의 purchase_supplier_partner_id를 조회하고 snapshot에 전달. null인 경우 필드를 추가하지 않아 기존 null-ID fingerprint 형식을 유지.

### 테스트 5개

6. `lib/ledger/manual-entry-policy.test.ts` — 가스 수동 분류 계약을 새 조합으로 갱신.
7. `tests/business-partner-info-grouping.test.ts` — 공식 대분류 정렬 순서 갱신.
8. `tests/utilities-partner-policy.test.mjs` — 신규 분류 파싱·KO/VI·그룹·이모지·수동 매핑·실제 등록/수정 API 계약·원입고 ID 전달.
9. `tests/utilities-gas-purchase-db.test.mjs` — 실제 migration과 기존 PostgreSQL 함수 실행을 포함하는 격리 DB 테스트 13건.
10. `tests/utilities-partner-browser.test.mjs` — 실제 공통 거래처 컴포넌트의 KO/VI × PC/모바일 등록·수정·그룹·중분류 선택 검증.

### 신규 migration 2개

11. `supabase/migrations/20261010180457_scope_gas_inventory_purchase_category.sql`
12. `supabase/migrations/20261010181400_reclassify_petrolimex_partner_utilities.sql`

### 보고서

13. `docs/reports/20261011-utilities-gas-partner-verification.md` — 이 문서.

기존 migration은 수정하지 않았다. PartnerForm, CandidatePartnerReviewForm, PartnerSubtypeManager, PartnerSettingsPanel은 기존 공통 상수·라벨·그룹 로직을 그대로 재사용하므로 별도 TSX 변경이 필요하지 않았다. 전체 PartnerType 참조를 검색하고 TypeScript로 누락된 Record 키를 확인했다.

## 신규 SQL의 목적 및 범위

### 20261010180457_scope_gas_inventory_purchase_category.sql

- 비공개 `inventory_ledger_private.purchase_category_rules` 테이블에 단 하나의 규칙(342, 21, 23)을 등록한다. 적용 시각 starts_at을 기록한다.
- 현재 품목·거래처 연결, 거래처 이름/활성/후불, 기존 장부 거래처 #21 연결과 기본 가스비 #23을 확인한다. 의존성이 다르면 중단한다.
- STABLE 보조 함수 `inventory_ledger_private.purchase_category_for_new_source_v1(jsonb,bigint)`를 추가한다.
- 원입고 로그와 snapshot의 품목·구매 거래처 ID를 대조한다. 이름 검색이나 현재 품목 마스터로 가스를 추정하지 않는다.
- 규칙 적용 이후 생성된 양수 원입고이며 영업일도 적용 영업일 이후인 경우에만 적용한다. 영업일은 기존 Asia/Ho_Chi_Minh 03:00 기준이다. 오래된 미처리 입고와 과거 날짜로 입력한 입고는 기존 매핑을 따른다.
- `inventory_ledger_private.sync_candidate(jsonb,bigint)`와 기존 `public.ledger_sync_inventory_candidates_core_v1(jsonb,bigint)`의 분류 조회 위치만 좁게 수정한다. 기존 최신 후보가 있는 경우 신규 규칙으로 덮어쓰지 않는다.
- 기존 배치 경로에서도 해당 가스 조합에 한해 마스터가 아니라 원입고 거래처 ID로 장부 거래처를 선택한다.
- pg_get_functiondef로 실제 설치된 함수 본문을 읽어 검증한 anchor만 바꾼다. 전체 함수를 과거 정의로 덮어쓰지 않는다. anchor가 없거나 중복되면 transaction 전체를 중단한다. 기존 실행 권한, 함수 속성, 잠금, 정정, 월마감, rebook, 미납·감사 정책을 유지한다.
- 테이블 RLS를 켜고 PUBLIC/anon/authenticated/service_role의 테이블 및 보조 함수 직접 접근을 차단한다. 기존 보안 정의자 함수 내부에서만 사용한다.

### 20261010181400_reclassify_petrolimex_partner_utilities.sql

- 새 앱 배포·실사용 확인 뒤 별도로 실행한다. #43은 기존 참조만 사용한다.
- #21을 잠근 뒤 기존 이름·후불·활성 상태, #43의 코드/대분류, 장부 거래처 #21·기본 분류 #23, 재고 #342 연결, 첫 migration 규칙을 확인한다.
- 기존 consumable / NULL 상태만 utilities / 43으로 이동한다. 이미 utilities / 43이면 아무 변경도 하지 않는 재실행 안전 경로다. 다른 분류로 바뀌었으면 덮어쓰지 않고 중단한다.
- 대분류·중분류·updated_at만 바꾼다. payment_mode, settlement_mode/rule, default_payment_term_days, 출금 기본값, 이름, 활성 상태, 연결 및 과거 이력은 보존한다.
- 실제 작업자의 활성 owner/master ID를 같은 DB 세션의 `baba.migration_actor_user_id` 설정으로 받아 검증한다. 임의의 사용자를 선택하거나 기본 actor를 만들지 않는다. actor가 없거나 권한이 없으면 중단한다.
- 기존 business_partner_audit_logs에 before/after를 기록한다. 수정과 감사 로그는 함께 commit하거나 함께 rollback한다.
- 기존 거래처 수정 API가 후불 조건을 정규화하기 때문에, 기존 지급조건을 엄밀히 보존하는 분류 이동에는 이 제한된 migration을 사용한다.

## UI 및 실제 처리 경로

- 거래처 등록/수정 및 후보 승인: 공통 PARTNER_TYPES와 partnerTypeLabels를 사용해 utilities 선택 가능.
- 중분류 관리/선택: 기존 GET 응답의 #43을 partnerType=utilities로 필터링한다. #43을 다시 만들지 않는다.
- 거래처 설정 목록: 기존 groupPartnersByTypeAndSubtype에서 ⚡ 공과금 → 가스 → 거래처로 표시한다. KO/VI와 기존 활성/비활성 필터 유지.
- 수동 장부 GET은 공통 manualExpenseCategoryNameForPartner를 통해 #21의 수동 기본 category를 가스비로 제안한다. POST도 DB에서 partner/subtype을 다시 읽고 같은 규칙으로 실제 비용 분류를 검증한다.
- 신규 재고 입고: `/api/inventory/items`가 구매 로그에 실제 supplier_partner_id를 purchase_supplier_partner_id로 저장 → `projectInventoryPurchaseLog` → `ledger_project_inventory_purchase_log_v1` → 비공개 sync_candidate → 신규 후보 분류 규칙 → 기존 resolve_candidate의 payable 확정.
- 후불 #21은 가스 비용과 미납을 만들며 입고 시 출금 movement를 만들지 않는다. 지급은 기존 ledger_pay_payables_v1과 결제 배분·감사 로그를 사용한다.
- 월 단위 입고 동기화 API는 기존 ledger_reconcile_inventory_month_v1를 통해 같은 원입고 projection 경로를 사용한다.
- 로컬 설치 함수에서는 ledger_parties.default_category_id를 입고 비용 선택의 일반 우선값으로 참조하지 않았다. 그래서 모든 거래처 기본 분류를 우선하는 변경 대신 정확한 가스 품목·거래처 조합만 추가했다. #21의 기본 분류 #23은 migration 의존성 검증과 기존 수동 흐름에 유지한다.

## 과거 데이터 보호 및 테스트

- 격리 fixture에서 거래 #1611(9/5, 2,920,000₫), 지급 #2488(10/8, 2,920,000₫), 손익 대상이 아닌 잔액 조정 #2489(9₫), 구매 #2487(10/9, 2,790,000₫), 지급된 #705와 미납 #1162, 9월 closed/revision 3을 재현했다.
- 두 migration과 분류 이동 전후의 transaction/payable/movement/closure 전체 JSON을 비교해 불변을 확인했다. 지급 계정·날짜·분류·금액·지급 상태도 비교 대상이다.
- #21의 기존 후불 지급조건을 scheduled/net_days/7로 재현해 분류 이동이 그 조건을 보존함을 확인했다.
- 새 #342/#21 구매는 가스비, 다른 품목·거래처·ID 없는 gas 이름은 기존 기타 재고매입. 원입고 후 마스터 거래처가 바뀌어도 원입고 지급 거래처 보존.
- 신규 미납의 기존 결제 RPC 정산, 지급 후 원입고 금액 drift 차단, 재시도 멱등성 통과.
- 감사 실패/잘못된 actor/중분류가 바뀐 상황에서 분류 이동 rollback. 이미 이동한 #21 재실행은 중복 감사 없이 no-op.
- 함수 본문이 예상과 다르면 신규 DDL·규칙 생성까지 전체 rollback.
- 기존 pending 후보·과거 미처리 원입고·월마감·결제 배분·수동 수정·수정 충돌·Ledger rebook 회귀 유지.

## 검증 결과 및 실패 항목

- 관련 단위/API/거래처·장부·입고·DB 회귀: **506/506 통과**.
- 신규 가스 격리 DB: **13/13 통과**(위 506건에 포함). 최종 fixture의 지급 거래도 실제 payable_payment 유형으로 재검증했다.
- KO/VI × 데스크톱/모바일 브라우저 4조합 통과. 실제 공통 화면 컴포넌트, API 모킹, 가로 overflow 없음. 실제 로그인과 운영 데이터 변경은 사용하지 않았다.
- 변경 소스·신규 테스트 ESLint 통과.
- `next build --webpack`: **종료 코드 0**, 컴파일·빌드 TypeScript·72개 정적 페이지 생성 완료. 검사 우회 설정을 추가하지 않았다.
- 전체 `tsc --noEmit`: **기존 오류 40건으로 실패, 신규 오류 0건**. 기존 감사 목록과 파일·TS 코드·진단 메시지를 대조했다. TS5097 32건, TS2322 4건, TS2339 1건, TS18048 3건이며 기존 테스트 파일의 진단이다. 이번 범위에서는 수정하지 않았다.
- 운영 함수 정의 SELECT는 도구가 승인을 요구했으나 현재 승인 정책상 실행할 수 없어 차단됐다. 로컬 migration으로 구성한 실제 PostgreSQL 함수만 검증했으며 운영 함수와의 동일성을 주장하지 않는다. SQL 계약 guard가 예상치 못한 운영 본문을 덮어쓰지 않도록 한다.

증거 파일: `.qa-review/utilities-regression-final.txt`, `utilities-db.txt`, `utilities-browser.txt`, `utilities-tsc.txt`, `utilities-eslint.txt`, `utilities-db-eslint-final.txt`, `utilities-build-final.txt`.
화면 캡처: `.qa-review/utilities-browser/ko-desktop.png`, `ko-mobile.png`, `vi-desktop.png`, `vi-mobile.png`.

## Production 적용 필요 단계 및 순서

현재 운영 반영은 전혀 하지 않았다. 승인된 적용 작업에서는 다음 순서를 지킨다.

1. **읽기 전용 사전 대조**: 운영 migration history 및 두 후보 생성 함수의 정의/권한, #21·#43·#342·비용 #23과 장부 연결을 확인한다. 로컬에서 이미 적용된 migration을 중복 실행하거나 미적용된 무관 migration을 일괄 적용하지 않는다. 위 보호 대상 거래·미납·마감의 값을 기록한다.
2. **utilities를 지원하는 앱 소스 배포**: 등록·수정에서 utilities / #43이 표시되는지 실제 KO/VI에서 확인한다. 이 단계가 끝나기 전에 #21의 대분류를 바꾸지 않는다.
3. **첫 신규 migration 적용**: `20261010180457_scope_gas_inventory_purchase_category.sql`을 적용해 앞으로의 정확한 가스 조합에 대한 규칙을 설치한다. starts_at과 실제 함수 amendment/권한을 확인한다. 기존 재고·구매·장부·미납 backfill은 하지 않는다.
4. **실제 manager actor를 지정하고 두 번째 migration 적용**: 동일한 migration 실행 세션에서 실제 작업자인 활성 owner/master의 ID를 지정한 뒤 `20261010181400_reclassify_petrolimex_partner_utilities.sql`을 실행한다. 예시는 계획이며 이번 작업에서 실행하지 않았다:

   ```sql
   -- <실제 작업자 ID>는 적용 담당자가 확인한 값으로 대체한다.
   select set_config('baba.migration_actor_user_id', '<실제 작업자 ID>', false);
   -- 반드시 위 설정과 동일한 DB 세션에서 두 번째 migration 파일을 실행한다.
   reset baba.migration_actor_user_id;
   ```

   실제 배포 runner가 이 세션 설정을 전달할 수 있는지 먼저 확인한다. actor 없이 자동으로 실행하면 안전하게 실패한다. migration history는 사용한 승인된 적용 도구의 절차에 맞게 기록한다. SQL Editor 실행만으로 원격 migration history가 자동 기록된다고 가정하지 않는다.
5. **사후 읽기 전용 검증**: #21 utilities/43/postpaid/active, #43 유지·#38 부재, #342 및 장부 #21 연결, 감사 before/after, 기존 지급조건·보호 대상 장부 값·미납 상태·9월 closed/revision 3, 함수와 PUBLIC/anon/authenticated/service_role 권한 및 Advisor를 확인한다.
6. **실사용 확인**: 정상 업무로 생성되는 다음 가스 구매에서 비용 #23·미납 거래처 #21·무출금 상태를 확인하고, 일반 기타 재고는 기존 분류를 유지하는지 확인한다. 검증용 운영 입고·지급 데이터를 임의 생성하지 않는다.

분류 이동 뒤 utilities를 모르는 구버전 앱으로 먼저 되돌리지 않는다. 복구가 필요하면 별도로 검토한 후속 migration으로 분류 메타데이터와 감사만 복원하며 과거 장부를 재처리하지 않는다.

운영 DB 실제 데이터 수정, migration 적용, 배포, Git 명령을 실행하지 않았다.
