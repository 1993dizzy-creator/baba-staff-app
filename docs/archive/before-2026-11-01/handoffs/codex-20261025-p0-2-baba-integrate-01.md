# 인계서 — BABA P0-2 baba-integrate

> 작성: 2026-10-25T10:29:50.703Z · baba-handoff · 기준 정책 docs/agents/baba-agent-workflow.md

## 1. 작업 정보
- 작업명: BABA P0-2 baba-integrate
- 작업 ID: 20261025-p0-2-baba-integrate-01
- 담당 AI: Codex
- Worktree: baba-wt-codex

## 2. Git 상태
- 작업 브랜치: codex/20261025-p0-2-baba-integrate-01
- HEAD SHA: b340d4449d0ad334cadd34b47817a09efc693114
- 기준: main · merge-base d2f74cc33252b3e40db1657b93c636c40f4fb572
- 작업 커밋 1개:
  - b340d44 feat: prepare BABA integration with evidence and SHA-bound approval gates
- 미커밋 변경: 없음

## 3. 변경 파일과 기능
| 파일 | 상태 | 변경량 | 커밋 |
| --- | --- | --- | --- |
| `docs/agents/baba-agent-workflow.md` | 수정 | +4 −0 | 커밋됨 |
| `docs/agents/baba-integrate.md` | 추가 | +109 −0 | 커밋됨 |
| `scripts/agent/baba-handoff.mjs` | 수정 | +2 −2 | 커밋됨 |
| `scripts/agent/baba-integrate.mjs` | 추가 | +279 −0 | 커밋됨 |
| `scripts/agent/baba-start.mjs` | 수정 | +1 −1 | 커밋됨 |
| `scripts/agent/baba-verify.mjs` | 수정 | +22 −8 | 커밋됨 |
| `scripts/agent/lib/baseline.mjs` | 수정 | +2 −1 | 커밋됨 |
| `scripts/agent/lib/common.mjs` | 수정 | +34 −3 | 커밋됨 |
| `scripts/agent/lib/verify-evidence.mjs` | 추가 | +72 −0 | 커밋됨 |
| `tests/agent-workflow-build-env.test.mjs` | 수정 | +2 −2 | 커밋됨 |
| `tests/agent-workflow-integrate.test.mjs` | 추가 | +273 −0 | 커밋됨 |
| `tests/agent-workflow-safety.test.mjs` | 수정 | +4 −3 | 커밋됨 |
| `tests/agent-workflow-start.test.mjs` | 수정 | +20 −2 | 커밋됨 |
| `tests/agent-workflow-tools.test.mjs` | 수정 | +2 −2 | 커밋됨 |

기능 요약:
- Notion [P0-2의 2026-10-25 최신 명세](https://app.notion.com/p/4037ad2aac798172a1ebc24ac492e588)를 기준으로 inspect/prepare와 SHA에 묶인 로컬 main 승인 게이트를 추가했다. 구 본문의 이전 SHA보다 사용자와 최신 항목의 d2f74cc 기준을 우선했다.
- 기존 common Git helper, start task manifest, Verify, Handoff 형식을 재사용했다. 후보의 branch/task ID/코드 SHA/후보 HEAD/커밋된 Handoff/immutable Verify archive와 지문·digest를 대조한다. 신규 실패·증거 누락·불명확 상태를 차단한다.
- prepare는 담당 Worktree의 `.tmp-baba/integrate/environments/`에 독립 Git 저장소를 만들어 ff/두 부모 merge 후 실제 Verify와 Build를 실행한다. 원본 main은 쓰지 않는다. 충돌 환경·결과·기존 브랜치와 로그를 보존한다.
- 기존 실패에는 merge-base snapshot manifest/index와 실제 TAP diagnostics 또는 타입/lint/Build signature 비교 증거를 요구한다. 구형 report의 증거가 부족하면 재검증이 필요하다.
- dirty main, 진행 중 Git 작업, 겹치는 활성 task scope·파일·DB table/RPC, 공유 API·SQL/DB 스키마 변경을 차단한다. 다른 독립 작업의 완료를 기다리지 않고 개별 후보를 준비할 수 있다. main/후보/준비 증거가 바뀌면 이전 승인을 거부한다.
- 파일 출력은 lexical/realpath·junction·dangling link·drive-relative/stream·hardlink 경계를 검사한다. fixture 기본 위치의 cwd 의존성을 제거하고 검증 자식 TEMP/TMP/TMPDIR를 내부 `.tmp-baba/tmp`로 고정한다. 중첩 Node test IPC 환경을 제거해 실제 TAP 결과를 검증한다.
- push·Production·DB·Migration action은 구현하지 않고 차단한다. 운영 SQL Editor → GPT 운영 객체·권한 검증 → 해당 신규 Migration의 조건부 history → 배포 SOP를 유지한다. CLI 게이트는 full-access 셸 전체의 OS 격리를 의미하지 않는다.

## 4. 검증 결과
- 검증 상태 지문: 8aa3e5b9d8b68144
- baba-verify 판정: **PASS_WITH_PREEXISTING** (2026-10-25T10:29:24.188Z, .tmp-baba/verify/2026-10-25T10-29-24-188Z-b340d444-d450b97d-ccb2-4dda-bb46-31a52f838b23.json)
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
- 세 Worktree의 실제 상태: 원본 main 및 Claude ready는 `d2f74cc33252b3e40db1657b93c636c40f4fb572`, 모두 clean. Codex만 본 작업 브랜치의 코드 커밋으로 진행했다. 세 Worktree 상태·task record 목록은 `.tmp-baba/p0-2-baba-integrate/preflight-1792923994071.json`에 보존했다.
- 사전 점검 ①: Claude는 `claude/ready-20261024-01`이며 smoke branch도 기준 main SHA다. 기존 start는 과거 smoke manifest/run이 있어도 clean ready의 새 작업을 차단하지 않는다. 격리 fixture에서 smoke branch에 머물면 Handoff 없이 `UNFINISHED_TASK`, 같은 branch 재개는 `RESUMED`, ready에서 다음 작업은 `STARTED`를 실제 확인했다. manifest/run과 smoke ref를 그대로 보존했다. 실제 Claude 파일·기록은 변경하지 않았고 slug별 예외도 추가하지 않았다.
- 사전 점검 ②: `C:/workspace/` 직하의 해당 임시 파일 2개는 이미 삭제되어 정확한 생성 명령을 입증하지 못했다. 현재 최상위 파일 목록과 남은 task/run을 조사했다. 기존 safety/tools fixture의 cwd 의존성과 검증 자식의 외부 TEMP/TMP 상속을 재발 가능한 경로로 확인하고 수정했다. 정확한 과거 원인은 Claude 실행 기록의 독립 확인이 필요하다.
- 사전 점검 ③: 실제 CLI를 호출했다. Verify `--base main --tests ... --build --json`의 JSON과 종료 코드, Handoff `--task-name ... --base main`의 Markdown, `--check`의 종료 코드, Integrate의 후보 증거 판정을 연결했다. 정상·기존 실패 fixture의 Verify → 커밋된 Handoff → inspect → prepare 흐름은 통과했다. Verify FAIL/누락/불명확/SHA 불일치는 차단했다. fixture의 lint/type/build 도구는 결정적 로컬 stub이며 실제 앱 검증과 구분한다.
- 변경 전 기준선: 기존 4개 agent-workflow 테스트 파일 44건 모두 통과. 최종 관련 5개 파일은 63건 중 통과 62, 실패 0, skip 1. 실제 baseline 비교에서 기존 TypeScript 40건, 신규 0건. ESLint 신규 오류·경고 0, Production Build exit 0. 실제 앱 Build는 운영 자격 증명 없는 offline-local-fixture이며 배포하지 않는다.
- 격리 fixture에서 정상 ff와 두 부모 merge, 충돌 보존, dirty main, main/후보 SHA 변경, 잘못된/누락 Handoff·Verify, 기존/신규 assertion 차이, 먼저 완료된 Codex의 개별 통합과 후속 Claude 후보의 새 main 재검증을 확인했다. 서로 다른 source path의 공유 table 충돌도 차단했다.
- 상대/절대 외부 경로, cwd, TEMP/TMP/TMPDIR, junction/dangling link, Windows stream/drive-relative 경로, hardlink output을 확인했다. 일반 native symlink 생성은 Windows EPERM으로 1건 skip했다. 권한 요청/설정 변경으로 우회하지 않았다.
- 최종 코드 SHA와 Verify 지문 일치 확인 및 증거 gate 직접 실행 결과는 `.tmp-baba/p0-2-baba-integrate/final-evidence-1792924198569.json`. 실제 결과는 `VERIFY_TEST_INCOMPLETE`이며 native symlink skip을 성공으로 간주하지 않는다. 인계서 커밋 후 후보 inspect 결과는 `.tmp-baba/integrate/latest.json`과 그 `savedAs`의 실행별 archive에서 확인한다.
- 브라우저 UI·운영 인증/DB·Production 접근은 수행하지 않았다. 이번 세션의 권한 승인 요청은 0회다.

## 5. DB·Migration
- Migration 변경: 없음
- 기타 SQL 변경: 없음
- 에이전트의 운영 DB 변경·Migration 적용: 없음 (정책상 금지 — AGENTS.md 수동 적용 절차)

## 6. Push·병합·배포
- Git push: push 안 됨
- main 병합: 미병합
- Vercel 배포: 에이전트 미실시 (사용자 승인 후 별도 진행)

## 7. 미완료 사항
- 로컬 구현·허용된 fixture/실제 앱 Verify 및 Build는 완료. native symlink 생성 권한이 없는 Windows의 skip 1건은 미검증으로 남는다. 현재 후보는 통합 gate의 `VERIFY_TEST_INCOMPLETE`로 차단되므로 main 병합 승인만으로 진행할 수 없다.
- Claude의 독립 검증은 이 세션에서 수행하지 않았다. 권한 경계는 관리 도구 수준의 검사이며 임의 shell/native program, 외부 프로세스의 링크 교체 경쟁까지 통제하는 OS sandbox가 아니다.
- 삭제된 과거 외부 임시 파일의 정확한 생성 명령은 미확인이다. 기존 TypeScript 오류 40건은 범위 밖이며 수정하지 않았다.
- 원본 main 병합, GitHub push, Production 배포, 운영 DB/Migration 변경은 0건. 기존 작업/로그/Git 기록/타 Worktree 파일을 삭제·초기화하지 않았다. 사전 권한 검증 작업은 기존 Verify/Handoff로 종결하고 보존 브랜치에 인계서 커밋 `ab07f35644d9218c821e55cfe60c12642ebe70a8`을 남겼다.

## 8. 후속 작업
- Claude가 승인된 변경을 자체 Worktree에 반영한 후 독립 검증: 기존 start/verify/handoff 회귀, native symlink 경계, full-access 권한 한계, 별도 사용자 승인과 SHA 변경 시 취소, 먼저/나중 완료 후보를 확인한다. 이 세션은 다른 Worktree를 수정하지 않는다.
- native symlink 미검증을 해소하고 후보를 재검증한 뒤 새 prepare 결과를 만든다. 현재 테스트 skip이 있으므로 기존 준비/승인으로 자동 진행하지 않는다.
- 검증·독립 검토 이후에도 로컬 main 병합은 명시적인 별도 사용자 승인 대상이며 branch HEAD/main SHA/prepare digest에 묶는다. 실제 main 쓰기 직전에 재확인한다.
- GitHub push 및 그에 따른 Vercel Production은 로컬 main 승인과 별도 승인이 필요하다. 향후 승인 후 배포 SHA·READY·공개 읽기 전용 smoke를 확인하고 접근 실패는 미확인으로 기록한다. 운영 DB/Migration SOP는 별개로 유지한다.

