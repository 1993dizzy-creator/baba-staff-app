# 인계서 — P0-1 Build 검증 환경 보완

> 작성: 2026-10-24T15:26:04.385Z · baba-handoff · 기준 정책 docs/agents/baba-agent-workflow.md

## 1. 작업 정보
- 작업명: P0-1 Build 검증 환경 보완
- 작업 ID: 20261024-baba-start-01
- 담당 AI: Codex
- Worktree: baba-wt-codex

## 2. Git 상태
- 작업 브랜치: codex/20261024-baba-start-01
- HEAD SHA: 484a586db9760399976989e5c6a6b90b0a080a1e
- 기준: main · merge-base a157f461474dd1430d1a8b2183f722e6ed292823
- 작업 커밋 8개:
  - 484a586 Decode split UTF-8 verification output without changing failure comparison
  - f05a40d Provide offline local fixture environment only for agent builds
  - d2e0715 Clarify unexecuted checks in baba-start handoff
  - 3f6d6f9 Record baba-start verification and handoff
  - ac5f707 Expand directory scope to protect nested worktree changes
  - 90f4316 Allow completed legacy tasks to advance only after checked handoff
  - 07cdb73 Reject incomplete baba-start command options before mutation
  - aad1756 Add safe shared baba-start task preparation and resume
- 미커밋 변경: 없음

## 3. 변경 파일과 기능
| 파일 | 상태 | 변경량 | 커밋 |
| --- | --- | --- | --- |
| `.agents/skills/baba-preflight/SKILL.md` | 수정 | +1 −1 | 커밋됨 |
| `.agents/skills/baba-start/SKILL.md` | 추가 | +30 −0 | 커밋됨 |
| `.agents/skills/baba-verify/SKILL.md` | 수정 | +1 −0 | 커밋됨 |
| `.claude/skills/baba-start/SKILL.md` | 추가 | +7 −0 | 커밋됨 |
| `AGENTS.md` | 수정 | +2 −1 | 커밋됨 |
| `CLAUDE.md` | 수정 | +1 −0 | 커밋됨 |
| `docs/agents/baba-agent-workflow.md` | 수정 | +20 −20 | 커밋됨 |
| `docs/handoffs/codex-20261024-baba-start-01.md` | 추가 | +84 −0 | 커밋됨 |
| `scripts/agent/baba-start.mjs` | 추가 | +254 −0 | 커밋됨 |
| `scripts/agent/baba-verify.mjs` | 수정 | +10 −3 | 커밋됨 |
| `scripts/agent/lib/build-env.mjs` | 추가 | +30 −0 | 커밋됨 |
| `tests/agent-workflow-build-env.test.mjs` | 추가 | +135 −0 | 커밋됨 |
| `tests/agent-workflow-start.test.mjs` | 추가 | +232 −0 | 커밋됨 |

기능 요약:
- Build 프로세스 전용 로컬 가상 환경을 추가했다. sanitizedEnv와 기존 offline-guard는 변경하지 않는다. 제거 후 loopback URL 및 실행 시 생성한 anon JWT만 Build 자식에 주입한다. 서버 초기화 변수에도 같은 anon 토큰을 사용하며 service_role 권한/실제 프로젝트 서명은 없다. 부모·일반 테스트·lint·TypeScript에는 주입하지 않는다. Build 결과 JSON/사람용 출력에 가상 환경·운영 미검증·배포 불가를 표시한다.

## 4. 검증 결과
- 검증 상태 지문: f725b846b9af2e32
- baba-verify 판정: **PASS_WITH_PREEXISTING** (2026-10-24T15:25:42.242Z, .tmp-baba/verify/2026-10-24T15-25-42-242Z-484a586d.json)
- 현재 상태와 일치: 예

| 검사 | 실제 실행 | 결과 |
| --- | --- | --- |
| 변경 파일 검사 | 예 | passed |
| 회귀 테스트 | 예 | passed-with-preexisting |
| ESLint (변경 파일) | 예 | passed |
| TypeScript (tsc --noEmit) | 예 | passed-with-preexisting |
| Production Build (next build) | 예 | passed |

미검증 항목:
- Build는 offline-local-fixture 환경의 검증이다. 운영 환경·인증·DB 연결은 미검증이며 이 .next 산출물을 배포하지 않는다.

수동 확인(브라우저·실행 확인 등): 실제 Next.js Production Build exit 0, 기존 에이전트 37건 및 신규 보호 7건 통과, Skills 4개 정합성 통과, 원본 main/Claude의 HEAD·브랜치·status·추적 파일 해시 유지 확인. 실제 앱 UI/운영 인증/DB/새 AI 세션 자동 선택은 검증하지 않았다.

## 5. DB·Migration
- Migration 변경: 없음
- 기타 SQL 변경: 없음
- 에이전트의 운영 DB 변경·Migration 적용: 없음 (정책상 금지 — AGENTS.md 수동 적용 절차)

## 6. Push·병합·배포
- Git push: push 안 됨
- main 병합: 미병합
- Vercel 배포: 에이전트 미실시 (사용자 승인 후 별도 진행)

## 7. 미완료 사항
- Build 환경 보완 미완료 사항 없음. 기존 테스트 실패 8건 및 TypeScript 오류 40건은 main 기준선과 동일하여 범위 밖으로 남긴다. 실제 운영 환경·인증·DB·UI는 미검증이며 이 .next는 배포용이 아니다.

## 8. 후속 작업
- 사용자 승인 후 새 HEAD를 main에 ff-only 통합하고 재검증한다. push 및 가능한 Production 자동 배포는 별도 승인 대상이다. clean Worktree 최신화 시 기존 브랜치와 활성 Claude 세션을 보존한다. baba-integrate·MCP·Notion은 구현하지 않았다.


## 9. Build 안전성 보완 근거

- 이번 코드 커밋: 484a586db9760399976989e5c6a6b90b0a080a1e. 기존 P0-1 HEAD d2e07153bbc504d94dfcff1e049d25938d518fe0 이후 Build 도구 5파일만 보완했다. 이 인계서는 기존 인계서를 보존하는 추가 기록이다.
- sanitizedEnv·offline-guard·baba-start·앱·업무 정책·DB·Migration·의존성은 변경하지 않았다.
- 고정 URL http://127.0.0.1:9는 실제 Supabase가 아니다. 키는 메모리의 임시 난수로 HS256 서명한 테스트 anon JWT이며 실제 프로젝트에서 사용할 수 없다. SUPABASE_SERVICE_ROLE_KEY 변수에도 같은 anon JWT만 제공한다. 토큰 값과 임시 서명 키는 보고서/로그/Git에 출력하지 않는다.
- Build는 환경 파일 없이 자식 process.env로만 설정한다. 운영 설정을 가져오거나 DB/테스트 서버를 띄우지 않는다. 기존 네트워크 가드를 preload하며 외부 fetch/socket 차단을 회귀 테스트했다. 가드는 기존 문서대로 Node API 방어이며 OS 전체 네트워크 격리를 주장하지 않는다.
- 보호 테스트 7건: 상속 자격 증명 제거·고정 loopback/anon; 일반 프로세스 격리; 설치된 SDK 초기화; 가드 강제 preload·외부 연결 차단; CLI Build 한정 주입·키 미출력; 추가 의존성 실패가 blocked-env/FAIL로 유지됨; UTF-8 청크 분할 출력 보존. 계측된 CLI fixture는 환경 전달만 확인하고 실제 Next Build는 별도 실명령으로 실행했다.
- 실제 Build: passed, exit 0; 환경 offline-local-fixture; 운영 검증 false; 배포 가능 산출물 false.
- 기존 37건(23+7+7)과 신규 7건 = 44건 모두 통과. 기존 실패 8건은 4파일에서 main과 실패 내용까지 동일. TypeScript 40건 기존/신규 0, ESLint 신규 오류·경고 0.
- 최종 명령: node scripts/agent/baba-verify.mjs --base main --build --tests tests/agent-workflow-build-env.test.mjs,tests/agent-workflow-start.test.mjs,tests/agent-workflow-tools.test.mjs,tests/agent-workflow-safety.test.mjs,tests/ledger-deployed-qa.test.mjs,tests/ledger-inventory-rebook.test.ts,tests/ledger-reserve-history-entries.test.ts,tests/ledger-summary-cards.test.ts --json
- 최종 결과: .tmp-baba/verify/2026-10-24T15-25-42-242Z-484a586d.json; .tmp-baba/start-final-audit-20261024/build-env-verify-utf8-final.log. 기존 blocked-env 보고서는 역사적 증거로 보존하고 최종 실제 Build 성공으로 차단을 해소했다. 실패/환경 차단을 성공으로 바꾸는 판정 변경은 없다.
- main 통합 가능 판정: PASS (Verify는 PASS_WITH_PREEXISTING). 이 판정은 로컬 코드 통합에 한하며 운영 환경 검증/배포 승인이 아니다. main 병합·GitHub push·Production 배포·운영 DB 변경은 수행하지 않았다.

- 재검증 중 큰 TAP 출력의 한글이 바이트 청크 경계에서 깨져 기존 실패 1건이 신규로 오인되는 문제를 발견했다. 현재/기준선의 테스트와 앱 파일 SHA-256은 동일했고, 차이는 U+FFFD 대체문자였다. 실패 재현 회귀 테스트를 먼저 확인한 뒤 자식 stdout/stderr에 setEncoding(utf8)을 지정했다. 실패 서명 비교·판정 기준 및 기존 테스트 기대값은 변경하지 않았다.
