---
name: baba-start
description: BABA 관리자 앱의 새 개발 요청을 시작하거나 기록된 작업을 재개한다. 자기 Worktree 소유권과 미완료 작업을 확인하고 기존 baba-preflight를 재사용하며 원격 main을 조회·필요 시 fetch한 후 검증된 로컬 main에서 고유 작업 브랜치를 만든다. 코드·문서 수정 전에 먼저 사용하고 차단 시 기존 작업을 보존한다.
---

# baba-start

기준 정책: `docs/agents/baba-agent-workflow.md` §2. 사용자 지시와 `AGENTS.md` 운영 DB·Migration 규칙이 우선한다.

1. 자기 Worktree에서 요청과 코드를 읽기 전용으로 조사해 작업명·수정 예정 경로/glob을 정한다. Codex는 `baba-wt-codex`, Claude Code는 `baba-wt-claude`를 사용한다. 원본 main에서 실행하지 않는다.
2. 저장소 루트에서 실행한다. 아래 명령은 CMD·PowerShell 모두 동일하다. 에이전트는 위치로 자동 판별하며 `--agent codex` 또는 `--agent claude`로 대조할 수 있다.

   ```
   node scripts/agent/baba-start.mjs --task "작업명" --slug task-slug --files "app/example/**,tests/example.test.mjs" --json
   ```

   작업명/slug에 비밀정보를 넣지 않는다. `--slug` 생략 시 작업명에서 생성한다. 한글만 있는 이름은 안정적인 해시 slug를 사용한다. 파일 범위가 불명확하면 먼저 읽기 전용 조사한다.
3. `STARTED` 또는 `RESUMED`와 내부 최종 Preflight 결과를 확인한 뒤 개발한다. 같은 작업명·slug로 반복 호출하면 기록된 현재 브랜치를 재사용한다. 파일 범위가 바뀌면 `--files`를 갱신한다. Preflight의 공통 파일·업무 정책·DB 위험 조건은 별도로 이행한다.
4. `BLOCKED`(종료 코드 2)이면 코드 수정을 중단하고 code·reason과 기록 위치를 보고한다. dirty 상태는 재개 요청도 중단한다. 자동 stash·정리·강제 전환으로 해결하지 않는다. 원격만 앞서거나 이력이 갈라지면 main 통합에 별도 승인이 필요하다.
5. 전환 후 실패한 clean 작업은 기록된 현재 브랜치에서 명시적으로 재개한다.

   ```
   node scripts/agent/baba-start.mjs --resume YYYYMMDD-task-slug-NN --json
   ```

   기존 브랜치로 자동 이동하지 않는다. 기록이 없거나 손상되었거나 다른 작업이 미완료이면 보존 후 보고한다. 활성/불명확 잠금은 보존한다. 명시적 재개에서만 죽은 프로세스의 잠금 기록을 보관 이름으로 옮긴다.
6. 작업 ID·브랜치·기준 SHA·결과 기록 경로를 사용자에게 요약한다. `.tmp-baba/start/tasks/`의 생성 기록과 `runs/`의 실행 결과는 자기 Worktree에만 누적한다. 기록을 삭제하거나 덮어쓰지 않는다. 이전 브랜치의 무작업 상태만으로 완료를 추정하지 않는다.
7. 개발 → `baba-verify` → `baba-handoff`로 마친다. 다음 다른 작업은 clean 상태이고 기존 작업이 main에 포함되었거나 현재 코드와 일치하는 검증 완료 Handoff가 있어야 새 브랜치를 만든다.

이 절차는 에이전트 지침에 의한 자동 호출이다. 터미널/사용자 명령 전체를 가로채는 hook이나 권한 확대는 설치하지 않는다. fetch와 자기 신규 브랜치 전환만 허용하며 main 변경·push·배포·운영 DB 작업 권한을 부여하지 않는다.
