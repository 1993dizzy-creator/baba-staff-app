---
name: baba-handoff
description: BABA 관리자 앱 작업 완료 시 표준 인계서를 작성한다. 작업명·작업 ID·담당 AI·브랜치·Git SHA·변경 파일과 기능·baba-verify 검증 결과·DB/Migration 변경 여부·push/병합/배포 여부·미완료 사항과 후속 작업을 docs/handoffs에 기록하고 형식을 검사한다.
---

# baba-handoff (Claude Code 진입점)

이 파일은 Claude Code용 진입점이다. **절차 본문은 Codex와 공유하는 기준 정의 `.agents/skills/baba-handoff/SKILL.md`에만 있다.**

1. `.agents/skills/baba-handoff/SKILL.md`를 처음부터 끝까지 읽고, 그 절차를 그대로 따른다.
2. 스크립트에 `--agent` 인자가 있으면 `claude`를 쓴다. 작업 브랜치 접두사는 `claude/`, 담당 Worktree는 `C:\workspace\baba-wt-claude`다.
3. 기준 정의와 이 파일의 내용이 다르면 기준 정의를 따르고, 차이를 사용자에게 보고한다.
4. 권한 확인을 우회하는 모드(bypassPermissions)로 이 절차를 실행하지 않는다.

공통 정책: `docs/agents/baba-agent-workflow.md`
