# 입고 수정 장부 자동 정정 및 사건 배너 검토

## 범위

로컬 소스 수정과 격리 테스트만 수행했다. Git 명령, 운영 DB 조회·변경, 운영 migration 적용, 배포, 완료된 Production 취소 거래 재실행은 수행하지 않았다.

사용자가 제공한 10/11 ID와 연결 관계를 fixture로 사용했다. 실제 금액·수량·담당자·시각은 제공되지 않아 테스트용 값을 사용했다. 운영 행의 현재 상태를 직접 확인한 결과로 해석하면 안 된다.

## 자동 정정

- API의 입고 정정 분기를 `inventory_apply_purchase_correction_v3` 한 번의 호출로 변경했다. 원입고 선택, 세션 사용자, 기존 권한 검사와 수정 충돌 검사를 유지했다.
- V3는 기존 V2 재고 정정과 기존 장부 projector/rebook 구현을 동일 트랜잭션에서 사용한다. 별도 관리자 repair RPC를 직원 대신 실행하지 않는다.
- 원입고 날짜와 서버 영업일이 같고 DB의 설정 기반 현재 영업일과도 일치해야 한다. 미지급·배분 없음·미마감·장부 수동 금액 변경 없음·경제정보와 거래처 연결이 명확한 경우에만 자동 확인을 설정한다.
- 이전 날짜, 지급/부분 지급/배분, 월마감, 수동 금액 변경, 거래처 변경·매핑 누락·모호함은 기존 관리자 확인 경로를 유지한다. 일반 직원은 관리자 repair RPC를 실행할 수 없다.
- 역분개, 기존 미납취소, 정정 장부/신규 미납, 가격 이력, 감사 로그와 수정 버전 검사를 재사용한다. 기술적 처리 실패나 필수 감사 로그 누락 시 재고까지 롤백한다.
- 정상 처리 후 같은 요청을 다시 보내면 기존 수량/버전 충돌 검사에서 거절한다. 재고 수량이나 장부 정정을 다시 생성하지 않는다.
- 지급 확인 대기(`paymentVerification: pending`)를 실제 현금 지출로 바꾸지 않고 기존 의미를 보존한다.

## 사건별 확인 배너

- 원입고 ID와 품목 ID, 명시적인 `correction_of_inventory_log_id`만으로 사건을 묶는다. 원입고와 취소 로그는 한 사건으로 집계한다.
- 품목명, 원입고 ID, 원입고 날짜, 입고 수량 전후/변화, 현재 연결 장부 금액, 최종 확인 상태와 거래처를 표시한다. 수정 모달의 수정일은 원입고 날짜와 별도로 보존한다.
- 처리 과정에는 원입고·연결 수정/취소·동일 품목의 재고조사 문맥·장부 감사 기록을 담당자와 시간 순으로 표시한다. 재고조사는 입고 수량에 합산하지 않는다.
- 장부 역분개/정정 이력은 명시적인 장부 연결 ID로 조회하고, 기존 미납취소와 금액 전후를 표시한다. 관련 로그·감사 기록은 페이지 및 ID 묶음 단위로 읽는다.
- 완료된 사건은 최신 원입고/전체 정정 가족과 장부 snapshot의 수량·가격·금액·거래처·정정 ID 반영 여부를 대조한 뒤 제외한다. 오래된 root/child 경고만 남은 경우도 제외하며, 누락된 정정이나 수동 금액 변경이 있으면 유지한다.
- 같은 품목의 독립 신규 입고, 이름만 같은 서로 다른 품목은 별개 사건이다. 미연결 수정은 원입고를 추정하여 묶지 않는다.

## 10/11 사례와 중복 생성 정책

| 품목 | 독립 사건/문맥 | 검증 |
|---|---|---|
| 토닉워터 #309 | 원입고 #12971 → 재고조사 #12982 → 취소 #13000 | #12971 한 사건, 재고조사 집계 제외, 완료 상태에서는 확인 목록 제외 |
| 토닉워터 #309 | 신규 #13001 | #12971 취소 가족과 별도 |
| 진저에일 #566 | 원입고 #12972 → 취소 #12998 | #12972 한 사건, 완료 상태에서는 확인 목록 제외, #566 비활성 유지 |
| 진저에일 #477(O6) | 재고조사 #12983 → 신규 #13002 | #566과 별도, 재고조사는 문맥으로 표시 |

기존 등록 정책은 정규화한 한국어명 또는 베트남어명이 같고 코드도 같으면 비활성 품목까지 포함해 중복 등록을 거절한다. 기존 품목 수정은 다른 활성 품목과의 동일 이름/코드 조합을 거절한다. 코드가 다르면 동일 이름이 허용된다. 이 정책과 과거 재고는 변경하지 않았다.

로컬 migration에서 이 이름/코드 정책을 직접 강제하는 DB unique 제약은 발견하지 못했다. API 사전 조회에 의존하므로 동시 신규 등록 방지까지 보장한다고 판단하지 않았다. 별도 정책/제약 검토 사항이며 이번 작업에서는 병합이나 신규 중복 제약을 추가하지 않았다.

## 신규 migration 별도 검토 요청

`supabase/migrations/20261011161314_safe_same_day_inventory_correction.sql`은 **미적용 검토 파일**이다.

- 신규 함수: `public.inventory_apply_purchase_correction_v3(bigint,bigint,numeric,jsonb,jsonb,date,bigint)`.
- 기존 함수/테이블/제약 수정 없음. 데이터 backfill/기존 취소 재실행 없음.
- `SECURITY DEFINER`, 고정 search_path, 기존 actor·item·경제정보 보호 검사 재사용. PUBLIC/anon/authenticated 실행 금지, service_role에만 EXECUTE 허용. private helper 권한 변경 없음.
- 선행 의존성: 기존 atomic V2, 경제정보 repair 검사, source projector/rebook 및 `store_business_date_for_timestamp_v1`.
- 향후 적용 전 함수·권한과 선행 migration의 운영 상태를 별도 검토해야 한다. 앱의 V3 호출은 migration 이후 사용 가능하며, 함수가 없으면 저장 요청은 실패하고 구버전/분리 호출로 우회하지 않는다.
- 향후 코드 롤백 시 API 호출 변경과 신규 V3 함수를 함께 검토한다. 이미 생성한 역분개·미납·감사 기록을 삭제하거나 재실행하는 롤백은 하지 않는다.

## 수정 파일

애플리케이션:
- `app/api/inventory/items/route.ts`
- `lib/inventory/purchase-cases.ts`
- `lib/ledger/purchase-case-loader.ts`
- `lib/ledger/inventory-display.ts`
- `app/(protected)/admin/ledger/entries/page.tsx`
- `components/ledger/InventoryPurchaseCaseSummary.tsx`
- `components/ledger/InventoryPurchaseCaseSummary.module.css`
- `components/ledger/InventoryProjectionResolution.tsx`
- 신규 migration 1개(위 참조).

테스트:
- `tests/inventory-safe-correction-db.test.mjs`
- `tests/inventory-safe-correction-postgres.test.mjs`
- `tests/helpers/inventory-safe-correction-fixture.mjs`
- `tests/inventory-purchase-cases.test.ts`
- `tests/inventory-purchase-case-loader.test.mjs`
- `tests/inventory-purchase-cases-browser.test.mjs`
- `tests/inventory-items-final-validation.test.mjs`
- `tests/inventory-ledger-projection-api.test.mjs`
- `tests/ledger-inventory-supplier-display.test.mjs`

## 검증

- 최종 관련 회귀 및 native PostgreSQL: 201/201 통과. 결과는 `.qa-review/purchase-cases-final-regression.txt`.
- 추가 자동 정정 DB 검증: 26/26 통과. 지급 확인 대기 보존, 직원 권한, 미마감/미지급 조건, 모든 필수 쓰기 실패·감사 기록 누락의 전체 롤백, 중복 요청과 비활성 품목 보존 포함.
- 실제 로컬 PostgreSQL 18.4에서 두 세션의 동시 정정·지급 처리·월마감 경합 검증 통과. 데드락 0.
- KO/VI × PC/모바일 4조합: 사건 목록·수량·장부금액·상태·담당자/시간 순서·재고조사 집계 제외·완료 사건 제외·가로 넘침 없음 통과. 기존 동기화 배너/관리자 승인 브라우저 회귀도 4조합 통과. 모든 API를 모킹하여 운영 데이터에 접근하지 않았다.
- 변경 애플리케이션 파일 ESLint 통과.
- 전체 TypeScript 검사는 기존 오류 40건으로 미통과. 수정/신규 파일의 오류는 없다. 기존 프로젝트 오류는 이 작업에서 수정하지 않았다.
- 화면 증거: `.qa-review/purchase-cases-browser/ko-desktop.png`, `ko-mobile.png`, `vi-desktop.png`, `vi-mobile.png`.
