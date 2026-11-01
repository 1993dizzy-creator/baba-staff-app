# 입고 수정 장부 확인 배너 상세보기 간소화 — 2026-10-18

## 결과와 범위

상세보기를 다음 순서로 구성했다.

1. **변경 원인**: 장부 스냅샷과 현재 입고 기록에서 실제 변경된 구매 단가, 서버 미리보기로 확인되는 수량·거래처만 표시.
2. **장부 영향**: 기존 서버 미리보기의 금액 변화가 있는 경우에만 기존 금액 → 수정 금액과 차액을 표시. 금액 변화가 없으면 0₫이나 동일 금액을 반복하지 않는다. 금액 근거가 없으면 확정할 자료 부족을 안내한다.
3. **확인 필요 사유**: 서버 판정에 대응하는 KO/VI 안내. 기존 오류 번역을 재사용하고 화면 전용 사유 번역을 보완했다.
4. **처리 이력 N건**: 기본 접힘. 펼치면 베트남 현지시간, 번역된 유형, 담당자, 원본에 제공된 수량·금액 변화를 표시.
5. **기술정보 · 감사 기록**: 별도 기본 접힘. 원입고/처리 대상 ID, 원래 코드·상태, 장부 스냅샷, 제공된 이력 원본을 보존한다.

품목명·날짜·거래처 보조정보, 동일 수량·단가, confirmed / confirmed 및 영어 기술 코드를 상세 기본 영역에서 제거했다. 목록·서버 판정·재고 정정 V3·장부 계산·해결 모달·승인/차단 로직은 변경하지 않았다.

이력은 복사본을 시간순으로 정렬하며, 같은 이름·시각이어도 서로 다른 사건은 합치거나 삭제하지 않는다. 같은 장부 연동 검토가 여러 번 발생한 경우에도 각각 유지한다. 등록과 연동 검토를 서로 다른 번역된 처리 유형으로 구분한다. 원본에 값이 없는 사건의 변경 금액·단가는 재구성하지 않는다.

## 서버 원본 재검증

기존 읽기 전용 loader의 SELECT와 읽기 전용 preview RPC로 검증했다. 변경용 RPC·운영 쓰기·Migration은 실행하지 않았다. 화면 테스트에서는 조회 결과를 로컬 fixture로 제공하고 모든 /api/** 요청을 가로챘다. 확인 fingerprint와 자격 증명은 저장하지 않았다.

조회 시점의 실제 대기는 **4건**이었다. 요청한 기존 3건 외에 2026-10-18 방울토마토 원입고 #13532가 추가돼 있었다. 새 사건도 숨기거나 해결하지 않고 함께 검증했다.

| 사건 | 검증한 변경 원인 | 장부 영향 | 이력 건수 |
| --- | --- | --- | --- |
| 노란 멜론 #13085 / 2026-10-12 | 단가 32,000₫/kg → 38,000₫/kg. 수량 2.2Kg와 거래처 Chợ 유지 | 70,400₫ → 83,600₫ (+13,200₫) | 4 |
| 슈웹스 토닉워터 #13297 / 2026-10-15 | Dabaco → Ok Mart. 단가·수량 유지 | 금액 480,000₫ 동일, 기본 상세에서 생략 | 4 |
| 방울토마토 #13477 / 2026-10-17 | Trung Đông → Chợ. 단가·수량 유지 | 금액 50,000₫ 동일, 기본 상세에서 생략 | 7 |
| 추가 방울토마토 #13532 / 2026-10-18 | Chợ → Trung Đông. 단가·수량 유지 | 금액 50,000₫ 동일, 기본 상세에서 생략 | 4 |

최신 preview는 멜론 READY, 거래처 변경 3건은 SUPPLIER_CHANGE_CONFIRMATION_REQUIRED이었다. 멜론은 기존 대기 판정 PURCHASE_AMOUNT_CONFIRMATION_REQUIRED에 맞춘 금액 확인 안내를, 거래처 변경은 최신 preview의 거래처 확인 안내를 사용한다. 원인 불명·기타 오류는 기존 KO/VI 번역의 안전한 일반 안내를 사용하며 코드명을 일반 화면에 출력하지 않는다.

## 이번 요청에서 변경한 파일

| 파일 | 내용 |
| --- | --- |
| components/ledger/InventoryPurchaseCaseDetails.tsx | 상세 구조, 변경값·안내·접힌 이력·감사 정보 표시 전담 컴포넌트 |
| components/ledger/InventoryPurchaseCaseSummary.tsx | 기존 상세 마크업을 새 상세 컴포넌트로 교체. 기본 목록은 유지 |
| components/ledger/InventoryPurchaseCaseSummary.module.css | 기존 앱 색상을 사용하는 상세 카드·텍스트 위계·접힘 구분 스타일 |
| lib/text/inventory-purchase-review.ts | KO/VI 확인 안내와 처리 유형 번역. 서버 판정이나 승인 로직에는 관여하지 않음 |
| tests/inventory-purchase-details-browser.test.mjs | 실제 조회 fixture와 합성 복합 사례로 상세·이력·코드 숨김·순서·모바일 검증 및 캡처 |
| tests/inventory-purchase-cases-browser.test.mjs | 새 중첩 접힘에 맞춰 기존 이력 회귀 검사 갱신 |
| tests/inventory-purchase-review-compact-browser.test.mjs | 상세 기본 영역에서 ID·이력이 숨겨지는지 검사 갱신 |

이전 요청에서 생긴 미커밋 변경은 그대로 보존했다. lib/inventory의 표시 데이터 생성·case 그룹화와 lib/ledger loader, 서버 함수 및 해결 모달은 이번 요청에서 변경하지 않았다.

## 검증 결과

| 검사 | 결과 |
| --- | --- |
| 기존 표시·case 그룹화·loader·해결 API 테스트 | **43/43 통과** |
| 기존 case 브라우저 회귀 | **통과**, KO/VI × PC/모바일 |
| 기존 기본 목록 스타일·해결 후 갱신 브라우저 회귀 | **통과**, KO/VI × PC/모바일 |
| 기존 동기화/거래처 승인·차단 브라우저 회귀 | **통과**, KO/VI × PC/모바일 |
| 신규 상세 브라우저 테스트 | **통과**, 실제 4건 × KO/VI × PC 1280×900 / 모바일 390×844 |
| 변경 TSX/TS/MJS ESLint | **통과** |
| git diff --check | **통과** |
| Production Build | **통과**, TypeScript 단계와 정적 페이지 72개 생성 완료 |

신규 상세 브라우저 테스트는 변경 없는 필드 숨김, 기술 코드 기본 비노출, 단가·금액·거래처 정확성, 이력 N건과 전체 사건 ID의 일치, 베트남 현지시간, 감사 정보 펼침 시 원래 코드·ID 보존, 접기·펼치기, 가로 넘침 없음과 페이지 오류 없음을 검사했다. 합성 복합 변경·지급 차단 사례에서는 동일 시각·동일 유형의 서로 다른 사건이 누락되지 않는지와 원본 불변도 검사했다.

초기 신규 테스트의 합성 복합 사례에 실제 fixture의 변경 전후 거래처 판정 정보가 남아 있어 실패했다. 합성 사례 데이터를 일관되게 수정한 후 실제 4건과 합성 사례 모두 통과했다. 운영 데이터나 서버 로직 수정은 없었다.

## 스크린샷

| 환경 | 상세 펼침 / 이력 접힘 | 멜론 처리 이력 펼침 |
| --- | --- | --- |
| KO PC | .qa-review/purchase-review-details/ko-desktop.png | .qa-review/purchase-review-details/ko-desktop-history.png |
| KO 모바일 | .qa-review/purchase-review-details/ko-mobile.png | .qa-review/purchase-review-details/ko-mobile-history.png |
| VI PC | .qa-review/purchase-review-details/vi-desktop.png | .qa-review/purchase-review-details/vi-desktop-history.png |
| VI 모바일 | .qa-review/purchase-review-details/vi-mobile.png | .qa-review/purchase-review-details/vi-mobile-history.png |

전체 배너에서 4건의 상세를 펼친 화면을 캡처했다. 캡처 시에만 무관한 고정 잔액 바를 가려 상세 내용을 가리지 않게 했다. 제품의 고정 바 스타일은 변경하지 않았다. 원본 조회 fixture는 Git 제외 경로 .qa-review/purchase-review-details/actual-cases.json에 있다.

운영 DB 변경, Migration, Git Push, 배포는 수행하지 않았다.
