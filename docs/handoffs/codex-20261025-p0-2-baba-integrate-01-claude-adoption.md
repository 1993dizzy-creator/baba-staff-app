# 인계서 — BABA P0-2 Claude fixes independently verified adoption

> 작성: 2026-10-25T15:40:39.412Z · baba-handoff · 기준 정책 docs/agents/baba-agent-workflow.md

## 1. 작업 정보
- 작업명: BABA P0-2 Claude fixes independently verified adoption
- 작업 ID: 20261025-p0-2-baba-integrate-01
- 담당 AI: Codex
- Worktree: baba-wt-codex

## 2. Git 상태
- 작업 브랜치: codex/20261025-p0-2-baba-integrate-01
- HEAD SHA: d7668f4c344b895925d2825e4594a821b6501d30
- 기준: main · merge-base d2f74cc33252b3e40db1657b93c636c40f4fb572
- 작업 커밋 8개:
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
| `docs/agents/baba-integrate.md` | 추가 | +163 −0 | 커밋됨 |
| `docs/handoffs/claude-20261025-p0-2-claude-fixes-01.md` | 추가 | +99 −0 | 커밋됨 |
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
- 기존 Codex 후보 `6e98052854c15c0c76d1f39dd9ccaa7f3d4ff90e`의 직계 후속 3개 커밋 `44c5d31` → `4afa730` → `d7668f4`를 독립 검토·검증한 뒤 기존 Codex 작업 브랜치에 `--ff-only`로 반영했다. cherry-pick, 이력 재작성, 원본 main 병합은 하지 않았다. 이 인계서의 HEAD는 검증한 코드 상태이며, 인계서 자체는 후속 문서 커밋에 포함한다.
- N1: 공통 Git 자식 환경에서 editor/askpass 변수 4개를 제거하고 다른 Git 환경 override 차단을 유지한다. D1: 공통 Git helper의 fsmonitor 비활성화와 내용 diff의 textconv/external diff 비활성화를 적용한다. 파일·config Hook과 includeIf 검사도 유지한다.
- D2: 자동 매칭되지 않은 변경 코드의 실행 증거를 기록하고, 변경 범위·실행 테스트·모듈 import 증거의 일치를 검사한다. prepare는 명시적 테스트 목록과 실행 증거를 통합 트리에서 재검증한다. 이는 독립 인증이나 테스트 assertion의 적절성 증명이 아니다.
- 이번 반영 범위는 Claude의 9개 파일이며 앱 기능·SQL·Migration 변경은 없다. 기존 Codex/Claude Handoff와 task 기록은 수정하지 않았다. Codex task 파일 SHA-256은 반영 전후 `cf086787da0a22a0d229fc8d29e1a8c0bb109754597ddebcf5d063c2bfd0cb1f`로 같다. 반영 후 `baba-start --resume 20261025-p0-2-baba-integrate-01 --json`은 `RESUMED`, branchCreated=false를 반환했다.

## 4. 검증 결과
- 검증 상태 지문: 7ef007ccda7e2ea5
- baba-verify 판정: **PASS_WITH_PREEXISTING** (2026-10-25T15:40:16.189Z, .tmp-baba/verify/2026-10-25T15-40-16-189Z-d7668f4c-46f4700d-5518-419e-9171-90ac7b2b2a39.json)
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

수동 확인(브라우저·실행 확인 등): 브라우저 확인 없음. 다음 로컬 CLI·격리 fixture 확인을 수행했다.

- 세 Worktree의 HEAD·브랜치·clean 상태와 기존 기록을 읽기 전용으로 조사했다. 원본 main과 Claude Worktree의 HEAD는 모두 `d2f74cc33252b3e40db1657b93c636c40f4fb572`였고 반영 후에도 같다. Claude Worktree는 `claude/ready-20261024-01`을 유지한다.
- 반영 전 Hook·유효 Git 설정·include/환경 영향과 대상 파일의 filter/diff/working-tree-encoding 속성을 확인했다. 활성 외부 Hook/checkout filter가 없음을 확인한 뒤 명령 단위 전용 빈 hooksPath를 사용했다. 원본·전역 설정 및 공유 Hook은 변경하지 않았다.
- 독립 저장소에서 Codex 기본 Git 환경으로 agent-workflow 5개 파일을 실행: 77건 / PASS 76 / FAIL 0 / SKIP 1. editor/askpass 변수 4개를 주입한 N1/D1/D2 검증: 11건 / PASS 11 / FAIL 0. Hook·fsmonitor·textconv positive control과 helper 내 실행 방지, prepare 재검증을 포함한다.
- 실제 실행 증거를 대상으로 summary/test 불일치, access 누락, import 대신 read, 미실행 test, 변경 밖 파일, 실패 test의 6가지 변조를 각각 주입했고 모두 거부됐다. 서로 일치하도록 악의적으로 함께 위조한 같은 프로세스의 기록까지 인증하지는 못한다.
- 최초 깊은 격리 경로에서는 Git branch lock의 `Filename too long`을 실제 재현했다(참조 경로 길이 277). 기본 profile FAIL 12 및 주입 profile FAIL 4는 이 경로 제약으로 인한 fixture 실패였다. 같은 SHA를 짧은 Worktree 내부 경로 `.tmp-baba/v/baba-wt-codex`에서 재실행해 위 결과를 얻었다. 기존 실패 로그도 보존했고 전역 longpaths 설정은 변경하지 않았다.
- 반영 후 실제 Codex Worktree에서 `baba-verify --base main --build --json` 재실행: 5개 테스트 파일 77건 / PASS 76 / FAIL 0 / SKIP 1. ESLint 통과, TypeScript 40건은 main snapshot의 진단과 일치(신규 0), Build exit 0. Build는 offline-local-fixture이며 운영 자격 증명을 사용하지 않았다.
- 엄격한 `verifyEvidence(..., build:true)` 결과는 `VERIFY_TEST_INCOMPLETE` 1개다. native directory symlink SKIP은 통과로 처리하지 않았다. junction/hardlink 결과로 대체하지 않았고 관리자 권한·Developer Mode·ACL을 변경하지 않았다.
- 증거 디렉터리: `.tmp-baba/claude-adoption/review-RY8DSH/`. 주요 파일: `lineage-and-handoff.json`, `pre-adoption-safety.json`, `adoption.json`, `short-default-1792942113981.json`, `short-agent-env-1792941835329.json`, `independent-evidence-mutations.json`, `path-switch-diagnosis.json`, `post-adoption-gate.json`. 재검증 원본은 위 baba-verify archive를 사용한다.

## 5. DB·Migration
- Migration 변경: 없음
- 기타 SQL 변경: 없음
- 에이전트의 운영 DB 변경·Migration 적용: 없음 (정책상 금지 — AGENTS.md 수동 적용 절차)

## 6. Push·병합·배포
- Git push: push 안 됨
- main 병합: 미병합
- Vercel 배포: 에이전트 미실시 (사용자 승인 후 별도 진행)

## 7. 미완료 사항
- native symlink는 현재 환경의 생성 권한 부족으로 미검증이다(기존 조사: Node EPERM/-4048, Win32 1314). `VERIFY_TEST_INCOMPLETE`와 main 실행 비활성화를 유지한다. symlink 생성이 허용된 독립 Windows 환경에서 실제 테스트와 전체 검증을 재실행해야 한다.
- Claude 원브랜치에는 해당 task record가 없어 실제 inspect가 `MISSING_RECORD`를 반환한다. Claude 기록을 새로 만들거나 과거 SHA를 바꾸지 않았다. 반영된 Codex 브랜치는 기존 유효 task record와 이 새 Codex Handoff를 사용한다. 후보 검사는 반드시 이 인계서를 `--handoff`로 지정한다. 기본 경로의 과거 Handoff는 그대로 보존했으므로 현재 코드 검증용으로 사용하지 않는다.
- 지원 범위는 공통 Git helper와 확인한 diff 경로다. filter driver, credential helper, core.sshCommand 및 test/build/native 코드가 helper 밖에서 직접 실행하는 Git 등 모든 외부 명령 경로를 범용 샌드박스로 보장하지 않는다. 이번에 그러한 추가 개발은 수행하지 않았다.
- recorder는 같은 프로세스의 활동 기록이다. 우회·일관된 악의적 기록 위조 및 assertion 품질 문제를 해결했다고 주장하지 않는다. 신뢰할 수 없는 후보에는 독립 실행·인증 경계가 필요하다. R1 승인 출처 문제로 local main 실행은 계속 비활성화돼 있고 R2 TOCTOU도 미해결이다.
- 이전 전체 업무 테스트의 FAIL 59 / SKIP 43과 P1 Windows TAP 경로 정규화 문제는 이전 인계서의 별도 기존 결함이다. 이번에는 관련 agent-workflow 테스트를 재실행했으며 전체 업무 테스트를 다시 통과했다고 주장하지 않는다. TypeScript 기존 40건도 해결하지 않았다.

## 8. 후속 작업
- 이 인계서 형식 검사 후 문서만 로컬 커밋하고, 최신 후보 SHA에서 `baba-handoff --check`와 Integrate inspect/prepare를 이 인계서 경로로 재실행한다. 실행 결과는 증거 디렉터리의 `final-integration-checks.json`에 별도 기록하며 과거 기록을 수정하지 않는다.
- Claude 독립 재검증: Codex 후보의 유효 기록·새 Handoff 연결, N1/D1/D2의 지원 범위와 recorder 신뢰 한계, Windows 경로 길이 제약, symlink 미검증 차단을 확인한다. Claude 원브랜치의 기록 부재와 Codex 후보의 기록 유효성을 구분한다.
- main 병합은 이번 범위에서 금지한다. 향후 미검증 해소 후에도 사용자 직접 실행 또는 독립 인증 경로 설계가 필요하다. push·Production 배포는 별도 명시적 승인 대상이며 이번에는 실행하지 않았다. 운영 DB·Migration 변경도 없다.

