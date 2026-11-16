# /tables UI 간소화 3차 — 2026-11-16

## 작업 기준과 결과

- 브랜치: `codex/tables-ui-phase3-20261116`.
- 기준 커밋: `05216ec2c8e695a5a3550dd165a3f54701966f34`. 직전 유효 결제 영수증 기준 완료 집계를 포함한다.
- 시작 시 로컬 main과 Codex Worktree HEAD 모두 `05216ec2`, fetch 후 origin/main은 `a762bd7a65adeb37f9b5be93579a61942df6679e`로 확인했다. Codex Worktree는 깨끗한 상태였고 로컬 main에 있던 별도 급여관리 작업은 건드리지 않았다.
- main의 기존 미커밋 경로: `app/(protected)/admin/payroll/[runId]/page.tsx`, `components/payroll/PayrollRunLedgerView.tsx`, `lib/payroll/run-ledger-view.ts`. 이번 변경과 겹치지 않는다.
- 로컬 구현·검증·Worktree 커밋 범위만 수행했다. main 병합·Push·배포·운영 DB 쓰기·Migration·Cron 변경·추가 CUKCUK 호출 없음.

## 화면 변경 전후

| 항목 | 변경 전 | 변경 후 |
| --- | --- | --- |
| 최초 로딩 | 확인 중 문구, BAR 0개/빈 구역도 표시 | 현황바 아래 10px 간격의 회색 카드, CSS 스피너+문구; 목록 미수신 시 구역을 렌더링하지 않음 |
| 갱신/오류 | 기존 60초 갱신 및 오류 안내 | 데이터가 있는 갱신에는 로딩 카드 없음; 오류 안내와 새로고침 재시도 유지, 재시도 중 이전 오류 해제 |
| 타일 | 번호·시각·축약금액, 74px | 번호·🕒 시작시각만, 60px; 금액 DOM·금액 aria-label/title·관련 import 제거 |
| 구역 | 상하 8px 패딩 | 상하 7px, 기존 구역 간격과 헤더 간격 유지 |
| 일반 상태 상세 | 이용 근거 부족 안내 노출 | usageHelp 영역 숨김; 실제 수집/미확인 경고는 유지 |
| 오늘 이용 횟수 | 상세 헤더에 1/null 등 항상 노출 | 헤더에서 제거; 검증된 count ≥ 2이고 최근 결제가 있을 때만 결제 제목 옆에 표시 |
| 일반 상태 빈 주문 | 작은 일반 문구 | 정상 idle+snapshot ok에만 15px/700, 중앙 정렬, 상하 22px, 이모지와 텍스트 가로 배치 |

BAR 6열(320~359px는 4열), 1층/2층 4열, PC 3구역 가로 배치를 유지했다. 타일은 60px 높이와 44px 이상 터치 영역, BAR 번호 줄바꿈 방지, 1px 내부 줄 간격을 적용했다. KO/VI 실제 화면 비교에서 두 줄의 가독성과 전체 높이 감소를 확인했다.

로딩 문구는 KO `매장현황 확인 중…`, VI `Đang kiểm tra cửa hàng…`를 유지한다. `role=status`, 스피너의 `aria-hidden`, `prefers-reduced-motion: reduce`에서 애니메이션 중지를 적용했다.

## 이용 횟수 표시 조건과 현재 한계

기존 `usage` 응답만 사용한다. 상세 스냅샷이 정상이고 usage.snapshotAt이 일치하며 status가 `confirmed_order_basis`인 count에 대해, 안전한 정수이고 2 이상일 때 표시한다. 최근 결제 정보가 없으면 별도 영역을 만들지 않는다. 0·1·null·미확인·오래된 스냅샷은 표시하지 않는다. `verifiedOrderCount`를 이용 횟수로 바꾸지 않았다.

- KO: `최근 결제 · 오늘 이용 2회`.
- VI: `Thanh toán gần nhất · Đã sử dụng 2 lượt hôm nay`.
- 사용 중 테이블의 기존 결제 섹션 제목인 이전 결제/Thanh toán trước는 그대로 유지한다.

현재 `projectDailyTableUsage`는 한 주문 묶음만 1로 확정하고 복수 묶음은 독립 이용인지 증명할 수 없어 `count=null`로 반환한다. 따라서 **현재 집계 데이터로는 2회 이상 문구가 나타나지 않는다**. 이번 작업은 향후 적격 응답을 표시할 조건만 구현했다. 서버가 확인되지 않은 2/3을 만들도록 확장하지 않았고 새 집계·DB·Migration도 추가하지 않았다. 2/3 표시 테스트와 스크린샷은 조건부 UI 검증용 응답을 사용한 것으로 운영 이용 횟수 증거가 아니다.

## 검증 결과

| 검사 | 결과 |
| --- | --- |
| 관련 회귀 17개 파일 | 177/177 PASS, FAIL/skip 0 |
| TypeScript | `tsc --noEmit --incremental false --pretty false` PASS |
| ESLint | 수정 TSX/TS/MJS 3개 파일, 오류/경고 없음 PASS |
| Production Build | 운영 .env/자격 증명을 제외한 격리 복사본의 `next build --webpack` PASS |
| KO/VI × 320/360/390/430/1280px | 10조합 PASS, 실제 TSX/CSS를 사용한 오프라인 Chrome |

화면 검증에는 다음 항목을 포함했다.

- 응답 지연 중 최초 로딩 카드·스피너·10px 간격·연회색 배경·10px radius·reduced-motion, 가짜 0개 구역 부재.
- 60초 갱신 응답 대기 중 기존 27개 타일 유지 및 로딩 카드 부재, 실패 시 오류 안내와 재시도 복구.
- 타일 60px, 번호/시각 두 줄, 타일 금액 및 금액 접근성 문구 제거, 정상·완료·미확인 상태의 잘못된 시작시각 방지.
- 27개 UUID/순서와 BAR 11/1층 8/2층 8, 4/6열, 44px 이상 터치 영역, 타일·페이지·상세창 가로 넘침 없음.
- 헤더 이용 횟수 제거, 0/1/null/2/3 × 최근 결제 유무, review/unavailable/과거 스냅샷의 표시 방지, idle usageHelp 숨김.
- 정상 일반 상태의 빈 주문 안내 중앙 정렬·15px·700·22px 여백, 수집 실패를 일반 안내로 표시하지 않음.
- 주문번호/복수 주문/메뉴 옵션·취소·단가·합계·정확한 예상금액 보존, 상세창 스크롤·닫기·포커스 복귀/순환.
- 각 언어/폭에서 격리 SQL-backed 서비스로 청소 저장·30분 경과 자동 일반 전환·신규 주문 우선순위와 완료 건수 유지 확인.
- 유효 영수증 3건 → 상단 완료 3 표시 유지. 기존 완료 0/중복·취소·재발행·#8885 합산결제·03:00 경계·일반 GET/청소 ON 경로 검사는 회귀 177개에 포함한다.

운영 DB·POS·실제 로그인 세션을 사용하는 E2E는 실행하지 않았다. Build의 다중 lockfile workspace root 감지 경고는 기존 환경 경고이며 종료 코드는 0이다. 서버/API/수집기/상태 판정/청소 저장/관측시각/30분 전환/매출 KPI 파일은 변경하지 않았다.

## 변경 파일 전체 경로

- `C:\workspace\baba-wt-codex\app\(protected)\tables\page.tsx`
- `C:\workspace\baba-wt-codex\app\(protected)\tables\tables.module.css`
- `C:\workspace\baba-wt-codex\lib\text\tables.ts`
- `C:\workspace\baba-wt-codex\tests\tables-compact-ui.test.mjs`
- `C:\workspace\baba-wt-codex\docs\reports\tables-ui-phase3-20261116.md`

## 로컬 화면 비교와 검증 증거

검증 파일은 Git에서 제외된 `C:\workspace\baba-wt-codex\.local\tables-ui-phase3\`에 보존했다. `regression.log`, `tsc.log`, `eslint.log`, `build.log`, `build-result.json`, `browser.log`, `browser-results.json`과 10조합별 PNG를 포함한다.

- [430px KO 변경 전](../../.local/tables-ui-phase3/before-ko-430-overview.png) / [변경 후](../../.local/tables-ui-phase3/after-ko-430-overview.png)
- [320px KO 로딩](../../.local/tables-ui-phase3/after-ko-320-loading.png)
- [320px VI 일반 상태와 이용 2회 조건부 표시](../../.local/tables-ui-phase3/after-vi-320-idle-usage2.png)
- [1280px VI 변경 후](../../.local/tables-ui-phase3/after-vi-1280-overview.png)

로컬 구현과 검증을 완료했으며, 운영 반영 없이 Owner의 다음 지시를 기다린다.
