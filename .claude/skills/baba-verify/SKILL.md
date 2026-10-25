---
name: baba-verify
description: BABA 관리자 앱 전용 Worktree(격리·병렬 모드)의 코드 변경 후 실행하는 검증. 변경 파일 검사(충돌 표식·자격 증명·기존 Migration 수정), 관련 회귀 테스트(자격 증명 제거·오프라인 가드), ESLint, TypeScript, 필요 시 Production Build를 실행하고 merge-base 기준선과 비교해 기존 오류와 신규 오류를 구분하며 실제 실행 항목과 미검증 항목을 분리해 보고한다. 원본 main 직렬 모드에서는 일반 lint·TypeScript·관련 테스트를 쓴다.
---

# baba-verify (Claude Code 진입점)

이 파일은 Claude Code용 진입점이다. **절차 본문은 Codex와 공유하는 기준 정의 `.agents/skills/baba-verify/SKILL.md`에만 있다.**

1. `.agents/skills/baba-verify/SKILL.md`를 처음부터 끝까지 읽고, 그 절차를 그대로 따른다.
2. 스크립트에 `--agent` 인자가 있으면 `claude`를 쓴다. 작업 브랜치 접두사는 `claude/`, 담당 Worktree는 `C:\workspace\baba-wt-claude`다.
3. 기준 정의와 이 파일의 내용이 다르면 기준 정의를 따르고, 차이를 사용자에게 보고한다.
4. 권한 확인을 우회하는 모드(bypassPermissions)로 이 절차를 실행하지 않는다.

공통 정책: `docs/agents/baba-agent-workflow.md`
