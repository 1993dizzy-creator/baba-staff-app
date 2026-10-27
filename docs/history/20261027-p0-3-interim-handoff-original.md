# 인계서 — P0-3 MCP connection

> 작성: 2026-10-26T13:25:10.911Z · baba-handoff · 기준 정책 docs/agents/baba-agent-workflow.md

## 1. 작업 정보
- 작업명: P0-3 MCP connection
- 작업 ID: 20261026-p0-3-mcp-01
- 담당 AI: Codex
- Worktree: baba-wt-codex

## 2. Git 상태
- 작업 브랜치: codex/20261026-p0-3-mcp-01
- HEAD SHA: de0ecaa70202fb136cd276754017be72f33d754d
- 기준: origin/main · merge-base de0ecaa70202fb136cd276754017be72f33d754d
- 작업 커밋 0개
- 미커밋 변경: 초안 생성 전 없음. 최종 상태에는 이 인계서만 미추적 파일로 남는다. 사용자 지시로 add·commit하지 않았다.

## 3. 변경 파일과 기능
| 파일 | 상태 | 변경량 | 커밋 |
| --- | --- | --- | --- |
| (변경 없음) | - | - | - |

기능 요약:
- 사용자 승인에 따라 공유 로컬 제외 파일 `C:/workspace/baba-staff-app/.git/info/exclude`에 `/.codex/` 한 줄만 추가했다. 전역 제외·추적 중인 .gitignore·기존 커밋은 변경하지 않았다.
- `C:/workspace/baba-staff-app/.codex/config.toml`에서 transport가 없는 `[mcp_servers.codex_apps] enabled=false` 블록만 제거했다. 원본과 Codex Worktree의 `.codex/config.toml`에 `[features] apps=false`를 추가했다. 다른 기존 설정과 Supabase URL·도구 목록은 유지했다.
- 두 설정에 Notion 직접 MCP를 추가했다. 읽기 도구와 `notion-create-comment`만 허용하며 기본 승인 방식은 prompt다. 페이지 변경·생성·이동·삭제 도구는 허용하지 않았다. 담당 카드 제한은 도구 자체가 강제하지 않으므로 인증 후 담당 카드 주소를 확인해야 한다. 아직 댓글을 작성하지 않았다.
- GitHub 직접 MCP는 기존 읽기 전용 URL·도구 목록을 유지하고 `BABA_GITHUB_READONLY_PAT` 환경 변수 이름만 참조한다. 비밀값은 저장하지 않았다.
- Sheets 공식 MCP는 `get_values`, `get_spreadsheet`만 허용하는 비활성 설정으로 준비했다. 읽기 전용 OAuth와 Google 사전 요건을 확인할 때까지 활성화하지 않는다. Vercel Plugin은 비활성 상태를 유지했다.
- `.codex/`는 Git 제외 대상이므로 위 자동 변경 파일 표·baba-verify 지문에 포함되지 않는다. 별도 설정 SHA256과 실제 도구 목록은 `.tmp-baba/p0-3/final-audit.json`에 기록했다.

## 4. 검증 결과
- 검증 상태 지문: 4ce0996feb6e3860
- baba-verify 판정: **PASS_WITH_PREEXISTING** (2026-10-26T13:23:28.531Z, .tmp-baba/verify/2026-10-26T13-23-28-531Z-de0ecaa7-f941463c-b892-45d0-8b8b-7f08a4fbe66f.json)
- 현재 상태와 일치: 예

| 검사 | 실제 실행 | 결과 |
| --- | --- | --- |
| 변경 파일 검사 | 예 | passed |
| 회귀 테스트 | 아니오 | not-run |
| ESLint (변경 파일) | 아니오 | not-run |
| TypeScript (tsc --noEmit) | 예 | passed-with-preexisting |
| Production Build (next build) | 아니오 | not-run |

미검증 항목:
- 관련 회귀 테스트를 찾지 못해 테스트를 실행하지 않았다.

수동 확인(브라우저·실행 확인 등):
- 최초 원본·Codex Worktree의 미추적 파일은 각각 `.codex/config.toml`뿐이었다. 제외 등록 후 두 폴더의 Git 상태가 clean임을 확인했다.
- baba-start는 로직 수정·우회 없이 STARTED, 이후 RESUMED를 반환했다. 원격 main과 로컬 main은 동일했으며 fetch하지 않았다. 인계서 작성 후 최종 재개 확인에서는 이 미추적 인계서 때문에 BLOCKED / DIRTY_WORKTREE가 반환됐다. 이를 우회하거나 인계서를 자동 정리하지 않는다.
- 최종 두 폴더의 strict-config exit=0, apps=false를 확인했다. 프로젝트별 임시 세션을 생성하고 추론 턴 없이 thread-scoped MCP 도구 목록을 조회했다. 두 목록에 codex_apps와 Vercel 도구가 없고, 실제 도구는 Supabase 5개뿐이다. threadId 없는 전역 목록은 프로젝트 제한 검증 근거로 사용하지 않았다.
- 기존 대화의 도구 목록은 hot reload되지 않는다. 신규 BABA 세션에서 제한이 반영됨을 확인했으며, 현재 대화에 남은 광범위한 Plugin 쓰기 도구는 호출하지 않았다.
- GitHub CLI OAuth 시도는 동적 등록 미지원으로 실패했다. Notion CLI OAuth는 사용자 브라우저 인증 단계에 도달했으나 완료하지 않았다. OAuth URL·상태값·자격 증명은 출력하거나 기록하지 않았다.
- Supabase는 앞선 실제 SELECT 검증 결과인 transaction_read_only=on, database_role=supabase_read_only_user, public_table_count=100을 유지한다. 재인증·재설정·추가 SQL 실행은 하지 않았다.
- 재현 명령: Codex Worktree에서 `node .tmp-baba/p0-3/audit.cjs`. 설정 SHA256, strict 결과, Git 상태, 프로젝트별 도구 이름만 저장하며 자격 증명과 데이터 본문은 저장하지 않는다. 이 파일과 결과는 로컬 제외 경로에 있어 Claude가 읽기 전용 검증할 수 있다.

## 5. DB·Migration
- Migration 변경: 없음
- 기타 SQL 변경: 없음
- 에이전트의 운영 DB 변경·Migration 적용: 없음 (정책상 금지 — AGENTS.md 수동 적용 절차)

## 6. Push·병합·배포
- Git push: 해당 없음(작업 커밋 없음)
- main 병합: 미병합
- Vercel 배포: 에이전트 미실시 (사용자 승인 후 별도 진행)

## 7. 미완료 사항
- GitHub: PAT가 아직 제공되지 않아 저장소 실제 조회는 미실시다. bearerToken 상태는 인증 성공을 뜻하지 않는다.
- Notion: 사용자 OAuth가 미완료여서 실제 읽기·담당 카드 댓글 쓰기는 미실시다. 담당 카드 URL과 권한 범위 확인이 필요하다.
- Sheets: Developer Preview 가입, Google Cloud API·MCP 서비스, AI agent용 OAuth client 및 읽기 전용 scope 확인이 필요하다. 연결·인증·실제 셀 조회는 미실시다.
- Vercel: 읽기 전용 강제 방식을 검증할 때까지 연결 보류한다.
- TypeScript 기존 오류 40개, 신규 오류 0개다. 회귀 테스트·lint·Production Build는 미실행이며 앱 소스 변경은 없다.

## 8. 후속 작업
- 사용자: BABA 저장소만 선택한 fine-grained GitHub PAT를 발급한다. 필요한 Contents·Issues·Pull requests는 Read-only, Metadata는 Read-only로 제한하고 쓰기 권한은 부여하지 않는다. PAT는 대화·파일·문서에 넣지 않고 Codex 실행 프로세스의 BABA_GITHUB_READONLY_PAT 환경 변수로 제공한다.
- 사용자: Codex Worktree에서 `codex.cmd mcp login baba_notion_tasks`를 실행하고 브라우저 OAuth를 완료한다. 담당 카드 URL도 지정한다. OAuth 후 새 세션에서 읽기·담당 카드 기록만 검증한다.
- 사용자: Sheets 읽기 전용 OAuth 사전 요건을 준비한다. spreadsheets.readonly만으로 인증되는지 확인하며 쓰기 scope는 승인하지 않는다. 확인 후 Codex가 비활성 설정을 활성화하고 읽기 도구만 조회한다.
- Claude: 설정 파일은 수정하지 않고 독립 검증한다. 다른 작업을 시작하거나 이 인계서를 정리·커밋하는 일은 승인 범위 밖이다.
- 금지사항 유지: Git add·commit·push, main 병합, 운영 DB·Migration 변경, 배포를 수행하지 않았다. 설정 작성과 인증 대기까지 진행했으며 전체 서비스 연결 완료로 보고하지 않는다.

