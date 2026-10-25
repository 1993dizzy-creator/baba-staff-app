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
| MERGED_LOCAL | 0 | 일치하는 별도 사용자 승인으로 로컬 main만 변경 |
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

## 별도 승인 이후 로컬 main

이번 개발에서는 실제 main 병합을 실행하지 않는다. 향후 사용자가 특정 후보/main에 대한 로컬 병합을
명시 승인한 후, 승인 주체가 담당 Worktree 내부에 다음 JSON을 제공한다. 도구는 승인을 자동 발급하지 않는다.

```json
{
  "version": 1,
  "action": "merge-local-main",
  "approvedBy": "user",
  "approvedAt": "사용자가 승인한 ISO 시각",
  "branch": "codex/YYYYMMDD-task-01",
  "candidateHead": "후보 40자리 SHA",
  "mainHead": "승인 대상 main 40자리 SHA",
  "preparedId": "PREPARED 결과의 id",
  "preparedDigest": "저장된 PREPARED JSON을 parse한 후 JSON.stringify한 내용의 SHA-256"
}
```

```powershell
node scripts/agent/baba-integrate.mjs merge --prepared .tmp-baba/integrate/runs/RESULT.json --approval .tmp-baba/USER-APPROVAL.json
```

직전에 후보/main/증거/격리 환경을 다시 확인한다. 실제 테스트한 merge commit을 가져와 원본 main을
그 commit으로 ff-only 진행한다. 승인 대상이 바뀌면 중단한다. 원본의 활성 Git hook은 자동 실행하지 않고
검토 대상으로 차단한다. main 작업은 사용자와 다른 도구가 동시에 수정하지 않는 시점에 수행해야 한다.

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

`push`, `deploy`, `production`, `db`, `migration` action/옵션은 지원하지 않고 차단한다.
GitHub push 및 그에 따른 Vercel Production은 로컬 main 승인과 별도 사용자 승인이 필요하다.
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
