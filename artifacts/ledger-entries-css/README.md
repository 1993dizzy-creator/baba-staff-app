# 장부작성 CSS 회귀 검증

- 문제 주소: `http://localhost:3000/admin/ledger/entries`
- 정상 기준: `98fa1b56e01df297ad17f25a7a3d0da42938c4c5`의 entries.module.css
- 기준 CSS의 class 104개는 작업 전부터 모두 보존돼 있었습니다. 기준 stylesheet 전체 내용도 로컬 파일에 그대로 포함돼 있었습니다.
- JSX에만 있던 class는 `dateChevron` 1개였고, 접힌 화살표의 명시적 회전 상태를 추가했습니다. 현재 JSX class 누락은 0개입니다.
- CSS에만 있는 class: `cardSettlementLink`, `detailCategory`, `itemInvalid`, `payableMonth`. 기존 스타일 보존을 위해 삭제하지 않았습니다. `income`, `expense`, `transfer`는 동적으로 사용되므로 미사용이 아닙니다.
- 기존 3000 개발 서버는 수정된 source의 dateChevron을 반영하지 않은 CSS를 반환했습니다. 사용자 재시작 후 class 115개가 모두 반환됐고 정상 화면 복귀를 확인받았습니다. 서버가 갱신되지 않은 내부 원인까지는 단정하지 않습니다.

## 브라우저 검증 방법

실제 entries/page.tsx와 CSS import, 실제 root layout을 재사용하는 격리된 임시 Next.js 앱에서 `/admin/ledger/entries`를 렌더링했습니다. 운영 인증을 사용하는 서버 layout은 이 격리 앱에 포함하지 않았고, 모든 fetch는 로컬 테스트 응답으로 대체했습니다. 운영 DB 접근이나 실제 거래 등록은 없었습니다.

Edge headless/CDP 브라우저에서 320·390·430px의 실제 computed style과 screenshot을 확인했습니다. 수입/지출 2열, 시재 펼침, 월별 미납·카드정산 카드, 날짜별 거래 카드, 수입/지출 색상, 가로 넘침을 검사했습니다. 현황 padding은 8px 12px로 유지했습니다.

`entries-320.png`, `entries-390.png`, `entries-430.png`는 해당 렌더링의 전체 screenshot이고 `metrics-*.json`은 computed style과 차단된 로컬 요청 목록입니다. `server-3000.css`와 `server-3000-after.css`는 재시작 전후 실제 개발 서버 CSS 응답입니다. `selector-audit.json`에는 전수검사 목록이 있습니다.

## 자동 검증

- inventory-ledger: 186개 통과
- 관련 장부 UI 및 요약카드: 57개 통과
- 수정 파일 lint: 통과
- production build: 통과

회귀 테스트는 기존 `tests/ledger-entries-v1.test.ts`에 포함돼 `test:inventory-ledger`에서 함께 실행됩니다.
