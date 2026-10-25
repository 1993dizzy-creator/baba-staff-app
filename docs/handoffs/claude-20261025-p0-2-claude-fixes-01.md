# 인계서 — BABA P0-2 Claude fixes N1 D1 D2

> 작성: 2026-10-25T14:17:32.902Z · baba-handoff · 기준 정책 docs/agents/baba-agent-workflow.md

## 1. 작업 정보
- 작업명: BABA P0-2 Claude fixes N1 D1 D2
- 작업 ID: 20261025-p0-2-claude-fixes-01
- 담당 AI: Claude Code
- Worktree: baba-wt-claude

## 2. Git 상태
- 작업 브랜치: claude/20261025-p0-2-claude-fixes-01
- HEAD SHA: 4afa730bd5918bc4755f8fa3f4a46836562f4b1b
- 기준: main · merge-base d2f74cc33252b3e40db1657b93c636c40f4fb572
- 작업 커밋 7개:
  - 4afa730 test: cover access recorder import/read separation and inert preload
  - 44c5d31 fix: neutralize agent-shell Git env, fsmonitor/textconv, and accept recorded test exercise evidence
  - 6e98052 docs: hand off P0-2 independent review fixes and remaining blockers
  - d751179 fix: restrict index overrides to internal verification snapshots
  - 0c6c846 fix: harden integration hooks test evidence and remote freshness
  - 10bdc30 docs: record P0-2 verification and remaining integration blockers
  - b340d44 feat: prepare BABA integration with evidence and SHA-bound approval gates
- 미커밋 변경: 없음

## 3. 변경 파일과 기능
| 파일 | 상태 | 변경량 | 커밋 |
| --- | --- | --- | --- |
| `docs/agents/baba-agent-workflow.md` | 수정 | +4 −0 | 커밋됨 |
| `docs/agents/baba-integrate.md` | 추가 | +163 −0 | 커밋됨 |
| `docs/handoffs/codex-20261025-p0-2-baba-integrate-01-review-fixes.md` | 추가 | +104 −0 | 커밋됨 |
| `docs/handoffs/codex-20261025-p0-2-baba-integrate-01.md` | 추가 | +95 −0 | 커밋됨 |
| `scripts/agent/baba-handoff.mjs` | 수정 | +3 −3 | 커밋됨 |
| `scripts/agent/baba-integrate.mjs` | 추가 | +281 −0 | 커밋됨 |
| `scripts/agent/baba-start.mjs` | 수정 | +5 −9 | 커밋됨 |
| `scripts/agent/baba-verify.mjs` | 수정 | +72 −15 | 커밋됨 |
| `scripts/agent/lib/access-recorder.mjs` | 추가 | +43 −0 | 커밋됨 |
| `scripts/agent/lib/baseline.mjs` | 수정 | +4 −3 | 커밋됨 |
| `scripts/agent/lib/common.mjs` | 수정 | +96 −5 | 커밋됨 |
| `scripts/agent/lib/remote-main.mjs` | 추가 | +28 −0 | 커밋됨 |
| `scripts/agent/lib/verify-evidence.mjs` | 추가 | +94 −0 | 커밋됨 |
| `tests/agent-workflow-build-env.test.mjs` | 수정 | +2 −2 | 커밋됨 |
| `tests/agent-workflow-integrate.test.mjs` | 추가 | +507 −0 | 커밋됨 |
| `tests/agent-workflow-safety.test.mjs` | 수정 | +4 −3 | 커밋됨 |
| `tests/agent-workflow-start.test.mjs` | 수정 | +20 −2 | 커밋됨 |
| `tests/agent-workflow-tools.test.mjs` | 수정 | +2 −2 | 커밋됨 |

기능 요약:
- 기반: Codex 후보 `6e98052854c15c0c76d1f39dd9ccaa7f3d4ff90e`. 위 표는 main 이후 P0-2 전체이며, 이 작업(Claude)의 커밋은 `44c5d31`, `4afa730` 두 개다. 변경 파일: `scripts/agent/lib/common.mjs`, `scripts/agent/baba-verify.mjs`, `scripts/agent/lib/access-recorder.mjs`(신규), `scripts/agent/lib/verify-evidence.mjs`, `scripts/agent/baba-integrate.mjs`, `scripts/agent/baba-handoff.mjs`, `tests/agent-workflow-integrate.test.mjs`, `docs/agents/baba-integrate.md`.
- N1 (`common.mjs`): Claude Code 셸의 `GIT_EDITOR`/`GIT_ASKPASS`(및 `GIT_SEQUENCE_EDITOR`, `SSH_ASKPASS`) 때문에 baba-start/verify/integrate가 `GIT_ENVIRONMENT_UNVERIFIED`로 전부 막히던 문제를 고쳤다. 이 변수들은 신뢰하지 않고 모든 도구 Git subprocess 환경에서 제거하며 `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`를 지정한다. 원격 인증은 사용자 credential helper만 사용한다. 그 밖의 `GIT_*` override(`GIT_SSH_COMMAND`, `GIT_EXEC_PATH`, `GIT_CONFIG_*`, `GIT_DIR`, `GIT_TRACE` 등)는 계속 차단한다.
- D1 (`common.mjs`, `baba-handoff.mjs`): 읽기 전용 `git status`에서도 `core.fsmonitor` 프로그램이 실행되던 우회를 막았다. 공통 `git()` helper가 모든 호출에 `-c core.fsmonitor=false`를 넣고, 내용 diff(`--binary`, `--numstat`)에는 `--no-ext-diff --no-textconv`를 붙인다. `assertNoGitHooks`의 config 조회도 같은 helper를 쓴다. 사용자·시스템 config는 바꾸거나 거부하지 않는다(시스템의 LFS filter·astextplain textconv·credential helper가 있어 거부하면 도구가 다시 막힌다).
- D2 (`baba-verify.mjs`, `access-recorder.mjs`, `verify-evidence.mjs`, `baba-integrate.mjs`): 경로를 참조하는 테스트가 없는 변경 파일이 있으면 Verify가 recorder를 테스트 프로세스에 preload해 실제 import/read를 기록한다. 코드 파일은 통과한 테스트가 import했을 때만, SQL/CSS는 읽었을 때만 `testSelection.exercised`에 남고 gap에서 빠진다. evidence 검사는 각 테스트의 기록과 대조하고(변경 파일만, 통과 테스트만, 실행 목록 안의 테스트만), prepare는 상속한 증거를 병합 트리에서 다시 확보하지 못하면 `PREPARE_EXERCISE_NOT_REPRODUCED`로 차단한다. 증거가 없으면 기존처럼 차단한다. 무조건 허용 예외는 없다.

## 4. 검증 결과
- 검증 상태 지문: 7ef007ccda7e2ea5
- baba-verify 판정: **PASS_WITH_PREEXISTING** (2026-10-25T14:17:20.093Z, .tmp-baba/verify/2026-10-25T14-17-20-093Z-4afa730b-f373b3af-82e9-4b87-9c28-21e822bb2a81.json)
- 현재 상태와 일치: 예

| 검사 | 실제 실행 | 결과 |
| --- | --- | --- |
| 변경 파일 검사 | 예 | passed |
| 회귀 테스트 | 예 | passed |
| ESLint (변경 파일) | 예 | passed |
| TypeScript (tsc --noEmit) | 예 | passed-with-preexisting |
| Production Build (next build) | 예 | passed |

미검증 항목:
- tests/agent-workflow-integrate.test.mjs: skip 1건 (실행 통과로 간주하지 않음)
- Build는 offline-local-fixture 환경의 검증이다. 운영 환경·인증·DB 연결은 미검증이며 이 .next 산출물을 배포하지 않는다.

수동 확인(브라우저·실행 확인 등):
- 시작 전: Claude Worktree clean, `claude/ready-20261024-01` @ d2f74cc, 공유 Hook 0개, hook·includeIf·hooksPath·fsmonitor config 0건. 시스템/전역 config에 LFS filter·astextplain textconv·credential helper·core.editor가 있음(이름만 확인, 값 미출력).
- baba-start는 Codex 후보와의 의도된 파일 겹침으로 `WORKTREE_CONFLICT` 차단(변경 없음). 사용자 지시에 따라 후보 SHA에서 `git switch --no-track -c`로 직접 생성했다. 그래서 start task 기록이 없으며 임의로 만들지 않았다.
- agent-workflow 5개 파일: Claude Code 기본 환경(`GIT_EDITOR` 존재) 77건 / 통과 76 / 실패 0 / skip 1, `GIT_EDITOR`·`GIT_ASKPASS`·`GIT_TERMINAL_PROMPT` 제거(Codex형) 환경 77건 / 통과 76 / 실패 0 / skip 1. skip은 native symlink(EPERM) 1건.
- 신규 회귀: N1(에이전트 셸 변수 무력화, CLI inspect·prepare 실제 실행, 위험 override 차단), D1(fsmonitor·textconv 미실행 + 같은 fixture의 일반 Git 양성 대조에서 실행 확인), D2(정상 0건 매칭 후보 PREPARED, 새 main에서 증거 재현 실패 차단, 무관 테스트·read-only·위조 증거 차단), recorder 단위 테스트.
- Claude 기본 환경 실제 CLI: Codex 후보 inspect `VERIFY_TEST_INCOMPLETE`(환경 차단 아님), merge `LOCAL_MAIN_EXECUTION_DISABLED` / 원격 `equal`, baba-start는 기록 없는 이 브랜치를 `UNRECORDED_BRANCH`로 보호.
- 전체 `baba-verify --base main --all-tests --build` (44c5d31): 4281건 / 통과 4179 / 실패 59 / skip 43, 원본 판정 FAIL 유지. 실패 23개 파일 59건은 경로 정규화 후 23개 모두 main 기준선 및 6e98052 실행과 동일, 신규 0. raw "new" 2개 파일은 P1 오분류. 비교 결과 `.tmp-baba/claude-fix/full-comparison.json`.

## 5. DB·Migration
- Migration 변경: 없음
- 기타 SQL 변경: 없음
- 에이전트의 운영 DB 변경·Migration 적용: 없음 (정책상 금지 — AGENTS.md 수동 적용 절차)

## 6. Push·병합·배포
- Git push: push 안 됨
- main 병합: 미병합
- Vercel 배포: 에이전트 미실시 (사용자 승인 후 별도 진행)

## 7. 미완료 사항
- native symlink skip 1건 미검증. Windows 권한을 바꾸지 않았고 `VERIFY_TEST_INCOMPLETE` 차단을 유지한다.
- 이 브랜치에는 start task 기록이 없어 그대로는 baba-integrate 후보(`MISSING_RECORD`)가 될 수 없다. 통합 경로는 사용자가 정한다.
- R2 TOCTOU, P1 TAP 이중 백슬래시 경로 오분류, R1 독립 승인 경로 부재는 미해결.
- D1 잔여: filter driver(LFS 등)·credential helper·`core.sshCommand`는 사용자/시스템 config로 실행될 수 있고 helper가 격리하지 않는다. 테스트·Build 자식 프로세스가 직접 실행하는 Git에는 fsmonitor 무력화가 적용되지 않는다.
- D2 한계: recorder는 실행 증거이지 assertion 품질 증명이 아니며, 테스트 코드가 같은 프로세스에서 우회·위조할 수 있다.

## 8. 후속 작업
- Codex 독립 검증: Codex 기본 환경에서 이 브랜치의 agent-workflow 회귀, N1 변수 제거 범위와 차단 목록, fsmonitor/textconv 무력화의 Git 호출 누락 여부, recorder 증거 판정 규칙(코드=import, SQL/CSS=read)과 위조 내성, prepare 재현 검사.
- 사용자 결정: (1) Codex 브랜치 대신 이 브랜치를 P0-2 후보로 쓸지와 start 기록 처리 방법, (2) native symlink skip 해소 방법, (3) D1 잔여 범위를 이번 P0-2에서 더 다룰지.
- main 병합·GitHub push·Production 배포·운영 DB/Migration은 별도 사용자 승인 대상이며 이번에 실행하지 않았다.

