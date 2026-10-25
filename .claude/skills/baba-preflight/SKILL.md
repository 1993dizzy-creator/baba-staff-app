---
name: baba-preflight
description: BABA 관리자 앱 전용 Worktree(격리·병렬 모드)에서 새 작업을 시작하기 전에 실행하는 읽기 전용 점검. Worktree 소유권·작업 브랜치·미커밋 변경, 다른 Worktree와의 파일 겹침, 수정 예정 파일의 API·DB 테이블·RPC, Migration 위험, 운영 데이터 변경 가능성을 확인하고 개발 가능 여부와 위험도를 판정한다. 코드 수정 전 반드시 사용한다. 원본 main 직렬 모드에서는 사용하지 않는다.
---

# baba-preflight (Claude Code 진입점)

이 파일은 Claude Code용 진입점이다. **절차 본문은 Codex와 공유하는 기준 정의 `.agents/skills/baba-preflight/SKILL.md`에만 있다.**

1. `.agents/skills/baba-preflight/SKILL.md`를 처음부터 끝까지 읽고, 그 절차를 그대로 따른다.
2. 스크립트에 `--agent` 인자가 있으면 `claude`를 쓴다. 작업 브랜치 접두사는 `claude/`, 담당 Worktree는 `C:\workspace\baba-wt-claude`다.
3. 기준 정의와 이 파일의 내용이 다르면 기준 정의를 따르고, 차이를 사용자에게 보고한다.
4. 권한 확인을 우회하는 모드(bypassPermissions)로 이 절차를 실행하지 않는다.

공통 정책: `docs/agents/baba-agent-workflow.md`
