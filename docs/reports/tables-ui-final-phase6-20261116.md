# /tables UI 최종 마감 후보 — Phase 6, 2026-11-16

## 작업 기준과 범위

- 브랜치: `codex/tables-ui-final-phase6-20261116`.
- 기준 main: `4ce1f3ba86ea7b557c4d7f3b7e60e15fb1356951`. Phase 1~5 UI 및 별도 급여관리 변경을 포함한다.
- 시작 시 main·Worktree HEAD 및 미커밋 변경 없음 확인. fetch 후 origin/main은 `a762bd7a65adeb37f9b5be93579a61942df6679e`. 최신 로컬 main에서 독립 Worktree 브랜치를 생성했다.
- 작업 도중 main에서 진행된 별도 급여관리 변경(`PayrollModal.tsx`, `PayrollRunLedgerView.tsx`, `run-ledger-view.ts`)은 건드리지 않았다.
- 요청한 두 UI 수정만 구현했다. main 병합·Push·배포·운영 DB 쓰기·Migration·Cron·CUKCUK API 변경/추가 호출 없음.

## 변경 전후

| 항목 | 변경 전 | 변경 후 |
| --- | --- | --- |
| 상세 헤더 상태 | 사용 중 · 경과시간 | 8px 원형 dot + 6px 간격 + 기존 상태·경과시간 텍스트 |
| 메뉴 펼침 | 선택 언어 메뉴명 반복, 원본 메뉴명 라벨 및 원본 | 반복 메뉴명/라벨 제거, 표시 이름과 다른 POS 원본만 11px 보조 텍스트로 표시 |
| 원본과 표시 이름 동일 | 동일 메뉴명 재출력 | 원본 이름을 별도 재출력하지 않음. 펼친 상단 이름이 줄바꿈되어 긴 이름 전체를 읽을 수 있음 |

dot 색상은 occupied `#22C55E`, paid `#3B82F6`, reserved `#A855F7`, idle `#E5E7EB`, unknown `#9CA3AF`다. 기존 차콜 헤더와 상태 텍스트·수집시각·경과시간을 유지했다. dot은 `aria-hidden=true`이며 색상만으로 상태를 전달하지 않는다.

dot의 상태는 기존 헤더 텍스트와 동일한 `snapshotStatus === ok ? tile.state : unknown` 경로를 사용한다. 수집 미확인 상태에서 초록/파랑 dot을 만들어 내지 않는다. 상태 판정·예약 기능·API 응답은 추가하거나 변경하지 않았다. reserved 등 모든 색상은 서버 응답을 가정한 표시 fixture로 검증했다.

KO의 `[D5] 감자튀김`, VI의 `[D5] Khoai tây chiên`은 상단 메뉴 요약에 그대로 표시한다. 펼치면 `[D5] Khoai tây chiên / 감자튀김` 원문과 기존 수량·단가·합계를 표시한다. `원본 메뉴명:`/`Tên món gốc:` 라벨은 출력하지 않는다. 옵션·취소 배지와 상품 코드, 펼침/접힘·키보드·터치는 유지했다. 표시 함수 `localizedTableMenuName`과 그 보수적인 분리 판정 규칙은 수정하지 않았다.

## 검증 결과

| 검사 | 결과 |
| --- | --- |
| 관련 회귀 18개 파일 | 192/192 PASS, FAIL/skip 0 |
| TypeScript | `tsc --noEmit --incremental false --pretty false` PASS |
| ESLint | 수정 TSX/MJS 2개 파일, 오류/경고 없음 PASS |
| Production Build | 운영 .env/자격 증명 없는 격리 복사본의 `next build --webpack` PASS |
| KO/VI × 320/360/390/430/1280px | 10조합 PASS, 실제 TSX/CSS를 사용한 오프라인 Chrome |
| 모바일 터치 | KO/VI × 320/360/390/430px에서 메뉴 및 영수증 정보 tap PASS |

화면 검증에 포함된 사항:

- occupied/paid/reserved/idle/unknown의 dot 색상·8px 크기·6px 간격, 상태별 정상/수집 실패 응답의 회색 대체, 차콜 헤더 텍스트·시각·경과시간 보존과 가로 넘침 없음.
- `[D5]` KO/VI 표시, 원본 병기 1개 및 라벨/중복 번역명 부재. 단일 언어/동일 원본 이름의 별도 문단 부재와 긴 이름의 펼침 후 줄바꿈.
- 수량 1/2/3, 단가·합계·서버 예상금액 보존, 옵션·취소 배지, 메뉴 44px 이상 조작 영역, tap·Enter·Space 펼침/접힘.
- 모달 스크롤·닫기·ESC·포커스 순환/복귀, 27개 테이블/UUID/구역 순서·60px 타일·시작시간·4/6열 및 PC 3구역 배치.
- 최초 로딩 카드·reduced-motion·가짜 0개 영역 방지, 60초 갱신·오류·재시도, usageHelp 부재와 검증된 이용 2회 이상 조건부 표시.
- Phase 5 최신/당일 이력 카드, 긴 영수증 번호·결제 배지 조합·정확한 금액/시각·접힘 영업일 정보·03:00 경계·메뉴 언어 분리 유지.
- 각 언어/폭에서 격리 SQL-backed 서비스로 청소 저장·30분 자동 전환·신규 주문 우선순위·상단 완료 건수 유지 확인.

유효 영수증 집계·취소/재발행/#8885 합산결제·03:00 경계·청소 및 자동 전환 DB/서버 검사는 회귀 192개에 포함한다. 메뉴 표시 함수·서버/API/DB/수집기/집계/청소 token/최초 관측시각/30분 전환/매출 KPI 파일은 변경하지 않았다. 운영 DB·실제 POS·운영 로그인 세션 E2E는 실행하지 않았다. Build의 다중 lockfile workspace root 감지 경고는 기존 환경 경고이며 종료 코드는 0이다.

## 변경 파일 전체 Windows 경로

- `C:\workspace\baba-wt-codex\app\(protected)\tables\page.tsx`
- `C:\workspace\baba-wt-codex\app\(protected)\tables\tables.module.css`
- `C:\workspace\baba-wt-codex\tests\tables-compact-ui.test.mjs`
- `C:\workspace\baba-wt-codex\docs\reports\tables-ui-final-phase6-20261116.md`

## 화면 비교 및 로컬 증거

Git 제외 경로 `C:\workspace\baba-wt-codex\.local\tables-ui-phase6\`에 `regression.log`, `tsc.log`, `eslint.log`, `build.log`, `build-result.json`, `browser.log`, `browser-results.json`과 KO/VI 폭별 상태 dot/메뉴/결제 카드 PNG를 보존한다. 모든 화면 자료는 오프라인 표시 fixture이며 운영 자료를 새로 조회하거나 수집하지 않았다.

- [320px KO 변경 전](../../.local/tables-ui-phase6/before-ko-320-d5-expanded.png) / [변경 후](../../.local/tables-ui-phase6/after-ko-320-d5-expanded.png)
- [320px VI 변경 전](../../.local/tables-ui-phase6/before-vi-320-d5-expanded.png) / [변경 후](../../.local/tables-ui-phase6/after-vi-320-d5-expanded.png)
- [320px KO 완료 dot](../../.local/tables-ui-phase6/after-ko-320-state-paid.png)
- [1280px VI 변경 후](../../.local/tables-ui-phase6/after-vi-1280-d5-expanded.png)

**판정: 로컬 검증 PASS, 테이블현황 UI 최종 마감 후보.** 운영 반영은 수행하지 않았으며 Owner의 다음 지시를 기다린다. 추가 기능이나 화면 재구성은 포함하지 않았다.
