# 인계서 — 장부 매입 미납-결제 중복 표시 제거 (최종 검증)

> 작성: 2026-10-28T07:41:43.005Z · baba-handoff · 기준 정책 docs/agents/baba-agent-workflow.md

## 1. 작업 정보
- 작업명: 장부 매입 미납-결제 중복 표시 제거 (최종 검증)
- 작업 ID: 20261028-ledger-purchase-payment-single-row-01
- 담당 AI: Claude Code
- Worktree: baba-wt-claude

## 2. Git 상태
- 작업 브랜치: claude/20261028-ledger-purchase-payment-single-row-01
- HEAD SHA: 1ac4a3c292f3b8508a633cb6dfd39f87ceddcce1
- 기준: origin/main · merge-base c4956ab74ef4cbed5050517f15b161cdbdf896cd
- 작업 커밋 4개:
  - 1ac4a3c test(ledger): point stale page.tsx assertions at the code they moved to
  - 2c73a20 fix(ledger): show only the prior-month part on a mixed payment row
  - fa11d87 docs: hand off ledger purchase single-row payment display
  - 7c14a3d fix(ledger): list each purchase once as 미납 → 일부결제 → 결제
- 미커밋 변경: 없음

## 3. 변경 파일과 기능
| 파일 | 상태 | 변경량 | 커밋 |
| --- | --- | --- | --- |
| `app/(protected)/admin/ledger/entries/entries.module.css` | 수정 | +3 −0 | 커밋됨 |
| `app/(protected)/admin/ledger/entries/page.tsx` | 수정 | +38 −1 | 커밋됨 |
| `docs/handoffs/claude-20261028-ledger-purchase-payment-single-row-01.md` | 추가 | +84 −0 | 커밋됨 |
| `lib/ledger/entries.ts` | 수정 | +103 −8 | 커밋됨 |
| `lib/ledger/entry-display-amount.ts` | 수정 | +2 −1 | 커밋됨 |
| `lib/ledger/entry-display-badge.ts` | 수정 | +9 −5 | 커밋됨 |
| `lib/ledger/entry-list-filter.ts` | 수정 | +14 −8 | 커밋됨 |
| `tests/inventory-ledger-projection-api.test.mjs` | 수정 | +11 −3 | 커밋됨 |
| `tests/ledger-entries-v1.test.ts` | 수정 | +6 −4 | 커밋됨 |
| `tests/ledger-entry-filter-visibility.test.ts` | 수정 | +2 −1 | 커밋됨 |
| `tests/ledger-entry-list-filter.test.ts` | 수정 | +17 −14 | 커밋됨 |
| `tests/ledger-inventory-auto-post.test.ts` | 수정 | +5 −2 | 커밋됨 |
| `tests/ledger-inventory-rebook.test.ts` | 수정 | +3 −1 | 커밋됨 |
| `tests/ledger-purchase-payment-single-row.test.ts` | 추가 | +276 −0 | 커밋됨 |
| `tests/ledger-reserve-history-entries.test.ts` | 수정 | +1 −1 | 커밋됨 |

기능 요약:
- 기본 변경은 이전 인계서 `claude-20261028-ledger-purchase-payment-single-row-01.md`와 같다. 같은 달 매입·지급은 매입 행 하나로 표시하고 상태를 미납 → 일부결제 → 결제로 바꾼다. 지급 행은 숨기고 상세 화면에 지급 내역을 표시한다.
- 2c73a20: 사용자 결정에 따라, 전월·당월 청구서를 한 번에 지급한 지급 행은 당월 매입분을 빼고 전월분만 표시한다(메타: 총 지급 · 당월 매입분 제외). 전월 매입만 지급한 경우는 [결제] 행을 유지하며, 지출 소계에는 들어가지 않는다.
- 1ac4a3c: 사용자 승인에 따라 원본 main(c4956ab)에서도 실패하던 page.tsx 소스 검사 3건을 코드가 옮겨간 위치로 고쳤다(의도는 유지, 삭제 없음). 대상: payable-payment-client 단일 요청, readEditedLedger 후 payables 갱신, InventoryProjectionResolution 코드 문구 변환.

## 4. 검증 결과
- 검증 상태 지문: 0afc02c2747d70e7
- baba-verify 판정: **FAIL** (2026-10-28T07:41:37.138Z, .tmp-baba/verify/2026-10-28T07-41-37-138Z-1ac4a3c2-eea2aa2e-29d6-42b7-a7e9-750ccfa1a787.json)
- 현재 상태와 일치: 예

| 검사 | 실제 실행 | 결과 |
| --- | --- | --- |
| 변경 파일 검사 | 예 | passed |
| 회귀 테스트 | 예 | failed-unclassified |
| ESLint (변경 파일) | 예 | passed |
| TypeScript (tsc --noEmit) | 예 | passed-with-preexisting |
| Production Build (next build) | 예 | passed |

미검증 항목:
- tests/inventory-display-category-sync-browser.test.mjs: skip 1건 (실행 통과로 간주하지 않음)
- tests/ledger-dashboard-scope-browser.test.mjs: skip 1건 (실행 통과로 간주하지 않음)
- tests/ledger-entries-readonly-ui.test.mjs: skip 4건 (실행 통과로 간주하지 않음)
- tests/ledger-entries-scope-browser.test.mjs: skip 1건 (실행 통과로 간주하지 않음)
- tests/ledger-payroll-payment-groups-browser.test.mjs: skip 1건 (실행 통과로 간주하지 않음)
- tests/ledger-progressive-loading-browser.test.mjs: skip 5건 (실행 통과로 간주하지 않음)
- Build는 offline-local-fixture 환경의 검증이다. 운영 환경·인증·DB 연결은 미검증이며 이 .next 산출물을 배포하지 않는다.
- 브라우저 화면 동작(UI)은 이 스크립트가 확인하지 않는다. 필요 시 별도 실행 확인 결과를 인계서에 기록한다.

수동 확인(브라우저·실행 확인 등):
- 로컬 QA 환경: verify Build(.next)를 offline fixture 환경으로 `next start`(127.0.0.1)에서 실행했다. 서버 인증 확인은 테스트 전용으로 대체했다: 임시 로컬 세션 secret, 서버 프로세스 안에서 `users` 조회 1건만 응답하는 fetch stub, 세션 쿠키를 붙이는 로컬 프록시. **실제 로그인·인증 검증은 하지 않았다.** 쿠키 파일은 삭제했고 코드·커밋에 남기지 않았다. 서버·프록시·브라우저는 종료했다.
- 장부 화면: /api는 Playwright가 기존 테스트 helper(실제 route.ts + 메모리 DB)로 응답했다(GET만 허용, 외부 연결 차단). 데이터는 10/3 실제 거래(#2224~2240, #2398, #2403~2406의 ID·금액·거래처·계정·품목, 읽기 전용 조회)와 추가 시나리오(다른 날짜 지급, 부분결제, 여러 청구서 일괄 지급, 전월 매입 지급, 전월+당월 일괄 지급)다. KO/VI × 360px/1280px 4개 조합 모두 통과했다. 10/3은 6건 · 지출 4,859,000₫, 결제 필터 5건 · 4,807,000₫, 일부결제는 Chợ #2225 1건(미지급 1,000)이다. 10/9·10/12 지급일 행은 없다. 10/14 전월 지급은 600,000₫ 1건이고 지출 소계는 없다. 10/16 일괄 지급은 300,000₫(당월 200,000 제외)이다. 상세 지급 내역(#2405 현금, #2398 법인, 연결 청구서 #2236~2238)과 검색(#2405, 일부결제)을 확인했다. 가로 스크롤 0, 페이지 오류 0, 예상 밖 API 0.
- 불변 확인: 같은 fixture를 원본 main 코드와 이 브랜치로 계산한 9·10월 손익 요약·현금보고·계정 잔액·미납금 합계·거래처별 미납이 바이트 단위로 같았다.
- verify가 skip한 브라우저 테스트 6개를 같은 로컬 QA 환경에서 직접 실행했다. ledger-entries-readonly-ui 4/4, ledger-payroll-payment-groups-browser 1/1 통과. ledger-progressive-loading-browser 0/5: 하네스가 모든 /api를 app/api/admin/ledger/<name>/route.ts로 연결해 /api/session에서 ENOENT가 나고, 이후 프로세스가 멈춰 제한 시간에 종료했다. ledger-dashboard-scope-browser 0/1: API 요청 수 기대 3, 실제 5(session·leave-pending-summary 포함). ledger-entries-scope-browser 0/1: 저장소에 없는 /before 비교 경로가 필요하다. inventory-display-category-sync-browser 0/1: 재고 화면 가로 스크롤(이번 변경 범위 밖). 실패 4개 파일은 원본 main 빌드에서 재현하지 않았으므로 기존/신규 분류는 미확정이다.

## 5. DB·Migration
- Migration 변경: 없음
- 기타 SQL 변경: 없음
- 에이전트의 운영 DB 변경·Migration 적용: 없음 (정책상 금지 — AGENTS.md 수동 적용 절차)

## 6. Push·병합·배포
- Git push: push 안 됨
- main 병합: 미병합
- Vercel 배포: 에이전트 미실시 (사용자 승인 후 별도 진행)

## 7. 미완료 사항
- verify 판정 FAIL의 유일한 원인: 브라우저 테스트 6개 파일이 전체 skip이다(PLAYWRIGHT_MODULE_PATH/QA_UI_BASE_URL 없음 → `failed-unclassified`). 그 밖에는 신규 실패 0, 기존 실패 6개 파일, TypeScript 신규 0, ESLint·Build 통과다. 규칙상 인계서 형식 검사는 통과하지 않는다.
- PASS를 받으려면 브라우저 QA 하네스(인증된 QA 서버, /before 비교 경로, session·근태 API 응답)를 제공해야 한다. 이 4개 파일의 실패가 원본 main에서도 같은지 확인해야 한다.
- 데이터 확인: 운영 #2225 payable status는 paid인데 배분은 51,000/52,000이다. 앱은 일부결제(미지급 1,000)로 표시한다. 운영 데이터는 수정하지 않았다.
- 상세 요약의 메타 문구(당월 매입분 제외)는 좁은 화면에서 말줄임 처리된다.

## 8. 후속 작업
- 사용자 결정 필요: 브라우저 QA 하네스 제공 또는 브라우저 테스트 skip 처리 방침. 그 후 verify 재실행.
- 사용자 승인 필요: main 병합, GitHub push, Production 배포. Migration·운영 DB 변경은 없다.

