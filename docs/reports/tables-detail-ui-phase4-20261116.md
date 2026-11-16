# /tables 현재 주문 상세 UI 간소화 4차 — 2026-11-16

## 작업 기준과 범위

- 브랜치: `codex/tables-detail-ui-phase4-20261116`.
- 기준 main: `6fa555b4cd03bfb4d29b4a6747aaff871c9a1431`. 직전 UI 3차 `8c6b8f38`와 유효 결제 영수증 기준 완료 집계 `05216ec2`, 별도 급여관리 커밋을 포함한다.
- 시작 시 main과 Worktree 미커밋 변경 없음 확인. fetch 후 origin/main은 `a762bd7a65adeb37f9b5be93579a61942df6679e`. 최신 로컬 main에서 독립 Worktree 브랜치를 생성했다.
- 로컬 코드·오프라인 검증·Worktree 커밋 범위만 수행했다. main 병합·Push·배포·운영 DB 변경·Migration·Cron 변경·추가 CUKCUK 호출 없음.

## 변경 내용

### 상세 안내

모든 상태에서 usageHelp DOM과 관련 CSS를 제거했다. 자료 부족/확인된 주문 N건/주문 묶음 기준/실제 방문 횟수 관련 안내가 상세창에 나오지 않는다. 검증된 이용 횟수가 2 이상이고 최근 결제가 존재할 때 결제 제목 옆에 표시하는 조건은 유지했다. 수집 오류·미확인·결제 이력 실패·청소 저장 실패 경고는 기존 조건대로 유지한다.

이용 횟수 계산 자체는 변경하지 않았다. 기존 서버가 복수 이용의 독립성을 증명하지 못해 count=null을 반환하므로 실제 현재 자료에서 2회 이상 표시가 생기지는 않는다.

### 메뉴명 언어 선택

새 순수 함수 `localizedTableMenuName(original, lang)`을 현재 주문과 보관된 주문의 메뉴 행, 영수증 메뉴 펼침에서 함께 사용한다. `useLanguage()`의 lang을 그대로 전달한다.

| 원본 | KO | VI |
| --- | --- | --- |
| `[N1] Rượu Soju Chamisul fresh/ 참이슬` | `[N1] 참이슬` | `[N1] Rượu Soju Chamisul fresh` |
| `[H1] Trái Cây Thập Cẩm / 모듬 과일 안주` | `[H1] 모듬 과일 안주` | `[H1] Trái Cây Thập Cẩm` |

상품 코드가 있으면 앞의 ASCII 코드 `[N1]`, `[H1]` 등을 보존한다. 슬래시가 정확히 하나이고 양쪽이 비어 있지 않으며 한쪽은 한글 문자명, 다른 쪽은 라틴 문자명으로 명확히 나뉠 때만 선택한다. 언어 순서가 뒤집힌 경우와 한글 자모/베트남어 결합 문자 형태도 처리한다. 외부 번역이나 원본 문자열 수정은 없다.

영어/베트남어/한국어 단독 이름, `Gin/Tonic`, `Red / White`, `소주/맥주`, `과일 1/2 접시`, 슬래시가 여러 개인 이름, 한쪽에 한글·라틴 문자가 섞인 이름, 다른 문자권이 섞인 이름, 중복 상품 코드 등은 정확한 원문 전체를 반환한다. 보수적인 표시 규칙이므로 한국어 이름 안에 영문 브랜드가 섞인 경우에도 임의 분리하지 않는다.

### 메뉴 카드

기존 연한 배경·테두리를 유지하고 메뉴 행을 이름 / ×수량 / 합계금액의 3열 grid로 바꿨다. 기본 행은 44px 이상 터치 영역과 얇은 구분선, 7px 상하 패딩을 사용한다. 이름은 한 줄 말줄임, 수량은 가운데, 금액은 오른쪽에 정렬한다. 옵션/취소 배지는 행에서 계속 보이고 필요한 경우 이름 아래에서 줄바꿈한다.

각 항목은 기본 HTML details/summary로 펼친다. 탭·Enter·Space·터치로 열고 닫을 수 있다. 펼친 영역에는 선택 언어의 전체 메뉴명과 원본 단가·수량·합계를 표시하며, 언어 분리가 적용된 메뉴는 원본 POS 이름도 별도 표시한다. 따라서 모바일에서 hover/title에 의존하지 않고 원본 정보를 확인할 수 있다.

취소 항목의 수량·금액을 바꾸거나 제외하지 않았다. 행 합계와 하단 주문 예상금액은 기존 서버 값을 그대로 포맷하며 합산/재계산하지 않는다. 영수증 메뉴도 같은 언어 함수만 적용하고 기존 수량·금액·취소 표시는 유지했다.

## 검증 결과

| 검사 | 결과 |
| --- | --- |
| 관련 회귀 18개 파일 | 184/184 PASS, FAIL/skip 0 |
| TypeScript | `tsc --noEmit --incremental false --pretty false` PASS |
| ESLint | 수정 TSX/TS/MJS 5개 파일, 오류/경고 없음 PASS |
| Production Build | 운영 .env/자격 증명 없는 격리 복사본에서 `next build --webpack` PASS |
| KO/VI × 320/360/390/430/1280px | 10조합 PASS, 실제 TSX/CSS를 사용한 오프라인 Chrome |
| KO/VI × 320/360/390/430px 터치 | 8조합 PASS, touch-enabled Chrome의 실제 tap 이벤트로 펼침·접힘·닫기 확인 |

순수 함수 테스트는 실제 메뉴명 2종, 반대 언어 순서, 코드 유무, 구분자 공백 유무, 한 언어 이름, 일반 상품명 속 슬래시, 혼합 문자·중복 구분자·빈 이름의 원문 보존, Unicode 결합형을 확인한다.

화면 테스트는 두 예시의 KO/VI 표시, 긴 베트남어 이름 말줄임과 펼친 원문 줄바꿈, 수량 2/3, 옵션·취소 배지, 단가 150,000/320,000/40,000 VND 및 합계/예상금액 보존, 영수증 메뉴의 동일 언어 표시와 취소 배지를 확인했다. 전체 주문 예상금액이 메뉴 행 표시와 별도로 서버 원본값을 사용하는 것도 검증했다.

상세창 가로 넘침 없음, 펼친 긴 콘텐츠 스크롤, 포커스 순환·복귀, Enter/Space 조작, ESC/닫기, 타일 27개 및 기존 순서/60px 높이/4·6열, 로딩 카드·reduced-motion·초기 가짜 0개 영역 방지, 60초 갱신·오류·재시도도 통과했다. 이용 횟수 0/1/null/2/3 조건부 표시와 실제 미확인 경고 보존을 검증했다.

각 언어/화면 폭에서 격리 SQL-backed 서비스로 청소 저장·30분 자동 전환·신규 주문 우선순위·상단 완료 건수 유지도 확인했다. 기존 유효 영수증 3건 → 완료 3, 취소/재발행/#8885/03:00 경계·청소 및 자동 전환 DB/서버 검사는 회귀 184개에 포함한다.

서버/API/DB/수집기/완료 집계/usage 계산/청소 token/최초 관측시각/30분 전환/매출 KPI 파일은 수정하지 않았다. 운영 DB·실제 POS·운영 로그인 세션 E2E는 실행하지 않았다. Build의 다중 lockfile workspace root 감지 경고는 기존 환경 경고이며 빌드 종료 코드는 0이다.

## 변경 파일 전체 Windows 경로

- `C:\workspace\baba-wt-codex\app\(protected)\tables\page.tsx`
- `C:\workspace\baba-wt-codex\app\(protected)\tables\tables.module.css`
- `C:\workspace\baba-wt-codex\lib\sales\table-menu-display.ts`
- `C:\workspace\baba-wt-codex\lib\text\tables.ts`
- `C:\workspace\baba-wt-codex\tests\tables-menu-display.test.mjs`
- `C:\workspace\baba-wt-codex\tests\tables-compact-ui.test.mjs`
- `C:\workspace\baba-wt-codex\docs\reports\tables-detail-ui-phase4-20261116.md`

## 화면 비교 및 로컬 증거

검증 파일은 Git 제외 경로 `C:\workspace\baba-wt-codex\.local\tables-ui-phase4\`에 보존한다. `regression.log`, `tsc.log`, `eslint.log`, `build.log`, `build-result.json`, `browser.log`, `browser-results.json`, `touch.log`, `touch-results.json` 및 언어/폭별 PNG를 포함한다.

- [320px KO 변경 전](../../.local/tables-ui-phase4/before-ko-320-detail.png) / [변경 후](../../.local/tables-ui-phase4/after-ko-320-detail.png)
- [320px KO 긴 메뉴 펼침](../../.local/tables-ui-phase4/after-ko-320-menu-expanded.png)
- [320px VI 현재 주문](../../.local/tables-ui-phase4/after-vi-320-detail.png) / [영수증 메뉴](../../.local/tables-ui-phase4/after-vi-320-receipt-menu.png)
- [1280px VI 현재 주문](../../.local/tables-ui-phase4/after-vi-1280-detail.png)

로컬 구현과 검증을 완료했다. main 병합이나 운영 반영 없이 Owner의 다음 지시를 기다린다.
