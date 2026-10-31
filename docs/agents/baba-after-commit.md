# P0-2B: 직렬 커밋 후 후보·배포 분기

[승인 정책과 검증 범위](https://app.notion.com/p/40a7ad2aac7981da963ecdb0dc1adff0). Codex·Claude Code 공통 명령이며 Git Hook은 설치하지 않는다. 기존 병렬 도구 소유권 검사와 R1 자동 main 병합 비활성화는 유지한다.

```powershell
# 검증 후 지정 파일 로컬 커밋 -> 공통 종료 명령
node scripts/agent/baba-after-commit.mjs --project baba-staff-app --scope baba333 --json
# 작업별 push/Production 금지 지시가 있으면 이 명령으로 대체
node scripts/agent/baba-after-commit.mjs --check --project baba-staff-app --scope baba333 --json
```

기본 실행은 사용자 승인된 조건부 일반 push를 포함한다. 원본 main에서만 실행한다. 작업별 금지 지시는 상시 승인보다 우선한다. 후보 탐지는 Git 읽기 전용이며 결과·잠금만 ignored `.tmp-baba/after-commit/`에 기록한다.

| 분기 | 결과 | 실행 |
| --- | --- | --- |
| A | INTEGRATION_PENDING | 검증된 후보·건수·SHA·변경·의존성·prepare 명령 출력, push 보류 |
| B | ELIGIBLE / DEPLOYED / ALREADY_DEPLOYED | 전체 게이트 통과 시 정확한 SHA의 일반 push 및 Production 확인. --check는 ELIGIBLE에서 중단 |
| C | BLOCKED / PUSHED_UNCONFIRMED | 미완료·미검증·충돌·원격/환경/증거 불명·Production 미확인. 성공으로 표시하지 않음 |

## 후보 탐지

모든 `refs/heads/*`를 조회하고 main의 조상인 브랜치만 제외한다. 비활성 Codex·Claude 작업 브랜치도 owner Worktree의 Task와 커밋된 Handoff·불변 Verify archive를 `inspectCandidate`로 검증한다. 이름·PID·ahead 수나 PASS 문자열만으로 완료 판정하지 않는다.

실제 SHA·커밋 수·활성 여부·Handoff/Verify·변경 파일·ff/merge 전략·재검증 필요 여부를 구분한다. 후보끼리 겹치거나 기존 inspect의 API·schema·table/RPC 의존 차단이 있으면 C다. 미확인 hold/legacy 브랜치·Handoff 없는 작업·실패 archive·DIRTY/진행 중 Git 작업도 C이며 임의 제외·삭제·완료 처리하지 않는다. 확인 가능한 후보는 C 보고에도 함께 표시한다.

## 배포 게이트

1. 원본 main 경로·브랜치·CLEAN·Git 작업·Hook 안전성, 모든 Worktree/브랜치 상태를 확인한다.
2. 실제 `git ls-remote origin refs/heads/main`이 main과 같거나 조상이어야 한다. 원격 선행·분기·조회/객체/관계 불명은 차단한다.
3. 명시적 Vercel project/scope를 GET으로 조회한다. 저장소 연결, production branch=main, Git 배포 enabled, 자동 도메인 반영, ignore-build 없음, 다른 SHA의 진행 중 Production 없음이 필요하다. 비밀 환경값·deploy hook URL은 출력하지 않는다.
4. 실제 Production SHA가 로컬에 있고 main의 조상인지 확인한다. 그 이후 **전체 미배포 커밋**을 순서대로 보고한다. net diff뿐 아니라 중간 SQL/RPC 버전도 검사한다. 원격이 이미 main이면 중복 push 없이 검증·Production 확인만 재개한다.
5. 커밋된 객체만 독립 Git 저장소로 가져오고 자기 node_modules junction만 임시 연결한다. 원본 `.env`·`.next`는 복사·사용하지 않는다. caller의 실제 baba-verify로 관련 테스트·ESLint·typegen/TypeScript·offline-local-fixture Build를 실행한다. SHA·tree·변경 범위·TAP·skip·신규 실패·기준선 증거를 검사한다. 커버리지 불명은 차단하며 `--tests a.test.mjs,b.test.ts`로 필요한 실제 테스트를 추가할 수 있다.
6. SQL·Migration·Supabase/RPC 코드 변경은 아래 실제 운영 postflight 증거 없이는 차단한다. SQL 실행·Migration history 등록은 하지 않는다.
7. push 직전 모든 refs/Task/Handoff/Verify·원격·main·운영 증거·대상을 재검사한다. intent를 보존하고 `git push --porcelain origin <정확한 SHA>:refs/heads/main`만 실행한다. force·main merge·PR·Vercel deploy/promote는 없다.
8. 실제 원격 SHA와 Vercel Production target의 같은 SHA·READY를 확인한다. `--wait-ms` 기본 300000, 최대 600000ms 동안 조회한다. 시간 초과·읽기 실패·불일치는 PUSHED_UNCONFIRMED이며 자동 재push하지 않는다. 이미 같은 원격/Production SHA가 READY면 ALREADY_DEPLOYED다.

## 운영 적용 증거

`--operations <원본 Worktree 내부 JSON>`은 사용자 SQL Editor 실행 후 연결된 읽기 전용 검증 담당자가 제공한 **실제 결과**를 소비한다. 에이전트가 임의로 approval/applied/PASS를 채우는 경로는 없다. 작업명·approvedBy·적용했다는 설명만으로 통과하지 않는다. 운영 적용 여부 불명은 C로 남긴다.

- version=1, source=`connected-read-only-postflight`, 정확한 배포 head, BABA projectId, 15분 이내 observedAt이 필요하다.
- reviewedChangesDigest는 `sensitiveChanges(root, outgoingCommits(root, productionSha, head))` 전체 목록 JSON의 SHA256이다. 중간 버전 검토도 누락하지 않는다.
- records는 마지막 변경 버전별 commit/path/blob, applied=true, observedAt, queryFile/querySha256, resultFile/resultSha256를 가진다. 모든 경로는 원본 내부로 제한한다. 이전 SQL 버전의 재실행을 요구하지 않는다.
- 결과 파일의 projectId/observedAt/querySha256가 일치하고 checks의 appliedSqlMatches, migrationHistory, functionDefinitions, permissions, rowCounts, auditLogs, securityAdvisor, performanceAdvisor가 모두 true여야 한다. 각 항목의 원시 결과·적용 SQL 대조를 실제 검증 담당자가 보존해야 한다. 해당 없는 항목도 근거 없이 true로 만들지 않는다.
- 증거를 이 명령에서 생성하지 않으며 기본값은 증거 없음/BLOCKED다. 상태·내용 일치 검사이지 Full Access 에이전트에 대한 독립 서명/인증이 아니다. 같은 권한의 악의적 프로세스에 대한 증거 위조 방지 경계를 해결했다고 주장하지 않는다.

## 경합·보존·한계

배타적 wx 잠금으로 중복 실행을 차단한다. 죽은 PID라는 이유로 잠금을 자동 삭제하지 않는다. dev/ino를 재확인한 자기 잠금만 해제한다. crash 후에는 실제 원격/Production과 intent를 대조하며 중복 push하지 않는다. 타 Worktree·프로세스·설정·브랜치는 변경하지 않는다.

실행별 report/intent, 검증 snapshot·Build·기준선은 `.tmp-baba/after-commit/`에 보존한다. 자기 junction만 identity 확인 후 unlink한다. 공유 설정·Hook·기존 로그는 정리하지 않는다. Node offline guard는 OS 격리가 아니며 실제 자격 증명을 테스트/Build에 제공하지 않는다.

원격 비교 직후 다른 주체가 바꾸는 TOCTOU를 완전히 제거한 것은 아니다. 일반 push의 서버 fast-forward 검사로 상충 갱신은 거부하며 force-with-lease도 사용하지 않는다. 원자적 서버 승인·독립 증거 인증은 향후 별도 설계 대상이다.

## 보존된 639bef9 후보

`codex/20261031-login-keeping-recovery-01` @ `639bef9bec26b8965571a92a7d13cbd6927b1080`는 삭제·재작성하지 않는다. P0-2B를 main에 먼저 커밋하면 개발 기준 `75d7897e`에서 분기되어 기존 ff-only 직접 병합은 불가능하다.

사용자 승인 전에는 최신 도구를 **caller로** 사용해 담당 Worktree에서 prepare만 수행한다. 예: Codex Worktree에서 `node C:/workspace/baba-staff-app/scripts/agent/baba-integrate.mjs prepare --branch codex/20261031-login-keeping-recovery-01 --json`. 기존 Worktree 소스·Handoff는 바꾸지 않는다. 새 main과 후보를 두 부모로 갖는 독립 환경에서 전체 통합 검증을 다시 수행한다.

PREPARED와 정확한 main/candidate/mergedHead/mergedTree를 검토하고 실제 main 병합을 별도로 승인한 후에만, 사용자의 독립 터미널에서 검증된 독립 환경의 mergedHead 객체를 로컬 fetch하고 그 정확한 SHA를 main에 ff-only로 반영하는 경로를 사용할 수 있다. main이 바뀌면 재prepare한다. 기존 main/후보의 rebase·cherry-pick·reset이나 무승인 merge는 필요하지 않다.
