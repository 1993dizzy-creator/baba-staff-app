# 기록 — Claude 직렬 개발 모드 초안 (대체됨)

> 상태: **대체됨(superseded)**. 현행 정책은 main `66d01f8`의 `AGENTS.md`·`CLAUDE.md`·`docs/agents/baba-agent-workflow.md` §1·§12다.
> 이 문서는 과거 기록이며 규칙으로 적용하지 않는다. 초안 커밋은 main에 merge·cherry-pick하지 않았다.

## 1. 원본 커밋

| SHA | 시각(+0700) | 제목 | 파일 |
| --- | --- | --- | --- |
| `3e38fe2883920b4646b749c90eb4d2a64ed1c5a6` | 2026-10-26 02:05 | docs: allow user-designated Claude serial mode on original main | `CLAUDE.md` +1, `docs/agents/baba-agent-workflow.md` +38 −1 |
| `43d9862c01276701f5e22d1d773ce4043cb2ae82` | 2026-10-26 02:06 | docs: hand off Claude serial mode workflow | `docs/handoffs/claude-20261026-claude-serial-mode-01.md` +65 |

- 브랜치: `claude/20261026-claude-serial-mode-01` (Worktree `baba-wt-claude`), 기준 merge-base `d3d4f78`
- 작업 ID: `20261026-claude-serial-mode-01`, 담당 AI: Claude Code
- 대체한 커밋: main `66d01f8` (2026-10-26 02:25) docs: pick serial or parallel mode from the running worktree path

## 2. 작성 배경

P0-2 통합 준비 이후 사용자가 원본 `main`에서 바로 개발하는 직렬 방식을 원했다. 당시 정책(§1)은 원본 폴더·`main` 수정을 전면 금지했으므로, 초안은 이를 **Claude Code 한정·작업별 명시 지시 예외**로 정의했다.

## 3. 초안의 변경 내용

- `docs/agents/baba-agent-workflow.md`
  - §12 「Claude 직렬 개발 모드 (사용자 지정 예외)」 신설: 발동 조건(작업별 명시 지시, Claude Code 한정, 원본 main, 시작 시 clean, Codex 변경과 겹치지 않음), 절차(시작 SHA 기준 검증 → lint·tsc·관련 테스트 → 원본 main 커밋 → 사용자 보고), Codex 병렬 모드와의 관계
  - §1: 원본 폴더 수정 금지의 유일한 예외로 §12 안내
  - §2-8: "작업 브랜치에만 커밋(§12 직렬 모드 제외)"
  - §7: 원본 main 미커밋 시 병합 중단, main 변경 후 재 prepare·재검증
- `CLAUDE.md`: "사용자가 해당 작업에 Claude 직렬 개발 모드를 명시적으로 지시한 경우에만 §12를 따른다" 한 줄 추가
- 스크립트·테스트·Git 권한 검사(`assertOwnedWorktree` 등)는 변경하지 않았다.
- 인계서 검증: `baba-verify` PASS_WITH_PREEXISTING(TypeScript 기존 오류), `check-agent-skills` 통과, `baba-handoff --check` 통과. Push·병합·배포 없음.

## 4. 대체된 이유

사용자가 같은 날 최종 정책을 다르게 확정했고 `66d01f8`이 이를 반영했다.

| 항목 | 초안 `3e38fe2` | 최종 `66d01f8` |
| --- | --- | --- |
| 모드 결정 | 작업별 사용자 명시 지시 | 실행 중인 Git 작업 경로·브랜치(선언 불필요) |
| 적용 에이전트 | Claude Code만 (Codex 제외) | Codex·Claude Code 공통 |
| 원본 main 시작 조건 | clean 필수, 미커밋이면 시작 안 함 | 미커밋 변경 보존 후 이어받기, 에이전트 교체 규칙 |
| 검증 | lint·tsc·`node --test` | 같은 항목 + offline-guard, ESLint 기존 오류 확인법 |
| `.env.local` | Build만 금지 | 값 접근 금지, `next build/start/dev` 금지 |
| Skills 적용 범위 | 변경 없음 | 4개 Skill을 전용 Worktree 전용으로 명시 |

초안의 규칙은 모두 최종안에 같은 뜻이나 더 넓은 형태로 포함됐다. 초안에만 있고 최종안에 없는 기능·규칙은 없다. 초안을 병합하면 "명시 지시 필요"·"Codex 제외"가 되살아나 최종 정책과 충돌한다.

## 5. 브랜치 처리

초안 브랜치는 이 기록이 main에 커밋된 뒤 정리한다(2026-10-26 직렬 모드 작업). 브랜치를 지운 뒤에도 위 SHA는 reflog·객체가 남아 있는 동안 `git show <SHA>`로 볼 수 있다. 영구 보존 대상은 아래 부록의 원문이다.

## 부록 A. 초안 §12 원문 (`3e38fe2:docs/agents/baba-agent-workflow.md`)

> ## 12. Claude 직렬 개발 모드 (사용자 지정 예외)
>
> §1의 원본 폴더·`main` 수정 금지와 §2-8의 작업 브랜치 커밋 규칙에 대한 유일한 예외다. 이 절 밖의 규칙(§4·§5·§6·§9, AGENTS.md 운영 DB·Migration 규칙)은 그대로 적용한다. 공통 Git 권한 검사와 도구 동작은 바꾸지 않는다. 원본 폴더에서 `baba-start`·`baba-preflight`·`baba-verify`·`baba-handoff`·`baba-integrate`가 거부되는 것은 정상이다.
>
> **발동 조건**(모두 충족해야 한다)
>
> - 사용자가 해당 작업에 대해 직렬 모드 또는 원본 main 직접 개발을 명시적으로 지시했다. 이전 세션이나 다른 작업의 지시는 승계하지 않는다.
> - 에이전트는 Claude Code다. Codex에는 적용하지 않는다.
> - 실행 위치는 원본 폴더(`C:\workspace\baba-staff-app`), 브랜치는 `main`이다.
> - 시작 시 원본 main이 clean이고 진행 중인 merge·rebase·cherry-pick이 없다. 사용자의 미커밋 변경이 있으면 시작하지 않고 보고한다.
> - 수정 예정 파일이 Codex Worktree의 미커밋·미통합 변경과 겹치지 않는다(`git --no-optional-locks`로 읽기 전용 확인). Codex 후보의 main 병합 승인이 대기 중이면 사용자에게 순서를 먼저 확인한다.
>
> **절차**
>
> 1. 읽기 전용 조사로 수정 범위를 정한다. `baba-start`·`baba-integrate`는 사용하지 않는다. 작업 시작 SHA를 기록한다.
> 2. 코드를 고치기 전에 시작 SHA에서 아래 검증을 한 번 실행해 기준 결과를 남긴다. 변경 후 실패를 기존·신규로 분류하는 근거다.
> 3. 원본 main에서 개발한다. 자동 stash, `reset --hard`, 무조건적 `clean`, 이력 재작성, push된 커밋 amend는 금지한다.
> 4. 검증은 `baba-verify` 대신 직접 실행한다. 자격 증명 환경 변수 없이 실행하며 POS 동기화·cron·일괄 작업 경로는 mock 없이 실행하지 않는다.
>    - ESLint: 변경된 JS/TS 파일만 `npx eslint <파일>`
>    - TypeScript: `npx next typegen` 후 `npx tsc --noEmit`
>    - 관련 테스트: 변경 경로를 참조하는 테스트와 같은 폴더 테스트를 `node --test <파일>`로 실행
>    - Production Build: 원본 폴더는 `.env.local`을 자동으로 읽으므로 직렬 모드에서는 실행하지 않고 미검증으로 적는다. Build가 필요하면 사용자 승인 후 Claude Worktree에서 `baba-verify --build`로 확인한다.
> 5. 실패는 2단계 기준 결과와 비교해 "기존"과 "신규"로 나눈다. 기준 결과가 없거나 분류하지 못한 실패는 신규로 본다. 판정과 미검증 항목 표기는 §8 기준(`PASS`·`PASS_WITH_PREEXISTING`·`FAIL`)을 따른다. `FAIL`이면 커밋하지 않는다.
> 6. 원본 main에 커밋한다. 커밋 메시지나 보고에 검증 결과를 남긴다.
> 7. `baba-handoff` 대신 사용자에게 시작 SHA, 최종 SHA, 커밋 목록, 변경 파일, 검증 결과·미검증 항목, DB/Migration 변경 여부, push 여부를 보고한다.
> 8. `git push`, Vercel Production 배포, 운영 DB·Migration 작업은 §6·§7과 AGENTS.md에 따라 별도 사용자 승인을 받는다. 로컬 SQL 작성·테스트 역할은 직렬 모드에서도 Codex에 남는다(§6 역할 확대 미승인).
>
> **Codex 병렬 모드와의 관계**
>
> - Codex는 기존대로 `baba-wt-codex`에서 §2~§10과 `baba-integrate` 절차를 따른다. 직렬 모드는 Codex의 권한과 도구 검사를 바꾸지 않는다.
> - 원본 main에 미커밋 변경(직렬 모드 작업 중 포함)이 있으면 Codex 후보의 main 병합을 중단한다.
> - 직렬 모드 커밋으로 main이 바뀌면 그 전의 Codex prepare·검증 결과는 무효다. Codex 후보는 새 main 기준으로 `baba-integrate` prepare·`baba-verify`를 다시 수행해 재기준화·재검증한다. 후보 브랜치 rebase 등 이력 재작성으로 처리하지 않는다.
> - 직렬 모드를 마친 뒤 Claude가 병렬 작업으로 돌아가면 §2에 따라 Claude Worktree에서 최신 main 기준 새 작업 브랜치를 만든다.

## 부록 B. 초안 `CLAUDE.md` 추가 줄

> - 예외: 사용자가 해당 작업에 Claude 직렬 개발 모드(원본 main 직접 개발)를 명시적으로 지시한 경우에만 `docs/agents/baba-agent-workflow.md` §12를 따른다. 이 모드에서는 `baba-start`·`baba-integrate`를 사용하지 않고, push·Production·운영 DB는 별도 승인 대상이다.
