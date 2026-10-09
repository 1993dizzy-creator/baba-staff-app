# 입고 취소·금액변동 장부 반영 수정 검토

2026-10-09. 로컬 소스 및 격리 테스트만 수행했다. 운영 DB 연결·변경, 운영 배포, Git 명령은 수행하지 않았다. 기존 migration은 수정하지 않았다. #12655는 합성 격리 fixture로 회귀 검증했으며 운영 복구를 재실행하지 않았다.

## 1. 변경 파일

- `supabase/migrations/20261009080243_detect_inventory_purchase_economic_corrections.sql`
- `app/api/inventory/items/route.ts`
- `app/(protected)/admin/ledger/entries/page.tsx`
- `app/(protected)/admin/ledger/entries/entries.module.css`
- `components/ledger/InventoryProjectionResolution.tsx`
- `components/ledger/InventoryProjectionResolution.module.css`
- `lib/inventory/purchase-repair-contract.ts`
- `lib/ledger/inventory-display.ts`
- `package.json`
- `tests/purchase-economic-db.test.mjs`
- `tests/inventory-purchase-repair-api.test.mjs`
- `tests/inventory-ledger-projection-api.test.mjs`
- `tests/ledger-inventory-supplier-display.test.mjs`
- 이 보고서 및 `artifacts/purchase-economic-ui/`, `artifacts/purchase-economic-validation/`의 검증 증거.

## 2. 정확한 원인

`ledger_project_inventory_purchase_log_v1`은 원입고 참조가 없는 음수 구매 로그를 `source='edit_form'`일 때만 `review_required / PURCHASE_CORRECTION_REFERENCE_REQUIRED`로 분류했다. `quick_save` 취소는 `synced / NOT_A_PURCHASE`로 저장되었다. 경고 조회도 synced를 제외하여 누락이 화면에 드러나지 않았다.

`inspect_purchase_repair`와 repair preview는 해당 review 상태와 edit_form 출처만 허용하므로 기존 #12008은 `ISSUE_NOT_RESOLVABLE`이었다. 연결 트리거에도 edit_form 제한이 있어 세 함수만 바꾸어서는 정정할 수 없었다.

추가로 수정 로그 ID 목록 자체가 경제 비교에 포함되어 품목명만 수정한 연결 로그도 금액변동으로 오인할 수 있었다. Inventory PATCH에는 동일 날짜의 stock_check/other 변경을 최근 입고에 자동 연결하는 경로가 있어 구매 의도 없는 재고 변경도 구매 정정으로 바뀔 수 있었다.

## 3. 처리 흐름

| 경우 | 변경 후 |
|---|---|
| 참조 없는 quick_save/edit_form 구매 감소 | 관리자에게 원입고 연결 확인 요구. 최근 로그·7초 간격·최종 재고만으로 자동 연결하지 않음 |
| 원입고가 명확한 수량·단가·거래처 변경 | 경제 비교 후 확인 필요. 관리자 확인 RPC 이전에는 반전·재기장하지 않음 |
| 원입고 가족의 유효 수량 0 | 원본 입고 취소 표시. 관리자가 확인하면 기존 reversal-only 절차 실행 |
| 품목명·메모 등 비경제 변경 | 즉시 synced/metadata 처리. 원본 거래와 금액 보존 |
| 일반 재고조사·판매·기타 변경 | 구매 취소로 자동 연결하지 않음 |
| 원입고 후보 여러 건 | 미리보기에서 추천하지 않고 관리자가 선택 |
| 지급·부분 지급·배분 이력·현금 지급 | 정정 차단. 기존 거래·현금 이동 보존 |
| 관련 발생월·인식월·수정월 마감 | 정정 차단. 기존 월마감 절차를 통해 검토 |
| 동일 정정 요청 반복 | 연결 및 원본 snapshot을 확인한 감사 결과 재사용. 중복 거래·미납·감사 정정 없음 |

읽기 전용 경고 조회는 과거 `synced / NOT_A_PURCHASE` 중 `reason='purchase'`, `source='quick_save'`, 음수 수량인 로그만 추가로 노출한다. DB backfill을 하지 않는다. 미리보기는 조언이며 POST에서 원본·거래·후보·미납 및 관련 월을 기존 정렬된 잠금 아래 다시 검사한다. 실패하면 연결·반전·미납·감사를 함께 rollback한다.

KO/VI에 취소, 금액변경 확인, 원입고 연결 확인, 정정 완료를 구분한다. 상세 화면에는 정확한 변경 전후 수량·금액과 거래처 변경 전후를 표시하며 모바일 sheet·focus 복귀·기존 오류 안내를 유지한다.

## 4. 신규 migration 및 주요 SQL

`20261009080243_detect_inventory_purchase_economic_corrections.sql`

- `economics(jsonb)`: 표시 필드·메모·`inventory_correction_log_ids`를 경제 비교에서 제외한다.
- `inventory_purchase_correction_guard_v1()`: quick_save/edit_form을 동일하게 허용하고 품목·단위·유효 수량·단가·불변 연결을 검증한다. 거래처 변화는 관리자 정정 검증으로 처리한다.
- `ledger_project_inventory_purchase_log_v1(bigint,bigint)`: 기존 함수 정의에 검증된 contract anchor로 변경한다. anchor 불일치 시 migration 전체를 중단한다. 최신 연결 수정 로그의 단가·거래처·품목 표시를 반영하고 경제적 변경에 확인 gate를 둔다.
- `inspect_purchase_repair(bigint,bigint)`, preview, resolve: 과거 잘못 분류된 quick_save 취소, 이미 연결된 수정 및 기존 원입고의 직접 경제적 drift를 검증한다. 이미 현금 지급된 구매는 차단한다.
- 확인 gate는 owner/master 검사 후 원자적 resolver 안에서만 transaction-local 설정으로 열고 즉시 원래 값으로 복원한다. 실패 시 subtransaction이 rollback한다.
- PUBLIC/anon/authenticated에 RPC 권한을 주지 않는다. preview/resolve만 service_role에 EXECUTE를 유지한다. private helper와 trigger 함수는 service_role을 포함해 직접 호출을 금지한다.
- 테이블·제약·인덱스 신설, 운영 행 backfill, 월마감 해제, 운영 거래 정정 SQL은 없다. 기존 reversal/rebook 함수를 재사용한다.

## 5. 테스트 결과와 범위

- `npm run test:purchase-economic`: **43 통과 / 0 실패**. 실제 migration·projection·guard·repair SQL을 PGlite 안에서 실행하고 API/React UI를 검증한다.
- `npm run test:inventory-ledger`: **349건 중 348 통과 / 1 실패**. 남은 실패는 기존 `tests/ledger-payroll-advance.test.ts:266`의 EntryFlags JSX 문자열 개수 기대값 2와 실제 1의 불일치다. 변경 전 첫 회귀 실행에서도 동일 실패가 있었고 이 작업은 가불 표시 구간을 변경하지 않았다. 무관한 기능 수정은 하지 않았다.
- Chrome 실제 컴포넌트·CSS 검증: **10 통과 / 0 실패**. KO/VI × 320/360/390/430/768px에서 배너, 상세, 정정 완료, 가로 overflow 부재를 확인했다. 스크린샷과 `artifacts/purchase-economic-ui/results.json`을 남겼다.
- 포함한 시나리오: quick_save 전량·부분 취소, edit_form 수정, 품목명·메모 변경, 단가·거래처 변경, 복수 원입고, 지급·부분 지급·현금 지급·배분, 마감 월, 반복 요청, #12655 합성 회귀, 수량 초과·수동 장부 override·권한 제한·실패 rollback.

월마감 검증은 실제 `ledger_reopen_month_v1`/`ledger_close_month_v1` SQL로 revision 2 보관 및 revision 3 생성을 검사했다. 다른 사업 영역은 deterministic preflight fixture로 격리했으며 실 운영 전체 preflight, 실제 운영 데이터 복제, 다중 PostgreSQL 세션 경쟁 검증은 수행하지 않았다. 브라우저 검증은 실제 컴포넌트와 CSS를 사용하고 fetch만 격리 응답으로 대체했다. 운영 로그인/API/DB까지 연결한 테스트는 아니다.

## 6. ESLint·빌드

- 수정 TS/TSX/테스트 파일 ESLint: **0 오류 / 0 경고**.
- 전체 소스 ESLint(`.tmp`, artifacts 제외): **기존 오류 4 / 경고 4**, 실패. mypage, app/page, language-context의 effect state 변경과 기존 ledger-manual-amount-edit DB 테스트의 `module` 변수 규칙 위반이다.
- 기본 `npm run lint`는 임시 bundle/cache까지 검사하여 127 오류·4,486 경고가 발생했다. 검토 가능한 전체 소스 결과는 위의 임시 산출물 제외 검사로 별도 보관했다.
- `npm run build`: 성공. Next.js 16.2.1 컴파일, TypeScript, 72개 정적 페이지 생성 통과. 빌드만 수행했으며 배포하지 않았다.

## 7. Milan Food 예상 정정 영향

운영 값을 조회하거나 변경하지 않았으며 아래는 제공된 사례와 합성 fixture의 검증 결과다.

| 대상 | 전 | 정식 정정 후 예상 |
|---|---|---|
| 원입고 #12007 / 취소 #12008 | 연결 없이 장부 누락 | 원본 두 로그 보존, #12008의 명시적 원입고 연결 및 감사 추가 |
| 후보 #1364 | confirmed, 80,000₫ | dismissed / Inventory purchase fully cancelled |
| 매입 #1962 | 80,000₫ | 원본 보존 + 80,000₫ 반전 1건. 재매입·0원 거래 없음 |
| 활성 경제적 매입비 | 80,000₫ | 원본과 반전의 순액 0₫ |
| 미납 #866 | unpaid, 80,000₫ | cancelled로 보존. 활성 미납 0₫. 새 미납 없음 |
| 실제 현금 이동 | 0₫ | 0₫, 계정잔액 변화 없음 |
| 9월 최종 보유금 | 338,845,642₫ | 338,845,642₫ 불변 |
| 9월 운영손익 | 취소 매입비 포함 | 해당 비용 80,000₫ 제거로 이익 80,000₫ 증가. 현금 보유금과 구분 |
| 9월 월마감 | revision 2 closed | 승인된 해제→정정→재마감 시 revision 2 history 보존, revision 3 생성 |

기존 정상 거래, 기존 계정잔액, 재고 수량은 수정하지 않는다. 운영 전체 손익 및 마감 snapshot 변화는 승인된 정정 전에 다시 계산해야 한다.

## 8. 운영 반영 전 절차

1. GPT 검토 후 별도의 명시적 운영 승인 필요. 이 보고서는 운영 적용 승인 요청이나 실행 결과가 아니다. 먼저 기존 migration history와 현재 함수 정의를 읽기 전용으로 비교한다. 20261007182027의 적용 여부, 후속 migration 및 contract anchor를 확인하고 불일치한 상태에서 db push하지 않는다.
2. 대상 migration의 위 함수 변경·권한·데이터 backfill 없음과 복구 방안을 보고하고 검토한다. 배포와 DB migration은 별도 승인 범위다. 운영 DB 복제/스테이징의 전체 migration 및 전체 월마감 preflight와 동시 요청 검증을 추가한다. 남아 있는 회귀/ESLint 실패도 담당자가 검토한다.
3. 운영에서 #12007/#12008/#1364/#1962/#866의 실제 연결, 공급자, 수량·단가·날짜·금액, 지급/배분/수동 정정, 중복 반전, 관련 월을 읽기 전용으로 재확인한다. 새 정정 예상 대상은 원입고 연결 1건, 후보 1건, 미납 취소 1건, 반전 추가 1건이며 실제 상태가 다르면 중단한다.
4. 9월 revision 2 snapshot/hash와 계정별 잔액, 현금 이동, 미납, 손익, 최종 보유금 338,845,642₫을 보관한다. 월마감 해제 시 기존 API/RPC의 owner/master·사유·후속 마감 월 보호를 따른다. 이후 월이 이미 마감되었다면 `later_month_closed`를 우회하지 않는다.
5. 승인이 된 경우에만 기존 월마감 해제 UI/API를 이용한다. 새 migration 및 앱 코드 준비 후 preview에서 #12007을 직접 선택하고 #12008에 정정 확인을 요청한다. 본 사례의 기대 새 금액은 0₫이다. 기존 #12655 복구는 실행하지 않는다. 운영 테이블 직접 UPDATE/DELETE 또는 상태 강제 변경으로 정정하지 않는다.
6. 정정 감사·원본 보존·반전 1건·새 미납 없음·활성 미납 감소 80,000₫·경제적 비용 감소 80,000₫·현금 이동 0₫·계정별 잔액 불변을 확인한다. 정상적인 전체 preflight와 새 summary/hash를 다시 생성한 뒤 재마감한다. revision 2 archive 및 revision 3 snapshot, 최종 보유금 불변을 확인한다.
7. migration history, 모든 변경 함수의 정의/인자, PUBLIC/anon/authenticated/service_role 권한, 예상 행 수·다른 거래 불변, 감사 로그, Security/Performance Advisor를 확인한다. SQL Editor 수동 적용은 migration history 자동 등록이 아니므로 별도로 관리한다.
8. 실패한 정정은 RPC 안에서 전부 rollback된다. 성공 후 복구가 필요하면 원본/감사/반전을 삭제하지 말고 별도 승인된 정식 역정정과 재마감 절차를 사용한다. migration 롤백도 기존 적용 파일을 편집하지 않고 후속 migration으로 준비한다. 미리 보관한 함수 정의를 기준으로 변경 범위만 복구하며 정상 거래를 일괄 backfill하지 않는다.
