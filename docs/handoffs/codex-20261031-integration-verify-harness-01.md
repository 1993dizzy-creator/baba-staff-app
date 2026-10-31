# 인계서 — integration verification harness recovery

> 작성: 2026-10-31T13:13:04.669Z · baba-handoff · 기준 정책 docs/agents/baba-agent-workflow.md

## 1. 작업 정보
- 작업명: integration verification harness recovery
- 작업 ID: 20261031-integration-verify-harness-01
- 담당 AI: Codex
- Worktree: baba-wt-codex

## 2. Git 상태
- 작업 브랜치: codex/20261031-integration-verify-harness-01
- HEAD SHA: 308013bf95d86f589a8b2591352ec4172dd3defc
- 기준: main · merge-base b7aa024deb26aa6f5b5cdc1c43d05a38998721fd
- 작업 커밋 1개:
  - 308013bf test: split integration fixtures within verification time limits
- 미커밋 변경: 없음

## 3. 변경 파일과 기능
| 파일 | 상태 | 변경량 | 커밋 |
| --- | --- | --- | --- |
| `tests/agent-workflow-integrate-fixture.mjs` | 추가 | +94 −0 | 커밋됨 |
| `tests/agent-workflow-integrate-policy.test.mjs` | 추가 | +298 −0 | 커밋됨 |
| `tests/agent-workflow-integrate.test.mjs` | 수정 | +4 −375 | 커밋됨 |

기능 요약:
- 동기식 Git fixture 통합 테스트 34개를 15개 core 및 19개 policy 묶음으로 분리하고 fixture 함수만 공통 모듈로 추출했다. 전체 파일에 누적되던 실행 시간을 줄이며 각 파일의 600초 제한은 유지한다.
- 기존 34개 test 호출 본문은 AST로 추출하여 원본과 바이트 단위 일치를 확인했다(`.tmp-baba/integration-partition-evidence.json`). assertion·SKIP·기대값·실제 Verify/prepare 실행은 유지한다. 테스트 개수와 검증 범위는 늘리지 않았다.
- 앱·통합 도구·게이트·패키지·설정·규칙·장부·식대·SQL/Migration 코드는 수정하지 않았다. 원본 후보 브랜치를 변경하지 않고 baba-start/Preflight로 main b7aa024d 기준 새 복구 브랜치를 만들었다.

## 4. 검증 결과
- 검증 상태 지문: 6b547c314c1ff531
- baba-verify 판정: **PASS_WITH_PREEXISTING** (2026-10-31T13:13:00.269Z, .tmp-baba/verify/2026-10-31T13-13-00-269Z-308013bf-7479def8-9732-4c23-893d-ba2b90ef924e.json)
- 현재 상태와 일치: 예

| 검사 | 실제 실행 | 결과 |
| --- | --- | --- |
| 변경 파일 검사 | 예 | passed |
| 회귀 테스트 | 예 | passed |
| ESLint (변경 파일) | 예 | passed |
| TypeScript (tsc --noEmit) | 예 | passed-with-preexisting |
| Production Build (next build) | 아니오 | not-run |

미검증 항목:
- 이 복구 SHA의 실제 앱 Production Build는 실행하지 않았다(테스트 하네스 변경만 있음). 테스트 fixture 안의 작은 가짜 Build 실행과 실제 앱 Build를 구분한다.
- 최신 main에 복구를 포함한 로그인·자동완성 prepare는 아직 실행하지 않았다. 기존 실패 prepare의 Build PASS를 이번 SHA의 PASS로 재사용하지 않는다.
- 과거 타임아웃 순간의 정확한 자식 PID 및 종료 시그널은 로그가 없어 복원할 수 없다.

수동 확인(브라우저·실행 확인 등): 사람의 수동 조작은 없음. 아래 자동 실행 및 보존 증거 조사를 수행했다.

- 원본 실패 보고서: `.tmp-baba/integrate/runs/2026-10-31T12-26-51-321Z-5dc7160b-17b7-4a36-b4d3-b03153eb07b4.json`. main `b7aa024deb26aa6f5b5cdc1c43d05a38998721fd`, 후보 `639bef9bec26b8965571a92a7d13cbd6927b1080`, 실패 격리 HEAD `5ed4fe99a48cb91bcd54fbc20803ca458abe0bb7`이다. 원본 로그·환경은 보존했다.
- 기존 통합 테스트는 600079ms 후 exit -1, TAP header와 timeout 메시지만 남았다. Node 테스트의 동기식 spawnSync들이 이벤트 루프를 점유하므로 header만으로 첫 테스트 정지를 단정할 수 없다. fixture 생성 이력은 33번째 `D2: tests that do not load the changed code, read it only, or forged evidence stay blocked`까지 진행을 보여 준다.
- 마지막 fixture `한글 space-p1CSp1`의 Verify는 12:37:42.888Z PASS, Handoff는 12:37:44.373Z 작성·내용 채움 완료, 커밋은 미실행이다. 따라서 마지막 확인 단계는 Handoff 검사/커밋 경계이며, 그 순간 어떤 자식이 실행 중이었는지는 미확인이다. 조사 시 해당 원본 실행의 잔존 검증 프로세스는 없었다.
- main과 격리 트리의 통합 테스트·도구 코드는 동일했다. 선택된 테스트는 7파일이고 기본 병렬도는 4였다. 실패 파일의 기준선 재실행은 단독으로 수행되며 PASS했지만 fixture 생성 구간만 약 599초였다. 각 중첩 prepare는 작은 생성 테스트만 실행하므로 외부 통합 테스트의 재귀 실행은 확인되지 않았다. 대기 정지보다 단일 파일에 누적된 fixture 시간과 실행 경합이 확인된 원인이다.
- 마지막 하위 테스트를 원래 격리 HEAD에서 단독 재실행하여 34.4초 PASS를 확인했다(`.tmp-baba/diagnose-last-subtest.json`).
- 브라우저 SKIP 두 건은 각각 로그인 및 자동완성 테스트의 동일 조건 `!process.env.PLAYWRIGHT_MODULE_PATH` 때문이다. 해당 변수가 없었으며 테스트 결함이나 assertion 실패가 아니었다. 기존 로컬 Playwright 경로를 자격 증명 제거 자식 환경에만 지정하여 같은 격리 HEAD에서 직접 경합 1건과 브라우저 2건 모두 PASS, SKIP 0을 확인했다(`.tmp-baba/diagnose-browser.json`). 로그인 3435ms, 자동완성 42001ms, 전체 프로세스 45877ms였다.
- 이 브라우저 실행의 두 컴포넌트 및 lockfile이 후보 639bef9b와 일치함을 확인했다. 환경은 Node v24.15.0, React 19.2.4, TypeScript 5.9.3, Playwright 1.62.1, 기존 설치 Chrome headless다. 임의 loopback fixture 및 전송 mock만 사용했고 실제 운영 API·DB·원본 서버는 사용하지 않았다. 실제 운영 인증과 전체 Next 앱의 이동 완료는 검증하지 않았다.
- 분리 작업 첫 검증에는 두 suite의 verify import 누락이 있었다. 그 실행은 중단했으며 PASS로 재사용하지 않았다. 누락을 보완하고 no-undef를 포함한 ESLint 및 해당 하위 테스트 2건(5.1초/31.1초)을 통과한 후 코드 커밋을 만들었다. 중단은 식별한 자기 검증 프로세스 트리만 대상으로 했고, 종료 직후 기록된 하위 PID가 남지 않았음을 확인했다.
- 최종 커밋 308013bf에서 baba-verify를 다시 실행했다. core 15/15 PASS 305913ms, policy 19/19 PASS 396907ms, SKIP 0, ESLint 신규 오류·경고 0, TypeScript 기존 40건·신규 0건이다. 최종 SHA·기준선·실행 환경에 일치하는 새 archive를 사용했다.
- 자세한 로컬 증거 색인은 `.tmp-baba/integration-timeout-diagnosis.json`이다. 조사 스크립트·fixture·로그는 ignored 경로에 보존하며 이번 작업에서 삭제하지 않았다.

## 5. DB·Migration
- Migration 변경: 없음
- 기타 SQL 변경: 없음
- 에이전트의 운영 DB 변경·Migration 적용: 없음 (정책상 금지 — AGENTS.md 수동 적용 절차)

## 6. Push·병합·배포
- Git push: push 안 됨
- main 병합: 미병합
- Vercel 배포: 에이전트 미실시 (사용자 승인 후 별도 진행)

## 7. 미완료 사항
- 로그인·자동완성 통합 준비 판정은 BLOCKED(재실행 전)다. 원본 main과 후보는 그대로여서 이 둘의 merge tree에는 복구 테스트 분리가 없다. 새 브랜치의 PASS를 그 미수정 트리의 PASS로 대신하거나 실패 보고서를 갱신하지 않았다. 새 통합 커밋/새 PREPARED 보고서는 없다.
- 기존 main 및 후보, 미확인 보존 브랜치 2개를 유지한다. 이번 복구 브랜치도 후속 승인·통합 전까지 유지하고 ready 전환·삭제하지 않는다.

## 8. 후속 작업
- 사용자 별도 승인 후 복구 브랜치를 CLEAN main에 ff-only로 반영하고 실제 SHA를 재확인하는 경로가 안전하다. 이 실행에서는 main 병합을 하지 않는다. b7aa024d는 복구 코드 커밋의 조상이며 복구 diff는 테스트 3파일 및 이 인계서뿐이다.
- 그 뒤 Codex Worktree에서 기존 후보 `codex/20261031-login-keeping-recovery-01`를 지정해 최신 main의 baba-integrate prepare를 실행한다. 후보 원래 커밋과 인계서·Verify archive는 유지되어 비활성 브랜치도 검사할 수 있다. 원래 후보에 rebase/reset/cherry-pick을 하지 않는다.
- prepare 자식 환경에만 `PLAYWRIGHT_MODULE_PATH`를 기존 로컬 설치 `C:/Users/한근형/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright`로 지정한다. 패키지 설치·전역 환경 변경·SKIP 정책 변경은 필요하지 않다.
- 최신 main + 기존 후보의 격리 두 부모 커밋에서 전체 선택 테스트·TypeScript·ESLint·실제 offline fixture Build를 다시 실행하고, PREPARED일 때만 전체 SHA/부모/증거를 보고해 별도 main 병합 승인을 받는다. 이전 실패 환경의 HEAD를 병합 대상으로 사용하지 않는다.
- Push·배포·운영 DB 변경 및 보존 브랜치 정리는 이번 작업에서 수행하지 않는다.

