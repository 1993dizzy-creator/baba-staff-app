# baba-status — BABA Git 상태 한 번에 보기

선택적인 읽기 전용 Git 상태 조회 도구다. 개발규칙 정본은 [AGENTS.md](../../AGENTS.md)다.

## 실행

```bat
cd /d C:\workspace\baba-staff-app
baba-status
```

- 다른 폴더에서: `C:\workspace\baba-staff-app\baba-status` 또는 `node C:\workspace\baba-staff-app\scripts\agent\baba-status.mjs`
- 어디서나 `baba-status`로 쓰려면 사용자가 직접 `C:\workspace\baba-staff-app`를 사용자 PATH에 추가한다(도구가 PATH를 바꾸지 않는다).
- PowerShell에서는 `.\baba-status`로 실행한다.
- 실행 위치가 원본 main이면 직렬, 지정 Codex·Claude Worktree의 독립 브랜치이면 병렬로 자동 표시한다. 모드 옵션이나 시작 도구는 필요하지 않다. 병렬 Worktree가 없어도 원본 main의 직렬 조회는 가능하다.
- 옵션: `--offline`(원격 조회 생략), `--graph`(상세 관계도), `--branches`(Worktree 밖 main 미통합 브랜치 목록), `--no-color`, `--json`
- 종료 코드: 0 PASS · 1 검토 필요(WARN) · 2 FAIL

## 화면

- 기본 화면은 main SHA·GitHub Push 대기 수 → 자동 인식한 실행 모드 → Worktree 간략표 → 주의사항 순서다. 같은 대상의 WARN·FAIL 원인을 한 줄로 모으고 중복 문구와 INFO·긴 조치 설명·커밋 메시지 목록은 숨긴다. 원격 미확인 시 Push 대기 수를 추정값으로 표시한다.
- 간략표의 `main 대비 -N`은 뒤처진 커밋 수이며 미커밋 파일 수가 아니다. 미커밋 파일 수는 `DIRTY(N)`, main에 없는 커밋 수는 `미통합(커밋)`에 별도로 표시한다.
- `baba-status --graph`는 기존 상세 화면과 관계도를 표시한다. 실제 Git 공통 조상과 부모 연결을 조회하고, 선형 이력은 왼쪽→오른쪽으로 표시하며 마지막 SHA 아래에 브랜치 포인터를 둔다. 같은 HEAD·detached HEAD·merge 연결선을 구분한다. `--branches`는 Worktree 밖 미통합 브랜치 목록을 추가한다.
- 공통 이력은 최근 first-parent 2개, 분기 후 그래프는 최대 18개 커밋을 표시하며 긴 이력의 생략을 명시한다. 서로 공통 조상을 확인할 수 없으면 연결선을 추정하지 않는다. 미통합 요약은 Worktree별 합계이므로 같은 커밋이 여러 Worktree에 있으면 중복 집계된다.
- 상세표의 미통합은 main에 없는 커밋 수이며 ahead와 같다. behind는 main에만 있는 커밋 수다. JSON은 Git 상태와 자동 인식한 모드를 제공하며 인계서·대기 브랜치·선택 모드 필드는 포함하지 않는다.
- 색상: 초록 PASS·CLEAN·정상, 노랑 검토 필요·DIRTY·Push 대기·미통합, 빨강 FAIL·충돌·Push 불가, 청록 브랜치·SHA. 색이 없어도 PASS/WARN/FAIL 텍스트로 구분된다.
- 색상은 터미널이 ANSI를 지원할 때만 켠다. 리다이렉션·파이프, `CI`, `TERM=dumb`, `NO_COLOR`, `--no-color`에서는 끈다. `FORCE_COLOR=1`이면 강제로 켠다. `--json`에는 색상이 없다.
- Windows Terminal과 Windows 외 터미널은 상자 문자(┌─┐), 기존 CMD 콘솔은 ASCII(+-|) 테두리를 쓴다. 한글 글꼴에서 상자 문자가 2칸으로 그려져 줄이 어긋나는 것을 막기 위해서다.
- 터미널 폭이 표보다 좁으면 표 없이 줄 단위의 간결한 형식으로 바꾼다.

## 검사 항목

| 구분 | 내용 |
| --- | --- |
| Worktree | 원본 main·Claude·Codex의 경로, 브랜치, HEAD, 수정·미추적 파일, clean 여부, 진행 중인 merge·rebase |
| main 통합 | 각 Worktree에서 main에 없는 커밋 수·SHA·제목, main보다 뒤처진 커밋 수, 같은 패치가 이미 main에 있는지(`git cherry`) |
| GitHub | 로컬 main, 원격 main(`git ls-remote`로 직접 조회), Push 대기·원격 앞섬·갈라짐, `origin/main` 참조가 오래됐는지 |

- 결과 표의 "활성 Worktree 통합"은 등록된 원본 main·Claude·Codex를 판정한다. Worktree에 연결되지 않은 로컬 브랜치는 "기타 로컬 브랜치"(정상 / 검토 필요 N개)로 따로 표시하며 종료 코드에 영향을 주지 않는다. "GitHub Push"는 대기 커밋 수와 fast-forward Push 가능 여부를 보여준다. 실제 작업은 사용자가 승인한 범위에 따른다.
- clean이어도 main에 없는 커밋이 있으면 통합 검사는 "검토 필요"다. 그 커밋이 필요한 작업인지, 중복·폐기 대상인지는 도구가 정하지 않고 사용자가 검토한다.
- 원격을 조회하지 못하면 "미확인 — 마지막 fetch 기준 추정"으로 표시한다.
- 인계서나 별도 검증 기록을 요구하지 않는다. main보다 뒤처졌다는 이유만으로 재검증을 요구하지 않으며 테스트·병합·Push·배포를 실행하지 않는다.

## 하지 않는 것

- commit·merge·push·fetch·checkout·reset·clean·stash·브랜치 삭제, 파일·index·ref 변경, 기록 파일 생성
- 테스트·ESLint·TypeScript·보안 검사, Production 배포 승인. "Git 상태: PASS"는 이들의 통과를 뜻하지 않는다.
