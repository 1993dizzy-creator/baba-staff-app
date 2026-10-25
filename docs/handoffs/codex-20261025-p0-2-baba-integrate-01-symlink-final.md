# 인계서 — BABA P0-2 native symlink final verification

> 작성: 2026-10-25T16:29:21.207Z · baba-handoff · 기준 정책 docs/agents/baba-agent-workflow.md

## 1. 작업 정보
- 작업명: BABA P0-2 native symlink final verification
- 작업 ID: 20261025-p0-2-baba-integrate-01
- 담당 AI: Codex
- Worktree: baba-wt-codex

## 2. Git 상태
- 작업 브랜치: codex/20261025-p0-2-baba-integrate-01
- HEAD SHA: a70720b0632d307d3d769f9566fa184c8e15530d
- 기준: main · merge-base d2f74cc33252b3e40db1657b93c636c40f4fb572
- 작업 커밋 9개:
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
| `docs/agents/baba-integrate.md` | 추가 | +163 −0 | 커밋됨 |
| `docs/handoffs/claude-20261025-p0-2-claude-fixes-01.md` | 추가 | +99 −0 | 커밋됨 |
| `docs/handoffs/codex-20261025-p0-2-baba-integrate-01-claude-adoption.md` | 추가 | +104 −0 | 커밋됨 |
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
- 앱/도구 소스 변경 없이 후보 a70720b0632d307d3d769f9566fa184c8e15530d의 native symlink 권한 해소 후 최종 검증 증거를 추가했다. 기존 Handoff 3개와 Start task, 사용자 probe .tmp-baba/symlink-probe-ISrKb7을 보존했다.

## 4. 검증 결과
- 검증 상태 지문: 7ef007ccda7e2ea5
- baba-verify 판정: **PASS_WITH_PREEXISTING** (2026-10-25T16:28:55.221Z, .tmp-baba/verify/2026-10-25T16-28-55-221Z-a70720b0-50475ae2-cf46-40e7-88a5-832de3353469.json)
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

수동 확인(브라우저·실행 확인 등): 실제 native file/dir symlink 생성·읽기 PASS. writeRecord의 파일 링크 덮어쓰기 및 디렉터리 링크 외부 escape 쓰기 거부 PASS, 대상 파일 내용/행선지 파일 목록 불변 확인. .tmp-baba/final-symlink-JyZIIS/native.json 및 agent-workflow.tap 참고. 전체 관련 5개 파일 독립 실행 77 PASS / 0 FAIL / 0 SKIP; 기존 native directory symlink 회귀도 PASS. Verify에서도 별도로 77 PASS / 0 FAIL / 0 SKIP. TypeScript 40건은 main 기준선 40건과 동일하며 신규 0, 나머지 검사 및 offline-local-fixture Build PASS. verify-summary.json의 엄격한 verifyEvidence(build:true) gate=[]로 VERIFY_TEST_INCOMPLETE 해소 확인. 브라우저/운영 연결 확인 없음.

## 5. DB·Migration
- Migration 변경: 없음
- 기타 SQL 변경: 없음
- 에이전트의 운영 DB 변경·Migration 적용: 없음 (정책상 금지 — AGENTS.md 수동 적용 절차)

## 6. Push·병합·배포
- Git push: push 안 됨
- main 병합: 미병합
- Vercel 배포: 에이전트 미실시 (사용자 승인 후 별도 진행)

## 7. 미완료 사항
- 검증 게이트의 symlink SKIP 차단은 해소됐다. main 실행은 R1 독립 사용자 인증 부재로 비활성 상태를 유지한다. R2 TOCTOU 및 recorder 동일 프로세스 신뢰 한계는 기존 문서대로 남는다. TypeScript 기존 40건과 이전 전체 업무 테스트 결함은 수정하지 않았다. 이번 범위는 agent-workflow 77건이며 전체 업무 테스트 통과를 주장하지 않는다.

## 8. 후속 작업
- 이 Handoff만 로컬 작업 브랜치에 커밋한 뒤 --handoff를 명시해 inspect/prepare를 비파괴 재실행한다. 실행별 immutable JSON은 .tmp-baba/integrate/runs/에 보존하고 .tmp-baba/final-symlink-JyZIIS/final-integration-checks.json에 최종 SHA와 결과 경로를 연결한다. P0-2 inspect/prepare 구현과 검증 범위의 완료 여부는 해당 결과로 판단한다. main 병합·GitHub push·Production·운영 DB/Migration 변경은 사용자 금지에 따라 수행하지 않는다.


추가 증거 대조:
- 기존 task ID 20261025-p0-2-baba-integrate-01, base d2f74cc33252b3e40db1657b93c636c40f4fb572, branch 일치. baba-start resume은 RESUMED, branchCreated=false; .tmp-baba/start/runs/1792945147980-7a9f7097-ea64-4dff-ad58-ae42d421ad91.json.
- 시작 시 세 Worktree clean. 원본 main 및 Claude ready HEAD d2f74cc33252b3e40db1657b93c636c40f4fb572; Codex HEAD a70720b0632d307d3d769f9566fa184c8e15530d.
- 기존 claude-adoption Handoff는 동일 코드 지문 7ef007ccda7e2ea5지만 과거 archive SKIP 1로 inspect VERIFY_EVIDENCE_REJECTED / VERIFY_TEST_INCOMPLETE. old-handoff-inspect.json 보존. 이 후속 Handoff가 새 archive를 연결한다.
- 기존 task/Handoff SHA256 목록: .tmp-baba/final-symlink-JyZIIS/preserved-hashes-success.json. 사용자 probe 및 전체 fixture/기준선/증거 삭제 없음.
