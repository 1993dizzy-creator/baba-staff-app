# 직렬 로컬 커밋 후 상태 보고

정책은 AGENTS.md와 개발 워크플로 §12·§15를 따른다. 기존 P0-2B의 조건부 자동 Push·Production 상시 승인은 비활성화한다.

```powershell
node scripts/agent/baba-after-commit.mjs --project baba-staff-app --scope baba333 --json
# --check도 같은 로컬 상태 확인이며 배포 검증 모드가 아니다.
node scripts/agent/baba-after-commit.mjs --check --project baba-staff-app --scope baba333 --json
```

## 일반 개발 종료

1. 변경에 필요한 테스트·lint 등 필수 검증을 한 번 수행하고 이번 파일만 로컬 커밋한다.
2. 원본 main에서 종료 명령을 실행한다. CLEAN·Git 작업·Hook 안전성, 현재 SHA와 로컬 후보·보류 정보를 확인하고 ignored `.tmp-baba/after-commit/`에 보고서를 보존한다.
3. 정상 결과는 `LOCAL_COMMIT_RECORDED`이며 `deploymentStatus=NOT_REQUESTED`다. 후보·미검증 보류는 보고만 하고 삭제·병합하지 않는다. 원본 main DIRTY·Git 작업 진행·잠금 등은 `BLOCKED`로 남긴다.
4. 결과·SHA·실제 실행한 검증·미검증 항목을 보고하고 종료한다. 다른 Worktree의 보류 사항은 배포 판단과 분리한다.

독립 Git 검증 환경, `verifySerial`, 테스트 재실행, 전체 TypeScript·typegen·Build, 원격 main·Vercel 조회, Push·Production 대기는 이 명령에서 실행하지 않는다. `--operations`·`--tests`·`--wait-ms` 배포 옵션은 더 이상 지원하지 않는다. 테스트용 Git fixture 자동선택 규칙은 변경하지 않는다.

## 별도 승인 후 배포 검증

사용자가 Push·Production을 별도 승인할 때만 수행한다. 종료 명령은 배포 적격성이나 배포 완료를 선언하지 않는다.

1. 대상 SHA·CLEAN·후보/보류·실제 원격·Vercel Production 대상과 전체 미배포 변경을 확인한다.
2. 기존 PASS 증거가 같은 SHA·코드 상태·검사 범위·환경·도구/의존성·기준선에 해당하면 재사용한다. 기존 `validateSerial`·`verifyEvidence`의 원본 archive·digest 검사를 적용하며, 불명확한 조건은 재사용하지 않는다. 새 캐시나 검증 프레임워크를 추가하지 않는다.
3. 누락·무효인 필수 검사만 기존 도구로 수행한다. 전체 TypeScript·오프라인 Build 및 독립 검증 환경은 이 승인 단계의 필요 검사이며 로컬 종료 때 자동 생성하지 않는다. 운영 환경 파일·자격 증명은 격리 테스트에 사용하지 않는다.
4. SQL·Migration·Supabase/RPC 변경은 아래 실제 운영 Postflight 증거를 확인한다. 운영 SQL 실행과 Migration history 등록은 기존 수동 절차이며 이 명령에서 수행하지 않는다.
5. 실제 Push·Production은 해당 승인 범위에서만 진행하고 정확한 SHA·READY를 확인한다. 자동 main 병합·force push·PR·운영 DB 변경은 포함하지 않는다.

## 운영 적용 증거

기존 `checkOperations`가 소비하는 원본 내부 JSON 형식과 보호 조건은 유지한다. 사용자 SQL Editor 실행 후 연결된 읽기 전용 검증 담당자가 제공한 실제 결과만 사용한다. 개발 종료 때 이 증거를 요구하거나 생성하지 않는다.

- version=1, source=`connected-read-only-postflight`, 정확한 배포 head, BABA projectId, 15분 이내 observedAt이 필요하다.
- reviewedChangesDigest는 `sensitiveChanges(root, outgoingCommits(root, productionSha, head))` 전체 목록 JSON의 SHA256이다. 중간 버전 검토도 누락하지 않는다.
- records는 마지막 변경 버전별 commit/path/blob, applied=true, observedAt, queryFile/querySha256, resultFile/resultSha256를 가진다. 모든 경로는 원본 내부로 제한한다. 이전 SQL 버전의 재실행을 요구하지 않는다.
- 결과 파일의 projectId/observedAt/querySha256가 일치하고 checks의 appliedSqlMatches, migrationHistory, functionDefinitions, permissions, rowCounts, auditLogs, securityAdvisor, performanceAdvisor가 모두 true여야 한다. 각 항목의 원시 결과·적용 SQL 대조를 실제 검증 담당자가 보존해야 한다. 해당 없는 항목도 근거 없이 true로 만들지 않는다.
- 증거를 이 명령에서 생성하지 않으며 기본값은 증거 없음/BLOCKED다. 상태·내용 일치 검사이지 Full Access 에이전트에 대한 독립 서명/인증이 아니다. 같은 권한의 악의적 프로세스에 대한 증거 위조 방지 경계를 해결했다고 주장하지 않는다.

## 경합·보존

배타적 wx 잠금과 실행별 보고서 보존은 유지한다. 자기 잠금만 identity 확인 후 해제하며 기존 로그·검증 snapshot·Build·기준선은 삭제하지 않는다. 다른 Worktree·서버·환경·설정·브랜치는 변경하지 않는다.

## 보존된 639bef9 후보

`codex/20261031-login-keeping-recovery-01` @ `639bef9bec26b8965571a92a7d13cbd6927b1080`는 삭제·재작성하지 않는다. P0-2B를 main에 먼저 커밋하면 개발 기준 `75d7897e`에서 분기되어 기존 ff-only 직접 병합은 불가능하다.

사용자 승인 전에는 최신 도구를 **caller로** 사용해 담당 Worktree에서 prepare만 수행한다. 예: Codex Worktree에서 `node C:/workspace/baba-staff-app/scripts/agent/baba-integrate.mjs prepare --branch codex/20261031-login-keeping-recovery-01 --json`. 기존 Worktree 소스·Handoff는 바꾸지 않는다. 새 main과 후보를 두 부모로 갖는 독립 환경에서 전체 통합 검증을 다시 수행한다.

PREPARED와 정확한 main/candidate/mergedHead/mergedTree를 검토하고 실제 main 병합을 별도로 승인한 후에만, 사용자의 독립 터미널에서 검증된 독립 환경의 mergedHead 객체를 로컬 fetch하고 그 정확한 SHA를 main에 ff-only로 반영하는 경로를 사용할 수 있다. main이 바뀌면 재prepare한다. 기존 main/후보의 rebase·cherry-pick·reset이나 무승인 merge는 필요하지 않다.
