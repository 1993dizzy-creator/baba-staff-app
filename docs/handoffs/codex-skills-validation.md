# 인계서 — Claude 공통 개발 체계 독립 검증

> 작성: 2026-10-24T10:11:50.537Z · baba-handoff · 기준 정책 docs/agents/baba-agent-workflow.md

## 1. 작업 정보
- 작업명: Claude 공통 개발 체계 독립 검증
- 작업 ID: skills-validation
- 담당 AI: Codex
- Worktree: baba-wt-codex

## 2. Git 상태
- 작업 브랜치: codex/skills-validation
- HEAD SHA: 29c57724f55d6050dc204107b8269f467f4d1937
- 기준: origin/main · merge-base aba24f3823951a5e861e5ce2aa8d538d6e4867bb
- 작업 커밋 6개:
  - 29c5772 Harden agent workflow verification and handoff safety
  - 4357434 인계서: 병렬 개발 공통 정책 및 baba Skills 구축
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
| `.agents/skills/baba-verify/SKILL.md` | 추가 | +49 −0 | 커밋됨 |
| `.claude/skills/baba-handoff/SKILL.md` | 추가 | +15 −0 | 커밋됨 |
| `.claude/skills/baba-preflight/SKILL.md` | 추가 | +15 −0 | 커밋됨 |
| `.claude/skills/baba-verify/SKILL.md` | 추가 | +15 −0 | 커밋됨 |
| `AGENTS.md` | 수정 | +5 −0 | 커밋됨 |
| `CLAUDE.md` | 수정 | +5 −0 | 커밋됨 |
| `docs/agents/baba-agent-workflow.md` | 추가 | +189 −0 | 커밋됨 |
| `docs/handoffs/claude-20261024-agent-workflow-skills-01.md` | 추가 | +129 −0 | 커밋됨 |
| `scripts/agent/baba-handoff.mjs` | 추가 | +141 −0 | 커밋됨 |
| `scripts/agent/baba-preflight.mjs` | 추가 | +223 −0 | 커밋됨 |
| `scripts/agent/baba-verify.mjs` | 추가 | +408 −0 | 커밋됨 |
| `scripts/agent/check-agent-skills.mjs` | 추가 | +89 −0 | 커밋됨 |
| `scripts/agent/lib/baseline.mjs` | 추가 | +29 −0 | 커밋됨 |
| `scripts/agent/lib/common.mjs` | 추가 | +408 −0 | 커밋됨 |
| `scripts/agent/lib/handoff-format.mjs` | 추가 | +20 −0 | 커밋됨 |
| `scripts/agent/lib/offline-guard.mjs` | 추가 | +48 −0 | 커밋됨 |
| `tests/agent-workflow-safety.test.mjs` | 추가 | +133 −0 | 커밋됨 |
| `tests/agent-workflow-tools.test.mjs` | 추가 | +88 −0 | 커밋됨 |

기능 요약:
- Claude의 5개 커밋·18개 변경 파일을 독립 리뷰했다. 기준선 Junction 수명·동시 실행, Handoff 경로·덮어쓰기·검증 지문, 실패 분류 및 환경 파일 보호를 보강했다. 수정은 Codex 검증 브랜치의 로컬 커밋 29c5772에만 있다.

## 4. 검증 결과
- 검증 상태 지문: 5cd4251c72c4c5aa
- baba-verify 판정: **PASS_WITH_PREEXISTING** (2026-10-24T10:11:19.524Z, .tmp-baba/verify/2026-10-24T10-11-19-524Z-29c57724.json)
- 현재 상태와 일치: 예

| 검사 | 실제 실행 | 결과 |
| --- | --- | --- |
| 변경 파일 검사 | 예 | passed |
| 회귀 테스트 | 예 | passed-with-preexisting |
| ESLint (변경 파일) | 예 | passed |
| TypeScript (tsc --noEmit) | 예 | passed-with-preexisting |
| Production Build (next build) | 아니오 | not-run |

미검증 항목:
- 테스트가 참조하지 않는 변경 파일: scripts/agent/baba-verify.mjs

수동 확인(브라우저·실행 확인 등): 새 Codex CLI 세션 2개에서 3개 Skills의 주입 목록 인식을 확인했다. 명령 실행은 정책에 의해 차단되었다. 현재 검증 세션에서는 Preflight 실행 전후 세 Worktree의 index/status/HEAD/refs 불변, 실제 Windows Junction sentinel 보존, Handoff 초안의 미작성 항목 차단을 확인했다. 브라우저·운영 데이터 확인은 하지 않았다.

## 5. DB·Migration
- Migration 변경: 없음
- 기타 SQL 변경: 없음
- 에이전트의 운영 DB 변경·Migration 적용: 없음 (정책상 금지 — AGENTS.md 수동 적용 절차)

## 6. Push·병합·배포
- Git push: push 안 됨
- main 병합: 미병합
- Vercel 배포: 에이전트 미실시 (사용자 승인 후 별도 진행)

## 7. 미완료 사항
- 새 Codex 세션의 명령 실행 차단 원인과 허용 설정을 확인해야 한다. 정책·ACL·권한 우회는 하지 않았다. 전체 앱 빌드는 개발 환경 변수 부재로 실패했다. 전체 저장소 테스트는 실행하지 않았으며 관련 도구 전체와 기존 실패 기준선 4개 파일만 실행했다.

## 8. 후속 작업
- 현재 main 병합은 권고하지 않는다. 새 Codex 세션의 실제 실행 성공과 격리 개발 환경에서의 빌드 확인 후 재평가한다. Claude의 SQL 담당 역할 확대는 별도 사용자 결정 사항이다. MCP·Notion 연결은 아래 제안만 기록하며 외부 쓰기는 수행하지 않는다.

## 9. 독립 코드 리뷰 범위

검증 경로는 `C:\workspace\baba-wt-codex`, 브랜치는 `codex/skills-validation`이다. clean인 `codex/idle`에서 Claude HEAD `4357434f8c88164255cab2321f505874ee0b84d1`을 기준으로 새 브랜치를 만들었다. 원래 Claude 브랜치를 체크아웃하지 않았다. 기준 main은 `aba24f3823951a5e861e5ce2aa8d538d6e4867bb`다.

| Claude 커밋 | 검토 결과 |
| --- | --- |
| 86d24d8 | 공통 정책·Skills 6개·실행 도구·7개 테스트의 전체 최초 구현 검토. 아래 안전성 결함 발견. |
| 9820e81 | 수동 확인을 미검증 항목과 분리한 변경 적절. |
| 70a96f4 | 정상 Junction unlink는 타깃 디렉터리 삭제와 다르다. 그러나 SHA별 공유 임시 폴더와 무조건 재귀 삭제 문제는 남아 있었다. |
| 57c1998 | 인계서 작성·커밋이 코드 검증 지문을 무효화하지 않게 한 방향 적절. --check가 실제 지문을 다시 계산하지 않는 결함은 남아 있었다. |
| 4357434 | 인계서 원문과 모든 검증 주장을 대조. Codex 실제 실행·빌드 미검증은 원문에도 기록됨. 기존 오류 수는 이번에 별도 재현. |

변경 파일 18개를 모두 읽었다.

| 파일 | 결과 |
| --- | --- |
| `.agents/skills/baba-preflight/SKILL.md` | 트리거·루트 기준 실행·읽기 전용 지시 검토, 유지. |
| `.agents/skills/baba-verify/SKILL.md` | 실행/미실행 구분 적절. 임시 기준선·환경 파일·네트워크 보장 범위 문구 수정. |
| `.agents/skills/baba-handoff/SKILL.md` | --force 덮어쓰기 안내를 제거하고 새 출력 경로 사용으로 수정. |
| `.claude/skills/baba-preflight/SKILL.md` | 공통 정의 참조 및 agent=claude 정확. 유지. |
| `.claude/skills/baba-verify/SKILL.md` | 공통 정의 참조 정확. 유지. |
| `.claude/skills/baba-handoff/SKILL.md` | 공통 정의 참조 정확. 유지. |
| `AGENTS.md` | 기존 운영 규칙 원문을 유지하고 공통 문서 진입점만 추가. 유지. |
| `CLAUDE.md` | 미승인 SQL 역할 확대 문구 수정. |
| `docs/agents/baba-agent-workflow.md` | 브랜치·승인·확정 정책 보호 검토. SQL 역할 확대와 새 안전 동작을 정정. |
| `docs/handoffs/claude-20261024-agent-workflow-skills-01.md` | 주장·실행 한계 검토. 원문 보존. |
| `scripts/agent/baba-preflight.mjs` | 읽기 전용 Git 실행 확인. 외부 경로·환경 파일 내용 읽기 차단 및 같은 작업 내 Migration 중복 탐지 보강. |
| `scripts/agent/baba-verify.mjs` | 기준선 동시 실행, 실패 분류, typegen 실패, 환경 파일, 실행 위치 검사 보강. |
| `scripts/agent/baba-handoff.mjs` | 출력 경계·기존 파일 보존·실제 지문 재검사 보강. |
| `scripts/agent/check-agent-skills.mjs` | 정합성 검사일 뿐 실제 런타임 발견 증명이 아님을 확인. 실제 CLI 검증을 별도 수행. |
| `scripts/agent/lib/common.mjs` | 인자 배열 기반 shell 없는 실행 검토. 경로 경계·Worktree 검사·rename 원본 경로 보존 보강. |
| `scripts/agent/lib/handoff-format.mjs` | 필수 섹션·SHA·AI·작업 ID·미작성 항목 형식 검사 검토. 실제 코드 지문 검사와는 별개로 유지. |
| `scripts/agent/lib/offline-guard.mjs` | Node fetch/socket 가드 검토. OS 전체 격리라고 오인시키는 주석 정정. |
| `tests/agent-workflow-tools.test.mjs` | 기존 7개 테스트 전체 실행. rename 원본 경로 보존 기대값만 도구 변경에 맞춤. 업무 정책 테스트 기대값은 수정하지 않음. |

## 10. 발견 사항과 수정

| 우선순위 | Claude 구현에서 발견한 문제 | Codex 수정·검증 |
| --- | --- | --- |
| P1 | 같은 merge-base SHA의 OS 임시 폴더를 두 Worktree/실행이 공유. 한 실행이 다른 실행의 Junction을 해제하거나 준비 중인 폴더를 삭제할 수 있음. | 실행별 mkdtemp를 담당 Worktree .tmp-baba에 생성. 재귀 삭제 제거. 만든 Junction의 파일 ID·타깃을 확인한 뒤 그 링크만 unlink. 동시 스냅샷·반복 release·실제 디렉터리 교체 거부·의존성 sentinel 보존 테스트 통과. |
| P1 | Handoff --out/--task-id 경계 미검사, --force 덮어쓰기, exists 검사 후 일반 쓰기의 경쟁 조건. | docs/handoffs 내부 Markdown으로 제한하고 junction/상위 경로 탈출 차단. 기존 파일과 --force 모두 거부, wx 배타 쓰기. 회귀 테스트 통과. |
| P1 | --check가 문서의 현재 상태 일치 문구를 신뢰. 이후 코드가 바뀌어도 이전 인계서가 통과할 수 있음. | 저장된 지문을 현재 코드와 해당 Worktree의 최신 성공 검증에 대조. 실제 코드 변경 뒤 동일 인계서 실패를 검증. |
| P1 | 실패 테스트 이름만 같으면 기존 실패 처리. 실패 이름을 못 읽으면 빈 배열 every도 참. typegen 실패 무시. 임의 빌드 실패끼리 기존 오류 취급. | 전체 TAP 실패 진단(다중 줄 expected/actual 포함) 비교. 누락 테스트·미분류/인프라 실패 차단. typegen 종료 확인. 빌드 오류 서명 비교 및 환경 차단을 FAIL로 처리. 같은 이름의 다른 다중 줄 assertion 실패를 신규로 분류하는 테스트 통과. |
| P2 | 프로세스 환경만 제거해도 Next가 .env.local을 읽을 수 있음. Verify/Handoff가 원본이나 잘못된 브랜치에서 쓰기 가능. | 환경 파일 존재 시 값 읽기 전 중단. agent 소유 Worktree·브랜치 검사. 환경 파일 내용 미출력 테스트 통과. |
| P2 | 기존 Migration rename 원본 경로가 사라져 기존 파일 이동을 신규 파일로 오인할 수 있음. 같은 작업 내 신규 Migration 버전 중복 누락. | rename 원본 경로 보존과 기존 Migration 이동 검출, 신규 버전 map 갱신. parser 테스트 통과. 실제 Migration 파일 변경·적용 시나리오는 실행하지 않음. |

원본 구현의 정상적인 `unlinkSync(junction)`가 실제 node_modules 타깃을 삭제했다는 증거는 없다. 위험한 파괴 실험은 하지 않았다. 이번 수정은 공유 폴더·재귀 정리 자체를 없애고, 실제 Windows Junction의 타깃 데이터가 유지됨을 검증한 것이다. 스냅샷은 증거로 보존하며 자동 정리하지 않는다. 비정상 프로세스 종료 시 남은 링크도 자동 재귀 삭제 대상으로 취급하지 않는다.

## 11. 기존 정책과의 충돌 판단

AGENTS.md의 담당은 명시적으로 Codex이며, 사용자 SQL Editor 수동 적용과 GPT 운영 검증 단계가 구분돼 있다. Claude 구현이 CLAUDE.md와 공통 문서에서 로컬 SQL 담당을 Claude에도 자동 확대하는 것은 기존 문구에 없는 정책 결정이다. 사용자의 승인된 결정으로 간주할 수 없어 검증 브랜치에서는 담당을 Codex로 유지하고 역할 확대를 별도 결정 사항으로 표시했다. 두 에이전트의 DB 안전 제한은 유지한다.

브랜치 생성/종료 절차는 강제 전환·자동 stash·브랜치 삭제를 하지 않으며 --no-track으로 원치 않는 upstream을 막는다. 실제 도구는 작업 브랜치를 생성·전환하지 않는다. 새 검증 브랜치 외 기존 브랜치·main·Claude 브랜치는 이동하지 않았다.

## 12. Codex 실제 인식·실행 교차검증

OpenAI Docs와 skill-creator 지침을 적용했다. 공식 [Skills 평가 방법](https://developers.openai.com/blog/eval-skills)의 실제 CLI JSONL 관찰 방식을 참고했고, 설치된 CLI --help로 명령을 확인했다.

새 프로세스는 `codex --no-daemon exec --ignore-user-config --ephemeral --sandbox read-only|workspace-write --json`으로 시작했다. 사용자 설정은 변경하지 않았다. 저장소 Skills가 주입된 목록에 있는지 파일 검색 전에 응답하게 하고, 명시적 Skill 호출 뒤 실제 Node 실행을 요청했다.

| Skill | 새 세션 주입 목록 | 새 세션 지침 읽기·실행 | 현재 검증 세션의 직접 실행 |
| --- | --- | --- | --- |
| baba-preflight | 정확한 .agents 경로 인식 | Get-Content와 Node가 blocked by policy로 거부됨 | 읽기 전용 정상 실행. 세 Worktree index/status/HEAD/refs 불변. |
| baba-verify | 인식 | 지침 읽기와 Node 실행 거부됨 | 관련 도구 테스트·기존 실패 파일·ESLint·TypeScript·기준선 비교 실행. |
| baba-handoff | 인식 | 지침 읽기와 stdout 전용 Node 실행 거부됨 | 초안 생성·미작성 항목 거부·완성본 검사·덮어쓰기 방지 검증. |

따라서 **실제 Codex 발견은 성공, 새 세션에서의 Skill 실행은 미완료**다. CLI 대화 종료 코드 0은 명령 실행 성공을 뜻하지 않는다. 정책 거부를 권한 우회로 해결하지 않았다. 이전 PowerShell .ps1 실행 제한과 이번 Codex 명령 실행 정책 거부를 같은 원인으로 단정하지 않는다.

증거: [Preflight 세션 JSONL](../../.tmp-baba/validation/codex-preflight.jsonl), [Verify/Handoff 세션 JSONL](../../.tmp-baba/validation/codex-verify-handoff.jsonl), [읽기 전용 지문](../../.tmp-baba/validation/preflight-readonly-proof.json), [직접 Preflight 결과](../../.tmp-baba/validation/preflight-actual.json).

정적 정합성 검사도 3개 모두 통과했다. skill-creator의 Python quick_validate는 Python 실행 파일 부재로 실행하지 못했다. 이를 통과로 표시하지 않는다.

## 13. 실제 명령·기존 오류·신규 오류

```text
node --test tests/agent-workflow-tools.test.mjs tests/agent-workflow-safety.test.mjs
node_modules/.bin/eslint.cmd scripts/agent tests/agent-workflow-tools.test.mjs tests/agent-workflow-safety.test.mjs
node scripts/agent/check-agent-skills.mjs
node scripts/agent/baba-verify.mjs --tests tests/agent-workflow-safety.test.mjs,tests/ledger-deployed-qa.test.mjs,tests/ledger-inventory-rebook.test.ts,tests/ledger-reserve-history-entries.test.ts,tests/ledger-summary-cards.test.ts --json
```

- 도구 테스트 전체: 기존 7개 + 신규 안전성 7개 = **14/14 통과**, skip 0.
- 선택한 회귀 전체: **160개 중 152 통과, 기존 실패 8, 신규 실패 0**, skip 0. merge-base 스냅샷에서 실패 4개 파일을 다시 실행해 실패 진단이 같음을 확인했다.
- 변경 파일 ESLint: **신규 오류 0·경고 0**. 중간의 unused git import 경고는 제거한 뒤 재검증했다.
- TypeScript: `next typegen` 성공 후 전체 `tsc --noEmit --incremental false --pretty false -p tsconfig.json` 실행. **기존 40·신규 0**. 기준선에서도 같은 진단을 재현했다.
- 최종 코드 커밋 후 일반 Verify 판정은 PASS_WITH_PREEXISTING이다. 전체 저장소의 모든 테스트가 통과했다는 뜻이 아니다.

| 기존 실패 파일 | 실패 수 | 실제 실패 원인/관찰 |
| --- | --- | --- |
| tests/ledger-deployed-qa.test.mjs | 5 | 요청 URL에 scope=entries가 추가된 것과 기대 URL 차이, 투자 데이터 호출/응답 갱신 횟수(3 대 1, 2 대 0), 헤더 텍스트 확인 중 대 '-' 등 assertion 차이. |
| tests/ledger-inventory-rebook.test.ts | 1 | 소스에 setPayables(payableBody)가 있다는 정규식 기대 불충족. |
| tests/ledger-reserve-history-entries.test.ts | 1 | 소스 위치 비교 summaryAt > reserveRowsAt 실패. |
| tests/ledger-summary-cards.test.ts | 1 | paidExpenseRootsPromise 주변 recognition_month 범위·type 필터 정규식 기대 불충족. |

위 8건이 업무 동작 결함인지 오래된 테스트 기대값인지는 별도 조사 대상이다. 이번 변경의 신규 실패가 아니라는 것만 확인했으며 기존 기대값을 수정하지 않았다. TS40에는 TS5097 import 확장자 설정, ledger-entries-v1 테스트의 TS2322/TS18048/TS2339, POS 테스트의 TS2339가 포함된다.

빌드는 같은 Verify 명령에 --build를 추가해 실제 실행했다. Next 컴파일은 성공했으나 페이지 데이터 수집에서 **Missing NEXT_PUBLIC_SUPABASE_URL**, `/api/admin/ledger/meal-candidates/sync`로 종료 코드 1이었다. 운영 키·DB·POS를 제공하지 않았으며 빌드 통과로 보지 않는다. 빌드 포함 실행의 종합 판정은 FAIL(blocked-env)였다. 최종 일반 Verify에서는 --build를 재실행하지 않았으며 이 실패 기록을 유지한다.

증거: [최종 커밋 상태 Verify](../../.tmp-baba/verify/2026-10-24T10-11-19-524Z-29c57724.json), [빌드 포함 Verify](../../.tmp-baba/verify/2026-10-24T10-06-40-156Z-4357434f.json). 후자는 수정 중간 상태에서의 실행이며 앱 소스·의존성·Next 설정은 검증 브랜치 전체에서 변경하지 않았다.

## 14. 한계·보존·병합 판단·후속 통합

- Node 네트워크 가드는 fetch/socket의 방어 장치다. 네이티브 자식 프로그램·DNS/UDP·로컬 프록시까지 차단하는 보안 경계가 아니다. 이후 임의 테스트의 안전성을 이 가드만으로 승인하지 않는다.
- 기준선은 현재 Worktree 의존성을 참조한다. 이번에는 lockfile이 동일하다. 향후 의존성 변경 작업에서는 기준선별 의존성 검증이 추가로 필요하다.
- 관련 테스트 자동 탐색은 문자열 기반 정적 추정이다. Verify CLI 자체를 실행하는 안전성 테스트는 명시적으로 지정해 검증했다. 자동 탐색의 미참조 경고를 실제 테스트 미실행으로 혼동하지 않는다.
- Handoff 형식 검사·원격 ref 포함 여부는 사람의 의미 검토나 원격 push/배포/DB 감사의 대체물이 아니다. stale 원격 참조로 외부 변경이 없었다고 단정하지 않는다.
- 원본 1,395개·Claude 1,411개 추적/비무시 파일의 해시, 각 index/status/HEAD를 전후 대조해 보존을 확인했다. 원본 문서 2개 미커밋 변경은 그대로다. 기존 서버 종료 명령은 실행하지 않았다. 이번에는 원본 서버의 가용성 검증을 수행하지 않았다.
- 운영 DB·Migration·POS 호출·Vercel·GitHub 쓰기는 실행하지 않았다. 운영 비밀정보를 사용·출력하지 않았으며 새 앱 서버도 시작하지 않았다.
- **main 병합 권고: 보류.** 안전성 수정의 로컬 회귀는 통과했지만 새 Codex 실행이 차단되었고 빌드도 완료되지 않았다. Claude 역할 확대는 별도 사용자 결정 사항이다. 병합·push·배포는 수행하지 않았다.
- MCP·Notion 후속 통합: 우선 개발 전용/읽기 전용 커넥터를 분리하고, repo/task ID/branch/HEAD/코드 지문/실행 여부/verdict/미검증 항목/증거 경로를 전달할 표준 레코드를 정한다. 같은 repo+task ID+HEAD에 대한 중복 등록과 덮어쓰기를 방지한다. 외부 쓰기는 사용자 지시가 있는 작업으로 수행하고 운영 DB 적용·이력 등록 역할로 확대하지 않는다. 현재 외부 연결·Notion 작성은 하지 않았다.

