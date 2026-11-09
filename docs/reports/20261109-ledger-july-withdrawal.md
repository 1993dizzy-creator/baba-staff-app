# 7월 역산 코드·SQL 철회 — 2026-11-09

작업 Worktree: `C:\workspace\baba-wt-codex-july-restore`  
브랜치: `codex/july-ledger-batch-restore-20261107`  
철회 전 커밋: `fa4384ee` / 확인한 Main: `8dc72e1b`

## 범위와 보존

- 시작 시 Main 및 등록된 Worktree 4곳 모두 미커밋 변경이 없었다. 다른 Worktree는 수정하지 않았다.
- 7월 전용 Migration 2개, 일회성 기초 시드·복원·FAST PATH·경제분류 스크립트, 전용 라이브러리·테스트·보고서·추적 증거 파일 총 56개를 삭제했다. 전체 목록은 아래와 같다.
- `/admin/ledger`에서 분류 대기·분류 완료 UI를, API에서 `ledger_cash_import_status_v1` 호출과 응답을 제거했다. 공통 계산에서 `historical_cash_event` 및 `cash_import_recognition` 특별 처리를 제거했다.
- 공통 파일은 `2f7dab11`의 해당 변경만 역적용했다. AGENTS.md의 철회된 49행 등록 상태 문구와 10월 증거 보고서의 7월 로컬 경로 언급도 제거했다.
- **유지:** `20261105153442_protect_august_opening_fund_boundary.sql`, 기존 카드정산·수수료·입고·장부·마감 코드와 데이터 계약, 카드매출 #1190의 8월 이월 처리.
- **유지:** `fundOpeningBoundaries`와 계정별 최신 기초잔액 경계. FAST PATH 커밋에 들어왔지만 7월에 한정되지 않는 잔액 보호 로직이다. 제거하면 열린 9월 조회 fixture의 자금 잔액이 168,300에서 336,600으로 변하는 것을 전후 비교로 발견했다. 해당 부분은 유지하여 8월 이후 잔액 변화가 없도록 했다.
- 2026-10-27의 7월 카드비용 귀속 보고서는 기존 8월 정산 계산의 감사 근거이므로 유지했다. `.local/evidence-archive`의 10월 감사자료도 보존했다.
- 운영 DB 접속·SQL·Migration 적용/이력 수정은 하지 않았다. Main 병합·Push·배포도 하지 않았다.

## 검증

- `tsc --noEmit`: 종료 코드 0. 마지막 API 경계 보존 후에도 `next build` 내 TypeScript 검사를 통과했다.
- `npm run build`: 마지막 코드 기준 종료 코드 0, 컴파일·TypeScript·73개 정적 페이지 생성 성공. 운영 자격 증명 없이 localhost 더미 설정을 프로세스 환경변수로만 사용했다.
- 로컬 Node 검증 23파일: **435개 중 426 통과, 9 실패**, skip 0. 최종 경계 보존 후 영향받는 5파일을 재검증하여 **107개 중 105 통과, 같은 기존 실패 2개**를 확인했다. 코드가 바뀌지 않은 나머지 검사 증거는 재사용했다.
- 철회 전 `fa4384ee`의 독립 소스 사본에서 실패한 3파일을 재현했다. **77개 중 67 통과, 10 실패**였다. 현재 실패 9개는 모두 기존 실패와 동일하고, FAST PATH RPC 제거로 기존 실패 1개는 해소됐다. 임시 소스 사본은 비교 후 삭제했다.
- 기존 실패: 카드수수료 테스트 1개는 `confirmed_at`을 현재 날짜와 무관하게 `2026-10`으로 고정한다. Entries 조회 테스트 6개는 fixture에 `supplier-prepayments` 의존성이 없다. summary 테스트 2개는 기존 화면·쿼리 구조와 맞지 않는 소스 정규식이다. 이 작업에서 무관한 테스트나 제품 코드를 수정하지 않았다. **전체 테스트 PASS로 취급하지 않는다.**
- 철회 전후 API 직접 비교 **18조합 통과**: 8·9·10월 × 마감/열린 월 × 전체/계정/대시보드 scope. `summary`, `accounts`, `salesReceiptExplanation`, `cashReport`, `accrual`, `entries`가 동일하며, 철회 후 `cashImport` 응답은 없다. 실운영 데이터 검증이 아닌 로컬 fixture 비교다.
- 기존 8월 경계 DB 테스트는 PGlite에서 LF/CRLF, 월마감 스냅샷·해시, 권한·지급한도와 카드 이월 보호를 검증했다. 카드정산 API·자동 수수료·월마감·입고 projection 관련 검사도 위 23파일에 포함했다. 운영 DB 테스트는 실행하지 않았다.
- `git diff --check` 통과. 앱·공통 라이브러리·남은 테스트·실행 스크립트에서 철회한 RPC와 `historical_cash_event`, `cash_import_recognition`, 전용 모듈 참조가 남지 않은 것을 확인했다.
- 로컬 상세 로그: `.local/withdrawal-check/tests.tap`, `baseline-tests.tap`, `final-affected.tap`, `build.log`. 전체 삭제 목록은 `git show --name-status <철회 커밋>`으로도 확인할 수 있다.

## 남은 로컬 정리

`.local/july-restore`는 **253파일이 남아 있다**. 대상 절대 경로가 지정 Worktree 내부이고 reparse point가 없는 것을 확인했으나, 일괄 삭제 명령이 자동 승인 검토에서 `blocked by policy`로 거절됐다. 우회 삭제하지 않았다. 따라서 로컬 산출물 삭제까지 완결된 상태는 아니다. 이 폴더는 Git 추적 제외 상태다.

## Main 통합 검토

이번 커밋은 Worktree 전용이다. Main의 카드수수료·입고·매출 마감 후속 변경을 가져오거나 되돌리지 않았다. 실제 소스 충돌 여부는 커밋 후 `git merge-tree --write-tree main <철회 커밋>`으로 검사하고 최종 인계에 보고한다. 이 명령은 브랜치·인덱스·작업 파일을 병합하지 않는다. Main에만 있는 과거 FAST PATH 병합 보고서는 이번 Worktree에 존재하지 않아 변경하지 않았다.

## 삭제 파일 전체 목록

- `docs/reports/20261107-july-395-batch-restore.md`
- `docs/reports/20261107-july-fast-path-design.md`
- `docs/reports/20261107-july-fast-path-implementation.md`
- `docs/reports/20261107-july-local-artifact-relocation.md`
- `docs/reports/20261107-july-phase2-reconstruction.md`
- `docs/reports/20261107-july-phase2-resolver-contract.md`
- `docs/reports/20261107-july-phase2-scope-blocked.md`
- `docs/reports/20261107-july-phase3-lock-contract.md`
- `docs/reports/20261107-july-phase3-source-links.md`
- `docs/reports/20261107-july-phase4-advance-contract.md`
- `docs/reports/20261107-july-phase4-routing.md`
- `docs/reports/20261107-july-runtime-ready-subset.md`
- `docs/reports/20261108-july-economic-classification.md`
- `lib/ledger/july-restore-plan.ts`
- `lib/ledger/july-restore-runtime-review.mjs`
- `scripts/ledger/cash-first-simulation.mjs`
- `scripts/ledger/cash-import-batch.mjs`
- `scripts/ledger/cash-import-economics-plan.mjs`
- `scripts/ledger/evidence/20261106-july-opening-before-READONLY.json`
- `scripts/ledger/evidence/20261107-july-restore-summary.json`
- `scripts/ledger/evidence/20261107-july-runtime-summary.json`
- `scripts/ledger/july-opening-4funds-20261106-ONE-OFF.sql`
- `scripts/ledger/july-opening-4funds-20261106-preflight-READONLY.sql`
- `scripts/ledger/july-restore-batch.sql`
- `scripts/ledger/july-restore-dry-run.mjs`
- `scripts/ledger/july-restore-phase2-batch.sql`
- `scripts/ledger/july-restore-phase2-plan.mjs`
- `scripts/ledger/july-restore-phase2-readonly.mjs`
- `scripts/ledger/july-restore-phase2.mjs`
- `scripts/ledger/july-restore-phase3-batch.sql`
- `scripts/ledger/july-restore-phase3-plan.mjs`
- `scripts/ledger/july-restore-phase3-readonly.mjs`
- `scripts/ledger/july-restore-phase4-advance-contract.mjs`
- `scripts/ledger/july-restore-phase4-batch.sql`
- `scripts/ledger/july-restore-phase4-plan.mjs`
- `scripts/ledger/july-restore-phase4-readonly.mjs`
- `scripts/ledger/july-restore-rpc-contracts.mjs`
- `scripts/ledger/july-restore-runtime-readonly.mjs`
- `scripts/ledger/july-restore-runtime-review.mjs`
- `scripts/ledger/july-restore-source-review.mjs`
- `supabase/migrations/20261107150007_ledger_historical_cash_import_v1.sql`
- `supabase/migrations/20261108140000_ledger_import_economic_resolution_v1.sql`
- `tests/cash-first-simulation.test.mjs`
- `tests/cash-import-api.test.mjs`
- `tests/cash-import-boundary.test.mjs`
- `tests/cash-import-db.test.mjs`
- `tests/cash-import-economics.test.mjs`
- `tests/helpers/cash-import-fixture.mjs`
- `tests/july-restore-phase2-scope.test.mjs`
- `tests/july-restore-phase2.test.mjs`
- `tests/july-restore-phase3.test.mjs`
- `tests/july-restore-phase4.test.mjs`
- `tests/july-restore-runtime-review.test.mjs`
- `tests/july-restore-source-review.test.mjs`
- `tests/july-restore.test.mjs`
- `tests/ledger-july-opening-oneoff-db.test.mjs`
