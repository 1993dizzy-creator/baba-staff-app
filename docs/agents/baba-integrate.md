# baba-integrate (P0-2)

명세: [Notion P0-2, 2026-10-25 최신 항목](https://app.notion.com/p/4037ad2aac798172a1ebc24ac492e588).
기준 main: `d2f74cc33252b3e40db1657b93c636c40f4fb572`.
우선 정책은 AGENTS.md와 `docs/agents/baba-agent-workflow.md`다.

## 실행

담당 Worktree에서 기존 `baba-start` → 개발 → `baba-verify` → `baba-handoff`를 사용한다.
후보는 start task manifest와 커밋된 기본 경로의 Handoff를 가져야 한다.

```powershell
node scripts/agent/baba-integrate.mjs --branch codex/YYYYMMDD-task-01 --json
node scripts/agent/baba-integrate.mjs prepare --branch codex/YYYYMMDD-task-01 --json
```

기본값은 `inspect`. `inspect`는 후보·원본 main·타 Worktree를 읽고 담당 Worktree의
`.tmp-baba/integrate/runs/`에 새 기록을 쓴다. `prepare`는 그 안의 독립 Git 저장소에서
ff 또는 두 부모 merge를 만든 후 **실제 baba-verify --base main --build**를 실행한다.
원본 main의 index·파일·브랜치는 변경하지 않는다. Git 객체·ref·index도 격리 환경이 독립 소유한다.
충돌·실패 시 환경과 결과를 그대로 보존한다. source의 node_modules를 읽기 위한 자기 junction만
identity를 확인하고 unlink하며 의존성 디렉터리와 기존 결과는 삭제하지 않는다.

반환 상태와 종료 코드:

| 상태 | 코드 | 의미 |
| --- | --- | --- |
| INSPECTED | 0 | 증거·현재 상태 검사 통과, 병합/Build 준비는 미실행 |
| PREPARED | 0 | 격리 병합과 Verify/Build 통과, 로컬 main 승인 대기 |
| merge 요청 | 2 | R1: 독립적인 사용자 인증이 없어 실행 비활성화 |
| BLOCKED | 2 | `code`, `reason`, `inspection.blockers`에 사유 기록 |

`savedAs`는 실행별 JSON 경로이며 `latest.json`은 조회용 포인터다.
모든 실행 결과는 Handoff 경로·task ID·코드 SHA·후보 SHA·main SHA·Verify archive 경로와
digest, 격리 환경·통합 검증 경로를 포함한다. 차단이 빨라 입력을 확인하지 못한 경우에는
확인하지 못한 값을 채워 넣지 않는다. Handoff의 수동 확인/후속 작업에 해당 실행 기록을 연결한다.

## 증거와 차단

- 커밋된 Handoff의 작업 ID·담당 AI·branch·코드 SHA·상태 지문과 immutable Verify archive를 대조한다.
  Handoff 전 코드 SHA와 후보 HEAD가 다르면 그 사이에 **해당 Handoff 파일만** 바뀌었는지 확인한다.
  owner가 새 작업을 시작해 latest.json이 바뀌어도 Handoff에 기록한 archive로 기존 작업을 검증한다.
- Verify의 판정 문구만 신뢰하지 않는다. 필수 검사·실행 결과·TAP 개수·실패 diagnostics를 확인한다.
  신규 오류, 모르는 상태, 누락, skip/취소/외부 연결 차단, 실행하지 않은 필수 검사는 차단한다.
  기존 실패에는 동일 assertion diagnostics/타입·lint·Build signatures와 merge-base snapshot/manifest가 필요하다.
  구형 report에 이 증거가 없으면 재검증해야 한다. 기존 실패를 자동 성공으로 바꾸지 않는다.
- dirty main, 진행 중 Git 작업, 알 수 없는 활성 task, 겹치는 파일·선언된 scope·table/RPC를 차단한다.
  겹치지 않는 활성 작업의 완료를 기다릴 필요는 없다. 공유 API와 SQL/DB 스키마 변경은 별도 검토가
  필요하다는 사유로 차단한다. 이 버전에는 검토를 우회하는 플래그가 없다.
- main이 바뀌어도 예전 후보의 `prepare`를 새 main 기준으로 다시 수행할 수 있다.
  이전 준비 결과/승인은 사용할 수 없다. 후보 SHA 또는 증거·다른 활성 작업이 바뀌어도 재검증한다.

## R1: main 실행 비활성화와 독립 승인 설계

이전 `approvedBy: "user"` JSON은 사용자 출처를 증명하지 못한다. 현재 Full Access 에이전트가
같은 파일·digest·시각을 만들 수 있으므로 서명 없는 승인 파일을 사용자 승인으로 인정하지 않는다.
기존 main 실행 코드를 제거했다. `merge` 요청은 원격 최신성을 확인한 뒤
`LOCAL_MAIN_EXECUTION_DISABLED`로 차단하며 정상/위조 승인 파일 모두 실행을 허용하지 않는다.
원격 또는 로컬 main이 기존 prepare와 다르면 먼저 재검증 사유로 차단한다.

가능한 후속 설계는 다음과 같다. 아직 구현하거나 승인 경로를 설치하지 않았다.

- 사용자가 독립된 터미널에서 후보 SHA·main SHA·실제 원격 SHA·prepare 증거를 확인하고 직접 실행한다.
  현재 사용자는 main 병합을 금지했으므로 이 작업에서는 수행하지 않는다.
- 또는 에이전트와 다른 OS 계정/서비스의 승인 UI에서 인증한 뒤, 에이전트가 쓸 수 없는 키로
  일회성 승인에 서명한다. 검증 키와 실행 주체도 에이전트가 바꿀 수 없는 경계에 두고
  branch/candidate SHA/main SHA/remote SHA/prepare digest/만료·nonce/사용 이력을 확인한다.
- workspace 파일, 환경변수, 동일 권한의 로컬 키 파일만으로 독립 인증을 달성했다고 주장하지 않는다.

## D1: Git Hook 검사

Git 2.55는 파일 Hook 외에 `hook.<name>.event/command`도 실행한다.
[Git Hook 문서](https://git-scm.com/docs/git-hook/2.55.0)를 기준으로 공통 검사에서
effective config의 키를 `--includes`로 조사하며 command 값은 읽거나 출력하지 않는다.
`post-index-change`를 포함한 기본 shared hooks와 core.hooksPath 디렉터리 모두를 확인한다.
core.hooksPath를 비워 두는 것만으로 config Hook이 차단됐다고 가정하지 않는다.
조건부 includeIf는 다음 branch/gitdir 문맥에서 활성화될 수 있어 보수적으로 차단한다.
알 수 없는 Git 환경변수, 깨진 config, 읽지 못한 디렉터리도 차단한다.
외부에서 지정한 GIT_INDEX_FILE도 차단한다. baseline helper가 명시한 담당 Worktree 내부
전용 index에만 제한적인 내부 허용을 부여한다. 원격 조회의 대화형 인증 요청도 비활성화한다.
공유 Hook을 삭제하거나 원본 설정을 변경하지 않는다. start의 fetch/switch, Verify의 baseline
index 쓰기, prepare의 fetch/switch/merge 전에 공통 검사를 실행한다.

Hook이 아닌 config도 읽기 전용 명령에서 외부 프로그램을 실행할 수 있다. 공통 `git()` helper는
모든 도구 Git subprocess에 `-c core.fsmonitor=false`를 지정하고, 내용 diff(`--binary`, `--numstat`)에는
`--no-ext-diff --no-textconv`를 붙인다. 사용자 config를 바꾸거나 거부하지 않고 호출 단위로 무력화한다.
Claude Code 등 에이전트 셸이 내보내는 `GIT_EDITOR`·`GIT_SEQUENCE_EDITOR`·`GIT_ASKPASS`·`SSH_ASKPASS`는
신뢰하지 않고 Git subprocess 환경에서 제거하며 `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`를 지정한다.
원격 인증은 사용자가 설정한 credential helper만 사용한다. 그 밖의 `GIT_*` override는 계속 차단한다.
LFS 등 filter driver·credential helper·`core.sshCommand`는 사용자/시스템 config로 실행될 수 있으며
이 helper가 격리하지 않는다. 테스트·Build 자식 프로세스가 직접 실행하는 Git에도 이 무력화는 적용되지 않는다.

## D2: 테스트와 SHA 증거

Verify archive에 `baseSha`와 `testSelection.explicit/allTests/executed`를 기록한다.
후보 code HEAD·merge-base·실제 diff와 archive의 변경 범위 및 실행 목록을 대조한다.
prepare는 명시적 테스트를 포함한 후보 실행 목록 전체와 새 main 변경의 관련 테스트를 재실행한다.
기존 테스트가 사라졌거나 자동 정적 탐색으로 검사 범위를 확보하지 못하면 차단한다.
테스트 0건·불명확한 목록·skip은 통합 통과가 아니다. 정적 참조 탐색이 의미적 커버리지 증명은 아니다.

경로를 참조하는 테스트가 없는 변경 파일은 실행 증거로만 보완할 수 있다. Verify는 그런 파일이 있으면
`lib/access-recorder.mjs`를 테스트 프로세스에 preload해 해당 파일의 실제 import/read를 기록한다.
코드 파일은 **통과한** 테스트가 import했을 때, SQL/CSS는 읽었을 때만 `testSelection.exercised`에 남는다.
증거가 없으면 기존처럼 "테스트가 참조하지 않는 변경 파일" gap으로 차단된다. evidence 검사는 archive의
테스트별 기록과 대조하며, prepare는 상속한 증거를 병합 트리의 재Verify에서 다시 확보하지 못하면
`PREPARE_EXERCISE_NOT_REPRODUCED`로 차단한다. 이는 실행 증거이지 assertion 품질 증명이 아니며,
테스트 코드는 같은 프로세스의 계측을 우회·위조할 수 있다(독립 검토 대상).
후속 인계서는 기존 파일을 보존하고 `--handoff docs/handoffs/<branch>-<suffix>.md`로 지정한다.

## D3: 실제 원격 main 정책

prepare 시작·종료와 merge 요청 진입 시 `git ls-remote origin refs/heads/main`을 직접 읽는다.
로컬 origin/main 캐시는 최신성 증거가 아니다. 원격 조회는 읽기 전용이며 push하지 않는다.

| 관계 | 처리 |
| --- | --- |
| 실제 원격 = 로컬 main | 후속 검사 가능 |
| 로컬 선행, 원격 SHA가 조상 | inspect/prepare의 격리 검증 허용(P0-2B) |
| 원격 선행 | 차단 |
| 분기 | 차단 |
| 조회 실패/원격 객체 부재/관계 불명확 | 차단 |

P0-2B는 비교·격리 검증에 병합 승인 증거를 요구하지 않는다. 실제 원격 SHA와 조상 관계는 계속 직접 검증한다.
inspect/prepare에서만 `allowLocalAhead` 비교 정책을 명시하며 원격 선행·분기·조회 실패·관계 불명확은 차단한다.
이 허용은 main 변경·push·배포 승인이 아니다. merge 요청은 기존 엄격한 비교와 R1 실행 비활성화를 유지한다.
원격·main SHA가 바뀌면 이전 prepare는 무효다. 직렬 커밋 후 push 정책은 `docs/agents/baba-after-commit.md`로 분리한다.

## R2: 남아 있는 TOCTOU

검사 직후 외부 프로세스가 config/include/Hook·link·Git 상태를 바꾸는 경쟁은 해결되지 않았다.
변이 직전 반복 검사는 위험을 줄일 뿐 원자적 인증/격리를 제공하지 않는다. 개선 방향은
독립 실행 계정, 에이전트가 바꿀 수 없는 config/키/Hook 정책, 보호된 실행 환경과
승인 SHA를 expected-old로 묶는 원자적 ref 갱신이다. 이 작업에서는 해결됐다고 주장하지 않는다.

## 출력 경계와 권한 한계

managed output은 `insideRoot`의 lexical·realpath 검사 후 Worktree 내부에 쓴다.
상대/절대 탈출, 기존 symlink/junction·dangling link·Windows stream 경로를 거부한다.
검증 자식의 cwd를 담당 Worktree 내부로 제한하고 `TEMP`/`TMP`/`TMPDIR`는 `.tmp-baba/tmp`로 바꾼다.
테스트 fixture는 테스트 파일의 실제 저장소 위치를 기준으로 하며 셸 cwd에 의존하지 않는다.

이는 full-access 셸·악의적인 테스트·네이티브 프로그램 전체를 강제 통제하는 OS sandbox가 아니다.
링크를 검사 직후 외부 프로세스가 교체하는 경쟁 조건까지 방지한다고 주장하지 않는다.
운영 자격 증명은 전달하지 않고 기존 Node 오프라인 가드를 유지한다.
Windows 일반 symlink 생성 권한이 없으면 native symlink 테스트는 skip으로 기록한다.
이 경우 junction 검증과 구별하며 통합 게이트의 미완전 테스트 정책상 자동 승인 가능한 증거로 보지 않는다.

Windows의 prepare → 회귀 fixture → prepare 중첩은 Git object/ref 경로가 260자를 넘을 수 있다.
공통 Git helper는 Windows subprocess에만 `-c core.longpaths=true`를 지정한다.
원본·공유·전역 Git config와 Windows `LongPathsEnabled`는 변경하지 않는다.
이 옵션은 Git for Windows의 긴 경로 처리이며 Node/다른 네이티브 도구 전체의 긴 경로 지원을 보장하지 않는다.
회귀 테스트는 긴 object 경로에서 명시적인 `core.longpaths=false` 실패와 helper 성공을 대조하고,
긴 ref 쓰기 및 fixture의 local config 불변을 확인한다. 기존 테스트의 기대값·SKIP 정책은 유지한다.
prepare 환경은 담당 Worktree의 짧은 `.tmp-baba/i/p-*/<worktree>`에 생성한다.
기존 `.tmp-baba/integrate/environments/prepare-*` 증거는 이동하거나 삭제하지 않는다.
중첩 환경에서 Node의 `mkdtemp`가 기준선 snapshot을 생성할 경로 여유를 확보하며,
깊은 fixture의 실제 기존 실패 비교도 회귀 검증한다. 실행 결과 JSON 위치는 그대로다.

`push`, `deploy`, `production`, `db`, `migration` action/옵션은 지원하지 않고 차단한다.
GitHub push 및 그에 따른 Vercel Production은 로컬 main 승인과 별도 사용자 승인이 필요하다.
단, P0-2B가 상시 승인한 직렬 후처리의 조건부 일반 push는 별도 `baba-after-commit` 게이트를 따른다. 이 CLI에는 push 경로를 추가하지 않는다.
향후 별도 승인 후 배포 SHA·READY·공개 read-only smoke를 검증해야 하며 접근 실패는 미확인으로 남긴다.
운영 SQL/Migration 자동 실행 경로는 없다. SQL Editor → GPT 운영 객체·권한 검증 → 해당 신규 Migration의
조건부 history 등록 → 배포 SOP를 그대로 유지한다.

## 사전 점검과 독립 검증

Claude smoke task/run은 보존한다. 기존 start는 clean ready에서 과거 smoke 기록만으로 차단하지 않는다.
반대로 Handoff 없이 smoke branch에 머물면 UNFINISHED_TASK로 막으며, resume은 같은 branch만 허용한다.
실제 미완료 작업 보호를 느슨하게 하는 이름/slug 예외는 추가하지 않는다.

삭제된 외부 임시 파일 두 개의 생성 명령은 현재 남은 증거로 확정하지 못했다. 이전 fixture의 cwd 의존성과
외부 TEMP/TMP 상속은 재발 가능한 경로로 확인해 수정했다. 정확한 과거 생성 원인은 Claude의 별도 실행 기록 검토가 필요하다.

Claude는 자체 Worktree에 승인된 변경이 반영된 후 start/verify/handoff/integrate fixture와 Windows native symlink,
다른 task의 먼저 완료/후속 main 재검증, 사용자 승인 취소 경계를 독립 검증한다. 다른 Worktree를 자동 수정하지 않는다.
