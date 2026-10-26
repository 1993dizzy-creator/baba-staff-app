# 기록 — 2026-10-26 로컬 과거 브랜치 정리

> 원본 main 직렬 모드 작업. 대상은 Worktree에 연결되지 않은 채 main에 미통합으로 남아 있던 로컬 브랜치 4개다.
> 정리 전 기준: 로컬 main `ac33160`, origin/main `66d01f8`. Push·원격 브랜치 변경 없음.
> 같은 날 정리한 Claude 초안 브랜치는 `20261026-claude-serial-mode-draft.md`에 따로 기록했다.

## 요약

| 브랜치 | 원래 HEAD | 분류 | 결과 |
| --- | --- | --- | --- |
| `backup-before-cache-cleanup` | `a0593a0b28ea3c794b1dfbeece5147d8119f1da3` | C 백업 | 삭제 — 코드 상태가 main `7c14dbc`와 같다 |
| `backup/before-cache-clean-20261021` | `32eb201ec760caaaa00febe9ed6a5a68fe89428b` | C 백업 | 삭제 — 코드 상태가 main `9fc257c`와 같다 |
| `codex/20261025-p0-1-permission-validation-01` | `ab07f35644d9218c821e55cfe60c12642ebe70a8` | B 권한 검증 | 삭제 — 인계서 요지를 아래에 보존 |
| `codex/20261025-permission-probe-0932` | `0c5359cb670894fd9c66a571baeefbd44b4837a8` | B 권한 검증 | 삭제 — 인계서 요지와 프로브 파일 원문을 아래에 보존 |

공통 확인: 네 브랜치 모두 어떤 Worktree에서도 체크아웃되어 있지 않았다. upstream이 없고, docs·scripts·AGENTS.md·CLAUDE.md 어디에서도 참조하지 않았다. 세 Worktree는 clean이었다. 도구 중 브랜치를 읽는 것은 `baba-start`의 현재 브랜치 작업 기록뿐이다. Codex Worktree의 `.tmp-baba/start/tasks/` 기록(무시 경로)은 그대로 두었고, 현재 Codex 브랜치의 동작에는 영향이 없다.

## 1. 백업 브랜치 2개

두 브랜치는 각각 npm 캐시 정리 직전에 만든 1커밋 스냅샷이다. 작업 트리 전체와 npm 캐시 디렉터리를 함께 커밋했다.

| 항목 | `backup-before-cache-cleanup` | `backup/before-cache-clean-20261021` |
| --- | --- | --- |
| 커밋 | `a0593a0` "급여관리 수정" 2026-10-01 20:17 (+0700) | `32eb201` "정산오류 수정" 2026-10-21 22:25 (+0700) |
| 부모(main) | `f7d5efe` | `945cd78` |
| 변경 파일 | 1,482개 (`.tmp-npm-cache/` 1,472개 + 코드 10개) | 1,619개 (`.local-npm-cache/` 1,540개 + 코드·문서·테스트 79개) |
| 백업 대상과 같은 main 커밋 | `7c14dbc` 장부내역 마감 수정 (2026-10-01 20:27) | `9fc257c` Remove local npm cache from unpublished Git history (2026-10-21 22:44) |
| 그 커밋과의 차이(캐시 제외) | `.gitignore` 2줄(캐시 제외 규칙)만 다름 | `.gitignore` 1줄(캐시 제외 규칙)만 다름 |
| main에 없는 blob | `.tmp-npm-cache/` 103개뿐 | `.local-npm-cache/` 258개뿐 |

검증 방법:

- 캐시 디렉터리를 제외한 트리 비교: `git diff --name-only <백업> <main 커밋> -- . ':(exclude)<캐시>'` 결과 `.gitignore` 하나뿐이었다.
- 변경 파일의 모든 blob을 `git rev-list --objects main`과 대조했다. main 이력에 없는 것은 npm 캐시 파일뿐이었다.
- `7c14dbc`·`9fc257c`는 로컬 main과 origin/main(GitHub) 양쪽 이력에 포함되어 있다.

판단:

- 백업한 코드 상태는 main 이력의 커밋으로 그대로 남아 있고 GitHub에도 있다. 브랜치를 지워도 복구 수단이 사라지지 않는다.
- 브랜치에만 있는 것은 npm 다운로드 캐시다. 재생성할 수 있고, 저장소에서 빼기로 한 대상(`9fc257c`)이다.
- 10-21 백업에 들어 있던 POS 미해결 영수증 처리 기능(`app/api/admin/sales/receipts/[id]/resolution/**`, `lib/sales/admin-resolution-*.ts`, 관련 테스트 등)은 main `3d573ca` "매출현황 기능 롤백"(2026-10-22)에서 제거된 상태다. 이 코드는 `9fc257c`에 남아 있어 백업 브랜치 없이도 볼 수 있다.

복구가 필요할 때: `git switch -c <새-브랜치> 7c14dbc` 또는 `9fc257c` (캐시는 `npm ci`로 재생성). 파일 하나만 볼 때: `git show 9fc257c:<경로>`.

## 2. Codex 권한 검증 브랜치 2개

둘 다 P0-1 단계에서 Codex 전용 실행기 권한을 확인하려고 만든 임시 브랜치다. 앱 코드 변경은 없다. 현재 Codex 실행 방식은 이 검증 이후 확정되어 재사용 가치가 없다. 브랜치 객체는 나중에 정리될 수 있으므로 내용 요지를 아래에 남긴다.

### `codex/20261025-permission-probe-0932`

- 2026-10-25 16:31 `d2f74cc`에서 생성. 커밋 2개:
  - `6ac41be9546edbeebefa0ec0c65e29d024fd713e` test: verify BABA local file and commit permissions — `.tmp-baba/p0-1-permission-validation/probe-20261025-0932.txt` 추가
  - `0c5359cb670894fd9c66a571baeefbd44b4837a8` docs: record isolated BABA permission probe — `docs/handoffs/codex-20261025-permission-probe-0932.md` 추가
- 프로브 파일 원문: `BABA local permission probe. No application or production data changes.`
- 인계서 요지: 실행 경로 `C:\workspace\baba-wt-codex`, 세션 `danger-full-access` / `never`. `git switch -c`, 파일 생성, `git add`, `git commit`, `git fetch`, `baba-start --resume`가 모두 권한 승인 요청 0회로 성공했다. baba-verify PASS_WITH_PREEXISTING(TypeScript 기존 오류 40, 신규 0). DB·Migration·push·병합·배포 없음. 제안된 실행기: `codex.cmd --cd C:\workspace\baba-wt-codex --sandbox danger-full-access --ask-for-approval never` (전역 설정 변경 없음).

### `codex/20261025-p0-1-permission-validation-01`

- 2026-10-25 15:47 `d2f74cc`에서 생성. 커밋 1개:
  - `ab07f35644d9218c821e55cfe60c12642ebe70a8` docs: close completed Codex launcher permission validation — `docs/handoffs/codex-20261025-p0-1-permission-validation-01.md` 추가
- 인계서 요지: 소스 변경 없는 전용 실행기 권한 확인 작업이다. `danger-full-access` / `never`, 로컬 파일 쓰기와 `--no-write-fetch-head` fetch 성공, 권한 승인 요청 0회. 세 Worktree 상태와 Git ref 보존을 확인했다. baba-verify PASS_WITH_PREEXISTING(TypeScript 기존 오류 40, 신규 0, 관련 테스트 없음). 후속은 P0-2를 별도 Codex 브랜치에서 시작하는 것이었고, 이는 main에 통합됐다(`b340d44`~`d3d4f78`).

판단: main에 같은 변경은 없지만 검증 기록일 뿐 코드가 아니다. 결과 요지를 이 문서에 보존했고, 재사용할 작업이 없다.

## 3. 정리 방법

- 브랜치마다 위 확인 후 `git branch -D <브랜치>`를 하나씩 실행했다. 원격 브랜치·태그·reflog 만료·gc는 건드리지 않았다.
- 정리 후 main에 미통합인 로컬 브랜치가 없음을 `baba-status`로 확인했다.
