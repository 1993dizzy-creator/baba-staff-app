# 인계서 — BABA Skills final validation

> 작성: 2026-10-24T10:28:02.149Z · baba-handoff · 기준 정책 docs/agents/baba-agent-workflow.md

## 1. 작업 정보
- 작업명: BABA Skills final validation
- 작업 ID: 20261024-skills-final-validation-01
- 담당 AI: Codex
- Worktree: baba-wt-codex

## 2. Git 상태
- 작업 브랜치: codex/skills-validation
- HEAD SHA: 0485ab152baae8186053d343f53909df244146b0
- 기준: origin/main · merge-base aba24f3823951a5e861e5ce2aa8d538d6e4867bb
- 작업 커밋 7개:
  - 0485ab1 Record independent Codex workflow skills validation
  - 29c5772 Harden agent workflow verification and handoff safety
  - 4357434 인계서: 병렬 개발 공통 정책 및 baba Skills 구축
  - 57c1998 상태 지문에서 인계서를 제외하고 인계서 자체를 변경 목록에서 제외
  - 70a96f4 baba-verify: 기준선 node_modules junction을 실행 중에만 유지
  - 9820e81 baba-handoff: 수동 확인 항목을 미검증 목록과 분리
  - 86d24d8 병렬 개발 공통 절차와 baba-preflight/verify/handoff Skills 추가
- 미커밋 변경: 없음

## 3. 변경 파일과 기능
| 파일 | 상태 | 변경량 | 커밋 |
| --- | --- | --- | --- |
| `.agents/skills/baba-handoff/SKILL.md` | 추가 | +40 −0 | 커밋됨 |
| `.agents/skills/baba-preflight/SKILL.md` | 추가 | +39 −0 | 커밋됨 |
| `.agents/skills/baba-verify/SKILL.md` | 추가 | +49 −0 | 커밋됨 |
| `.claude/skills/baba-handoff/SKILL.md` | 추가 | +15 −0 | 커밋됨 |
| `.claude/skills/baba-preflight/SKILL.md` | 추가 | +15 −0 | 커밋됨 |
| `.claude/skills/baba-verify/SKILL.md` | 추가 | +15 −0 | 커밋됨 |
| `AGENTS.md` | 수정 | +5 −0 | 커밋됨 |
| `CLAUDE.md` | 수정 | +5 −0 | 커밋됨 |
| `docs/agents/baba-agent-workflow.md` | 추가 | +189 −0 | 커밋됨 |
| `docs/handoffs/claude-20261024-agent-workflow-skills-01.md` | 추가 | +129 −0 | 커밋됨 |
| `docs/handoffs/codex-skills-validation.md` | 추가 | +195 −0 | 커밋됨 |
| `scripts/agent/baba-handoff.mjs` | 추가 | +141 −0 | 커밋됨 |
| `scripts/agent/baba-preflight.mjs` | 추가 | +223 −0 | 커밋됨 |
| `scripts/agent/baba-verify.mjs` | 추가 | +408 −0 | 커밋됨 |
| `scripts/agent/check-agent-skills.mjs` | 추가 | +89 −0 | 커밋됨 |
| `scripts/agent/lib/baseline.mjs` | 추가 | +29 −0 | 커밋됨 |
| `scripts/agent/lib/common.mjs` | 추가 | +408 −0 | 커밋됨 |
| `scripts/agent/lib/handoff-format.mjs` | 추가 | +20 −0 | 커밋됨 |
| `scripts/agent/lib/offline-guard.mjs` | 추가 | +48 −0 | 커밋됨 |
| `tests/agent-workflow-safety.test.mjs` | 추가 | +133 −0 | 커밋됨 |
| `tests/agent-workflow-tools.test.mjs` | 추가 | +88 −0 | 커밋됨 |

기능 요약:
- 공통 Skills 3개를 새 Codex 세션에서 실제 호출했다. 관련 도구 테스트 14개 통과, 선택 회귀 160개 중 152개 통과·기존 실패 8개, TypeScript 기존 오류 40개·신규 0개, ESLint 신규 오류·경고 0개를 확인했다. 이번 최종 검증에서는 실행 코드나 업무 기능을 변경하지 않았다.

## 4. 검증 결과
- 검증 상태 지문: 5cd4251c72c4c5aa
- baba-verify 판정: **PASS_WITH_PREEXISTING** (2026-10-24T10:27:09.970Z, .tmp-baba/verify/2026-10-24T10-27-09-970Z-0485ab15.json)
- 현재 상태와 일치: 예

| 검사 | 실제 실행 | 결과 |
| --- | --- | --- |
| 변경 파일 검사 | 예 | passed |
| 회귀 테스트 | 예 | passed-with-preexisting |
| ESLint (변경 파일) | 예 | passed |
| TypeScript (tsc --noEmit) | 예 | passed-with-preexisting |
| Production Build (next build) | 아니오 | not-run |

미검증 항목:
- 테스트가 참조하지 않는 변경 파일: scripts/agent/baba-verify.mjs

수동 확인(브라우저·실행 확인 등): 새 Codex 세션의 Skill 지침 읽기와 실제 Node 실행, Junction 타깃 보존, Handoff 필수 항목 검사·중복 생성 거부·해시 보존을 확인했다. 별도 Production Build는 NEXT_PUBLIC_SUPABASE_URL 누락으로 blocked-env, exit 1이었으며 통과하지 않았다. 브라우저·운영 DB·POS 실행은 하지 않았다.

## 5. DB·Migration
- Migration 변경: 없음
- 기타 SQL 변경: 없음
- 에이전트의 운영 DB 변경·Migration 적용: 없음 (정책상 금지 — AGENTS.md 수동 적용 절차)

## 6. Push·병합·배포
- Git push: push 안 됨
- main 병합: 미병합
- Vercel 배포: 에이전트 미실시 (사용자 승인 후 별도 진행)

## 7. 미완료 사항
- 전체 Production Build는 개발 환경 변수 부족으로 미완료다. 기존 테스트 실패 8건과 TypeScript 오류 40건은 별도 업무로 남긴다. 자동 탐색에서 Verify CLI 미참조 경고가 있지만, 실제 CLI를 실행하는 안전성 테스트를 명시적으로 지정해 검증했다. 아래 최종 판정은 개발 도구·문서의 필수 검증 범위에 한정한다.

## 8. 후속 작업
- codex/skills-validation 한 브랜치만 main에 로컬 fast-forward로 통합하는 별도 승인이 필요하다. Claude 초기 브랜치는 중복 병합하지 않는다. push·배포·운영 DB·Migration 변경은 승인 범위에 포함하지 않는다. 아래 통합 직전 조건을 재확인한 후 진행한다.

## 9. 최종 완료 판정

**통합 준비 완료 — 개발 도구·문서 범위.** 이 문서는 이전 독립 리뷰 시점의 실행 차단·병합 보류 판단을 후속 실험 결과로 갱신한다. 과거 보고서는 수정하지 않았다. 검증한 실행 코드는 0485ab152baae8186053d343f53909df244146b0와 동일하며 이번 작업의 추적 변경은 이 최종 보고서뿐이다.

| 완료 조건 | 실제 근거 | 판정 |
| --- | --- | --- |
| Codex Skills 3개 실제 실행 | 새 CLI 세션에서 지침 읽기, Preflight exit 0, Verify exit 0, Handoff 생성 exit 0·완성본 검사 exit 0·중복 생성 거부 exit 2 | 충족 |
| 관련 안전성 테스트 | 기존 7개 + 안전성 7개, 14/14 통과. 실제 Codex node_modules에 연결한 Junction의 unlink 후 sentinel·Next 패키지 해시 보존 | 충족 |
| 신규 오류 0 | 선택 회귀 신규 실패 0, TypeScript 신규 0, 변경 파일 ESLint 신규 오류·경고 0 | 충족 |
| 기존 정책 충돌 없음 | SQL 담당 Codex 유지, Claude 역할 확대 미승인 유지, 운영 적용 수동 절차·승인 제한 유지 | 충족 |
| main 충돌·데이터 손실 위험 없음 | main이 대상의 조상, merge-tree 충돌 0, main 문서 2개와 통합 변경 파일 겹침 0. 원본·Claude 파일과 index/status/HEAD 보존 | 현재 확인한 HEAD 기준 충족 |

전체 Build 성공이나 전체 저장소 테스트 통과를 뜻하지 않는다. 전체 Build는 아래 환경 차단 상태로 남기며, 사용자 지시에 따라 이번 개발 도구·문서 범위의 필수 검증과 분리해 판정했다.

## 10. 실행 정책 조사와 정상 실행 설정

설치된 CLI는 0.164.0이다. config/read·configRequirements/read와 redacted doctor를 통해 확인한 사용자 설정은 approval_policy=never, sandbox_mode=workspace-write, windows.sandbox=elevated, sandbox_workspace_write.network_access=true다. 관리 requirements는 null이며 조회한 사용자 규칙은 allow 3개, forbidden 0개였다. 전역 설정 파일의 전후 SHA256은 동일하다.

현재 상위 검증 세션은 시작 시 제공된 danger-full-access/never 실행 환경을 사용한다. 이번에 활성화하거나 확대한 설정이 아니다. 반면 이전 새 CLI 시험은 --ignore-user-config로 시작해 사용자 설정의 Windows Sandbox backend 선택도 제외했다. 따라서 두 실행 환경은 같지 않았다.

| 통제 실험 | 실제 결과 |
| --- | --- |
| --ignore-user-config + read-only, backend 미지정 | node --version의 PowerShell 생성 전 blocked by policy. CLI 대화 exit 0과 실제 명령 실행 성공은 다름. |
| 같은 실행 경로 + windows.sandbox=mxc | Get-Content와 Node 실행 가능. 상위 환경이 모든 자식 실행을 일괄 금지한 것은 아님을 확인. |
| MXC read-only | Git status가 work tree 오류, 명시적 --work-tree 진단에서는 cannot come back to cwd: Permission denied. 이 조건은 통과로 표시하지 않음. |
| MXC workspace-write | Preflight exit 0. Verify는 Junction EPERM·loopback EACCES로 기준선 비교 불가, FAIL. 실패 결과 보존. |
| 기존 준비 완료 elevated + workspace-write + 이 세션만 network_access=true | Node 실행, Junction, loopback fixture, 전체 도구 테스트와 기준선 비교 정상. Verify PASS_WITH_PREEXISTING. |

차단은 Skill 파일 형식이나 Node 설치 문제가 아니라 새 CLI의 Windows 실행 backend/권한 프로필 적용 단계에서 재현됐다. backend를 명시한 뒤 파일 읽기·프로세스 실행은 성공했고, MXC의 추가 제한은 별도 런타임 실패로 구분됐다. 내부 정책 분기의 구현 전체를 추정하지 않고 이 통제 실험이 증명한 범위만 결론으로 삼았다.

정상적인 대화형 시작 예시:

```powershell
Set-Location C:\workspace\baba-wt-codex
codex.cmd --no-daemon --cd C:\workspace\baba-wt-codex --sandbox workspace-write --ask-for-approval on-request -c windows.sandbox=elevated
```

실제 자동 검증은 --no-daemon exec --ignore-user-config --ephemeral --sandbox workspace-write에 windows.sandbox=elevated와 sandbox_workspace_write.network_access=true를 **해당 프로세스에만** 명시했다. 기존 준비 완료 Sandbox를 사용했으며 Full Access·권한 우회 플래그·규칙 무시·수동 ACL 변경·관리자 재설정은 사용하지 않았다. loopback fixture가 필요한 실행은 네트워크 권한과 Node 오프라인 가드를 함께 적용했고 운영 자격 증명은 제공하지 않았다. 전역 설정을 변경하지 않았다.

공식 근거: [Windows Sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox), [Codex 보안](https://learn.chatgpt.com/docs/security), [실행 규칙](https://learn.chatgpt.com/docs/agent-configuration/rules). installed --help, doctor와 실제 프로세스 로그를 함께 대조했다.

### 남는 실행 환경 제한

- Sandbox의 별도 사용자 계정은 원본·Claude 경로의 Git status에서 dubious ownership을 보고했다. 이 **자식 세션의 교차 Worktree 자동 점검은 미완료**로 남긴다. safe.directory=* 또는 전역 trust 변경을 하지 않았다. 이번 통합의 교차 점검은 권한이 있는 현재 검증 세션에서 --no-optional-locks로 직접 수행해 보완했다.
- Handoff의 일반 file-edit 도구는 Failed to write file로 실패했다. 같은 Sandbox에서 Node fs.access(W_OK)가 성공함을 확인한 뒤, 같은 파일시스템 경계를 유지하는 Node 쓰기로 이번 새 초안의 필수 항목을 채웠다. ACL·소유권·파일 모드는 변경하지 않았다. 이후 실제 --check와 중복 생성 거부를 확인했다.
- PowerShell 5.1의 기본 파이프 인코딩으로 한글 보완 문구가 ?로 변환된 것도 발견했다. 이번 새 초안만 UTF-8로 정정했다. 한글을 Node stdin으로 보낼 때는 OutputEncoding을 UTF-8로 설정하거나 UTF-8 .mjs 파일을 사용해야 한다. 형식 검사만으로 본문 의미·인코딩 품질까지 보장하지 않는다.
- 위 도구별 제한을 해결하기 위해 전체 Sandbox나 Git 보안을 해제하지 않았다. 실행 불가·미분류였던 중간 결과도 증거에 유지한다.

## 11. 최종 테스트·빌드·안전성 증거

```text
node --test tests/agent-workflow-tools.test.mjs tests/agent-workflow-safety.test.mjs
node scripts/agent/check-agent-skills.mjs
node scripts/agent/baba-verify.mjs --tests tests/agent-workflow-safety.test.mjs,tests/ledger-deployed-qa.test.mjs,tests/ledger-inventory-rebook.test.ts,tests/ledger-reserve-history-entries.test.ts,tests/ledger-summary-cards.test.ts --json
node scripts/agent/baba-handoff.mjs --check docs/handoffs/codex-skills-final-integration-validation-20261024.md
```

최종 성공 Verify는 새 Codex elevated 세션에서 실행됐다. 160개 중 152 통과·기존 실패 8개·신규 실패 0·skip 0이다. 8건은 merge-base aba24f3에서 같은 실패 진단을 다시 확인했다. TypeScript 기존 오류 40·신규 0, ESLint 신규 오류 0·경고 0이다. Skills 정합성도 3개 모두 통과했다.

| 기존 실패 파일 | 실패 수 |
| --- | --- |
| tests/ledger-deployed-qa.test.mjs | 5 |
| tests/ledger-inventory-rebook.test.ts | 1 |
| tests/ledger-reserve-history-entries.test.ts | 1 |
| tests/ledger-summary-cards.test.ts | 1 |

별도 --build 실행은 컴파일 후 데이터 수집에서 Missing NEXT_PUBLIC_SUPABASE_URL로 종료 코드 1, blocked-env였다. 이번 실행에서는 /api/admin/ledger/payroll/sync 경로에서 보고됐다. 비밀정보·가짜 운영 키를 넣어 성공으로 만들지 않았다. 업무 기능·의존성·Next 설정을 바꾸지 않은 개발 도구·문서 변경이므로 필수 로컬 검증 통과와 전체 앱 Build 미완료를 구분한다. --all-tests, UI, 운영 DB/POS 검증은 실행하지 않았다.

Junction 안전성은 공유 임시 폴더 없음·실행별 mkdtemp·재귀 삭제 없음·링크 ID/타깃 확인 후 unlink를 소스에서 재확인했다. 정상 종료에서 실제 기준선 링크가 해제됨을 확인했고, 실제 Codex node_modules sentinel과 Next package 해시는 그대로였다. 다른 Worktree를 Junction 타깃으로 사용하는 코드는 없다. 원본·Claude 보호 파일 해시와 index/status/HEAD도 다시 대조했다.

로컬 증거(ignored, 커밋하지 않음):

- `.tmp-baba/final-validation/effective-policy.json`, `doctor.json`
- `control-default.jsonl`, `preflight-mxc.jsonl`, `preflight-workspace-mxc.jsonl`, `verify-workspace-mxc.jsonl`
- `preflight-elevated.jsonl`, `verify-elevated.jsonl`, `handoff-elevated.jsonl`, `handoff-completed-elevated.jsonl`
- [성공 범위 Verify](../../.tmp-baba/verify/2026-10-24T10-27-09-970Z-0485ab15.json)
- [빌드 포함 Verify](../../.tmp-baba/final-validation/build-report.json)
- [실제 node_modules Junction 증거](../../.tmp-baba/final-validation/actual-node-modules-junction-proof.json)

## 12. main 통합 대상 전체 파일

통합 대상은 codex/skills-validation 하나다. Claude 초기 5개 커밋은 이미 이 브랜치의 조상이므로 별도 중복 병합하지 않는다. main 대비 전체 22개 파일은 아래와 같다(이 최종 보고서 포함).

```text
.agents/skills/baba-handoff/SKILL.md
.agents/skills/baba-preflight/SKILL.md
.agents/skills/baba-verify/SKILL.md
.claude/skills/baba-handoff/SKILL.md
.claude/skills/baba-preflight/SKILL.md
.claude/skills/baba-verify/SKILL.md
AGENTS.md
CLAUDE.md
docs/agents/baba-agent-workflow.md
docs/handoffs/claude-20261024-agent-workflow-skills-01.md
docs/handoffs/codex-skills-validation.md
docs/handoffs/codex-skills-final-integration-validation-20261024.md
scripts/agent/baba-handoff.mjs
scripts/agent/baba-preflight.mjs
scripts/agent/baba-verify.mjs
scripts/agent/check-agent-skills.mjs
scripts/agent/lib/baseline.mjs
scripts/agent/lib/common.mjs
scripts/agent/lib/handoff-format.mjs
scripts/agent/lib/offline-guard.mjs
tests/agent-workflow-safety.test.mjs
tests/agent-workflow-tools.test.mjs
```

현재 main HEAD는 aba24f3823951a5e861e5ce2aa8d538d6e4867bb다. 원본 main의 기존 미커밋 변경은 다음 2개 파일뿐이며 통합 대상과 겹치지 않는다.

- `docs/pos-pending-admin-resolution.md`
- `docs/reports/2026-10-09-production-migration-history-audit.md`

원본과 Claude의 파일 내용·index·status·HEAD는 보존했다. `git merge-base --is-ancestor main codex/skills-validation`와 Claude 브랜치의 조상 여부 검사는 모두 exit 0이었다. `git merge-tree --write-tree main codex/skills-validation`도 exit 0이었다. main을 체크아웃하거나 병합하지 않고 확인했다. 원격 main도 ls-remote로 같은 aba24f3임을 확인했다.

## 13. 다음 main 통합 작업과 승인 범위

1. **별도 승인:** codex/skills-validation의 최종 보고서 커밋까지를 main에 로컬 fast-forward로 통합하는 작업. GitHub push·배포·운영 DB/Migration 변경은 포함하지 않는다.
2. 통합 직전에 main HEAD, 대상 최종 HEAD, main 문서 2개의 diff·해시·상태를 재확인한다. 예상 외 변경, 대상 경로 겹침, 새 main 커밋이 있으면 먼저 재검토한다.
3. 현재 상태가 유지되면 원본에서 아래 명령 **하나의 브랜치만** 통합한다. 이번 작업에서는 실행하지 않았다.

```powershell
git -C C:\workspace\baba-staff-app merge --ff-only codex/skills-validation
```

4. main HEAD가 승인한 대상 HEAD가 됐는지, 문서 2개의 미커밋 변경·바이트가 그대로인지 확인한다. stash/reset/clean 또는 문서 선행 커밋을 요구하지 않는다. 이 두 문서는 통합 대상과 겹치지 않는다.
5. Claude 초기 브랜치·idle·기존 커밋은 보존한다. 다른 Worktree를 자동 전환하지 않는다. 후속 작업 브랜치는 통합된 **로컬 main**을 기준으로 만들 수 있다. 별도 push 승인 전 origin/main은 여전히 이전 HEAD일 수 있으므로 혼동하지 않는다.
6. GitHub push가 필요하면 별도로 승인받는다. 이번 개발 도구·문서 통합 때문에 Vercel 배포나 DB 작업을 수행할 필요는 없다.
