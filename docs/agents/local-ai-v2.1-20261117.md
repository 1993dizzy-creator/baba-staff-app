# 로컬 AI 개발규칙 v2.1 적용 기록

Owner의 2026-11-17 작업 지시에 따라 원본 main에서 직렬 적용했다. 앱 기능·운영 데이터·Migration·Vercel 환경설정·Notion은 수정하지 않았다.

## 시작 상태와 작업 경계

| 경로 | 브랜치 | 시작 HEAD | 미커밋 / main에 없는 커밋 |
| --- | --- | --- | --- |
| `C:\workspace\baba-staff-app` | `main` | `6a7234d343a001239fca761882fc65accddc118b` | 없음 / 없음 |
| `C:\workspace\baba-wt-codex` | `codex/pos-sync-1700-tables-stability-20261117` | `efacb4a34d5d095de34e6741e4cb9fa6ea35a8f5` | 없음 / 0 |
| `C:\workspace\baba-wt-claude` | `claude/legacy-cleanup-p1-20261117` | `83c3fb865967d09a26018a5c02b5b2a4bf4d2fd0` | 없음 / 0 |

Codex 작업 목록에서 다른 활성 BABA main 작업이 없음을 확인했다. 새 Worktree·브랜치를 만들지 않았다. 두 기존 Worktree는 CLEAN 및 고유 미통합 커밋 없음 조건에서 `git merge --ff-only main`으로 규칙을 수신한다. 기존 브랜치 이름과 모든 고유 Git 이력을 보존하며, Worktree → main 병합은 수행하지 않는다. 종료 HEAD는 이 기록을 포함하는 main 커밋으로 완료 응답에 보고한다.

## 기존 규칙에서 달라진 점

- 일반 앱 개발: 로컬 Commit 뒤 운영 적용을 기다리는 표현을, 검증 PASS → Commit → 승인된 main Push → 기존 Vercel Production 자동 배포 확인으로 명확히 했다.
- DB 개발: 실행 가능한 정식 Migration·검증·Commit을 유지하고, DB 미적용 호환성이 확보된 앱은 먼저 배포한다. 호환성 위험이 있으면 배포를 중단하고 단계적 계획을 보고한다. 운영 적용은 GPT의 GitHub 원본 검수와 별도 Owner 승인 후 GPT가 이력 정합·Postflight까지 주관한다.
- Worktree 병합: 실제 main 작업 종료·CLEAN·Merge/Rebase 없음·개발/검증/Commit 완료·기존 작업 보호·충돌 및 계약 해결·전체 커밋 범위 확인·해당 병합 승인의 7개 조건을 명시했다.
- Codex·Claude: 동일 업무 승인 정책을 적용한다. 일반 Push 전체 차단을 제거했고, Notion 댓글을 포함한 Sheets·Apps Script·Notion 수정은 GPT 전담으로 정리했다.
- 기존 PASS 재사용, 정식 Migration, Git·회계·감사 증거·비밀정보 보호, `.local/` 임시자료 원칙과 선택적 `baba-status`는 유지했다. `CLAUDE.md`는 `@AGENTS.md` 단일 참조를 그대로 유지한다.

## 실제 변경 파일

Git 추적 산출물:

- `C:\workspace\baba-staff-app\AGENTS.md`
- `C:\workspace\baba-staff-app\docs\agents\local-ai-v2.1-20261117.md`

로컬 실행 설정과 기존 Hook·정책 파일(Git 제외):

- `C:\workspace\baba-staff-app\.claude\settings.local.json`
- `C:\workspace\baba-wt-codex\.claude\settings.local.json` — 기존 프로젝트 제한 재사용
- `C:\workspace\baba-wt-claude\.claude\settings.local.json`
- `C:\workspace\baba-staff-app\.codex\config.toml`
- `C:\workspace\baba-wt-codex\.codex\config.toml`
- `C:\workspace\baba-wt-claude\.codex\config.toml` — 기존 제한 재사용, 실행 모드 확대 없음
- `C:\Users\한근형\.claude\baba-p0-3\guard.cjs`
- `C:\Users\한근형\.claude\baba-p0-3\policy.json`
- `C:\Users\한근형\.codex\rules\default.rules`

Worktree의 추적 파일은 main 커밋을 fast-forward로 수신한다. 로컬 설정·Hook은 이 컴퓨터에 직접 적용되며 GitHub Push로 다른 컴퓨터에 배포되지 않는다. 원본 설정 백업 및 일회성 검증 자료는 `C:\workspace\baba-staff-app\.local\ai-rules-v2.1\`에만 보관하며 커밋하지 않는다.

## 권한과 Hook

Claude의 두 기존 프로젝트 설정에서 `Bash(git push *)`·`PowerShell(git push *)` deny를 제거했다. 세 폴더의 Claude/Codex 설정과 공유 Hook 정책에서 Notion 댓글 쓰기를 제거했다. 기존 Supabase `read_only=true` 및 읽기 전용 도구 목록을 보존했다.

실행 모드는 넓히지 않았다. 기존 Claude 전역 `bypassPermissions`, 원본 Codex의 `danger-full-access`/`never`, Worktree Codex가 상속하는 전역 `workspace-write`/`never`, 기존 Codex 실행기 옵션을 보존했다. 업무 승인 정책을 통일한 것이며 OS sandbox와 Hook 구현 자체가 같아진 것은 아니다. Hook은 Claude의 방어 수단이고 Codex의 임의 shell 실행을 강제 차단하는 보안 경계가 아니다. 새 Hook·전역 실행 허용·보안 우회는 추가하지 않았다. 실행 중인 세션이 설정을 캐시했다면 다음 세션에서 다시 읽어야 한다.

기존 `guard.cjs`는 CLI 이름이 파일 경로·검색 인자에 있는 경우와 실제 실행 위치에 있는 경우를 구분한다. 일반 Git 조회·정상 Push·CLI 버전·정식 `supabase migration new`를 허용한다. Vercel 읽기 전용 허용은 `ls/list/inspect/whoami`와 정확히 지정한 deployment GET 조회로 제한했다. 강제/삭제/mirror Push·위험 refspec·reset/clean·이력 재작성, 운영 DB CLI, Vercel 변경 명령·Secret·직접 서비스 API·자격증명 접근을 차단한다. Hook의 exec-form 등록은 변경하지 않았다([공식 Hook 문서](https://code.claude.com/docs/en/hooks#command-hook-fields)).

Codex의 활성 `default.rules`에서 폐기된 `baba-start` 2개와 이전 `baba-membership` 경로 2개의 일회성 허용 항목을 제거했다. 비활성 `.disabled` 복구 설정과 과거 개발·감사 기록은 보존했다.

## 검증 증거와 한계

- PASS: Node 구문 검사 및 390건의 격리 Hook 판정. 세 경로 × Bash/PowerShell의 정상 명령·위험 명령, MCP 읽기/쓰기 경계와 자격증명 파일 접근을 확인했다. 위험 명령은 문자열 입력으로만 전달했으며 실제 실행하지 않았다.
- PASS: 세 폴더의 Claude JSON 파싱·일반 Push deny 제거·Notion 쓰기 제거, Codex 읽기 전용 설정 유지 확인.
- PASS: Codex `debug prompt-input`에서 세 폴더 설정 로딩 exit 0. main의 v2.1 규칙 포함을 확인했다. Worktree는 main 수신 후 동일 v2.1 로딩을 확인한다. 모델 호출이나 별도 개발 에이전트 실행은 하지 않았다.
- PASS: `git diff --check`, 원격 main 조회·fetch 및 Push 대상 범위 확인. 시작 원격 main은 `6a7234d343a001239fca761882fc65accddc118b`였다.
- 도구 확인 중 지원하지 않는 `vercel ls --json`, `codex debug --strict-config` 옵션은 실패하여 지원되는 읽기 전용 명령으로 확인했다. PowerShell 실행정책을 변경하지 않고 설치된 `.cmd` 진입점을 사용했다.
- 앱 전체 테스트·TypeScript·로컬 Build는 규칙/로컬 환경 변경 범위 밖이므로 실행하지 않았다. Claude 실제 모델 세션의 Push와 모든 shell 문법에 대한 보안 증명은 수행하지 않았다.
- Commit SHA·최종 Push 결과·Vercel Production SHA/READY/alias 및 Worktree 종료 상태는 완료 응답에 기록한다. 커밋/Push만으로 배포 성공을 추정하지 않고 원격 조회로 확인한다.
