@AGENTS.md

## Claude Code 진입점

- 공통 절차는 `docs/agents/baba-agent-workflow.md`이고, Skill 본문은 Codex와 같은 `.agents/skills/`에 있다. `.claude/skills/`는 그 파일을 읽게 하는 진입점이다.
- 개발 모드는 실행 중인 Git 작업 경로로 정한다. 원본 폴더의 `main`에서는 별도 선언 없이 직렬 개발한다(기준 문서 §12). `baba-wt-claude`에서는 새 개발 요청에 `.claude/skills/baba-start/SKILL.md`를 먼저 사용한다. 공통 시작 절차와 차단·재개 규칙은 기준 본문을 따른다.
- AGENTS.md의 로컬 SQL 담당은 Codex로 유지한다. Claude Code로의 역할 확대는 승인된 것으로 간주하지 않으며 사용자의 별도 결정이 필요하다.
