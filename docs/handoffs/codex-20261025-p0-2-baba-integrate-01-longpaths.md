# 인계서 — BABA P0-2 Windows prepare long paths resolved

> 작성: 2026-10-25T17:12:06.757Z · baba-handoff · 기준 정책 docs/agents/baba-agent-workflow.md

## 1. 작업 정보
- 작업명: BABA P0-2 Windows prepare long paths resolved
- 작업 ID: 20261025-p0-2-baba-integrate-01
- 담당 AI: Codex
- Worktree: baba-wt-codex

## 2. Git 상태
- 작업 브랜치: codex/20261025-p0-2-baba-integrate-01
- HEAD SHA: 7950d08a8d8dc8439d461ade67f2e4eff2cc3746
- 기준: main · merge-base d2f74cc33252b3e40db1657b93c636c40f4fb572
- 작업 커밋 11개:
  - 7950d08 fix: support Windows long paths in isolated BABA preparation
  - 12af242 docs: record P0-2 native symlink final verification
  - a70720b docs: record independently verified Claude P0-2 adoption
  - d7668f4 docs: hand off Claude P0-2 fixes for N1 D1 D2 and remaining blockers
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
| `docs/agents/baba-integrate.md` | 추가 | +174 −0 | 커밋됨 |
| `docs/handoffs/claude-20261025-p0-2-claude-fixes-01.md` | 추가 | +99 −0 | 커밋됨 |
| `docs/handoffs/codex-20261025-p0-2-baba-integrate-01-claude-adoption.md` | 추가 | +104 −0 | 커밋됨 |
| `docs/handoffs/codex-20261025-p0-2-baba-integrate-01-review-fixes.md` | 추가 | +104 −0 | 커밋됨 |
| `docs/handoffs/codex-20261025-p0-2-baba-integrate-01-symlink-final.md` | 추가 | +93 −0 | 커밋됨 |
| `docs/handoffs/codex-20261025-p0-2-baba-integrate-01.md` | 추가 | +95 −0 | 커밋됨 |
| `scripts/agent/baba-handoff.mjs` | 수정 | +3 −3 | 커밋됨 |
| `scripts/agent/baba-integrate.mjs` | 추가 | +282 −0 | 커밋됨 |
| `scripts/agent/baba-start.mjs` | 수정 | +5 −9 | 커밋됨 |
| `scripts/agent/baba-verify.mjs` | 수정 | +72 −15 | 커밋됨 |
| `scripts/agent/lib/access-recorder.mjs` | 추가 | +43 −0 | 커밋됨 |
| `scripts/agent/lib/baseline.mjs` | 수정 | +4 −3 | 커밋됨 |
| `scripts/agent/lib/common.mjs` | 수정 | +99 −5 | 커밋됨 |
| `scripts/agent/lib/remote-main.mjs` | 추가 | +28 −0 | 커밋됨 |
| `scripts/agent/lib/verify-evidence.mjs` | 추가 | +94 −0 | 커밋됨 |
| `tests/agent-workflow-build-env.test.mjs` | 수정 | +2 −2 | 커밋됨 |
| `tests/agent-workflow-integrate.test.mjs` | 추가 | +551 −0 | 커밋됨 |
| `tests/agent-workflow-safety.test.mjs` | 수정 | +4 −3 | 커밋됨 |
| `tests/agent-workflow-start.test.mjs` | 수정 | +20 −2 | 커밋됨 |
| `tests/agent-workflow-tools.test.mjs` | 수정 | +2 −2 | 커밋됨 |

기능 요약:
- P0-2 prepare의 Windows 긴 경로 실패를 해결했다. common.mjs는 Windows 도구 Git subprocess마다 -c core.longpaths=true를 지정한다. baba-integrate.mjs의 격리 환경을 .tmp-baba/i/p-*/<worktree>로 단축해 prepare 단계마다 27자를 줄인다. 테스트 fixture에 깊이 옵션과 긴 Git object/ref 및 실제 기준선 비교 회귀 2건을 추가했다. docs/agents/baba-integrate.md에 범위와 한계를 기록했다. 앱/API/DB/의존성 변경은 없다.

## 4. 검증 결과
- 검증 상태 지문: 133719e9fe229fe5
- baba-verify 판정: **PASS_WITH_PREEXISTING** (2026-10-25T17:11:36.241Z, .tmp-baba/verify/2026-10-25T17-11-36-241Z-7950d08a-b6fbaac4-d7f8-4ae1-8af9-d6042bcbed32.json)
- 현재 상태와 일치: 예

| 검사 | 실제 실행 | 결과 |
| --- | --- | --- |
| 변경 파일 검사 | 예 | passed |
| 회귀 테스트 | 예 | passed |
| ESLint (변경 파일) | 예 | passed |
| TypeScript (tsc --noEmit) | 예 | passed-with-preexisting |
| Production Build (next build) | 예 | passed |

미검증 항목:
- Build는 offline-local-fixture 환경의 검증이다. 운영 환경·인증·DB 연결은 미검증이며 이 .next 산출물을 배포하지 않는다.

수동 확인(브라우저·실행 확인 등): 기존 12건의 실제 실패 보고와 경로를 조사했다(diagnosis.json). 내부 sandbox 209자, loose object 264자, ref lock 285자에서 Git for Windows 2.55.0.windows.2가 실패했다. core.longpaths는 영구 설정·출처 없음, Windows LongPathsEnabled=0이었다. 별도 동일 깊이 fetch 대조: false는 unable to write file / Filename too long / unpack-objects failed, true는 성공(fetch-control.json). Node는 별도 265자 object 쓰기·읽기에 성공(git-node-control.json). 첫 수정 재실행 11 PASS/1 FAIL/0 SKIP은 더 깊은 root 222자, baseline template 248자에서 Node mkdtemp ENAMETOOLONG이었다(node-stage-diagnosis-corrected.json). 이 실패도 면제하지 않고 prepare 경로를 단축했다. 최종 회귀 2 PASS/0 FAIL/0 SKIP(regression-v2.tap); 기존 12건을 source root 101자의 깊은 격리 환경에서 재실행해 12 PASS/0 FAIL/0 SKIP(v2/failed-12-rerun.json). 전체 관련 5개 파일은 79 PASS/0 FAIL/0 SKIP(v2/agent-workflow-full.json). 기존 symlink 회귀도 실제 통과했다. 최신 Verify의 strict verifyEvidence(build:true)는 차단 없음. 운영/브라우저 확인 없음.

## 5. DB·Migration
- Migration 변경: 없음
- 기타 SQL 변경: 없음
- 에이전트의 운영 DB 변경·Migration 적용: 없음 (정책상 금지 — AGENTS.md 수동 적용 절차)

## 6. Push·병합·배포
- Git push: push 안 됨
- main 병합: 미병합
- Vercel 배포: 에이전트 미실시 (사용자 승인 후 별도 진행)

## 7. 미완료 사항
- 소스 검증 단계의 경로 길이 FAIL/SKIP은 없다. 기존 TypeScript 40건은 main 기준선과 동일하고 신규 0이다. 전체 업무 테스트·운영 인증/DB는 이번 범위에서 실행하지 않았다. R1 독립 인증 부재에 따른 main 실행 비활성화, R2 TOCTOU, 동일 프로세스 recorder 신뢰 한계는 기존 정책 그대로 유지한다.

## 8. 후속 작업
- 이 추가 Handoff만 로컬 작업 브랜치에 커밋하고 --handoff를 명시해 inspect 및 실제 prepare를 순서대로 실행한다. 최종 결과·후보 SHA·격리 Verify archive·검증 지문은 .tmp-baba/p0-2-path-fix/final-integration-checks.json에 연결한다. 예전 Handoff/Start/검증 증거 및 긴 경로 환경은 보존한다. main 병합·GitHub push·Production·운영 DB/Migration 변경은 금지이며 자동 main 실행을 재활성화하지 않았다. 후속 병합은 사용자 직접 실행/독립 인증 경계에 대한 별도 결정이 필요하다.


추가 증거 위치: `.tmp-baba/p0-2-path-fix/`. 첫 실패 로그와 v2 통과 로그를 모두 보존한다. 공유 Git config SHA256은 shared-config-before.json과 최종 보고에서 대조하며 시스템/전역/공유 Git 설정을 변경하지 않는다. 기존 Start task ID와 브랜치를 재사용했다.
