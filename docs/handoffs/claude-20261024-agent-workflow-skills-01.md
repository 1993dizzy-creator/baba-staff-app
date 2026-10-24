# 인계서 — 병렬 개발 공통 정책 및 baba Skills 구축

> 작성: 2026-10-24T09:51:48.613Z · baba-handoff · 기준 정책 docs/agents/baba-agent-workflow.md

## 1. 작업 정보
- 작업명: 병렬 개발 공통 정책 및 baba Skills 구축
- 작업 ID: 20261024-agent-workflow-skills-01
- 담당 AI: Claude Code
- Worktree: baba-wt-claude

## 2. Git 상태
- 작업 브랜치: claude/20261024-agent-workflow-skills-01
- HEAD SHA: 57c1998a5553a901df70a4b8db81ac2cd7b00cc0
- 기준: origin/main · merge-base aba24f3823951a5e861e5ce2aa8d538d6e4867bb
- 작업 커밋 4개:
  - 57c1998 상태 지문에서 인계서를 제외하고 인계서 자체를 변경 목록에서 제외
  - 70a96f4 baba-verify: 기준선 node_modules junction을 실행 중에만 유지
  - 9820e81 baba-handoff: 수동 확인 항목을 미검증 목록과 분리
  - 86d24d8 병렬 개발 공통 절차와 baba-preflight/verify/handoff Skills 추가
- 미커밋 변경: 없음

## 3. 변경 파일과 기능
| 파일 | 상태 | 변경량 | 커밋 |
| --- | --- | --- | --- |
| `.agents/skills/baba-handoff/SKILL.md` | 추가 | +40 −0 | 커밋됨 |
| `.agents/skills/baba-preflight/SKILL.md` | 추가 | +39 −0 | 커밋됨 |
| `.agents/skills/baba-verify/SKILL.md` | 추가 | +47 −0 | 커밋됨 |
| `.claude/skills/baba-handoff/SKILL.md` | 추가 | +15 −0 | 커밋됨 |
| `.claude/skills/baba-preflight/SKILL.md` | 추가 | +15 −0 | 커밋됨 |
| `.claude/skills/baba-verify/SKILL.md` | 추가 | +15 −0 | 커밋됨 |
| `AGENTS.md` | 수정 | +5 −0 | 커밋됨 |
| `CLAUDE.md` | 수정 | +5 −0 | 커밋됨 |
| `docs/agents/baba-agent-workflow.md` | 추가 | +188 −0 | 커밋됨 |
| `scripts/agent/baba-handoff.mjs` | 추가 | +130 −0 | 커밋됨 |
| `scripts/agent/baba-preflight.mjs` | 추가 | +220 −0 | 커밋됨 |
| `scripts/agent/baba-verify.mjs` | 추가 | +396 −0 | 커밋됨 |
| `scripts/agent/check-agent-skills.mjs` | 추가 | +89 −0 | 커밋됨 |
| `scripts/agent/lib/common.mjs` | 추가 | +378 −0 | 커밋됨 |
| `scripts/agent/lib/handoff-format.mjs` | 추가 | +20 −0 | 커밋됨 |
| `scripts/agent/lib/offline-guard.mjs` | 추가 | +48 −0 | 커밋됨 |
| `tests/agent-workflow-tools.test.mjs` | 추가 | +88 −0 | 커밋됨 |

기능 요약:
- **공통 정책**
  - `docs/agents/baba-agent-workflow.md`는 Codex·Claude Code가 함께 따르는 단일 기준 문서다.
  - 다루는 범위: Worktree 소유권, 작업 브랜치 생성·종료(`--no-track`), 코드·데이터 보호, 영향 범위·공통 파일·API 충돌 검사, 병합·배포 승인, 검증 기준, 확정 업무 정책 보호, 인계서.
  - 운영 DB·Migration 규칙은 AGENTS.md 원문을 기준으로 참조만 하고 다시 쓰지 않았다.
- **Skills**
  - 기준 정의 3개를 `.agents/skills/`(Codex 0.164 repo 스킬 경로)에 두었다: baba-preflight, baba-verify, baba-handoff.
  - `.claude/skills/`에는 같은 name·description을 가진 진입점만 두고, 본문은 기준 정의를 읽도록 했다.
- **실행 스크립트**(`scripts/agent/`, Node .mjs, 외부 의존성 없음, PowerShell 실행 정책과 무관)
  - `baba-preflight.mjs`: 읽기 전용 점검과 가능/조건부/불가 판정.
  - `baba-verify.mjs`
    - 변경 파일 검사, 관련 테스트, ESLint, tsc, 선택적 build를 실행한다.
    - 실패가 있으면 merge-base 기준선으로 재실행해 기존 오류와 신규 오류를 구분한다.
    - 테스트·빌드는 자격 증명 환경 변수를 제거하고 오프라인 가드를 건 상태로 실행한다.
  - `baba-handoff.mjs`: 인계서 생성과 `--check` 형식 검사.
  - `check-agent-skills.mjs`: Codex·Claude 정의의 정합성 검사.
- **진입점**
  - AGENTS.md와 CLAUDE.md 끝에 공통 문서와 Skills 안내를 추가했다(추가만 했고 기존 문구는 변경 0줄).
  - CLAUDE.md에는 AGENTS.md의 "Codex" 로컬 역할·제한이 Claude Code에도 적용된다는 문구를 넣었다.
- **회귀 테스트**: `tests/agent-workflow-tools.test.mjs` 7건(오프라인 가드, 인계서 형식, 정적 분석, 관련 테스트 탐색, Skills 정합성, handoff 초안, preflight 읽기 전용).

## 4. 검증 결과
- baba-verify 판정: **PASS_WITH_PREEXISTING** (2026-10-24T09:51:47.930Z, .tmp-baba/verify/2026-10-24T09-51-47-930Z-57c1998a.json)
- 현재 상태와 일치: 예

| 검사 | 실제 실행 | 결과 |
| --- | --- | --- |
| 변경 파일 검사 | 예 | passed |
| 회귀 테스트 | 예 | passed |
| ESLint (변경 파일) | 예 | passed |
| TypeScript (tsc --noEmit) | 예 | passed-with-preexisting |
| Production Build (next build) | 아니오 | not-run |

미검증 항목:
- 테스트가 참조하지 않는 변경 파일: scripts/agent/baba-verify.mjs

수동 확인(브라우저·실행 확인 등):
- **Preflight 읽기 전용**
  - 세 Worktree의 index 해시, status, HEAD, 전체 ref 해시가 실행 전후로 같았다.
  - 기존 Migration 수정 시나리오를 BLOCKED로 판정했다.
- **Verify 판정 시뮬레이션**(scratchpad의 일회용 clone, 이 Worktree와 무관)
  - 기준선에서 이미 깨진 테스트는 "기존"으로 분류했다.
  - 새로 깨뜨린 테스트·`no-var`·TS2322는 "신규"로 분류해 FAIL로 판정했다.
  - 충돌 표식, secret 의심(값 미출력), 기존 Migration 수정을 검출했다.
- **실제 테스트 실행**
  - 오프라인 가드와 자격 증명 제거 상태에서 환경변수 의존 API 테스트 4개, PGlite DB 테스트, 같은 폴더 테스트가 통과했다.
  - 네이티브 Postgres 테스트는 `QA_POSTGRES_BIN`이 없어 skip이었다.
- **Handoff**: TODO 잔존, 검증 후 변경(상태 지문 불일치), 덮어쓰기 시도를 각각 실패로 막는 것을 확인했다.
- **기준선 junction 안전성**: Verify가 OS 임시 폴더의 기준선에 만드는 `node_modules` junction은 실행이 끝나면 제거된다. Worktree `node_modules`가 그대로인 것을 확인했다.
- **Claude Code Skills 인식**
  - README의 안전 실행 구성으로 `claude -p`를 1회 실행했다: `--permission-mode manual`, project 설정만, bypass 비활성화, 빈 MCP.
  - baba-handoff, baba-preflight, baba-verify 3개가 인식되고 description이 일치했다.
- **Codex**
  - `codex features list`에서 skills 관련 기능은 stable이고 `skip_host_skill_discovery`는 false였다.
  - 실제 Codex 세션의 인식 여부는 **미검증**이다.

## 5. DB·Migration
- Migration 변경: 없음
- 기타 SQL 변경: 없음
- 에이전트의 운영 DB 변경·Migration 적용: 없음 (정책상 금지 — AGENTS.md 수동 적용 절차)

## 6. Push·병합·배포
- Git push: push 안 됨
- main 병합: 미병합
- Vercel 배포: 에이전트 미실시 (사용자 승인 후 별도 진행)

## 7. 미완료 사항
- **Codex 실제 인식 미검증**: 이 브랜치가 병합되기 전에는 Codex Worktree에 파일이 없다. 병합 후 Codex Worktree에서 새 세션으로 Skills 목록을 확인해야 한다.
- **`baba-verify.mjs` 자동 테스트 없음**: 테스트 안에서 실행하면 자기 자신을 다시 선택하는 재귀가 생겨 시뮬레이션 검증으로 대신했다.
- **`--build` 실제 실행 미검증**: 운영 자격 증명이 제거된 환경에서 `next build`가 성공할지 확인하지 않았다. 실패하면 `blocked-env`(미검증)로 분류하도록 구현했다.
- **기준 브랜치에 기존 실패 존재**(이번 작업과 무관, 수정하지 않음)
  - `origin/main`(aba24f3)에서 다음 테스트 파일 4개(8개 케이스)가 이미 실패한다: `tests/ledger-deployed-qa.test.mjs`(5), `tests/ledger-inventory-rebook.test.ts`(1), `tests/ledger-reserve-history-entries.test.ts`(1), `tests/ledger-summary-cards.test.ts`(1).
  - tsc 기존 오류는 40건이다.

## 8. 후속 작업
- **사용자 승인 필요**
  - 이 브랜치의 push와 main 병합(공통 파일 16개 포함).
  - 배포는 필요 없다(앱 코드 변경 없음).
- **병합 후 Codex Worktree**
  - 최신 `origin/main`에서 새 작업 브랜치를 만든다.
  - `node scripts/agent/check-agent-skills.mjs`를 실행한다.
  - Codex 새 세션에서 baba-* Skills 인식을 확인한다.
- **로컬 실행 도구(Git 밖, 사용자 결정)**
  - `C:\workspace\baba-parallel-dev\README.md`의 브랜치 생성 예시에 `--no-track`을 반영하고, 공통 문서 경로를 안내할지 정한다.
- **선택 작업**
  - 기존 실패 테스트 4개 파일의 원인 조사를 별도 작업으로 할지 정한다.

