# /tables UI·기능 추가 개선 1차

판정: **로컬 구현·검증 PASS**. 브랜치 `codex/tables-ui-usage-phase1-20261116`의 로컬 커밋 산출물이다. main 병합·Push·배포·운영 DB 쓰기·Migration 적용·CUKCUK 호출·운영 환경변수 변경은 수행하지 않았다.

## 시작 상태 및 작업 범위

`git fetch origin main`으로 실제 원격을 다시 조회했다. 로컬 main과 origin/main 모두 `8b5ee561d75ee5f0026b0fe11ce5f2575437f135`였고, 원본 main과 Codex Worktree 모두 미커밋 변경이 없었다. 이 main에서 새 독립 브랜치를 생성했다. 급여관리 파일은 수정하지 않았다. 기존 이력·다른 Worktree를 reset/덮어쓰기하지 않았다.

## UI 변경 전후

| 대상 | 기존 | 변경 |
|---|---|---|
| 메인 타일 | 번호만, 높이 48px | 번호 아래 `18:07`, 높이 64px, 두 줄 중앙 정렬 |
| 시작시각 | 없음 | occupied + 정상 snapshot에서 검증된 현재 주문 중 가장 이른 시작. Asia/Ho_Chi_Minh HH:mm. 고객 착석시각 아님 |
| 좁은 BAR 배치 | 320px에서도 6열 | 320~359px 4열, 390/430/1280px 6열. PC 3구역 배치 유지 |
| 현재 주문 제목 | 현재 주문 / 주문 1.4 | `현재 주문 [1.4]`. 복수 주문은 카드마다 1/3·2/3 등 별도 식별, 누락 번호는 KO/VI 대체 문구 |
| 메뉴 | 밀집된 4열 표 | 연한 배경·테두리의 주문별 메뉴 카드. 긴 메뉴명 줄바꿈, 수량·단가·메뉴 합계·옵션·취소 표시 보존, 하단 원본 주문 예상금액 굵게 표시 |
| 이전 7일 | 이전 영업일 7일 조회·노출 | UI 제거, 영수증 조회 하한을 현재 businessDate로 축소, 당일 결제·최근 결제 유지 |
| 이용 횟수 | 없음 | `오늘 이용 N회` / `Số lượt sử dụng hôm nay: N`, 확인된 주문 기준 안내. 불확실하면 `—`와 확인 필요 표시 |

27개 테이블의 순서·UUID·BAR 11 / 1층 8 / 2층 8은 유지했다. 일반·미확인·완료에는 시작시간을 표시하지 않는다. 미래/이전 영업일/비정상/시간대 없는 시작시각, 미검증·오래된 관측, 정상 snapshot이 없는 경우에도 표시하지 않는다. 브라우저 시간대를 America/Los_Angeles로 두고 베트남 `18:07` 표시를 확인했다.

주문번호와 OrderId는 수정하지 않는다. 같은 번호의 서로 다른 OrderId를 합치지 않으며, 누락 번호도 개별 카드의 순번으로 구별한다. 메뉴 합계나 주문 예상금액을 새로 계산하지 않고 기존 서버 숫자를 그대로 표시한다. 일반 상태의 의미와 모든 상태 색상을 유지했다.

## 당일 이용 횟수의 정의·한계

새 `TableDetail.usage`는 상태 판정과 독립된 순수 읽기 전용 투영이다. `count`, `status`, `verifiedOrderCount`, `basis`, `snapshotAt`, `reason`을 제공한다. 신규 테이블·Migration·수집기·CUKCUK 호출을 추가하지 않았다.

1. 기존 businessDate와 03:00 경계를 사용한다. 현재 영업일의 중앙 주문 원본 테이블 연결과 검증된 결제 증거를 교차 확인한다. 진행 중인 검증된 주문도 후보이다. 원본 테이블이 없으면 영수증 TableName만으로 위치를 추정하지 않는다.
2. OrderId별로 중복 제거한다. 같은 주문의 반복 수집·진행→결제 전환·영수증 취소/재발행을 새 이용으로 더하지 않는다. 복수 활성 영수증·취소 여부 null·잘못된 시각/금액·연결 충돌은 숫자 확정을 막는다.
3. 기존 v3 closure 관계가 검증되면 같은 테이블의 합산 구성 주문은 하나의 주문 묶음으로 처리한다. 서로 다른 테이블은 각각 원본 주문 증거를 유지한다. #8885의 BAR8/BAR9/BAR11을 영수증에 쓰인 테이블 2로 몰지 않는다. 합산 관계는 실제 방문/착석/테이블 이동의 증거로 확대 해석하지 않는다.
4. 확인된 주문 묶음이 하나이고 충돌이 없을 때 `count=1`, `status=confirmed_order_basis`로 표시한다. **서로 관계가 입증되지 않은 OrderId가 여러 개면 독립 방문인지 주문 분할인지 구분할 수 없으므로 `count=null`, `status=review`이다.** 예를 들어 확인된 주문 3건을 임의로 이용 3회로 표시하지 않는다. 대신 확인된 주문 건수와 이용 횟수 확인 필요 안내를 보여준다.
5. 증거가 없거나 수집이 불완전하면 `count=null`이며 0회를 만들지 않는다. 청소완료 장식 과정에서 snapshot 시각이 바뀌어 usage 근거와 일치하지 않으면 화면은 숫자를 숨기고 다시 확인을 요구한다. 청소 token·자동 전환 데이터를 수정하지 않는다.

이 수치는 **현재 읽기 데이터에서 확인된 주문 묶음 기준**이며 실제 고객 방문 횟수나 영업일 전체 이력의 완전성을 보장하지 않는다. 현재 스냅샷에는 독립 방문 ID, 주문 분할/동일 방문 관계, 완전한 테이블 이동 이력, 영업일 전체 수집 범위 보증이 없다. 따라서 한 묶음이 보이는 경우의 1도 고객 방문의 정확한 하루 총계라는 의미가 아니다.

정확한 3회 등 방문 누계를 확정하려면 향후 별도 승인 범위에서 방문/session 식별자와 주문 관계, 이동 및 당일 증거의 완전성을 확보해야 한다. 이번에는 이를 추정하거나 신규 저장·수집 시스템으로 확장하지 않았다. 고객명·멤버십 DB/API/UI 필드도 추가하지 않았다.

## 읽기/API·기존 기능 보호

- 상세 영수증 조회는 현재 businessDate부터 다음 날짜까지의 기존 날짜 보정 범위를 사용한다. 과거 7일은 조회하지 않으며 메뉴 조회도 당일 상세 대상 영수증으로 제한한다. DB 영수증·결제 기록 삭제/수정은 없다.
- 호환을 위해 `TableDetail.historyFrom`과 `previous` 형식은 유지하되 실제 상세 API에서는 `historyFrom=businessDate`, `previous=[]`이다. 당일 `current`, `latest` 및 결제 메뉴는 유지한다.
- `table-overview.ts`, `table-cleaning-server.ts`, `table-auto-normal.ts`, POS 수집 core·매출 KPI·장부·급여·Migration은 수정하지 않았다. 기존 상태/금액/무효화/청소완료/30분 전환 계산에는 집계값을 입력하지 않는다.
- 청소완료 버튼·request/token·저장 RPC, 자동 전환 데이터, 신규 주문 우선순위, 60초 갱신, 취소/재발행/합산결제 보호를 유지한다.

## 검증

| 검사 | 결과 |
|---|---|
| 관련 Node/PGlite 회귀 15개 파일 | **158/158 PASS**, 실패·skip 0 |
| 최종 표시/집계 보수성 보완 후 영향 범위 재검증 | **29/29 PASS**, 위 158개 중 영향 범위 교체 검증이며 중복 가산하지 않음 |
| TypeScript `--noEmit --incremental false --pretty false` | PASS |
| 변경 TS/TSX/MJS ESLint `--max-warnings 0` | PASS, 오류·경고 0 |
| `git diff --check` | PASS |
| KO/VI × 320/390/430/1280px 브라우저 | **8/8 조합 PASS**, 변경 전후 실제 TSX/CSS 비교 및 실제 격리 SQL-backed 청소/자동 전환 흐름 |

검증 내용: earliest start와 잘못된 시간 숨김, 27개 순서·카탈로그 ID·11/8/8, 64px·44px 이상 터치 영역, 320px BAR 4열·나머지 6열·PC 3구역, 중복/누락 번호, 긴 베트남어 메뉴 줄바꿈, 옵션/취소/수량/단가/합계/원본 예상금액, 모달 내 가로 넘침 없음, focus trap·Escape/닫기·열었던 타일 focus 복귀·body 스크롤 잠금/복구·모달 세로 스크롤, 60초 목록/상세 재조회, 당일 이용 보수성·취소/재발행·#8885·03:00, 청소완료 저장·자동 만료 시 버튼 숨김/이력 유지·새 주문 우선순위를 확인했다.

합산결제 관계만 유효하고 결제 시각/금액이 불확실한 경우 이용 횟수를 확정하지 않는 검사도 포함한다. Native PostgreSQL의 기존 DB 동시성 검사는 이번 읽기/UI 변경으로 영향받지 않아 기존 유효 증거를 재사용하고 재실행하지 않았다. DB 함수·정책·Migration 변경은 없다.

전체 Production Build와 운영 E2E는 실행하지 않았다. 실제 POS 트래픽·운영 수집 자료의 누락/이동 이력·운영 화면은 이번 격리 fixture/브라우저 검증으로 보증하지 않는다. 새로운 운영 실행/배포 승인은 이 결과에 포함되지 않는다.

증거 경로: `C:\workspace\baba-wt-codex\.local\tables-ui-usage-phase1\`

- `regression.log`, `final-projection.log`, `tsc.log`, `eslint.log`
- `browser.log`, `browser-results.json`
- `before-{ko|vi}-{320|390|430|1280}-{overview|detail}.png`
- `after-{ko|vi}-{320|390|430|1280}-{overview|detail}.png`
- baseline bundle은 기준 커밋의 page.tsx/CSS, 변경 bundle은 최종 실제 소스로 생성. 브라우저 네트워크는 offline fixture API로 제한했다.

## 변경 파일 전체 Windows 경로

```text
C:\workspace\baba-wt-codex\app\(protected)\tables\page.tsx
C:\workspace\baba-wt-codex\app\(protected)\tables\tables.module.css
C:\workspace\baba-wt-codex\lib\text\tables.ts
C:\workspace\baba-wt-codex\lib\sales\table-detail-display.ts
C:\workspace\baba-wt-codex\lib\sales\table-detail.ts
C:\workspace\baba-wt-codex\lib\sales\table-detail-server.ts
C:\workspace\baba-wt-codex\lib\sales\table-usage.ts
C:\workspace\baba-wt-codex\tests\tables-compact-ui.test.mjs
C:\workspace\baba-wt-codex\tests\tables-detail.test.mjs
C:\workspace\baba-wt-codex\tests\tables-daily-usage.test.mjs
C:\workspace\baba-wt-codex\docs\reports\tables-ui-usage-phase1-20261116.md
```
