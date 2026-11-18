# 일간 입고 동기화·거래처 승인 검증 (2026-10-10)

## 수정사항
- 현재 품목 마스터의 경제정보를 과거 원입고에 적용하지 않는다. 원입고와 연결된 정정 기록을 기준으로 수량·단가·거래처를 보존한다.
- 품목명 등 표시정보는 원입고와 연결된 정정 로그까지 갱신하여 장부의 최신 연결 기록에도 반영한다. 과거 스냅샷의 금액·거래처는 보존한다.
- 동기화 결과에 품목명, 원입고 번호, 확인 사유와 다음 조치 링크를 표시한다.
- 장부 정정 화면은 중앙 모달과 내부 스크롤을 사용한다. 금액 차이 0인 거래처 변경은 지급 거래처 전후와 명시 확인을 표시한다.
- 일반 정정은 기존 V1, 명시 거래처 승인은 기존 V2를 호출한다. 확인 fingerprint 검증, 중복 제출 차단, stale 재조회, owner/master 권한과 기존 보호 절차를 유지한다.

## 변경 파일
- lib/inventory/snapshot-name-sync.ts
- lib/inventory/purchase-repair-contract.ts
- lib/inventory/daily-sync-result.ts
- app/api/inventory/snapshot/name-sync/route.ts
- app/api/admin/ledger/inventory-projection/[inventoryLogId]/resolve/route.ts
- app/(protected)/inventory/snapshots/page.tsx
- components/inventory/InventoryDailySyncResults.tsx
- components/ledger/InventoryProjectionResolution.tsx
- components/ledger/InventoryProjectionResolution.module.css
- tests/inventory-snapshot-name-sync.test.ts
- tests/inventory-purchase-repair-api.test.mjs
- tests/inventory-daily-sync-api.test.mjs
- tests/purchase-economic-db.test.mjs
- tests/inventory-sync-resolution-browser.test.mjs

## 검증 결과
- 관련 회귀 테스트: 252/252 통과.
- 격리 PGlite DB 테스트: 67/67 통과. #314의 10/09 Chợ 및 10/10 An Liên 입고를 fixture로 재현했고, 표시정보 갱신 후 두 날짜의 금액·지급 거래처 보존을 확인했다.
- 실제 API 경로와 격리 DB V2 연결 테스트: 0원 차이 거래처 승인, 미납금 재생성, 장부 합계 보존, 감사 로그, 재시도 멱등성 통과.
- 지급완료·결제 배분·월마감·수동 수정·오래된 fingerprint·권한 및 원자성 회귀 통과.
- KO/VI × PC/모바일 브라우저 4조합: 동기화 상세 결과, 중앙 모달, 내부 스크롤, 명시 승인, stale 재조회, 보호 사유 표시 및 중복 제출 차단 통과.
- 기존 snapshots 브라우저 4조합: 사진·거래처·편집 저장 실패/성공, 날짜 유지, 빠른저장 콤마·커서·숫자 API 회귀 통과.
- 변경 애플리케이션 파일 ESLint: 통과.
- 전체 TypeScript: 기존 오류 40건, 신규 오류 0건. 기존 진단의 다중 줄 부연을 제외한 동일 파일·코드·메시지 비교.

## 검증 범위
브라우저는 API를 모킹한 격리 UI 서버에서 실제 화면 컴포넌트를 실행했다. API 권한과 DB 계약은 별도 API 및 격리 DB 테스트로 확인했다. 운영 실데이터·실제 로그인 세션을 이용한 E2E는 실행하지 않았다. 운영 DB 변경, migration 적용, 배포 및 Git 명령을 실행하지 않았다.
