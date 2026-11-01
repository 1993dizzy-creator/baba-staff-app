# 입고 수정 장부 확인 배너 UI 개선 검증 — 2026-10-18

## 적용 범위와 구현 위치

요청한 문구의 실제 구현은 재고관리 페이지가 아니라 `/admin/ledger/entries`의 입고 수정 경고 영역에 있었다. 이 배너와 공유 표시 컴포넌트를 수정했다.

기존에는 전체 목록을 먼저 펼친 다음 각 건의 원입고 ID, 수량, 장부 금액, 최종 상태, 처리 과정을 읽어야 했다. 이제 목록은 기본으로 보이며 품목명 → 입고 날짜·거래처 → 핵심 확인 사유 → 변경 값 → 상세보기 순서로 표시된다. 해결하기는 각 항목 옆에 유지했다.

- 상단: **⚠ 장부 확인 필요 3건**
- 사유 집계: **사유별(중복 포함): 금액 변경 1건 · 거래처 변경 2건**
- 동일한 수량·금액은 기본 목록에서 숨긴다.
- 세 항목이 동시에 바뀌면 금액·수량을 한 요약 행에 묶고 거래처를 두 번째 행에 표시한다. 긴 값은 화면 너비에 따라 줄바꿈된다.
- 자료가 없거나 원입고 후보가 여러 개면 차액을 추정하지 않고 상세 확인 안내를 표시한다.
- 확인된 변화가 0이어도 목록 필터링이나 자동 해결을 하지 않는다.
- 상세보기에는 원입고/처리 대상 ID, 기존 수량·장부금액·상태, 장부 반영 당시 스냅샷과 현재 입고 기록, 서버 미리보기의 수정 전후 값, 기술적 사유 코드, 기존 시간순 이력을 표시한다.
- 해결 모달의 승인·차단·재조회·완료 후 새로고침 로직은 유지했다. 반복 상태 문구만 배너에서 숨기는 선택적 compact 속성을 추가했다.

## 현재 확인 대기 3건 — 읽기 전용 검증

운영 조회는 기존 Supabase 클라이언트의 SELECT와 이미 구현된 읽기 전용 `ledger_inventory_purchase_repair_preview_v1`만 사용했다. 미리보기의 로컬 Migration 정의를 먼저 확인했다. 변경용 RPC는 실행하지 않았다. MCP SELECT 도구는 승인 정책 때문에 거절되어 기존 로컬 설정을 통한 읽기 전용 경로로 조사했다. 자격 증명과 확인용 fingerprint는 보고서·소스에 기록하지 않았다.

| 품목 / 원입고 | 날짜 | 장부 기록과 현재 수정 내용 | 기본 목록 |
| --- | --- | --- | --- |
| 노란 멜론 / #13085 | 2026-10-12 | 장부 수량 2.2Kg, 당시 단가 32,000₫, 확정 장부 70,400₫. 현재 입고 단가 38,000₫. 서버 미리보기 newAmount 83,600₫ / delta +13,200₫ / quantityDelta 0. 거래처 Chợ 유지. | 금액 변경 확인 필요 / 금액: 70,400₫ → 83,600₫ (+13,200₫) |
| 슈웹스 토닉워터(노란색) 320ml / #13297 | 2026-10-15 | 수량 48Lon, 금액 480,000₫ 유지. 확정 장부 스냅샷 Dabaco → 현재 입고 Ok Mart. 미리보기는 SUPPLIER_CHANGE_CONFIRMATION_REQUIRED. | 거래처 변경 확인 필요 / 거래처: Dabaco → Ok Mart |
| 방울토마토 / #13477 | 2026-10-17 | 수량 1Kg, 금액 50,000₫ 유지. 확정 장부 스냅샷 Trung Đông → 현재 입고 Chợ. 미리보기는 SUPPLIER_CHANGE_CONFIRMATION_REQUIRED. | 거래처 변경 확인 필요 / 거래처: Trung Đông → Chợ |

확정 장부 거래 #2553, #2632, #2775의 금액과 confirmed 상태도 SELECT로 대조했다. 세 원입고에 명시적으로 연결된 추가 correction 로그는 조회 당시 없었다. 원입고의 현재 기록과 장부에 반영된 당시 스냅샷 사이의 차이가 확인 대상이다.

**차액 0인데 남아 있는 원인:** 토닉워터와 방울토마토는 금액·수량 변화가 없지만 실제 지급 거래처가 다르므로 관리자의 별도 확인이 필요하다. 저장된 projection status는 세 건 모두 PURCHASE_AMOUNT_CONFIRMATION_REQUIRED이지만, 최신 읽기 전용 미리보기는 뒤의 두 건을 거래처 확인 대상으로 구분한다. UI는 이 최신 미리보기를 사용한다. 실제 변경이 전혀 없는 불필요한 대기 건은 현재 3건에서 발견되지 않았다.

표시 금액은 해당 장부와 서버 미리보기의 oldAmount/newAmount/delta를 그대로 사용한다. 현재 품목 마스터 단가로 금액을 계산하지 않는다. 필요한 값은 기존 서버 응답에 있었으므로 DB 구조나 조회 RPC 변경은 필요 없었다.

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| app/(protected)/admin/ledger/entries/page.tsx | 간결한 제목, 중복 가능 사유 집계, 기본 목록 노출, compact 해결 버튼 |
| app/(protected)/admin/ledger/entries/entries.module.css | 항목 상단 정렬 및 버튼 너비 유지 |
| components/ledger/InventoryPurchaseCaseSummary.tsx | 핵심 변경만 기본 표시, 상세보기로 기록과 상태 이동 |
| components/ledger/InventoryPurchaseCaseSummary.module.css | 변경 값 강조, 모바일 배치 |
| components/ledger/InventoryProjectionResolution.tsx | 배너에서 반복 상태 문구를 생략하는 선택적 compact 속성 |
| lib/inventory/purchase-case-display.ts | 서버 미리보기 기반 표시·사유 집계 순수 함수 |
| lib/inventory/purchase-cases.ts | 기존 조회 결과에서 상세 표시용 receiptEvidence 필드만 추가. 그룹화·완료 판정·대상 선택 로직 유지 |
| tests/inventory-purchase-case-display.test.mjs | 금액/거래처/수량/복합/자료 부족/동일 값/거래처 식별자 변경 검증 7건 |
| tests/inventory-purchase-review-compact-browser.test.mjs | 실제 3건의 검증된 값으로 KO/VI·PC/모바일, 상세, 모달, 갱신, 복합·0변경·자료 부족 검증 |
| tests/inventory-purchase-cases-browser.test.mjs | 새 제목과 기본 목록·상세 분리에 맞춘 기존 검증 갱신 |

## 검증 결과

| 검사 | 결과 |
| --- | --- |
| 신규 표시 단위 테스트 | **7/7 통과** |
| 기존 purchase-cases / loader / repair API / repair DB 테스트 | **54/54 통과** |
| npm run test:purchase-economic | **71/71 통과**. 로컬 PGlite의 고립된 fixture DB 사용 |
| 신규 compact 브라우저 테스트 | **통과**. KO/VI × 1280×900 PC / 390×844 모바일 4개 조합 |
| 기존 purchase-cases / sync-resolution 브라우저 회귀 | **2/2 통과**, 각 4개 조합 |
| 변경한 TS/TSX/MJS 파일 ESLint | **통과** |
| 전체 app/components/lib/tests ESLint --quiet | **기존 오류 6건**: mypage/page.tsx 1건, language-context.tsx 2건, 기존 loader/manual-amount-edit/purchase-economic 테스트의 module 변수 규칙 각 1건. 변경 파일 오류 없음 |
| tsc --noEmit | **기존 오류 40건**. 원래 HEAD 소스와 현재 소스를 TypeScript compiler host로 각각 검사해 오류 파일·행·코드·메시지가 모두 동일함을 확인 |
| npm run build | **통과**. Next 16.2.1 Production 컴파일·TypeScript 단계·72개 정적 페이지 생성 완료 |
| git diff --check | **통과** |

브라우저는 기존 로컬 ledger UI harness에서 실제 페이지와 컴포넌트를 불러온다. 모든 /api/** 요청을 가로채며 해결 POST도 테스트 응답으로 처리한다. 원격 데이터베이스로 쓰기 요청이 전달되지 않는다. 신규 테스트는 실제 조회로 검증한 3건의 경제적 값과 합성 추가 사례를 사용한다. 페이지 오류, 가로 넘침, 불변 값 숨김, 모달 금액 일치, 해결 후 목록 갱신, 기존 거래처 승인 및 stale/지급/월마감/수동수정 차단 흐름을 확인했다.

로컬 스크린샷:
- .qa-review/purchase-review-compact/ko-desktop.png
- .qa-review/purchase-review-compact/ko-mobile.png
- .qa-review/purchase-review-compact/vi-desktop.png
- .qa-review/purchase-review-compact/vi-mobile.png

TypeScript 기준 비교: .qa-review/purchase-review-typescript-baseline.json — baselineErrors 40 / currentErrors 40 / identical true.

## 실행 범위

로컬 소스 수정과 로컬 검증을 완료했다. 운영 데이터 변경, Migration 생성·적용, 확인 대기 건 해결·삭제, Git Push, Vercel 배포는 수행하지 않았다.
