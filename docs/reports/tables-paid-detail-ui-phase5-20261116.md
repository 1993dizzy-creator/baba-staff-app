# /tables 결제완료 상세 UI 개선 5차 — 2026-11-16

## 작업 기준과 범위

- 브랜치: `codex/tables-paid-detail-ui-phase5-20261116`.
- 기준 main: `8165da2f36be64af0d22c88196d6bb3c7dd3b762`. UI 3·4차, 유효 결제 영수증 기준 상단 완료 집계와 별도 급여관리 변경을 포함한다.
- 시작 시 main 및 Codex Worktree 미커밋 변경 없음 확인. fetch 후 origin/main은 `a762bd7a65adeb37f9b5be93579a61942df6679e`. 최신 로컬 main에서 독립 Worktree 브랜치를 생성했다.
- 로컬 구현·검증·Worktree 커밋 범위만 수행했다. main 병합·Push·배포·운영 DB 변경·Migration·Cron 변경·추가 CUKCUK 호출 없음.

## 변경 전후

| 항목 | 변경 전 | 변경 후 |
| --- | --- | --- |
| 영수증 번호/상태 | 번호와 일반 상태 문구 | 번호는 왼쪽, 상태는 오른쪽 작은 배지 |
| 금액/시각 | 최종 결제금액 라벨과 작은 금액, 별도 시각 필드 | 왼쪽 20px 굵은 금액, 오른쪽 10px 영수증 기준시각 |
| 영업일 | 카드 기본 화면의 영업일 필드 | 현재 영업일과 같으면 번호를 눌러 접힘 정보에서 확인; 다르면 카드에 별도 표시 |
| 원본 시각 정보 | 월·일/시·분 | 기본 월·일/시·분 유지, 번호의 접힘 정보에는 연도 포함 현지시각·Asia/Ho_Chi_Minh·원본 dateTime 보존 |
| 메뉴 | 하단 메뉴 펼침 | 하단 한 줄 유지, 위 구분선 추가, 기존 메뉴 테이블/언어 분리 유지 |
| 카드 여백 | 10px 내부 패딩 및 별도 금액/영업일 블록 | 상하 8px 패딩, 불필요한 기본 필드 제거, 배경·테두리 유지 |

영수증 번호의 ⌄가 영수증 정보 펼침 역할을 한다. 기본 HTML details/summary를 사용하므로 터치·Enter·Space로 접힘 정보를 열고 닫을 수 있다. 44px 이상 조작 영역과 기존 포커스 표시를 유지했다. 긴 영수증 번호는 원문을 생략하지 않고 줄바꿈한다. 상태 배지는 폭을 제한하고 여러 개일 때 줄바꿈하여 320px에서도 넘치지 않는다.

`usageHelp`는 4차에서 이미 제거되어 소스/CSS에 없음을 확인했다. 해당 안내를 다시 수정하거나 추가하지 않았다. 일반·사용 중·결제완료 상세에서 자료 부족/주문 건수/방문 횟수 관련 안내가 없고, 실제 수집 오류·결제 확인 필요·저장 오류 경고는 유지한다.

## 상태·영업일·금액 보존

기존 canceled/validPaid/reissued/uncertain/link 응답값을 표시하며 결제 적격성을 다시 계산하지 않는다. 기본 유효/취소/확인 필요 배지와 재발행·합산결제 배지를 따로 표시한다. 취소 또는 유효 표시와 uncertain이 함께 전달되면 확인 필요 배지도 추가하여 경고가 누락되지 않게 한다. 배지 자체에 문구가 있으므로 색상만으로 상태를 구분하지 않는다.

금액은 기존 `receipt.amount`를 같은 VND 포맷으로 표시한다. null은 —로 유지하며 0을 만들어 넣지 않는다. 시각은 기존 `receipt.referenceAt`인 영수증 기준시각이다. 실제 결제완료 시각을 새로 추정하거나 30분 자동 전환의 최초 관측시각을 대체하지 않는다.

현재 영업일 비교는 기존 detail/overview의 businessDate를 사용한다. 브라우저 달력 날짜로 영업일을 계산하지 않는다. 예를 들어 11월 17일 02:59:59(+07)의 영수증은 영업일 11월 16일을 접힘 정보에서 정확히 보존한다. 03:00에 현재 영업일이 11월 17일이 되면, 11월 16일 영수증을 표시하는 경우 영업일 라벨이 카드 기본 화면에 나타난다. 기존 서버가 제공하는 자료 범위나 최신 영수증 선정 규칙을 확장하지 않았다.

최신 결제와 당일 결제 이력은 기존 공통 `receiptView`를 사용한다. 메뉴명 KO/VI 분리, 원본 수량·합계·취소 메뉴, 메뉴 수, 펼침/접힘은 유지한다. 오늘 이용 2회 이상 조건부 표시는 기존 조건대로이며 usage 계산은 바꾸지 않았다. 현재 서버의 복수 이용 미확정 한계도 그대로다.

## 검증 결과

| 검사 | 결과 |
| --- | --- |
| 관련 회귀 18개 파일 | 188/188 PASS, FAIL/skip 0 |
| TypeScript | `tsc --noEmit --incremental false --pretty false` PASS |
| ESLint | 수정 TSX/TS/MJS 3개 파일, 오류/경고 없음 PASS |
| Production Build | 운영 .env/자격 증명 없는 격리 복사본의 `next build --webpack` PASS |
| KO/VI × 320/360/390/430/1280px | 10조합 PASS, 실제 TSX/CSS를 사용한 오프라인 Chrome |
| 결제 카드 전용 10조합 | 긴 번호·배지 조합·시각·영업일·이력·메뉴·03:00 전후 PASS |
| 모바일 터치 | KO/VI × 320/360/390/430px의 8조합에서 번호 정보 및 메뉴 tap PASS |

카드 전용 검증은 다음을 포함한다.

- 영수증 #2601007585, 664,400 VND, 11.16 21:42의 정확한 표시와 금액/시각 배치 및 글자 크기.
- 긴 영수증 번호, 유효/취소/유효+재발행+합산/확인 필요+합산/취소+확인 필요+재발행+합산 배지 조합.
- 최신 결제와 당일 이력의 동일 카드 구조, 금액 null → —, 데이터 불변.
- 현재 영업일의 기본 영업일 필드 숨김과 접근 가능한 접힘 정보, 다른 영업일의 기본 라벨 노출.
- Asia/Ho_Chi_Minh 02:59:59 → 03:00 시각 및 영업일 응답 변화. 단위 테스트와 화면 fixture로 원본 dateTime/영업일 보존 확인.
- 메뉴 3건, KO/VI 이름, 수량·금액·취소 배지, 터치·Enter·Space 펼침/접힘, 카드·상세창 가로 넘침 없음.

기존 화면 검증도 유지했다. 일반/사용 중/결제완료 상세창, 27개 테이블 및 색상·60px 타일·시작시간, 4차 한 줄 주문 메뉴·원본 정보 펼침, usage 0/1/null/2/3 조건, 모달 스크롤·포커스·닫기, 최초 로딩·60초 갱신·오류/재시도를 확인했다. 각 언어/폭에서 격리 SQL-backed 서비스로 청소 저장·30분 자동 일반 전환·신규 주문 우선순위·상단 완료 건수 유지도 통과했다.

유효 영수증 집계·취소/재발행/#8885/03:00 경계·청소/자동 전환 DB·서버 검사는 회귀 188개에 포함한다. 서버/API/DB/수집기/집계/청소 token/최초 관측시각/30분 전환/매출 KPI 파일은 변경하지 않았다. 운영 DB·실제 POS·운영 로그인 세션 E2E는 실행하지 않았다. Build의 다중 lockfile workspace root 감지 경고는 기존 환경 경고이며 종료 코드는 0이다.

## 변경 파일 전체 Windows 경로

- `C:\workspace\baba-wt-codex\app\(protected)\tables\page.tsx`
- `C:\workspace\baba-wt-codex\app\(protected)\tables\tables.module.css`
- `C:\workspace\baba-wt-codex\lib\text\tables.ts`
- `C:\workspace\baba-wt-codex\tests\tables-compact-ui.test.mjs`
- `C:\workspace\baba-wt-codex\docs\reports\tables-paid-detail-ui-phase5-20261116.md`

## 로컬 화면 비교와 증거

Git 제외 경로 `C:\workspace\baba-wt-codex\.local\tables-ui-phase5\`에 `regression.log`, `tsc.log`, `eslint.log`, `build.log`, `build-result.json`, `browser.log`, `browser-results.json`, `paid-cards.log`, `paid-card-results.json` 및 KO/VI 폭별 PNG를 보존한다. 이용 횟수 2회 및 상태 조합은 표시 계약 검증용 비식별 fixture이며 운영 자료를 새로 수집하지 않았다.

- [320px KO 변경 전](../../.local/tables-ui-phase5/before-ko-320-paid-card.png) / [변경 후](../../.local/tables-ui-phase5/after-ko-320-paid-card.png)
- [320px VI 변경 전](../../.local/tables-ui-phase5/before-vi-320-paid-card.png) / [변경 후](../../.local/tables-ui-phase5/after-vi-320-paid-card.png)
- [320px VI 이력·긴 번호·배지 조합](../../.local/tables-ui-phase5/after-vi-320-receipt-history.png)
- [1280px VI 변경 후](../../.local/tables-ui-phase5/after-vi-1280-paid-card.png)

로컬 구현과 검증을 완료했다. main 병합이나 운영 반영 없이 Owner의 다음 지시를 기다린다.
