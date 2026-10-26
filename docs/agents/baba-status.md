# baba-status — BABA Git 상태 한 번에 보기

읽기 전용 상태 검사 도구다. 개발 정책은 바꾸지 않으며 기준은 `baba-agent-workflow.md`다.

## 실행

```bat
cd /d C:\workspace\baba-staff-app
baba-status
```

- 다른 폴더에서: `C:\workspace\baba-staff-app\baba-status` 또는 `node C:\workspace\baba-staff-app\scripts\agent\baba-status.mjs`
- 어디서나 `baba-status`로 쓰려면 사용자가 직접 `C:\workspace\baba-staff-app`를 사용자 PATH에 추가한다(도구가 PATH를 바꾸지 않는다).
- PowerShell에서는 `.\baba-status`로 실행한다.
- 옵션: `--mode serial|parallel`(선택한 모드와 실행 경로 일치 검사), `--offline`(원격 조회 생략), `--json`
- 종료 코드: 0 PASS · 1 검토 필요(WARN) · 2 FAIL

## 검사 항목

| 구분 | 내용 |
| --- | --- |
| Worktree | 원본 main·Claude·Codex의 경로, 브랜치, HEAD, 수정·미추적 파일, clean 여부, 진행 중인 merge·rebase |
| main 통합 | 각 Worktree에서 main에 없는 커밋 수·SHA·제목, main보다 뒤처진 커밋 수, 같은 패치가 이미 main에 있는지(`git cherry`), 인계서 유무 |
| GitHub | 로컬 main, 원격 main(`git ls-remote`로 직접 조회), Push 대기·원격 앞섬·갈라짐, `origin/main` 참조가 오래됐는지 |
| 안전성 | 실행 경로·브랜치가 정책과 맞는지, 브랜치 접두사, 없는 경로·추가 Worktree, 선택 모드 불일치 |

- clean이어도 main에 없는 커밋이 있으면 통합 검사는 "검토 필요"다. 그 커밋이 필요한 작업인지, 중복·폐기 대상인지는 도구가 정하지 않고 사용자가 검토한다.
- 원격을 조회하지 못하면 "미확인 — 마지막 fetch 기준 추정"으로 표시한다.

## 하지 않는 것

- commit·merge·push·fetch·checkout·reset·clean·stash·브랜치 삭제, 파일·index·ref 변경, 기록 파일 생성
- 테스트·ESLint·TypeScript·보안 검사, Production 배포 승인. "Git 상태: PASS"는 이들의 통과를 뜻하지 않는다.
- `baba-start`·`baba-preflight`·`baba-verify`·`baba-handoff`·`baba-integrate`의 판정을 대신하지 않는다.
