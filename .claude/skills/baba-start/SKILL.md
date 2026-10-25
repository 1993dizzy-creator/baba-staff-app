---
name: baba-start
description: BABA 관리자 앱 전용 Worktree(격리·병렬 모드)에서 새 개발 요청을 시작하거나 기록된 작업을 재개한다. 자기 Worktree 소유권과 미완료 작업을 확인하고 기존 baba-preflight를 재사용하며 원격 main을 조회·필요 시 fetch한 후 검증된 로컬 main에서 고유 작업 브랜치를 만든다. 코드·문서 수정 전에 먼저 사용하고 차단 시 기존 작업을 보존한다. 원본 main 직렬 모드에서는 사용하지 않는다.
---

공통 절차 본문 `.agents/skills/baba-start/SKILL.md`를 읽고 그대로 실행한다.
기준 정책은 `docs/agents/baba-agent-workflow.md`이며 `AGENTS.md`가 우선한다.
