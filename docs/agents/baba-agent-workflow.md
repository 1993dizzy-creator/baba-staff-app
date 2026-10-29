# BABA 개발 공통 절차 — 직렬·병렬 모드 (Codex · Claude Code)

이 문서는 Codex와 Claude Code가 함께 따르는 **단일 기준 문서**다. 각 에이전트의 진입점은 다음과 같다.

- Codex: `AGENTS.md`, `.agents/skills/*`
- Claude Code: `CLAUDE.md`(`@AGENTS.md` 포함), `.claude/skills/*`

진입점은 이 문서와 `.agents/skills`를 가리키기만 하고 규칙을 다시 쓰지 않는다.

**우선순위**

1. 사용자의 명시적 지시
2. `AGENTS.md`의 「Supabase 운영 DB 안전 규칙」·「BABA 운영 Migration 기본 절차」·「운영 Migration 반복 금지 사항」
3. 이 문서

이 문서는 위 AGENTS.md 규칙을 완화하지 않는다. 둘이 다르게 읽히면 더 엄격한 쪽을 따른다.

## 1. 개발 모드와 Worktree 소유권

| 용도 | 경로 | 소유 | 브랜치 | 개발 모드 | 앱 포트 |
| --- | --- | --- | --- | --- | --- |
| 원본 | `C:\workspace\baba-staff-app` | 사용자 | `main` | 직렬(기본, §12) | 3000 |
| Codex | `C:\workspace\baba-wt-codex` | Codex | `codex/` | 격리·병렬 | 3001 |
| Claude Code | `C:\workspace\baba-wt-claude` | Claude Code | `claude/` | 격리·병렬 | 3002 |

- 개발 모드는 에이전트 종류가 아니라 **실제 실행 중인 Git 작업 경로와 브랜치**로 정한다. 별도 선언은 필요 없다.
  - 원본 폴더의 `main`: 직렬 모드(§12). Codex·Claude Code 모두 같은 규칙을 따른다.
  - 자기 전용 Worktree: 격리·병렬 모드(§2~§11).
  - 원본 폴더의 다른 브랜치, 등록되지 않은 경로, 다른 에이전트의 Worktree: 수정하지 않고 사용자에게 보고한다.
- 격리·병렬 모드의 에이전트는 **자기 Worktree 안에서만** 파일을 만들거나 수정한다. 다른 Worktree와 원본 폴더는 읽기 전용으로 조회만 한다(`git --no-optional-locks`).
- 원본 개발 서버(3000)는 건드리지 않는다. 원본의 미커밋 변경은 직렬 모드에서 이어받는 경우에만 §12에 따라 다룬다.
- 다른 에이전트의 개발 서버, 에이전트 프로세스, 브랜치를 종료·삭제·이동하지 않는다.
- 전용 Worktree의 기본 목적은 Codex와 Claude Code의 **독립적인 병렬 기능 개발**이다. 다른 에이전트 작업의 검토는 사용자가 요청한 경우에만 하는 별도 용도이며, 개발 Worktree 사용과 구분해 보고한다(§13.2).
- Worktree는 Git 객체·참조·설정을 공유하므로 보안 격리 환경이 아니다. 브랜치 이름 충돌과 공유 ref 변경에 주의한다.

## 2. 작업 브랜치 생성·종료

격리·병렬 모드(전용 Worktree)의 새 개발 요청은 에이전트가 별도 Git 지시를 기다리지 않고 `baba-start`를 먼저 호출한다. 원본 main 직렬 모드에서는 사용하지 않는다(§12). 수정 예정 범위를 정하기 위한 읽기 전용 조사는 먼저 할 수 있다. CMD·PowerShell에서 동일하게 실행한다.

```
node scripts/agent/baba-start.mjs --task "작업명" --slug task-slug --files "app/example/**,tests/example.test.mjs" --json
```

1. 실행 위치·에이전트·등록된 자기 Worktree·브랜치 접두사·clean 상태를 확인한다. 대기 브랜치는 `<agent>/idle`, `<agent>/ready-*`다. main에 없는 커밋이 있는 대기 브랜치는 보존하고 중단한다.
2. 기존 `baba-preflight`(§3)를 실행한다. 다른 Worktree를 조사할 수 없거나 수정 예정 경로가 미커밋/미통합 변경과 겹치면 중단한다. 새 파일을 포함한 glob 충돌도 검사한다.
3. `ls-remote`로 실제 원격 main을 조회하고 캐시와 다르면 main 참조만 fetch한다(강제 갱신·prune 없음). 읽기/인증 실패, 원격만 앞섬, 이력 분기, 관계 불명확이면 중단한다. 원격이 뒤처지면 **최신 로컬 main**을 유지한다. 로컬 main은 자동 수정하지 않는다.
4. 상태·Preflight를 재확인한 뒤 검증한 로컬 main SHA에서 `git switch --no-track -c <agent>/<YYYYMMDD>-<slug>-<NN> <SHA>`로 생성한다. 번호 충돌·다른 Worktree 사용·기존 예약 기록은 건너뛴다. upstream은 만들지 않는다. 최종 Preflight 후 STARTED를 반환한다.
5. 작업 ID는 접두사를 뺀 부분이다. `.tmp-baba/start/tasks/`에는 생성 기록, `runs/`에는 실행별 결과를 배타적으로 새 파일에 저장한다. 자기 Worktree의 ignored 경로만 사용하며 기존 기록을 덮어쓰지 않는다. 프로세스 잠금으로 같은 Worktree의 중복 실행을 막는다. 활성 Git 전환/ref hook은 실행하지 않고 중단한다.
6. 기록된 같은 작업명·slug는 새 브랜치를 만들지 않고 RESUMED로 반환한다. 명시적 재개는 `node scripts/agent/baba-start.mjs --resume <작업-ID> --json`이다. 현재 기록된 브랜치에서만 재개하며 dirty 상태는 항상 중단한다. 사망이 확인된 프로세스 잠금은 명시적 재개에서만 다른 이름으로 보관한다. 전환 후 최종 검사 실패도 브랜치·코드·생성 기록을 남겨 재개할 수 있게 한다.
7. 기록 없는 작업 브랜치, 다른 미완료 작업, 손상된 기록은 임의 채택하거나 완료 처리하지 않는다. 도구 도입 전 브랜치는 기본 경로의 현재 코드와 일치하는 완료 Handoff가 검증된 경우에만 다음 새 작업을 허용한다(과거 재개 기록은 만들지 않음). 기록된 작업의 다음 다른 작업은 clean이고 현재 커밋이 main에 포함되었거나 Handoff `--check`가 통과해야 시작한다. Handoff만으로 기능 커밋을 main에 자동 포함하지 않는다. 미통합 기능 의존성이 필요하면 별도로 보고한다.
8. 개발 중 커밋은 작업 브랜치에만 한다(직렬 모드는 §12). `reset --hard`, 무조건적 `clean`, 강제 전환, 자동 stash, 이력 재작성, 다른 Worktree 브랜치 삭제는 금지한다. 범위 변경 시 Preflight를 다시 실행한다. `package-lock.json`이 바뀌었으면 자기 Worktree에서만 `npm ci`한다.
9. `baba-verify`(§8) → `baba-handoff`(§10) → 작업 브랜치에 커밋한다. 인계서 커밋만으로 종료하지 않는다. §2.1의 종료 점검을 끝내거나 차단 사유와 보존 상태를 보고한다. main 병합·push·배포·운영 변경은 별도 승인 대상이다(§6·§7).

Skill 자동 호출은 `AGENTS.md`/`CLAUDE.md` 진입점의 지침으로 연결한다. 사용자 터미널을 강제 제어하는 hook을 설치하지 않으며 Claude 권한 모드나 `bypassPermissions`를 변경하지 않는다. 두 Worktree에 이 구현이 아직 없다면 승인된 main 통합과 clean 상태의 새 브랜치 반영이 먼저 필요하다.

### 2.1. 모든 Worktree 작업의 종료 점검

종료 순서는 **통합 또는 docs/history 아카이브 → Worktree 대기 전환 → 불필요한 로컬 브랜치 정리 → baba-status 확인**이다. 중단·인계 시에도 점검한다. 진행 중이거나 안전 조건을 충족하지 못한 작업은 브랜치와 기록을 보존하고 종료 보류로 보고한다. 다음 작업 시작으로 이 절차를 대신하지 않는다.

1. **읽기 전용 사전 점검**: 원본 main에서 `node scripts/agent/baba-status.mjs --branches --no-color`를 실행한다. 대상 Worktree의 `git --no-optional-locks -C <경로> status --porcelain=v1`, 현재 브랜치·전체 HEAD SHA, `git worktree list --porcelain`, `git log main..<대상 브랜치>`, `git diff main...<대상 브랜치> --stat`를 확인한다. status의 PASS·CLEAN이나 Handoff 존재만으로 완료·보존을 판정하지 않는다. 진행 중 작업, 미커밋 변경(미추적 포함), Git 작업 진행, 조사 실패가 있으면 전환·삭제를 중단한다.
2. **종료 판정과 보존**: 통합 대상은 승인된 main 통합과 대상 SHA의 포함 여부를 검증한다. 통합하지 않는 기록·초안은 사용자 승인 범위에서 `docs/history/`에 원문과 출처 브랜치·SHA·변경 내역을 보존한다. 과거 미완료 상태와 이후 완료·보류 상태 및 근거를 구분한다. 원본 blob과 보존 파일을 바이트 단위로 대조하고 자격 증명 의심 패턴과 내용을 검사하되 비밀값을 출력하지 않는다. 보존 문서를 main에 커밋한 뒤 해당 커밋의 파일도 원본과 재대조한다. 기능 커밋은 Handoff 아카이브만으로 보존된 것으로 간주하지 않는다. 미확인 기능·보존되지 않은 변경이 있으면 중단한다.
3. **대기 전환**: clean이고 종료 판정이 끝난 자기 Worktree만 검증된 최신 로컬 main SHA에서 새 `<agent>/ready-<날짜>-<고유번호>` 브랜치로 전환한다(`git switch --no-track -c <새 ready 브랜치> <main SHA>`). 기존 ready 브랜치는 덮어쓰지 않는다. main SHA·대상 HEAD·clean 상태·활성 hook을 직전에 재확인하고 변경 시 중단한다. 다른 Worktree는 별도 명시 승인 없이 전환하지 않는다. Worktree 디렉터리와 ignored 설정·증거·task/run 기록은 보존한다.
4. **불필요한 로컬 브랜치 정리**: 삭제가 승인된 대상 이름·전체 SHA를 다시 확인한다. 어느 Worktree에도 연결되지 않았고 통합 또는 전체 고유 변경의 보존 검증이 끝난 대상만 개별 삭제한다. 통합된 브랜치는 `git branch -d <정확한 이름>`을 사용한다. 아카이브로 종료한 미병합 브랜치의 강제 삭제는 정확한 대상에 대한 명시 승인 후에만 허용한다. `-d` 실패를 자동으로 `-D`로 재시도하지 않는다. 일괄 삭제·진행 중 작업·미확인 기능 커밋의 자동 삭제는 금지한다. 승인·쓰기 권한이 없거나 단계가 실패하면 현재 상태를 보존하고 중단한다.
5. **최종 확인**: `node scripts/agent/baba-status.mjs --branches --no-color`와 Worktree 목록으로 미통합 잔여·DIRTY·새 ready HEAD·대상 ref 부재를 확인한다. 삭제 브랜치와 이전 SHA, 보존 문서·main SHA, 테스트 결과, 종료 보류·미확인 사항을 보고한다. `--offline` 사용 또는 원격 조회 실패 시 원격 미확인을 명시한다. 정리 대상 밖 브랜치·Worktree·인계 기록은 변경하지 않는다.

기본 종료 점검은 기존 읽기 전용 `baba-status`와 Git 조회로 수행한다. 자동 삭제 명령은 추가하지 않는다. 로컬 전용 `.claude/settings.local.json`은 내용을 읽거나 변경하지 않고, 미추적임을 확인한 뒤 필요하면 공유 저장소의 `.git/info/exclude`에 `/.claude/settings.local.json`만 등록한다. 추적 파일·전역 Git 설정·MCP 권한은 변경하지 않는다.

## 3. 작업 시작 점검 — `baba-preflight`

`node scripts/agent/baba-preflight.mjs --task "<작업명>" --agent <claude|codex> --files "<수정 예정 파일·glob>"`

- **읽기 전용이다.** 파일 쓰기, fetch, 브랜치 전환, DB 접속을 하지 않는다.
- **확인 항목**
  - Worktree 소유권과 브랜치 접두사
  - 미커밋 변경
  - 기준 대비 ahead/behind와 마지막 fetch 시각
  - `node_modules` 상태, `.env.local` 존재 여부(값은 읽지 않는다)
  - 다른 Worktree의 미커밋·브랜치 변경과의 파일 겹침
  - 수정 예정 파일의 API, import하는 파일, 테이블·RPC·쓰기 경로(정적 분석)
  - 관련 테스트
  - 확정 정책 영역
  - Migration 버전 중복과 기존 Migration 수정 여부
  - 운영 데이터 변경 가능성
- **판정**
  - `가능`: 진행한다.
  - `조건부 가능`: 선행 조건을 해결하거나 사용자에게 보고한 뒤 진행한다.
  - `불가`(위험도 `BLOCKED`): 진행하지 않고 근거를 보고한다.

## 4. 기존 코드·데이터 보호

- 요청 범위 밖의 소스를 수정하지 않는다. 포맷팅, 이름 변경, 리팩터링을 끼워 넣지 않는다.
- 기존 문서·보고서·SQL·patch 파일을 삭제하거나 덮어쓰지 않는다. 증거 로그를 보존한다. 캐시 정리 외의 삭제는 사용자 승인 후에만 한다.
- 운영 자격 증명(service role key, DB password, access token, session secret, POS 키)은 읽기·복사·출력·커밋하지 않는다. 변수 이름만 다룬다.
- Worktree에 운영 `.env.local`을 복사하지 않는다. 개발 환경 값은 별도로 발급된 것만 쓴다.
- `CUKCUK_BASE_URL`이 없으면 코드가 운영 POS 주소를 기본값으로 쓴다. POS 동기화·cron·일괄 작업 경로는 mock 없이 실행하지 않는다.

## 5. 변경 전 영향 범위·공통 파일·API 충돌 검사

- 코드를 고치기 전에 수정 예정 파일, 그 파일을 import하는 파일, 영향받는 API 경로, DB 테이블·RPC를 확인한다(§3 preflight가 정적으로 추정한다).
- **공통 파일**(`scripts/agent/lib/common.mjs`의 `HOT_FILES`)
  - 설정: `package.json`, `package-lock.json`, `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`, `vercel.json`
  - 레이아웃·공용 라이브러리: `app/layout.tsx`, `app/(protected)/layout.tsx`, `lib/supabase/**`, `lib/auth/**`, `lib/navigation/**`, `lib/text/**`, `lib/common/**`
  - Migration: `supabase/migrations/**`
  - 에이전트 정책·도구: `AGENTS.md`, `CLAUDE.md`, `docs/agents/**`, `.agents/**`, `.claude/**`, `scripts/agent/**`
  - 이 파일들을 고치면 다른 Worktree의 진행 작업과 병합 순서를 사용자에게 보고한다.
- 다른 Worktree가 **미커밋으로 수정 중인 파일**은 사용자 확인 없이 수정하지 않는다.
- API 응답 형태, 쿼리 파라미터, RPC 인자·반환 형태를 바꾸면 모든 호출부(`app/`, `components/`, `lib/`)와 관련 테스트를 함께 확인한다. 하위 호환이 깨지면 사용자에게 먼저 보고한다.
- Migration 버전은 Worktree 사이에서 중복되면 안 된다. preflight가 기준선과 다른 Worktree의 신규 Migration 버전을 대조한다.

## 6. Supabase 운영 DB·Migration

- 기준은 `AGENTS.md`의 「Supabase 운영 DB 안전 규칙」, 「BABA 운영 Migration 기본 절차」, 「운영 Migration 반복 금지 사항」이며 그대로 적용한다.
- **로컬 SQL 담당**: 직렬 모드(§12)에서는 현재 실행 중인 에이전트가 로컬 SQL 작성·테스트·검증을 담당한다. 격리·병렬 모드에서는 Codex로 유지하며, Claude Code에 같은 역할을 부여하려면 사용자의 별도 결정이 필요하다. 공통 DB 안전 제한은 두 에이전트 모두에 적용한다.
- 운영 검증과 Migration 이력 등록("GPT" 단계)은 Worktree의 코딩 에이전트가 대신하지 않는다. 사용자가 해당 작업을 명시적으로 지시한 경우에만 수행한다.
- 운영 적용은 사용자가 Supabase SQL Editor에서 직접 실행한다. 에이전트는 `supabase db push`, `db reset`, `migration repair`, 운영 DML·DDL을 실행하지 않는다.
- 이미 적용된 Migration 파일은 수정하지 않고 후속 Migration을 추가한다. `baba-verify`는 기준선에 있는 Migration이 수정되면 실패로 판정한다.
- DB 동작 검증은 로컬 PGlite·네이티브 Postgres fixture 테스트(`tests/*-db.test.mjs`, `*-postgres.test.mjs`)로만 한다.

## 7. Git 병합·배포 승인

- 에이전트는 다음을 **사용자의 명시적 요청 없이 하지 않는다.**
  - `git push`
  - `main` 병합(merge·rebase·cherry-pick 포함)
  - 원격 브랜치 삭제
  - PR 생성
  - Vercel 배포·환경 변수 변경
- 병합 순서는 사용자가 정한다. 병합 전 조건:
  - 대상 브랜치의 `baba-verify`가 FAIL이 아니다.
  - 인계서 `--check`를 통과했다.
  - 다른 Worktree와 겹치는 파일이 정리됐다.
  - 원본 main에 미커밋 변경이 없다. 있으면 병합을 중단하고 보고한다.
  - 후보의 prepare·검증 이후 main이 바뀌었다면(다른 후보 병합, §12 직렬 모드 커밋 포함) 새 main 기준으로 다시 prepare·`baba-verify`한다. 후보 브랜치 rebase 등 이력 재작성으로 처리하지 않는다.
- §12 직렬 모드의 원본 main 직접 커밋은 이 절의 "main 병합"이 아니다. push·배포 승인은 똑같이 필요하다.
- 배포는 AGENTS.md 절차 5단계에 따라 Migration 운영 검증이 끝난 다음에만 진행한다.

## 8. 테스트·회귀 검증 기준 — `baba-verify`

`node scripts/agent/baba-verify.mjs [--build] [--tests a,b] [--all-tests]`

- **변경 파일 검사**
  - 병합 충돌 표식, 자격 증명 의심 패턴(값은 출력하지 않는다), `.env` 파일
  - 기존 Migration 수정
  - 공통 파일 변경
- **관련 회귀 테스트**
  - 변경 경로를 문자열로 참조하는 테스트, helper fixture가 참조하는 Migration 파일명, 같은 폴더 테스트의 상대 import를 기준으로 자동 선택한다.
  - 자격 증명 환경 변수를 제거하고, **오프라인 가드**(loopback 외 연결 차단)를 걸어 실행한다.
- **ESLint**: 변경된 JS/TS 파일만 검사한다. 파일별로 기준선 내용과 비교한다.
- **TypeScript**: `next typegen`과 `tsc --noEmit`으로 프로젝트 전체를 검사한다.
- **Production Build**: `--build`일 때만 실행한다.
  - 다음 변경이면 필요하다: 설정·의존성·layout·page/route 추가·삭제, CSS, `proxy.ts`
  - 병합 준비 단계에서도 필요하다.
  - 운영 환경 변수를 제거한 후 Build 자식에만 `http://127.0.0.1:9`와 실행 시 생성한 테스트 `anon` JWT를 제공한다. 서버 초기화에 필요한 service-role 이름의 변수에도 같은 `anon` 값을 넣는다. 실제 키·환경 파일·DB·서버는 제공하지 않는다. 테스트·lint·TypeScript·부모 프로세스에는 주입하지 않는다. 오프라인 가드는 유지한다.
  - 결과에 `offline-local-fixture`를 표시한다. 실제 운영 환경·인증·DB 연결 성공을 뜻하지 않으며 검증용 `.next`를 배포하면 안 된다. 추가 환경 변수·서비스가 필요하면 기존 실패/환경 차단 판정을 유지하며 성공으로 바꾸지 않는다.
- **기존 오류와 신규 오류 구분**
  - 실패가 있으면 담당 Worktree의 `.tmp-baba/baseline-*`에 실행별 merge-base 스냅샷과 별도 index를 만들어 같은 검사를 비교한다. 스냅샷은 보존하며 자동 재귀 삭제하지 않는다. node_modules junction은 만든 실행만 자기 링크임을 확인한 뒤 unlink한다.
  - 기준선에도 있는 오류는 "기존", 새로 생긴 오류는 "신규"로 분류한다.
- **판정**
  - `PASS`: 실행한 검사가 모두 통과했다.
  - `PASS_WITH_PREEXISTING`: 기존 오류만 있다.
  - `FAIL`: 신규 오류가 있거나 분류하지 못한 실패가 있다.
- **실행 여부 표기**
  - 각 검사에 실제 실행 여부(예/아니오)를 표시한다.
  - 실행하지 않은 검사, 테스트가 없는 변경 파일, UI 동작, 운영 DB 적용은 「미검증 항목」에 따로 적는다.
  - 미검증 항목을 통과로 보고하지 않는다.
- **최소 기준**: 신규 오류 0과 관련 테스트 실행을 충족한다. 테스트가 없는 로직 변경은 회귀 테스트를 추가하거나 미검증으로 명시한다.

## 9. 확정 업무 정책 보호

- POS(매출·영업일 마감·결제 예정·차감), 장부(매입·지급·카드 정산·원장), 재고(입출고·스냅샷·케그), 급여·근태, VAT·세금 계산의 기존 동작은 **확정된 정책**이다.
- 기준은 `docs/`의 해당 영역 문서·보고서와 기존 테스트다. 예: `docs/pos-resolution-operating-contract-final.md`, `docs/pos-business-day-close*.md`, `docs/inventory-ledger-*.md`, `docs/reports/*`. preflight가 영역별 문서를 나열한다.
- 에이전트는 이 정책의 의미(계산식, 상태 전이, 권한, 마감·집계 기준)를 임의로 바꾸지 않는다. 바꿔야 한다면 근거와 영향 범위를 보고하고 사용자 승인을 받는다.
- 정책을 고정하는 기존 테스트의 기대값을 수정해 통과시키지 않는다.

## 10. 작업 완료 인계서 — `baba-handoff`

`node scripts/agent/baba-handoff.mjs --task-name "<작업명>"` → `docs/handoffs/<agent>-<작업 ID>.md`

- **자동 기록 항목**
  - 작업 ID, 담당 AI
  - 브랜치, HEAD SHA, 기준 merge-base, 커밋 목록, 미커밋 변경
  - 변경 파일·변경량
  - 최신 `baba-verify` 결과: 현재 트리와 상태 지문(fingerprint)이 일치하는지 표시한다.
  - Migration·SQL 변경
  - push·병합 상태, 배포 미실시
- **에이전트 작성 항목**(TODO 표식)
  - 기능 요약
  - 실제 수행한 수동 확인
  - Migration 적용 상태
  - 미완료 사항, 후속 작업
- **형식 검사**
  - `node scripts/agent/baba-handoff.mjs --check <파일>`로 검사한다.
  - TODO가 남았거나, 저장된 상태 지문이 현재 코드·해당 Worktree의 최신 검증과 다르거나, 검증이 FAIL이거나, 필수 섹션·SHA가 없으면 실패한다.
- 출력은 현재 Worktree의 `docs/handoffs/*.md` 범위로 제한하며 기존 파일은 --force로도 덮어쓰지 않는다. 새 경로를 지정한다.
- 인계서는 작업 브랜치의 마지막 커밋으로 포함한다. 인계서에 적힌 SHA는 인계서 커밋 직전의 코드 상태를 가리킨다.
- 상태 지문은 `docs/handoffs/`를 제외한 트리 내용으로 계산한다. 따라서 인계서를 쓰거나 커밋해도 검증 일치 여부는 바뀌지 않는다.

## 11. Skills 구조

P0-2 통합 준비 CLI는 `scripts/agent/baba-integrate.mjs`이며 사용법·상태·승인 증거·한계는
`docs/agents/baba-integrate.md`를 따른다. 기본 inspect/prepare는 담당 Worktree 안에서 결과를 기록하고
원본 main을 보존한다. 실제 로컬 main 병합, push, Production, 운영 DB 승인 경계는 §6·§7 그대로다.

| Skill | 기준 정의 (Codex·공통) | Claude Code 진입점 | 실행 스크립트 |
| --- | --- | --- | --- |
| baba-start | `.agents/skills/baba-start/SKILL.md` | `.claude/skills/baba-start/SKILL.md` | `scripts/agent/baba-start.mjs` |
| baba-preflight | `.agents/skills/baba-preflight/SKILL.md` | `.claude/skills/baba-preflight/SKILL.md` | `scripts/agent/baba-preflight.mjs` |
| baba-verify | `.agents/skills/baba-verify/SKILL.md` | `.claude/skills/baba-verify/SKILL.md` | `scripts/agent/baba-verify.mjs` |
| baba-handoff | `.agents/skills/baba-handoff/SKILL.md` | `.claude/skills/baba-handoff/SKILL.md` | `scripts/agent/baba-handoff.mjs` |

- 절차 본문은 `.agents/skills`에만 둔다. Claude 진입점은 같은 `name`·`description`을 갖고, 본문은 기준 파일을 읽도록 지시만 한다.
- 정합성은 `node scripts/agent/check-agent-skills.mjs`로 검사한다.
- 스크립트는 Node.js `.mjs`다. Windows PowerShell 실행 정책(.ps1 차단)과 관계없이 실행되고, 외부 의존성이 없다.
- 위 Skill과 `baba-integrate`는 격리·병렬 모드 전용이다. 소유권 검사로 원본 폴더에서는 거부되며, 이는 정상 동작이다.
- 이 문서나 Skills를 바꾸는 것은 공통 파일 변경이다. 격리·병렬 모드에서는 한 에이전트 브랜치에서 바꾸고 사용자 승인 후 병합한다. 직렬 모드에서는 원본 main에서 직접 바꾼다. 다른 에이전트는 바뀐 `main`에서 새 작업 브랜치를 만들어 반영한다.

## 12. 직렬 모드 — 원본 main 직접 개발

**적용**: 원본 폴더(`C:\workspace\baba-staff-app`)의 `main`에서 실행 중인 에이전트. Codex·Claude Code 공통이며 별도 선언 없이 기본으로 적용한다. §4·§5·§6·§9·§13과 AGENTS.md 운영 DB·Migration 규칙은 그대로 적용한다.

**도구**

- `baba-start`·`baba-integrate`는 사용하지 않는다. `baba-preflight`·`baba-verify`·`baba-handoff`도 소유권 검사로 원본 폴더에서 거부된다. 이는 정상이며 우회하거나 검사를 고치지 않는다.
- 직렬 모드 전용 도구·자동화는 두지 않는다. 일반 Git·npm·node 명령을 쓴다.

**시작·이어받기**

1. `git status`로 브랜치가 `main`이고 진행 중인 merge·rebase·cherry-pick이 없는지 확인한다.
2. 미커밋 변경이 있으면 보존한다. `git status`·`git diff`·최근 커밋으로 내용을 확인한 뒤 이어서 작업한다. 이어받을 작업인지 판단할 수 없으면 수정 전에 사용자에게 묻는다.
3. 수정 예정 파일이 전용 Worktree의 미커밋·미통합 변경과 겹치는지 `git --no-optional-locks -C <Worktree> status`로 읽기 전용 확인한다. 겹치면 사용자 확인 전까지 그 파일을 수정하지 않는다.
4. 수정 전에 아래 검증을 한 번 실행해 기준 결과를 남긴다. 기존·신규 실패를 나누는 근거다.

**에이전트 교체**

- 같은 원본 폴더를 두 에이전트가 동시에 수정하지 않는다. 다른 에이전트 프로세스(PID)가 있다는 이유만으로 작업을 차단하거나 종료를 요구하지 않는다. 예상하지 못한 미커밋 변경·커밋 등 원본 main을 실제로 동시에 수정하는 충돌이 확인될 때만 중단하고 사용자에게 보고한다.
- 이어받는 에이전트는 위 1~2단계로 HEAD·최근 커밋·미커밋 변경을 확인하고 그대로 이어서 작업한다. 이전 에이전트의 커밋과 변경을 되돌리지 않는다.
- 사용자 승인 없이 `reset`, `clean`, `checkout`/`restore`로 파일 되돌리기, 강제 전환, 자동 stash, 이력 재작성으로 기존 작업을 폐기하지 않는다.
- 검증이 끝나지 않은 작업은 커밋하지 않고 미커밋 상태로 남겨 이어받게 한다. 중단 시 가능한 범위에서 진행 상황(변경 파일, 남은 작업, 검증 상태)을 사용자에게 보고한다.

**검증**

- ESLint: 변경된 JS/TS 파일만 `npx eslint <파일>`
- TypeScript: `npx tsc --noEmit` (route 타입이 없으면 `npx next typegen`을 먼저 실행)
- 관련 테스트: 변경 경로를 참조하는 테스트와 같은 폴더 테스트를 `node --import ./scripts/agent/lib/offline-guard.mjs --test <파일>`로 실행한다(TypeScript 테스트는 `--experimental-strip-types` 추가). POS 동기화·cron·일괄 작업 경로는 mock 없이 실행하지 않는다.
- 기존·신규 구분: 시작 4단계 기준 결과와 비교한다. 기준 결과가 없거나 분류하지 못한 실패는 신규로 본다. ESLint 기존 오류는 `git show HEAD:<파일> | npx eslint --stdin --stdin-filename <파일>`로 확인할 수 있다.
- 판정과 표기는 §8 기준(`PASS`·`PASS_WITH_PREEXISTING`·`FAIL`, 실제 실행 여부, 미검증 항목)을 따른다. `FAIL`이면 커밋하지 않는다.
- `.env.local` 보호: 값을 읽기·출력·복사하지 않는다. 원본 폴더에서 Next.js가 `.env.local`을 읽어 운영에 연결될 수 있으므로 `next build`·`next start`·`next dev`를 실행하지 않는다(원본 개발 서버 3000은 사용자 소유). Build 검증이 필요하면 미검증으로 보고하고, 사용자 승인 후 전용 Worktree의 `baba-verify --build`(오프라인 fixture)로 확인한다.

**커밋·보고**

- 검증 후 원본 `main`에 직접 커밋한다. 이번 작업 파일만 지정해 add하고 관련 없는 변경을 섞지 않는다.
- `git push`, Vercel Production 배포, 운영 DB·Migration 적용은 §6·§7과 AGENTS.md에 따라 별도 사용자 승인을 받는다. 직렬 모드에서는 현재 실행 중인 에이전트가 SQL·Migration·RPC·코드·테스트를 모두 담당한다.
- `baba-handoff` 파일 대신 사용자에게 시작 SHA, 최종 SHA, 커밋 목록, 변경 파일, 검증 결과·미검증 항목, DB/Migration 변경 여부, push 여부를 보고한다.

**격리·병렬 모드와의 관계**

- 전용 Worktree의 소유권 검사, 도구 동작, `baba-integrate`의 main 실행 비활성화(R1)는 바꾸지 않는다. 전용 Worktree 에이전트는 원본 main을 읽기 전용으로만 본다.
- 원본 main에 미커밋 변경이 있으면 전용 Worktree 후보의 main 병합을 중단한다(§7).
- 직렬 모드 커밋으로 main이 바뀌면 그 전의 후보 prepare·검증은 무효다. 후보는 새 main 기준으로 `baba-integrate` prepare와 `baba-verify`를 다시 수행한다(§7).

## 13. 개발 착수·검토·중단 게이트 (직렬·병렬 공통)

과잉 개발과 끝없는 교차 검증을 막기 위한 규칙이다. 아래 §13.4의 보호 규칙은 완화하지 않는다.

**고위험 변경**: 금전·회계(매입·지급·배분·정산·원장), DB 스키마·Migration·RPC·권한, POS 마감·결제, 운영 데이터 수정에 영향을 주는 변경. 그 밖은 일반 변경이다.

### 13.1. 개발 착수 게이트

- 고위험 변경은 다음 순서를 지킨 뒤 개발한다: **문제 재현 → 실제 원인 확인 → 영향 규모 조사 → 기존 기능으로 해결 가능한지 검토 → 최소 수정안 선정 → 개발**.
- 발생 사례 1건을 근거 없이 범용 기능으로 확대하지 않는다. 일회성 사례는 기존 기능·운영 절차로 처리할 수 있는지 먼저 보고한다.
- 새 테이블·Migration·RPC·API 추가처럼 개발 범위가 커지면, 개발 전에 대안·영향 범위·유지보수 부담을 사용자에게 보고하고 승인을 받는다.
- 단순 UI 변경에는 운영 DB 전수조사를 요구하지 않는다. 운영 조회는 원인 확인에 필요한 최소 범위의 읽기 전용 조회로 한정한다.

### 13.2. 검토 범위

- 일반 변경은 담당 에이전트의 자체 테스트와 검증(§8, 직렬 모드 §12)으로 종료할 수 있다.
- 고위험 변경도 독립 검토는 필요한 부분(예: SQL, 잠금, 회계 무결성)으로 한정한다.
- 사용자가 요청하지 않은 교차 검토를 자동으로 반복하지 않는다. "한 에이전트 개발 → 다른 에이전트 검토 → 재수정 → 재검토"의 반복은 기본 절차가 아니며, 다음 검토 여부는 사용자가 정한다.

### 13.3. 검증 중단 게이트

- 검증·검토 중 중대한 P0/P1 결함, 설계 결함 또는 범위 확대가 발견되면 수정·재검증을 자동으로 반복하지 않는다. 먼저 **기존 설계 유지 / 범위 축소 / 개발 중단** 중 무엇이 타당한지 근거와 함께 사용자에게 보고하고 판단을 받는다.
- 진행하기로 한 수정은 해당 결함과 관련 회귀를 중심으로 검증한다.
- 필수 보안·회계 무결성 검증을 생략하지 않으며, 미해결 결함을 PASS로 보고하지 않는다. 추가 고위험 검토가 필요하면 그 범위와 근거를 사용자에게 보고한다.

### 13.4. 유지되는 보호 규칙

이 절은 다음을 바꾸지 않는다: 운영 DB 읽기 전용 원칙과 Migration·운영 변경의 명시적 승인(AGENTS.md, §6), 로컬 SQL 작성·검증 담당 제한(AGENTS.md, §6), Worktree 소유권·충돌 보호(§1, §5), 변경 파일만 커밋(§12), `git push`·배포 별도 승인(§7), 신규 테스트 실패 0건 기준(§8).
