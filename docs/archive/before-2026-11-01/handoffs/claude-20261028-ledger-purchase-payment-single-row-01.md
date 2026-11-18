# 인계서 — 장부 매입 미납-결제 중복 표시 제거

> 작성: 2026-10-28T06:50:45.327Z · baba-handoff · 기준 정책 docs/agents/baba-agent-workflow.md

## 1. 작업 정보
- 작업명: 장부 매입 미납-결제 중복 표시 제거
- 작업 ID: 20261028-ledger-purchase-payment-single-row-01
- 담당 AI: Claude Code
- Worktree: baba-wt-claude

## 2. Git 상태
- 작업 브랜치: claude/20261028-ledger-purchase-payment-single-row-01
- HEAD SHA: 7c14a3d405f935d7a6e8d0e729a577f51566afd8
- 기준: origin/main · merge-base c4956ab74ef4cbed5050517f15b161cdbdf896cd
- 작업 커밋 1개:
  - 7c14a3d fix(ledger): list each purchase once as 미납 → 일부결제 → 결제
- 미커밋 변경: 없음

## 3. 변경 파일과 기능
| 파일 | 상태 | 변경량 | 커밋 |
| --- | --- | --- | --- |
| `app/(protected)/admin/ledger/entries/entries.module.css` | 수정 | +3 −0 | 커밋됨 |
| `app/(protected)/admin/ledger/entries/page.tsx` | 수정 | +32 −1 | 커밋됨 |
| `lib/ledger/entries.ts` | 수정 | +96 −6 | 커밋됨 |
| `lib/ledger/entry-display-badge.ts` | 수정 | +9 −5 | 커밋됨 |
| `lib/ledger/entry-list-filter.ts` | 수정 | +14 −8 | 커밋됨 |
| `tests/ledger-entries-v1.test.ts` | 수정 | +6 −4 | 커밋됨 |
| `tests/ledger-entry-filter-visibility.test.ts` | 수정 | +2 −1 | 커밋됨 |
| `tests/ledger-entry-list-filter.test.ts` | 수정 | +17 −14 | 커밋됨 |
| `tests/ledger-purchase-payment-single-row.test.ts` | 추가 | +259 −0 | 커밋됨 |
| `tests/ledger-reserve-history-entries.test.ts` | 수정 | +1 −1 | 커밋됨 |

기능 요약:
- `lib/ledger/entries.ts`: 이 월 화면에 나오는 미지급 매입 전체에 지급액이 모두 배분된 `payable_payment`는 `paymentSettledInPayables`로 표시한다. 매입 행(재고 묶음 포함)은 `payablePayments`(지급일·지급계정·배분액·총 지급액·연결 청구서 ID)를 갖는다. 다른 월 매입에 배분된 지급은 기존처럼 자기 행을 유지한다. 연결 지급차액(예: 9/11 Mega Market 600₫)은 지급 행이 숨겨질 때 파생 [조정] 행이 전체 목록과 소계에 들어가 일 지출 소계를 유지한다. 금액·direction·movement·DB는 바꾸지 않는다.
- `lib/ledger/entry-display-badge.ts`: 미지급 매입 배지를 정산 상태(조회 월 기준)로 표시한다: 미납 → 일부결제(신규, VI "Trả một phần") → 결제. 완납 매입은 더 이상 [지출]로 표시하지 않는다.
- `lib/ledger/entry-list-filter.ts`: `일부결제` 필터를 추가했다. `paymentSettledInPayables` 행은 모든 필터에서 제외한다. 결제 필터 날짜 헤더는 부호 없는 지급 합계를 쓰고, 일부결제는 수입/지출 쌍을 쓴다. 지출 필터는 기존대로 회계상 expense(상태 무관)를 표시한다.
- `page.tsx`·`entries.module.css`: 상세에 "지급 내역 · N회" 섹션(지급일·계정·배분액·지급 #ID·총 지급액·연결 청구서)을 추가했다. 검색 대상에 배지 이름과 지급 #ID를 넣고, `.direction.partial` 배지 스타일을 추가했다.
- 테스트: 신규 `tests/ledger-purchase-payment-single-row.test.ts`(10/3 운영 ID·금액 5건, 다른 날짜 지급, 여러 날짜 청구서 일괄 지급, 분할 지급, 월 경계, 수기·POS·급여·카드 영향, 금액·소계 불변, KO/VI). 기존 기대값 변경은 사용자 확정 요구사항(완납 매입 [지출] 금지, 결제 행 중복 금지)에 따른 것이다: v1 배지 3/4번 unpaid/expense→partial/payment, 필터 목록에 partial 추가, 9/11 A/E는 결제 행 대신 매입 1회 + 차액 행으로 변경(지출 소계 11,862,600 유지), 소스 정규식 2건을 갱신했다.

## 4. 검증 결과
- 검증 상태 지문: 2d701f611fa4ee8c
- baba-verify 판정: **FAIL** (2026-10-28T06:50:44.416Z, .tmp-baba/verify/2026-10-28T06-50-44-416Z-7c14a3d4-86da4af2-2e94-4134-b52a-2686e8e30bc1.json)
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

수동 확인(브라우저·실행 확인 등): 없음. 운영 DB는 읽기 전용 SELECT로만 10/3 거래·배분(#2224~2240, #2398, #2403~2406)과 지급차액 연결 지급 4건(#1640, #1978, #2016, #2148, 모두 같은 월 매입)을 확인했다. 회귀 테스트 "신규 실패" 3건(inventory-ledger-projection-api, ledger-inventory-auto-post, ledger-inventory-rebook)은 원본 main(c4956ab)에서도 같은 assertion으로 실패한다. 이번 변경과 무관한 기존 실패이며 verify가 잘못 분류했다.

## 5. DB·Migration
- Migration 변경: 없음
- 기타 SQL 변경: 없음
- 에이전트의 운영 DB 변경·Migration 적용: 없음 (정책상 금지 — AGENTS.md 수동 적용 절차)

## 6. Push·병합·배포
- Git push: push 안 됨
- main 병합: 미병합
- Vercel 배포: 에이전트 미실시 (사용자 승인 후 별도 진행)

## 7. 미완료 사항
- 모바일 360px·PC 실제 화면 확인 미실시(CSS·마크업만 테스트). 실제 데이터로 10월 장부 화면을 확인해야 한다.
- 다른 월 매입에 대한 지급(예: 9월 매입을 10월에 지급)은 10월 목록에 [결제] 행으로 남는다. 숨기면 해당 월 목록에서 현금 지급이 보이지 않기 때문이다. 정책 확인이 필요하다.
- 숨겨진 지급 행의 기존 상세 기능(수동 표시 수정 등)은 목록에서 열 수 없다. 지급 수정이 필요하면 미납금 지급 내역 화면을 사용한다.
- 연결 청구서는 같은 월 화면에 있는 매입 ID만 표시한다.

## 8. 후속 작업
- 사용자 승인 필요: main 병합, GitHub push, Production 배포. Migration·운영 DB 변경은 없다.
- 다음 담당: 사용자 화면 확인(10/3 5건, 360px·PC, KO/VI) → 승인 후 병합.

